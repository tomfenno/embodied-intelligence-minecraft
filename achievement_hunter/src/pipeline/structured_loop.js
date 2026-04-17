import {readFile as read_file} from 'fs/promises';

import {clearCheckpoint as clear_checkpoint, saveCheckpoint as save_checkpoint,} from './checkpoint.js';
import {extract_json, save_json, to_snake_case} from './json_utils.js';
import {
  get_canonical_mob_source,
  get_canonical_source_for_target,
  get_grounded_nearby_source,
  get_source_kind_for_target,
  resolve_fallback_block_source,
  resolve_nearby_block_source,
  resolve_nearby_mob_source,
} from './mc_sources.js';
import {fill_ptd_prompt} from './prompt_utils.js';
import {createRolloutLogger as create_rollout_logger} from './rollout_logger.js';
import {compute_scsg} from './scsg.js';
import {get_nts_state as get_state_for_candidates, get_sgsg_state} from './state.js';
import {execute_task_action} from './structured_loop_actions.js';
import {
  build_incoming_edge_map,
  edge_in_subgraph,
  edge_key,
  get_satisfied_inputs_by_type,
  get_single_satisfied_input_item,
  resolve_concrete_craft_target,
} from './structured_loop_graph.js';

const max_outer_retries = 10;
const itemish_types = new Set(['item', 'tool', 'workstation']);

const spl = {
  log: (...args) => console.log('[SPL]', ...args),
  warn: (...args) => console.warn('[SPL]', ...args),
  error: (...args) => console.error('[SPL]', ...args),
};

const log_source = {
  llm: 'llm',
  deterministic: 'deterministic',
};

// Runs the full structured task loop.
async function structured_loop(models, agent, task_name, graph = null) {
  const log = create_rollout_logger(task_name);

  // This hard coded option to load a graph is intended. Do not remove.
  const load_graph = true;
  graph = load_graph ?
      await load_graph_from_file(
          './achievement_hunter/docs/ptd_jsons/cook_a_porkchop.json') :
      await generate_primary_task_dag(models.ptd, task_name, graph, log);
  if (!graph) return;

  save_checkpoint(task_name, graph);

  let consecutive_failures = 0;
  while (true) {
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

    if (await execute_task_action(task, agent, log) === 'success') {
      consecutive_failures = 0;
      continue;
    }

    spl.log('Task failed after max retries, re-evaluating state...');
    if (++consecutive_failures >= max_outer_retries) break;
  }

  spl.error('Max outer retries exceeded. Aborting.');
  log.complete('max outer retries exceeded');
}

export {structured_loop as structuredLoop};

// Builds or resumes the prerequisite task graph.
async function generate_primary_task_dag(
    model, task_name, existing_graph, log) {
  if (existing_graph) {
    spl.log('Resuming from checkpoint, skipping PTD for:', task_name);
    log.ptd('[loaded from checkpoint]', existing_graph, {source: 'checkpoint'});
    return existing_graph;
  }

  spl.log('Building PTD for:', task_name);

  const {response, latency_ms} =
      await timed_send_request(model, fill_ptd_prompt(task_name));

  if (response === null) {
    spl.error('PTD model call failed.');
    log.ptd('', null, {
      latency_ms,
      error: 'PTD model call failed',
      source: log_source.llm,
    });
    log.complete('PTD model call failed');
    return null;
  }

  const graph = extract_json(response);
  log.ptd(response, graph, {
    latency_ms,
    error: graph ? null : 'PTD extraction failed',
    source: log_source.llm,
  });

  if (!graph) {
    spl.error('Failed to extract PTD graph from LLM response.');
    log.complete('PTD extraction failed');
    return null;
  }

  save_json(
      graph,
      `achievement_hunter/docs/ptd_jsons/${to_snake_case(task_name)}.json`);
  spl.log('PTD built.');
  return graph;
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
  log.nts('[deterministic]', task, {source: log_source.deterministic});

  if (!task) {
    spl.warn('No task selected by get_next_task.');
    return null;
  }

  spl.log('Next task:', JSON.stringify(task));
  return task;
}

