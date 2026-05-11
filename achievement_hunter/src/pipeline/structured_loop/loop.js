import {readFile as read_file} from 'fs/promises';

import {get_nts_state as get_state_for_candidates, get_sgsg_state} from '../agent_state.js';
import {clearCheckpoint as clear_checkpoint, saveCheckpoint as save_checkpoint,} from '../checkpoint.js';
import {get_canonical_source_for_target, get_grounded_nearby_source, get_source_kind_for_target,} from '../mc_sources.js';
import {createRolloutLogger as create_rollout_logger} from '../rollout_logger.js';
import {compute_scsg} from '../scsg.js';
import {generate_primary_task_dag_self_refined} from '../self_refine.js';

import {execute_task_action} from './actions.js';
import {build_incoming_edge_map, edge_in_subgraph, edge_key,} from './graph.js';
import {make_spl} from './log.js';
import {make_fallback_acquisition_task, select_next_task, try_make_craft_task, try_make_immediate_acquisition_task, try_make_interact_task, try_make_smelt_task,} from './tasks.js';

const max_outer_retries = 10;

const spl = make_spl('[SPL]');

// Runs the full structured task loop.
export async function structured_loop(models, agent, task_name, graph = null) {
  const log = create_rollout_logger(task_name);
  const bot = agent.bot;

  // This hard coded option to load a graph is intended. Do not remove.
  const load_graph = true;
  const graph_file_path =
      //    './achievement_hunter/docs/ptd_jsons/bake_a_cake.json';
      //   `./achievement_hunter/docs/ptd_jsons/get_a_lava_bucket.json`;
      //    `./achievement_hunter/docs/ptd_jsons/create_an_iron_golem.json`;
      // './achievement_hunter/docs/ptd_jsons/construct_one_pickaxe_one_shovel_one_axe_and_one_hoe_with_the_same_material.json';
      // './achievement_hunter/docs/ptd_jsons/smelt_an_iron_ingot.json';
      // './achievement_hunter/docs/ptd_jsons/cook_a_porkchop.json';
      './achievement_hunter/docs/ptd_jsons/pick_up_a_diamond_from_the_ground.json'
  graph = load_graph ? await load_graph_from_file(graph_file_path) :
                       await generate_primary_task_dag_self_refined(
                           models, task_name, graph, log);
  if (!graph) return;

  save_checkpoint(task_name, graph);

  // Track death within this SPL run. When the bot dies the server cancels all
  // actions; on the next loop iteration we wait for respawn, then let the loop
  // recompute a fresh SCSG against the post-death (empty) inventory. Death is
  // not counted as a consecutive failure — it is an external event, not a sign
  // that the loop logic is stuck.
  let death_pending = false;
  let post_respawn_promise = Promise.resolve();

  const on_death = () => {
    spl.log('Bot died — awaiting respawn to recompute SCSG.');
    death_pending = true;
    post_respawn_promise = new Promise(
        resolve => bot.once('spawn', () => setTimeout(resolve, 500)));
  };
  bot.on('death', on_death);

  let consecutive_failures = 0;
  try {
    while (true) {
      if (death_pending) {
        death_pending = false;
        await post_respawn_promise;
        spl.log('Respawned — recomputing SCSG with post-death inventory.');
        consecutive_failures = 0;
        continue;
      }

      const state_conditioned_subgraph =
          build_state_conditioned_subgraph(graph, agent, log);
      if (state_conditioned_subgraph.status === 'complete') {
        clear_checkpoint();
        log.complete(state_conditioned_subgraph.reason);
        return;
      }

      const candidate_result = get_source_candidates(
          state_conditioned_subgraph.subgraph, graph, agent, log);
      if (candidate_result.status === 'complete') {
        clear_checkpoint();
        log.complete(candidate_result.reason);
        return;
      }

      const task = get_next_task(candidate_result.candidates, agent, log);

      if (!task) {
        spl.warn('get_next_task returned NULL; re-evaluating state...');
        if (++consecutive_failures >= max_outer_retries) break;
        continue;
      }

      if (await execute_task_action(
              task, agent, log, models.failure_replanner, graph) ===
          'success') {
        consecutive_failures = 0;
        continue;
      }

      spl.log('Task failed after max retries, re-evaluating state...');
      if (++consecutive_failures >= max_outer_retries) break;
    }
  } finally {
    bot.off('death', on_death);
  }

  spl.error('Max outer retries exceeded. Aborting.');
  log.complete('max outer retries exceeded');
}


