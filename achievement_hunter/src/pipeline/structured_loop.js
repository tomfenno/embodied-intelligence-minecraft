import {readFile as read_file} from 'fs/promises';

import {executeCommand as execute_command} from '../../../src/agent/commands/index.js';

import {clearCheckpoint as clear_checkpoint, saveCheckpoint as save_checkpoint,} from './checkpoint.js';
import {extract_json, save_json, to_snake_case} from './json_utils.js';
import {get_item_batch_size} from './mc_utils.js';
import {fill_ptd_prompt} from './prompt_utils.js';
import {createRolloutLogger as create_rollout_logger} from './rollout_logger.js';
import {ABSTRACT_CLASS_MEMBERS, compute_scsg} from './scsg.js';
import {get_am_state, get_nts_state as get_state_for_candidates, get_sgsg_state} from './state.js';

const max_inner_retries = 5;
const max_outer_retries = 10;
const search_radii = [32, 64, 128, 256, 511];
const craft_debounce_ms = 750;
const itemish_types = new Set(['item', 'tool', 'workstation']);

const spl = {
  log: (...args) => console.log('[SPL]', ...args),
  warn: (...args) => console.warn('[SPL]', ...args),
  error: (...args) => console.error('[SPL]', ...args),
};

const log_source = {
  llm: 'llm',
  search: 'search',
  deterministic: 'deterministic',
};

