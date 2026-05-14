import {readFile as read_file} from 'fs/promises';

import {get_nts_state as get_state_for_candidates, get_sgsg_state} from '../agent_state.js';
import {clearCheckpoint as clear_checkpoint, loadCheckpoint as load_checkpoint, saveCheckpoint as save_checkpoint, saveRuntimeState as save_runtime_state,} from '../checkpoint.js';
import {get_canonical_source_for_target, get_grounded_nearby_source, get_source_kind_for_target,} from '../mc_sources.js';
import {createRolloutLogger as create_rollout_logger} from '../rollout_logger.js';
import {compute_scsg} from '../scsg.js';
import {generate_primary_task_dag_self_refined} from '../self_refine.js';

import {execute_task_action} from './actions.js';
import {BreadcrumbTracker} from './breadcrumbs.js';
import {BREADCRUMB_LANDMARK_POOL_SIZE, BREADCRUMB_MIN_DIST, BREADCRUMB_PERIOD_MS, BREADCRUMB_RECENT_POOL_SIZE, MAX_OUTER_RETRIES,} from './config.js';
import {build_incoming_edge_map, edge_in_subgraph, edge_key,} from './graph.js';
import {make_spl} from './log.js';
import {make_fallback_acquisition_task, select_next_task, try_make_craft_task, try_make_immediate_acquisition_task, try_make_interact_task, try_make_smelt_task,} from './tasks.js';

const spl = make_spl('[SPL]');