function build_state_conditioned_subgraph(graph, agent, log) {
  const scsg_state = get_sgsg_state(agent);
  const result = compute_scsg(graph, scsg_state.inventory);

  log.scsg(
      '[deterministic]', result.r === 1 ? {...result, s: graph.sinks} : result,
      scsg_state);

  if (result.r === 2) {
    spl.log('Task complete — all sinks satisfied.');
    return {status: 'complete', reason: 'all sinks satisfied'};
  }

  const subgraph = {
    objective: graph.objective,
    sinks: result.r === 1 ? graph.sinks : result.s,
    ...result.final,
  };

  if (!subgraph.vertices?.length) {
    spl.log('Task complete — subgraph is empty.');
    return {status: 'complete', reason: 'subgraph empty'};
  }

  return {status: 'continue', subgraph};
}

// Builds executable source candidates from the remaining subgraph.
function get_source_candidates(subgraph, original_graph, agent, log) {
  const subgraph_edges = subgraph.edges ?? [];
  const subgraph_edge_set = new Set(
      subgraph_edges.map(({from, to, type}) => edge_key(from, to, type)));
  const subgraph_incoming_ids = new Set(subgraph_edges.map(({to}) => to));
  const original_vertex_map = new Map(
      (original_graph.vertices ?? []).map(vertex => [vertex.id, vertex]));
  const original_incoming = build_incoming_edge_map(original_graph.edges ?? []);
  const state = get_state_for_candidates(agent);

  const candidates = (subgraph.vertices ?? []).flatMap(subgraph_vertex => {
    if (subgraph_incoming_ids.has(subgraph_vertex.id)) return [];

    const original_vertex =
        original_vertex_map.get(subgraph_vertex.id) ?? subgraph_vertex;
    const satisfied_inputs =
        (original_incoming.get(subgraph_vertex.id) ?? [])
            .filter(edge => !edge_in_subgraph(edge, subgraph_edge_set))
            .map(({from, qty, type, consumed}) => ({
                   item: from,
                   qty,
                   type,
                   consumed,
                 }));

    return [{
      id: subgraph_vertex.id,
      qty: subgraph_vertex.qty,
      item_type: original_vertex.item_type,
      acquisition_dependency: original_vertex.acquisition_dependency,
      satisfied_inputs,
      source_hint: get_canonical_source_for_target(original_vertex.id),
      source_kind: get_source_kind_for_target(original_vertex),
      grounded_nearby_source:
          get_grounded_nearby_source(original_vertex, state),
    }];
  });

  log.candidates(candidates);

  return candidates.length ?
      {status: 'continue', candidates} :
      {status: 'complete', reason: 'no remaining source candidates'};
}

// Selects the next task deterministically.
function get_next_task(candidates, agent, log) {
  const task = select_next_task(candidates, get_state_for_candidates(agent));

  if (!task) {
    spl.warn('No task selected by get_next_task.');
    return null;
  }

  spl.log('Next task:', JSON.stringify(task));
  log.task(task);
  return task;
}

// Loads a PTD graph JSON file from disk.
async function load_graph_from_file(file_path) {
  try {
    return JSON.parse(await read_file(file_path, 'utf8'));
  } catch (error) {
    throw new Error(
        `Failed to load PTD graph from "${file_path}": ${error.message}`);
  }
}