const any_log_search_targets = [
  'oak_log',
  'spruce_log',
  'birch_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'pale_oak_log',
];

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
function select_next_task(candidates, state) {
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
function try_make_craft_task(candidate, state) {
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
function try_make_smelt_task(candidate) {
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
function try_make_immediate_acquisition_task(candidate, state) {
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
function make_fallback_acquisition_task(candidate, state) {
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

// Mediates repeated action execution with retry handling.
async function execute_task_action(task, agent, log) {
  let repeated_failure_signature = null;
  let repeated_failure_count = 0;

  for (let attempt = 0; attempt < max_inner_retries; attempt++) {
    const state = get_am_state(agent);
    const action = mediate_action(task, state);

    log.am(attempt + 1, serialize_am_output(action), state, {
      source: log_source.deterministic,
    });

    spl.log(
        `Action (attempt ${attempt + 1}/${max_inner_retries}):`,
        serialize_am_output(action));

    if (action.kind !== 'command') {
      spl.warn('Unexpected AM action kind:', action.kind);
      continue;
    }

    const search_target = parse_search_command(action.command);
    if (search_target != null) {
      const found =
          await run_search(search_target, state, agent, log, attempt + 1);
      found ? spl.log(`Search found "${
                  search_target}", re-running AM with fresh state.`) :
              spl.warn(`Search exhausted all radii for "${
                  search_target}", re-evaluating.`);
      continue;
    }

    const result = await execute_command(agent, action.command);
    spl.log('Command result:', result);

    if (is_successful_command_result(result)) {
      repeated_failure_signature = null;
      repeated_failure_count = 0;

      if (is_craft_command(action.command)) {
        spl.log(`Craft debounce: sleeping ${
            craft_debounce_ms}ms before continuing.`);
        await sleep(craft_debounce_ms);
      }

      return 'success';
    }

    spl.warn('Command error:', result);

    const failure_signature =
        get_command_failure_signature(action.command, result);
    if (failure_signature == null) {
      repeated_failure_signature = null;
      repeated_failure_count = 0;
      continue;
    }

    if (failure_signature === repeated_failure_signature) {
      repeated_failure_count += 1;
    } else {
      repeated_failure_signature = failure_signature;
      repeated_failure_count = 1;
    }

    if (should_abort_repeated_failure(
            task, action.command, result, repeated_failure_count)) {
      spl.warn(
          `Aborting early after repeated identical failures (${
              repeated_failure_count}) for:`,
          action.command);
      return 'fail';
    }
  }

  return 'fail';
}

// Dispatches a task to the correct mediator.
function mediate_action(task, state) {
  switch (task.action_type) {
    case 'collect':
      return mediate_collect(task, state);
    case 'kill':
      return mediate_kill(task, state);
    case 'craft':
      return mediate_craft(task);
    case 'smelt':
      return mediate_smelt(task, state);
    default:
      throw new Error(`Unsupported action_type: "${task.action_type}"`);
  }
}

// Converts a collect task into a command.
function mediate_collect(task, state) {
  const {source_block, item_dependency} = task.parameters;
  const nearby_blocks = state.nearby_blocks ?? [];

  if (!nearby_blocks.includes(source_block)) {
    return {kind: 'command', command: `!search("${source_block}")`};
  }

  return item_dependency && is_environmental_use_target(source_block) ?
      {
        kind: 'command',
        command: `!useOn("${item_dependency}", "${source_block}")`,
      } :
      {
        kind: 'command',
        command: `!collectBlocks("${source_block}", ${task.qty})`,
      };
}

// Converts a kill task into a command.
function mediate_kill(task, state) {
  const {source_mob} = task.parameters;
  return (state.nearby_entities?.mobs ?? []).includes(source_mob) ?
      {
        kind: 'command',
        command: `!attack("${source_mob}")`,
      } :
      {
        kind: 'command',
        command: `!search("${source_mob}")`,
      };
}

// Converts a craft task into a command.
function mediate_craft(task) {
  const batch_size = get_item_batch_size(task.target_item);
  const crafts = batch_size > 0 ? Math.ceil(task.qty / batch_size) : task.qty;

  return {
    kind: 'command',
    command: `!craftRecipe("${task.target_item}", ${crafts})`,
  };
}

// Converts a smelt task into a command.
function mediate_smelt(task, state) {
  const smelting_input = task.parameters.smelting_inputs?.[0];
  if (!smelting_input) {
    throw new Error(
        `Smelt task missing smelting_inputs: ${JSON.stringify(task)}`);
  }

  const fuel_name = resolve_smelt_fuel_name(task, state);
  return {
    kind: 'command',
    command: fuel_name ?
        `!smelt_item("${smelting_input.item}", ${smelting_input.qty}, "${
            fuel_name}")` :
        `!smelt_item("${smelting_input.item}", ${smelting_input.qty})`,
  };
}

// Picks a concrete smelting fuel from state.
function resolve_smelt_fuel_name(task, state) {
  const fuel_input = task.parameters?.fuel_inputs?.[0];
  if (!fuel_input) return null;

  const inventory = state.inventory ?? {};
  if (!fuel_input.item.startsWith('any_')) {
    return inventory[fuel_input.item] > 0 ? fuel_input.item : null;
  }

  for (const member of ABSTRACT_CLASS_MEMBERS[fuel_input.item] ?? []) {
    if ((inventory[member] ?? 0) > 0) return member;
  }
  return null;
}

// Serializes mediator output for logging.
function serialize_am_output(action) {
  return action.kind === 'task_complete' ? '{"status":"TASK_COMPLETE"}' :
      action.kind === 'command'          ? action.command :
                                           JSON.stringify(action);
}

// Times a model request.
async function timed_send_request(model, prompt) {
  const started_ms = Date.now();
  return {
    response: await model.send_prompt(prompt),
    latency_ms: Date.now() - started_ms,
  };
}

// Parses a synthetic search command.
function parse_search_command(action) {
  const match = action.trim().match(/^!search\("([^"]+)"\)$/);
  return match?.[1] ?? null;
}

// Runs expanding-radius search commands.
async function run_search(target, state, agent, log, start_attempt) {
  const concrete_items = expand_search_item(target);
  for (const item of concrete_items) {
    if (check_search_complete(item, state)) {
      spl.log(`Search fast-path: "${item}" already in state.`);
      return true;
    }
  }

  let attempt = start_attempt;
  for (const radius of search_radii) {
    for (const item of concrete_items) {
      const command = make_search_command(item, radius);
      log.am(++attempt, command, null, {source: log_source.search});
      if (await execute_search_command(agent, item, radius, command))
        return true;
    }
  }

  return false;
}

// Executes one concrete search command.
async function execute_search_command(agent, item, radius, command) {
  spl.log(`Search (${item} r=${radius}):`, command);
  const result = await execute_command(agent, command);
  spl.log('Search result:', result);

  const found = typeof result !== 'string' ||
      (result.startsWith('Action output:') &&
       !result.includes('Could not find'));

  found ? spl.log(`Search succeeded: "${item}" at radius ${radius}.`) :
          spl.warn(`Search failed: "${item}" at radius ${radius}.`);
  return found;
}

// Expands abstract search targets into concrete items.
function expand_search_item(item) {
  if (item === 'any_log') return any_log_search_targets;
  if (item.startsWith('any_')) {
    throw new Error(`Unsupported abstract search target: "${
        item}". Add an expansion to expand_search_item.`);
  }
  return [item];
}

const mob_search_targets = new Set([
  'skeleton',
  'stray',
  'wither_skeleton',
  'zombie',
  'zombie_villager',
  'drowned',
  'husk',
  'zombified_piglin',
  'creeper',
  'spider',
  'cave_spider',
  'enderman',
  'witch',
  'slime',
  'magma_cube',
  'blaze',
  'ghast',
  'phantom',
  'silverfish',
  'shulker',
  'guardian',
  'elder_guardian',
  'vindicator',
  'evoker',
  'pillager',
  'ravager',
  'cow',
  'mooshroom',
  'sheep',
  'pig',
  'chicken',
  'rabbit',
  'squid',
  'glow_squid',
  'fox',
  'wolf',
  'llama',
  'trader_llama',
  'horse',
  'donkey',
  'mule',
  'bee',
  'panda',
  'polar_bear',
  'turtle',
  'axolotl',
  'goat',
  'frog',
  'sniffer',
  'armadillo',
]);

// Checks whether a search target is an entity.
function is_entity_target(target) {
  return mob_search_targets.has(target);
}

// Checks whether a search target is already nearby.
function check_search_complete(target, state) {
  return is_entity_target(target) ?
      (state.nearby_entities?.mobs?.includes(target) ?? false) :
      (state.nearby_blocks?.includes(target) ?? false);
}

// Builds the appropriate search command for a target.
function make_search_command(target, radius) {
  return is_entity_target(target) ? `!searchForEntity("${target}", ${radius})` :
                                    `!searchForBlock("${target}", ${radius})`;
}

export {is_entity_target, check_search_complete, make_search_command};

// Builds a map of incoming edges by target id.
function build_incoming_edge_map(edges) {
  const incoming_edge_map = new Map();
  for (const edge of edges) {
    const incoming = incoming_edge_map.get(edge.to);
    incoming ? incoming.push(edge) : incoming_edge_map.set(edge.to, [edge]);
  }
  return incoming_edge_map;
}

// Creates a stable edge identity key.
function edge_key(from, to, type) {
  return `${from}→${to}→${type}`;
}

// Checks whether an edge remains in the subgraph.
function edge_in_subgraph(edge, subgraph_edge_set) {
  return subgraph_edge_set.has(edge_key(edge.from, edge.to, edge.type));
}

// Collects satisfied inputs of a given dependency type.
function get_satisfied_inputs_by_type(candidate, type) {
  return (candidate.satisfied_inputs ?? [])
      .filter(input => input.type === type)
      .map(({item, qty}) => ({item, qty}));
}

// Returns a single satisfied input item of a given type.
function get_single_satisfied_input_item(candidate, type) {
  return (candidate.satisfied_inputs ?? [])
             .find(input => input.type === type)
             ?.item ??
      null;
}

// Resolves an abstract craft target into a concrete craftable item.
function resolve_concrete_craft_target(candidate_id, craftable_items) {
  if (!candidate_id.startsWith('any_')) {
    return craftable_items.includes(candidate_id) ? candidate_id : null;
  }

  const members = ABSTRACT_CLASS_MEMBERS[candidate_id] ?? [];
  for (const item of craftable_items) {
    if (members.includes(item)) return item;
  }
  return null;
}

// Resolves a nearby concrete block source for a candidate.
function resolve_nearby_block_source(candidate, nearby_blocks) {
  if (candidate.id === 'water_bucket') {
    return nearby_blocks.includes('water') ? 'water' : null;
  }
  if (candidate.id === 'lava_bucket') {
    return nearby_blocks.includes('lava') ? 'lava' : null;
  }

  if (candidate.id.startsWith('any_')) {
    const members = candidate.id === 'any_log' ?
        any_log_search_targets :
        (ABSTRACT_CLASS_MEMBERS[candidate.id] ?? []);
    return members.find(block => nearby_blocks.includes(block)) ?? null;
  }

  const canonical = get_canonical_block_source(candidate.id);
  return canonical && nearby_blocks.includes(canonical) ? canonical :
      nearby_blocks.includes(candidate.id)              ? candidate.id :
                                                          null;
}

// Resolves a fallback block source when nothing is nearby.
function resolve_fallback_block_source(candidate, nearby_blocks) {
  if (candidate.id === 'water_bucket') return 'water';
  if (candidate.id === 'lava_bucket') return 'lava';
  return candidate.id.startsWith('any_') ?
      (resolve_nearby_block_source(candidate, nearby_blocks) ?? candidate.id) :
      (get_canonical_block_source(candidate.id) ?? candidate.id);
}

// Resolves a nearby concrete mob source for a candidate.
function resolve_nearby_mob_source(candidate, nearby_mobs) {
  const canonical = get_canonical_mob_source(candidate.id);
  return canonical && nearby_mobs.includes(canonical) ? canonical : null;
}

// Resolves the best grounded nearby source for a vertex.
function get_grounded_nearby_source(vertex, state) {
  return vertex.acquisition_dependency === 'mob' ?
      resolve_nearby_mob_source(vertex, state.nearby_entities?.mobs ?? []) :
      resolve_nearby_block_source(vertex, state.nearby_blocks ?? []);
}

// Returns the source kind for a target vertex.
function get_source_kind_for_target(vertex) {
  return vertex.acquisition_dependency === 'mob' ? 'mob' : 'block';
}

// Returns the canonical source for a target id.
function get_canonical_source_for_target(target_id) {
  return get_canonical_mob_source(target_id) ??
      get_canonical_block_source(target_id);
}

// Checks whether a block requires environmental use.
function is_environmental_use_target(source_block) {
  return source_block === 'water' || source_block === 'lava';
}

// Resolves the canonical block source for a target item.
function get_canonical_block_source(target_id) {
  const explicit = canonical_block_source_by_target[target_id];
  if (explicit) return explicit;
  if (target_id.endsWith('_log')) return target_id;
  return target_id.endsWith('_planks') ? target_id.replace(/_planks$/, '_log') :
                                         null;
}

// Resolves the canonical mob source for a target item.
function get_canonical_mob_source(target_id) {
  return canonical_mob_source_by_target[target_id] ?? null;
}

const canonical_block_source_by_target = {
  any_log: 'any_log',
  oak_log: 'oak_log',
  spruce_log: 'spruce_log',
  birch_log: 'birch_log',
  jungle_log: 'jungle_log',
  acacia_log: 'acacia_log',
  dark_oak_log: 'dark_oak_log',
  mangrove_log: 'mangrove_log',
  cherry_log: 'cherry_log',
  pale_oak_log: 'pale_oak_log',

  cobblestone: 'stone',
  coal: 'coal_ore',
  raw_iron: 'iron_ore',
  raw_gold: 'gold_ore',
  redstone: 'redstone_ore',
  diamond: 'diamond_ore',
  lapis_lazuli: 'lapis_ore',
  emerald: 'emerald_ore',
  obsidian: 'lava',
  flint: 'gravel',

  sand: 'sand',
  clay_ball: 'clay',
  sugar_cane: 'sugar_cane',
  wheat: 'wheat',
  pumpkin: 'pumpkin',
  melon_slice: 'melon',
  cactus: 'cactus',
  kelp: 'kelp',
  bamboo: 'bamboo',
};

const canonical_mob_source_by_target = {
  bone: 'skeleton',
  arrow: 'skeleton',
  gunpowder: 'creeper',
  string: 'spider',
  spider_eye: 'spider',
  rotten_flesh: 'zombie',
  ender_pearl: 'enderman',
  blaze_rod: 'blaze',
  ghast_tear: 'ghast',
  slime_ball: 'slime',
  magma_cream: 'magma_cube',
  phantom_membrane: 'phantom',
  ink_sac: 'squid',
  glow_ink_sac: 'glow_squid',
  leather: 'cow',
  beef: 'cow',
  mutton: 'sheep',
  wool: 'sheep',
  porkchop: 'pig',
  chicken: 'chicken',
  rabbit_hide: 'rabbit',
  rabbit: 'rabbit',
};

// Loads a PTD graph JSON file from disk.
async function load_graph_from_file(file_path) {
  try {
    return JSON.parse(await read_file(file_path, 'utf8'));
  } catch (error) {
    throw new Error(
        `Failed to load PTD graph from "${file_path}": ${error.message}`);
  }
}

// Checks whether a command result counts as success.
function is_successful_command_result(result) {
  return typeof result !== 'string' ||
      (result.startsWith('Action output:') &&
       !result.includes('!!Code threw exception!!') &&
       !result.includes('Error:') && !result.includes('Could not find'));
}

// Builds a normalized signature for repeated failures.
function get_command_failure_signature(command, result) {
  return typeof result === 'string' && !is_successful_command_result(result) ?
      `${command} || ${
          result.replace(/\d+ms/g, '<TIMEOUT>').replace(/\s+/g, ' ').trim()}` :
      null;
}

// Decides whether repeated failures should abort early.
function should_abort_repeated_failure(task, command, result, repeated_count) {
  if (typeof result !== 'string') return false;
  return command.startsWith('!craftRecipe(') &&
      result.includes('Event updateSlot:0 did not fire within timeout') &&
      repeated_count >= 2;
}

// Sleeps for a fixed duration.
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Checks whether a command is craft-like for debounce purposes.
function is_craft_command(command) {
  return typeof command === 'string' &&
      (command.startsWith('!craftRecipe(') ||
       command.startsWith('!smeltItem(') || command.startsWith('!smelt_item('));
}

export {
  parse_search_command,
  expand_search_item,
  is_successful_command_result,
  get_command_failure_signature,
  should_abort_repeated_failure,
  is_craft_command,
  is_environmental_use_target,
  get_canonical_block_source,
  get_canonical_mob_source,
  resolve_nearby_block_source,
  resolve_fallback_block_source,
  resolve_nearby_mob_source,
  build_incoming_edge_map,
  edge_key,
  edge_in_subgraph,
  get_satisfied_inputs_by_type,
  get_single_satisfied_input_item,
  resolve_concrete_craft_target,
  try_make_craft_task,
  try_make_smelt_task,
  try_make_immediate_acquisition_task,
  make_fallback_acquisition_task,
  select_next_task,
  mediate_collect,
  mediate_kill,
  mediate_craft,
  mediate_smelt,
  resolve_smelt_fuel_name,
};