// Runs the full structured task loop.
export async function structured_loop(models, agent, task_name, graph = null) {
  const log = create_rollout_logger(task_name);
  const bot = agent.bot;

  // This hard coded option to load a graph is intended. Do not remove.
  const load_graph = true;
  const graph_file_path =
      //    './achievement_hunter/docs/ptd_jsons/construct_one_pickaxe_one_shovel_one_axe_and_one_hoe_with_diamond.json'
      //  './achievement_hunter/docs/ptd_jsons/bake_a_cake.json';
      `./achievement_hunter/docs/ptd_jsons/get_a_lava_bucket.json`;
  // `./achievement_hunter/docs/ptd_jsons/create_an_iron_golem.json`;
  // './achievement_hunter/docs/ptd_jsons/construct_one_pickaxe_one_shovel_one_axe_and_one_hoe_with_the_same_material.json';
  //  './achievement_hunter/docs/ptd_jsons/smelt_an_iron_ingot.json';
  // './achievement_hunter/docs/ptd_jsons/cook_a_porkchop.json';
  // './achievement_hunter/docs/ptd_jsons/pick_up_a_diamond_from_the_ground.json'
  graph = load_graph ? await load_graph_from_file(graph_file_path) :
                       await generate_primary_task_dag_self_refined(
                           models, task_name, graph, log);
  if (!graph) return;

  // Track death within this SPL run. When the bot dies the server cancels all
  // actions; on the next loop iteration we wait for respawn, then let the loop
  // recompute a fresh SCSG against the post-death (empty) inventory. Death is
  // not counted as a consecutive failure — it is an external event, not a sign
  // that the loop logic is stuck.
  let death_pending = false;
  let post_respawn_promise = Promise.resolve();

  const breadcrumb_tracker = new BreadcrumbTracker(agent, {
    min_dist: BREADCRUMB_MIN_DIST,
    recent_pool_size: BREADCRUMB_RECENT_POOL_SIZE,
    landmark_pool_size: BREADCRUMB_LANDMARK_POOL_SIZE,
    period_ms: BREADCRUMB_PERIOD_MS,
    // Fires after every sample tick (cadence set by BREADCRUMB_PERIOD_MS
    // in config.js — currently 10 s) and after restore() / reset().
    // Decouples live-view + checkpoint freshness from outer-loop iteration
    // cadence, which can stall for minutes during long-running tasks
    // (e.g. a 511-radius search sweep). The rollout logger's write cache
    // skips redundant writes when the rendered markdown hasn't changed.
    on_update: list => {
      log.breadcrumbs(list);
      save_checkpoint(task_name, graph, list);
    },
  });

  // Resume exploration map from a prior checkpoint if it matches this
  // objective. Mismatched checkpoints (different rollout) are ignored.
  const prior_checkpoint = load_checkpoint();
  const prior_matches = prior_checkpoint?.objective === task_name;
  if (prior_matches && Array.isArray(prior_checkpoint.breadcrumbs)) {
    breadcrumb_tracker.restore(prior_checkpoint.breadcrumbs);
    spl.log(`Restored ${
        prior_checkpoint.breadcrumbs.length} breadcrumbs from checkpoint.`);
  }

  // Initial save covers the case where neither restore() nor the first
  // sample tick has fired yet (no matching prior checkpoint, bot still
  // spawning). on_update will subsequently refresh the checkpoint on every
  // sample.
  save_checkpoint(task_name, graph, breadcrumb_tracker.get_breadcrumbs());
  breadcrumb_tracker.start();

  // Hydrate the outer-loop failure counter from the prior checkpoint. If the
  // prior process died mid-task (active_task non-null) treat the crash as a
  // consecutive failure so crash-looping eventually trips MAX_OUTER_RETRIES
  // instead of spinning forever.
  //
  // Leave `active_task` and `active_replanner` intact — `execute_task_action`
  // and the replanners consume them on entry to restore their own counters
  // (or overwrite if the task_key has changed). Clearing here would erase the
  // crash context before the consumers could read it.
  let restored_failures = 0;
  if (prior_matches) {
    const prior_runtime = prior_checkpoint.runtime_state ?? null;
    restored_failures = prior_runtime?.outer?.consecutive_failures ?? 0;
    if (prior_runtime?.active_task != null) {
      restored_failures += 1;
      spl.warn(`Detected mid-task crash (active_task=${
          prior_runtime.active_task.key}). consecutive_failures bumped to ${
          restored_failures}.`);
    }
    save_runtime_state({outer: {consecutive_failures: restored_failures}});
  }

  // Cleared at the top of structured_loop and after the death-respawn branch
  // consumes it. Inner async loops (executeCommandWithModeRecovery's mode-
  // retry while-loop, run_search / run_breadth_first_sweep's radii loops,
  // execute_task_action's attempt loop) check this flag after each await and
  // bail with a bot_died-tagged result that bubbles up as a 'death' return,
  // so the next outer iteration enters the death_pending branch and SCSG
  // re-runs against the post-respawn (empty) inventory.
  bot._ah_death_pending = false;

  const on_death = () => {
    spl.log('Bot died — awaiting respawn to recompute SCSG.');
    death_pending = true;
    bot._ah_death_pending = true;
    // Break any in-flight pathfinder.goto so executeCommand returns promptly.
    // Best-effort: pathfinder may not exist on very early deaths, and stop()
    // is a no-op when no goal is active.
    try {
      bot.pathfinder?.stop();
    } catch {
    }
    breadcrumb_tracker.reset();
    post_respawn_promise = new Promise(
        resolve => bot.once('spawn', () => setTimeout(resolve, 500)));
  };
  bot.on('death', on_death);

  let consecutive_failures = restored_failures;
  const persist_failures = () =>
      save_runtime_state({outer: {consecutive_failures}});
  try {
    while (true) {
      if (death_pending) {
        death_pending = false;
        await post_respawn_promise;
        bot._ah_death_pending = false;
        spl.log('Respawned — recomputing SCSG with post-death inventory.');
        consecutive_failures = 0;
        persist_failures();
        continue;
      }

      const state_conditioned_subgraph =
          build_state_conditioned_subgraph(graph, agent, log);
      if (state_conditioned_subgraph.status === 'complete') {
        await clear_checkpoint();
        await log.complete(state_conditioned_subgraph.reason);
        return;
      }

      const candidate_result = get_source_candidates(
          state_conditioned_subgraph.subgraph, graph, agent, log);
      if (candidate_result.status === 'complete') {
        await clear_checkpoint();
        await log.complete(candidate_result.reason);
        return;
      }

      const task = get_next_task(candidate_result.candidates, agent, log);

      if (!task) {
        spl.warn('get_next_task returned NULL; re-evaluating state...');
        consecutive_failures += 1;
        persist_failures();
        if (consecutive_failures >= MAX_OUTER_RETRIES) break;
        continue;
      }

      const task_result = await execute_task_action(
          task, agent, log, models.failure_replanner, graph,
          models.search_replanner, breadcrumb_tracker);
      if (task_result === 'success') {
        consecutive_failures = 0;
        persist_failures();
        continue;
      }
      if (task_result === 'death') {
        // Death event already set death_pending; next iteration's top-of-loop
        // branch handles respawn + SCSG re-eval. Skip the failure bump so a
        // death near MAX_OUTER_RETRIES doesn't trip the cap.
        spl.log('Task aborted due to bot death — re-entering SCSG on respawn.');
        continue;
      }

      spl.log('Task failed after max retries, re-evaluating state...');
      consecutive_failures += 1;
      persist_failures();
      if (consecutive_failures >= MAX_OUTER_RETRIES) break;
    }
  } finally {
    bot.off('death', on_death);
    breadcrumb_tracker.stop();
  }

  spl.error('Max outer retries exceeded. Aborting.');
  await log.complete('max outer retries exceeded');
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
    // Scale consumed-edge qty by the remaining-work ratio. Satisfied inputs
    // come from the original graph (pruned edges) and otherwise carry the
    // full original recipe qty — so when SCSG reduces a sink (e.g. iron_ingot
    // 3 → 2 because inventory already has 1), the smelt task would otherwise
    // still ask for 3 raw_iron and 3 fuel. Non-quantitative dependencies
    // (workstation, tool) keep their original qty.
    const remaining_scale =
        original_vertex.qty > 0 ? subgraph_vertex.qty / original_vertex.qty : 1;
    const satisfied_inputs =
        (original_incoming.get(subgraph_vertex.id) ?? [])
            .filter(edge => !edge_in_subgraph(edge, subgraph_edge_set))
            .map(({from, qty, type, consumed}) => ({
                   item: from,
                   qty: consumed ?
                       Math.max(1, Math.ceil(qty * remaining_scale)) :
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