// Applies tiered task selection.
export function select_next_task(candidates, state) {
  for (const candidate of candidates) {
    const task =
        try_make_craft_task(candidate, state) ?? try_make_smelt_task(candidate);
    if (task) return task;
  }

  for (const candidate of candidates) {
    if (candidate.item_type !== 'resource') continue;
    const task = try_make_immediate_acquisition_task(candidate, state);
    if (task) return task;
  }

  for (const candidate of candidates) {
    if (candidate.item_type !== 'resource') continue;
    const task = make_fallback_acquisition_task(candidate, state);
    if (task) return task;
  }

  return null;
}

// Builds a craft task when inputs are already satisfied.
export function try_make_craft_task(candidate, state) {
  if (!itemish_types.has(candidate.item_type)) return null;

  const concrete_target =
      resolve_concrete_craft_target(candidate.id, state.craftable_items ?? []);
  return concrete_target ? {
    target_item: concrete_target,
    qty: candidate.qty,
    action_type: 'craft',
    parameters: {
      crafting_inputs:
          get_satisfied_inputs_by_type(candidate, 'crafting_input'),
      workstation:
          get_single_satisfied_input_item(candidate, 'workstation_dependency'),
    },
  } :
                           null;
}

// Builds a smelt task when smelting prerequisites are satisfied.
export function try_make_smelt_task(candidate) {
  if (!itemish_types.has(candidate.item_type)) return null;

  const smelting_inputs =
      get_satisfied_inputs_by_type(candidate, 'smelting_input');
  const fuel_inputs = get_satisfied_inputs_by_type(candidate, 'fuel_input');
  const workstation =
      get_single_satisfied_input_item(candidate, 'workstation_dependency');

  return smelting_inputs.length && fuel_inputs.length && workstation != null ?
      {
        target_item: candidate.id,
        qty: candidate.qty,
        action_type: 'smelt',
        parameters: {smelting_inputs, fuel_inputs, workstation},
      } :
      null;
}

// Builds an immediate nearby collect or kill task.
export function try_make_immediate_acquisition_task(candidate, state) {
  if (candidate.acquisition_dependency === 'mob') {
    const source_mob =
        resolve_nearby_mob_source(candidate, state.nearby_entities?.mobs ?? []);
    return source_mob ? {
      target_item: candidate.id,
      qty: candidate.qty,
      action_type: 'kill',
      parameters: {
        source_mob,
        weapon: get_single_satisfied_input_item(candidate, 'tool_dependency'),
      },
    } :
                        null;
  }

  const source_block =
      resolve_nearby_block_source(candidate, state.nearby_blocks ?? []);
  return source_block ? {
    target_item: candidate.id,
    qty: candidate.qty,
    action_type: 'collect',
    parameters: {
      source_block,
      item_dependency:
          get_single_satisfied_input_item(candidate, 'item_dependency'),
      tool: get_single_satisfied_input_item(candidate, 'tool_dependency'),
    },
  } :
                        null;
}

// Builds a fallback collect or kill task.
export function make_fallback_acquisition_task(candidate, state) {
  return candidate.acquisition_dependency === 'mob' ?
      {
        target_item: candidate.id,
        qty: candidate.qty,
        action_type: 'kill',
        parameters: {
          source_mob: get_canonical_mob_source(candidate.id),
          weapon: get_single_satisfied_input_item(candidate, 'tool_dependency'),
        },
      } :
      {
        target_item: candidate.id,
        qty: candidate.qty,
        action_type: 'collect',
        parameters: {
          source_block: resolve_fallback_block_source(
              candidate, state.nearby_blocks ?? []),
          item_dependency:
              get_single_satisfied_input_item(candidate, 'item_dependency'),
          tool: get_single_satisfied_input_item(candidate, 'tool_dependency'),
        },
      };
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

// Times a model request.
async function timed_send_request(model, prompt) {
  const started_ms = Date.now();
  return {
    response: await model.send_prompt(prompt),
    latency_ms: Date.now() - started_ms,
  };
}
