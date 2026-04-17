import {readFile} from 'fs/promises';

import {executeCommand} from '../../../src/agent/commands/index.js';

import {clearCheckpoint, saveCheckpoint} from './checkpoint.js';
import {extract_json, save_json, to_snake_case} from './json_utils.js';
import {get_item_batch_size} from './mc_utils.js';
import {fill_ptd_prompt} from './prompt_utils.js';
import {createRolloutLogger} from './rollout_logger.js';
import {ABSTRACT_CLASS_MEMBERS, compute_scsg} from './scsg.js';
import {get_am_state, get_nts_state, get_sgsg_state} from './state.js';

const MAX_INNER_RETRIES = 5;
const MAX_OUTER_RETRIES = 10;
const SEARCH_RADII = [32, 64, 128, 256, 511];
const CRAFT_DEBOUNCE_MS = 750;

const spl = {
  log: (...args) => console.log('[SPL]', ...args),
  warn: (...args) => console.warn('[SPL]', ...args),
  error: (...args) => console.error('[SPL]', ...args),
};

const LOG_SOURCE = {
  LLM: 'llm',
  SEARCH: 'search',
  DETERMINISTIC: 'deterministic',
};

// Overworld log blocks for Java Edition 1.21.6.
const ANY_LOG_SEARCH_TARGETS = [
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

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the Structured Prompting Loop for a primary task T.
 *
 * Flow:
 *   1. PTD  — build a full prerequisite dependency graph for T
 *   2. SCSG — prune the graph to what is still needed given current inventory
 *   3. NTS  — deterministically pick the next immediate task from the pruned
 * graph
 *   4. AM   — deterministically convert that task into a bot command and
 * execute it
 *             (!search(target) responses are intercepted and run as hardcoded
 *             searches; all other commands go to executeCommand)
 *          Repeat from (2) until the SCSG signals all sinks are satisfied.
 *
 * @param {{
 *   ptd: {send_prompt: function(string): Promise<string|null>}
 * }} models
 * @param {object} agent
 * @param {string} T
 * @param {object|null} [G]
 */
export async function structuredLoop(models, agent, T, G = null) {
  const log = createRolloutLogger(T);

  // ── Phase 1: PTD ───────────────────────────────────────────────────────────
  // G = await run_ptd(models.ptd, T, G, log)
  G = await loadGraphFromFile(
      './achievement_hunter/docs/ptd_jsons/cook_a_porkchop.json');

  if (!G) return;

  saveCheckpoint(T, G);

  // ── Phase 2+: Outer Loop ───────────────────────────────────────────────────
  let consecutive_failures = 0;

  while (true) {
    const scsg = run_scsg(G, agent, log);
    if (scsg.status === 'complete') {
      clearCheckpoint();
      log.complete(scsg.reason);
      return;
    }

    const task = run_nts_deterministic(scsg.candidates, agent, log);
    if (!task) {
      spl.warn(
          'Deterministic NTS could not select a task; re-evaluating state...');
      if (++consecutive_failures >= MAX_OUTER_RETRIES) break;
      continue;
    }

    const am_status = await run_am_deterministic(task, agent, log);
    if (am_status === 'success') {
      consecutive_failures = 0;
    } else {
      spl.log('Task failed after max retries, re-evaluating state...');
      if (++consecutive_failures >= MAX_OUTER_RETRIES) break;
    }
  }

  spl.error('Max outer retries exceeded. Aborting.');
  log.complete('max outer retries exceeded');
}

// ─────────────────────────────────────────────────────────────────────────────
// PTD
// ─────────────────────────────────────────────────────────────────────────────

async function run_ptd(model, T, existing_G, log) {
  if (existing_G) {
    spl.log('Resuming from checkpoint, skipping PTD for:', T);
    log.ptd('[loaded from checkpoint]', existing_G, {source: 'checkpoint'});
    return existing_G;
  }

  spl.log('Building PTD for:', T);

  const {response, latency_ms} =
      await timed_send_request(model, fill_ptd_prompt(T));

  if (response === null) {
    spl.error('PTD model call failed.');
    log.ptd('', null, {
      latency_ms,
      error: 'PTD model call failed',
      source: LOG_SOURCE.LLM,
    });
    log.complete('PTD model call failed');
    return null;
  }

  const G = extract_json(response);
  log.ptd(response, G, {
    latency_ms,
    error: G ? null : 'PTD extraction failed',
    source: LOG_SOURCE.LLM,
  });

  if (!G) {
    spl.error('Failed to extract PTD graph from LLM response.');
    log.complete('PTD extraction failed');
    return null;
  }

  const file_path =
      'achievement_hunter/docs/ptd_jsons/' + to_snake_case(T) + '.json';
  save_json(G, file_path);

  spl.log('PTD built.');
  return G;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCSG + candidate construction
// ─────────────────────────────────────────────────────────────────────────────

function run_scsg(G, agent, log) {
  const scsg_state = get_sgsg_state(agent);
  const result = compute_scsg(G, scsg_state.inventory);

  log.scsg(
      '[deterministic]', result.r === 1 ? {...result, s: G.sinks} : result,
      scsg_state);

  if (result.r === 2) {
    spl.log('Task complete — all sinks satisfied.');
    return {status: 'complete', reason: 'all sinks satisfied'};
  }

  const subgraph = {
    objective: G.objective,
    sinks: result.r === 1 ? G.sinks : result.s,
    ...result.final,
  };

  if (!subgraph.vertices || subgraph.vertices.length === 0) {
    spl.log('Task complete — subgraph is empty.');
    return {status: 'complete', reason: 'subgraph empty'};
  }

  const nts_state = get_nts_state(agent);
  const candidates = build_candidates(subgraph, G, nts_state);
  log.candidates(candidates);

  if (candidates.length === 0) {
    return {status: 'complete', reason: 'no remaining source candidates'};
  }

  return {status: 'continue', candidates};
}

/**
 * Deterministically builds the ordered candidate set expected by NTS.
 *
 * A candidate is a remaining "source" vertex in the pruned graph:
 * - or a vertex whose remaining prerequisites are all already satisfied by
 * state
 *
 * Each candidate is enriched with:
 * - vertex metadata
 * - satisfied local dependencies derived from the original PTD edges + current
 * state
 *
 * The resulting objects are self-sufficient for deterministic NTS.
 */
function build_candidates(subgraph, originalGraph, state) {
  const subgraphEdgeSet =
      new Set((subgraph.edges ?? []).map(e => edge_key(e.from, e.to, e.type)));
  const subgraphIncomingIds = new Set((subgraph.edges ?? []).map(e => e.to));

  const originalVertexMap =
      new Map((originalGraph.vertices ?? []).map(v => [v.id, v]));
  const originalIncoming = build_incoming_edge_map(originalGraph.edges ?? []);

  const candidates = [];
  for (const subVertex of subgraph.vertices ?? []) {
    // Candidates are ONLY source nodes of the current SCSG:
    // vertices with no incoming edges in the remaining subgraph.
    const isSourceNode = !subgraphIncomingIds.has(subVertex.id);
    if (!isSourceNode) continue;

    const originalVertex = originalVertexMap.get(subVertex.id) ?? subVertex;
    const incoming = originalIncoming.get(subVertex.id) ?? [];

    const satisfied_inputs =
        incoming.filter(e => !_edge_in_subgraph(e, subgraphEdgeSet))
            .map(e => ({
                   item: e.from,
                   qty: e.qty,
                   type: e.type,
                   consumed: e.consumed,
                 }));

    candidates.push({
      id: subVertex.id,
      qty: subVertex.qty,
      item_type: originalVertex.item_type,
      acquisition_dependency: originalVertex.acquisition_dependency,
      satisfied_inputs,
      source_hint: get_canonical_source_for_target(originalVertex.id),
      source_kind: get_source_kind_for_target(originalVertex),
      grounded_nearby_source: get_grounded_nearby_source(originalVertex, state),
    });
  }

  return candidates;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic NTS
// ─────────────────────────────────────────────────────────────────────────────

function run_nts_deterministic(candidates, agent, log) {
  const state = get_nts_state(agent);
  const task = select_next_task(candidates, state);

  log.nts('[deterministic]', task, {source: LOG_SOURCE.DETERMINISTIC});

  if (!task) {
    spl.warn('No deterministic NTS task selected.');
    return null;
  }

  spl.log('Next task:', JSON.stringify(task));
  return task;
}

function select_next_task(candidates, state) {
  // Tier 1: craft or smelt
  for (const candidate of candidates) {
    const craftTask = maybe_make_craft_task(candidate, state);
    if (craftTask) return craftTask;

    const smeltTask = maybe_make_smelt_task(candidate);
    if (smeltTask) return smeltTask;
  }

  // Tier 2: immediate collect or kill
  for (const candidate of candidates) {
    if (candidate.item_type !== 'resource') continue;

    const immediateTask =
        maybe_make_immediate_acquisition_task(candidate, state);
    if (immediateTask) return immediateTask;
  }

  // Tier 3: fallback collect or kill
  for (const candidate of candidates) {
    if (candidate.item_type !== 'resource') continue;

    const fallbackTask = make_fallback_acquisition_task(candidate, state);
    if (fallbackTask) return fallbackTask;
  }

  return null;
}

function maybe_make_craft_task(candidate, state) {
  // Candidates with item_type in {item, tool, workstation} are selectable
  // only in Tier 1.
  if (!['item', 'tool', 'workstation'].includes(candidate.item_type)) {
    return null;
  }

  const concreteCraftableTarget =
      resolve_concrete_craft_target(candidate.id, state.craftable_items ?? []);

  if (!concreteCraftableTarget) return null;

  return {
    target_item: concreteCraftableTarget,
    qty: candidate.qty,
    action_type: 'craft',
    parameters: {
      crafting_inputs:
          get_satisfied_inputs_by_type(candidate, 'crafting_input'),
      workstation:
          get_single_satisfied_input_item(candidate, 'workstation_dependency'),
    },
  };
}

function maybe_make_smelt_task(candidate) {
  // Tier 1 only.
  if (!['item', 'tool', 'workstation'].includes(candidate.item_type)) {
    return null;
  }

  const smelting_inputs =
      get_satisfied_inputs_by_type(candidate, 'smelting_input');
  const fuel_inputs = get_satisfied_inputs_by_type(candidate, 'fuel_input');
  const workstation =
      get_single_satisfied_input_item(candidate, 'workstation_dependency');

  if (smelting_inputs.length === 0 || fuel_inputs.length === 0 ||
      workstation == null) {
    return null;
  }

  return {
    target_item: candidate.id,
    qty: candidate.qty,
    action_type: 'smelt',
    parameters: {
      smelting_inputs,
      fuel_inputs,
      workstation,
    },
  };
}

function maybe_make_immediate_acquisition_task(candidate, state) {
  if (candidate.acquisition_dependency === 'mob') {
    const source_mob =
        resolve_nearby_mob_source(candidate, state.nearby_entities?.mobs ?? []);
    if (!source_mob) return null;

    return {
      target_item: candidate.id,
      qty: candidate.qty,
      action_type: 'kill',
      parameters: {
        source_mob,
        weapon: get_single_satisfied_input_item(candidate, 'tool_dependency'),
      },
    };
  }

  const source_block =
      resolve_nearby_block_source(candidate, state.nearby_blocks ?? []);
  if (!source_block) return null;

  return {
    target_item: candidate.id,
    qty: candidate.qty,
    action_type: 'collect',
    parameters: {
      source_block,
      item_dependency:
          get_single_satisfied_input_item(candidate, 'item_dependency'),
      tool: get_single_satisfied_input_item(candidate, 'tool_dependency'),
    },
  };
}

function make_fallback_acquisition_task(candidate, state) {
  if (candidate.acquisition_dependency === 'mob') {
    return {
      target_item: candidate.id,
      qty: candidate.qty,
      action_type: 'kill',
      parameters: {
        source_mob: get_canonical_mob_source(candidate.id),
        weapon: get_single_satisfied_input_item(candidate, 'tool_dependency'),
      },
    };
  }

  return {
    target_item: candidate.id,
    qty: candidate.qty,
    action_type: 'collect',
    parameters: {
      source_block:
          resolve_fallback_block_source(candidate, state.nearby_blocks ?? []),
      item_dependency:
          get_single_satisfied_input_item(candidate, 'item_dependency'),
      tool: get_single_satisfied_input_item(candidate, 'tool_dependency'),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic AM
// ─────────────────────────────────────────────────────────────────────────────

async function run_am_deterministic(task, agent, log) {
  let repeated_failure_signature = null;
  let repeated_failure_count = 0;

  for (let attempt = 0; attempt < MAX_INNER_RETRIES; attempt++) {
    const state = get_am_state(agent);
    const action = mediate_action(task, state);

    log.am(attempt + 1, serialize_am_output(action), state, {
      source: LOG_SOURCE.DETERMINISTIC,
    });

    spl.log(
        `Action (attempt ${attempt + 1}/${MAX_INNER_RETRIES}):`,
        serialize_am_output(action));

    if (action.kind !== 'command') {
      spl.warn('Unexpected AM action kind:', action.kind);
      continue;
    }

    const search_target = _parse_search_command(action.command);
    if (search_target !== null) {
      const found =
          await _run_search(search_target, state, agent, log, attempt + 1);
      found ? spl.log(`Search found "${
                  search_target}", re-running AM with fresh state.`) :
              spl.warn(`Search exhausted all radii for "${
                  search_target}", re-evaluating.`);
      continue;
    }

    const result = await executeCommand(agent, action.command);
    spl.log('Command result:', result);

    if (_is_successful_command_result(result)) {
      repeated_failure_signature = null;
      repeated_failure_count = 0;

      if (_is_craft_command(action.command)) {
        spl.log(`Craft debounce: sleeping ${
            CRAFT_DEBOUNCE_MS}ms before continuing.`);
        await _sleep(CRAFT_DEBOUNCE_MS);
      }

      return 'success';
    }

    spl.warn('Command error:', result);

    const failure_signature =
        _get_command_failure_signature(action.command, result);
    if (failure_signature !== null) {
      if (failure_signature === repeated_failure_signature) {
        repeated_failure_count += 1;
      } else {
        repeated_failure_signature = failure_signature;
        repeated_failure_count = 1;
      }

      if (_should_abort_repeated_failure(
              task, action.command, result, repeated_failure_count)) {
        spl.warn(
            `Aborting early after repeated identical failures (${
                repeated_failure_count}) for:`,
            action.command);
        return 'fail';
      }
    } else {
      repeated_failure_signature = null;
      repeated_failure_count = 0;
    }
  }

  return 'fail';
}

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

function mediate_collect(task, state) {
  const {source_block, item_dependency} = task.parameters;

  const nearbyBlocks = state.nearby_blocks ?? [];
  const immediatelyExecutable = nearbyBlocks.includes(source_block);

  if (!immediatelyExecutable) {
    return {kind: 'command', command: `!search("${source_block}")`};
  }

  if (item_dependency && is_environmental_use_target(source_block)) {
    return {
      kind: 'command',
      command: `!useOn("${item_dependency}", "${source_block}")`,
    };
  }

  return {
    kind: 'command',
    command: `!collectBlocks("${source_block}", ${task.qty})`,
  };
}

function mediate_kill(task, state) {
  const {source_mob} = task.parameters;
  const nearbyMobs = state.nearby_entities?.mobs ?? [];

  if (!nearbyMobs.includes(source_mob)) {
    return {kind: 'command', command: `!search("${source_mob}")`};
  }

  return {
    kind: 'command',
    command: `!attack("${source_mob}")`,
  };
}

function mediate_craft(task) {
  const batchSize = get_item_batch_size(task.target_item);
  const crafts =
      batchSize && batchSize > 0 ? Math.ceil(task.qty / batchSize) : task.qty;

  return {
    kind: 'command',
    command: `!craftRecipe("${task.target_item}", ${crafts})`,
  };
}

function mediate_smelt(task, state) {
  const firstSmeltingInput = task.parameters.smelting_inputs?.[0];
  if (!firstSmeltingInput) {
    throw new Error(
        `Smelt task missing smelting_inputs: ${JSON.stringify(task)}`);
  }

  const fuelName = _resolve_smelt_fuel_name(task, state);

  return {
    kind: 'command',
    command: fuelName ?
        `!smelt_item("${firstSmeltingInput.item}", ${
            firstSmeltingInput.qty}, "${fuelName}")` :
        `!smelt_item("${firstSmeltingInput.item}", ${firstSmeltingInput.qty})`,
  };
}

function _resolve_smelt_fuel_name(task, state) {
  const fuelInput = task.parameters?.fuel_inputs?.[0];
  if (!fuelInput) return null;

  const inventory = state.inventory ?? {};
  const fuelId = fuelInput.item;

  // Concrete fuel item already specified.
  if (!fuelId.startsWith('any_')) {
    return inventory[fuelId] > 0 ? fuelId : null;
  }

  // Abstract class fuel: choose a concrete inventory member.
  const members = ABSTRACT_CLASS_MEMBERS[fuelId] ?? [];
  for (const member of members) {
    if ((inventory[member] ?? 0) > 0) return member;
  }

  return null;
}

function serialize_am_output(action) {
  if (action.kind === 'task_complete') return '{"status":"TASK_COMPLETE"}';
  if (action.kind === 'command') return action.command;
  return JSON.stringify(action);
}

// ─────────────────────────────────────────────────────────────────────────────
// Timing
// ─────────────────────────────────────────────────────────────────────────────

async function timed_send_request(model, prompt) {
  const started_ms = Date.now();
  const response = await model.send_prompt(prompt);

  return {
    response,
    latency_ms: Date.now() - started_ms,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Task completion
// ─────────────────────────────────────────────────────────────────────────────

function _task_complete(task, state) {
  const {target_item, qty} = task;
  if (!target_item || qty == null) return false;

  const inventory = state.inventory ?? {};

  if (target_item.startsWith('any_')) {
    const members = ABSTRACT_CLASS_MEMBERS[target_item] ?? [];
    const total = members.reduce((sum, id) => sum + (inventory[id] ?? 0), 0);
    return total >= qty;
  }

  return (inventory[target_item] ?? 0) >= qty;
}

function _handle_task_complete_signal(task, agent, log) {
  const fresh_state = get_am_state(agent);
  if (!_task_complete(task, fresh_state)) {
    const label = task.target_item ?? task.action_type;
    const inv = JSON.stringify(fresh_state.inventory);
    spl.warn(
        'AM claimed TASK_COMPLETE but inventory check disagrees:', label,
        '| inventory:', inv);
    log.am_warn(
        `TASK_COMPLETE claimed but inventory disagrees — ${label}: ${inv}`);
  }

  spl.log(
      'AM reports task already complete:',
      task.target_item ?? task.action_type);
  return 'success';
}

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

function _parse_search_command(action) {
  const match = action.trim().match(/^!search\("([^"]+)"\)$/);
  return match ? match[1] : null;
}

async function _run_search(target, state, agent, log, start_attempt) {
  const concrete_items = expand_search_item(target);

  for (const item of concrete_items) {
    if (check_search_complete(item, state)) {
      spl.log(`Search fast-path: "${item}" already in state.`);
      return true;
    }
  }

  let attempt = start_attempt;
  for (const radius of SEARCH_RADII) {
    for (const item of concrete_items) {
      const command = make_search_command(item, radius);
      log.am(++attempt, command, null, {source: LOG_SOURCE.SEARCH});

      if (await _execute_search_command(agent, item, radius, command)) {
        return true;
      }
    }
  }

  return false;
}

async function _execute_search_command(agent, item, radius, command) {
  spl.log(`Search (${item} r=${radius}):`, command);
  const result = await executeCommand(agent, command);
  spl.log('Search result:', result);

  const found = typeof result !== 'string' ||
      (result.startsWith('Action output:') &&
       !result.includes('Could not find'));

  found ? spl.log(`Search succeeded: "${item}" at radius ${radius}.`) :
          spl.warn(`Search failed: "${item}" at radius ${radius}.`);

  return found;
}

function expand_search_item(item) {
  if (item === 'any_log') return ANY_LOG_SEARCH_TARGETS;
  if (item.startsWith('any_')) {
    throw new Error(
        `Unsupported abstract search target: "${item}". ` +
        'Add an expansion to expand_search_item.');
  }
  return [item];
}

const MOB_SEARCH_TARGETS = new Set([
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

export function is_entity_target(target) {
  return MOB_SEARCH_TARGETS.has(target);
}

export function check_search_complete(target, state) {
  if (is_entity_target(target)) {
    return state.nearby_entities?.mobs?.includes(target) ?? false;
  }
  return state.nearby_blocks?.includes(target) ?? false;
}

export function make_search_command(target, radius) {
  if (is_entity_target(target)) {
    return `!searchForEntity("${target}", ${radius})`;
  }
  return `!searchForBlock("${target}", ${radius})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate / source helpers
// ─────────────────────────────────────────────────────────────────────────────

function get_sink_ids(G) {
  const hasOutgoing = new Set((G.edges ?? []).map(e => e.from));
  return (G.vertices ?? []).filter(v => !hasOutgoing.has(v.id)).map(v => v.id);
}

function build_incoming_edge_map(edges) {
  const m = new Map();
  for (const e of edges) {
    if (!m.has(e.to)) m.set(e.to, []);
    m.get(e.to).push(e);
  }
  return m;
}

function edge_key(from, to, type) {
  return `${from}→${to}→${type}`;
}

function _edge_in_subgraph(edge, subgraphEdgeSet) {
  return subgraphEdgeSet.has(edge_key(edge.from, edge.to, edge.type));
}

function get_satisfied_inputs_by_type(candidate, type) {
  return (candidate.satisfied_inputs ?? [])
      .filter(i => i.type === type)
      .map(i => ({item: i.item, qty: i.qty}));
}

function get_single_satisfied_input_item(candidate, type) {
  const match = (candidate.satisfied_inputs ?? []).find(i => i.type === type);
  return match ? match.item : null;
}

function resolve_concrete_craft_target(candidateId, craftableItems) {
  if (!candidateId.startsWith('any_')) {
    return craftableItems.includes(candidateId) ? candidateId : null;
  }

  const members = ABSTRACT_CLASS_MEMBERS[candidateId] ?? [];
  for (const item of craftableItems) {
    if (members.includes(item)) return item;
  }

  return null;
}

function resolve_nearby_block_source(candidate, nearbyBlocks) {
  // Special cases from the prompt.
  if (candidate.id === 'water_bucket') {
    return nearbyBlocks.includes('water') ? 'water' : null;
  }
  if (candidate.id === 'lava_bucket') {
    return nearbyBlocks.includes('lava') ? 'lava' : null;
  }

  if (candidate.id.startsWith('any_')) {
    if (candidate.id === 'any_log') {
      const nearbyConcrete =
          ANY_LOG_SEARCH_TARGETS.find(b => nearbyBlocks.includes(b));
      return nearbyConcrete ?? null;
    }

    const members = ABSTRACT_CLASS_MEMBERS[candidate.id] ?? [];
    const nearbyConcrete = members.find(b => nearbyBlocks.includes(b));
    return nearbyConcrete ?? null;
  }

  const canonical = get_canonical_block_source(candidate.id);
  if (canonical && nearbyBlocks.includes(canonical)) return canonical;

  return nearbyBlocks.includes(candidate.id) ? candidate.id : null;
}

function resolve_fallback_block_source(candidate, nearbyBlocks) {
  if (candidate.id === 'water_bucket') return 'water';
  if (candidate.id === 'lava_bucket') return 'lava';

  if (candidate.id.startsWith('any_')) {
    const grounded = resolve_nearby_block_source(candidate, nearbyBlocks);
    return grounded ?? candidate.id;
  }

  return get_canonical_block_source(candidate.id) ?? candidate.id;
}

function resolve_nearby_mob_source(candidate, nearbyMobs) {
  const canonical = get_canonical_mob_source(candidate.id);
  return canonical && nearbyMobs.includes(canonical) ? canonical : null;
}

function get_grounded_nearby_source(vertex, state) {
  if (vertex.acquisition_dependency === 'mob') {
    return resolve_nearby_mob_source(vertex, state.nearby_entities?.mobs ?? []);
  }
  return resolve_nearby_block_source(vertex, state.nearby_blocks ?? []);
}

function get_source_kind_for_target(vertex) {
  return vertex.acquisition_dependency === 'mob' ? 'mob' : 'block';
}

function get_canonical_source_for_target(targetId) {
  return get_canonical_mob_source(targetId) ??
      get_canonical_block_source(targetId);
}

function is_environmental_use_target(source_block) {
  return source_block === 'water' || source_block === 'lava';
}

// Canonical direct block source for common world-acquired items.
// This is intentionally centralized so it is easy to extend as PTD coverage
// grows.
function get_canonical_block_source(targetId) {
  const explicit = CANONICAL_BLOCK_SOURCE_BY_TARGET[targetId];
  if (explicit) return explicit;

  if (targetId.endsWith('_log')) return targetId;
  if (targetId.endsWith('_planks')) return targetId.replace(/_planks$/, '_log');

  return null;
}

// Canonical mob source for common mob-dropped items.
function get_canonical_mob_source(targetId) {
  return CANONICAL_MOB_SOURCE_BY_TARGET[targetId] ?? null;
}

const CANONICAL_BLOCK_SOURCE_BY_TARGET = {
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

const CANONICAL_MOB_SOURCE_BY_TARGET = {
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

async function loadGraphFromFile(file_path) {
  try {
    const text = await readFile(file_path, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
        `Failed to load PTD graph from "${file_path}": ${err.message}`);
  }
}

function _is_successful_command_result(result) {
  // Non-string command results have historically been treated as success.
  if (typeof result !== 'string') return true;

  // Your command runtime returns successful actions as strings beginning with
  // "Action output:". The log shows examples like:
  //   Action output:\nCollected 3 spruce_log.
  //   Action output:\nSuccessfully crafted spruce_planks, you now have ...
  //
  // We should only treat these as failures if they clearly indicate an
  // exception or explicit failure.
  if (!result.startsWith('Action output:')) return false;

  return !result.includes('!!Code threw exception!!') &&
      !result.includes('Error:') && !result.includes('Could not find');
}

function _get_command_failure_signature(command, result) {
  if (typeof result !== 'string') return null;
  if (_is_successful_command_result(result)) return null;

  // Normalize noisy stack traces / timing-specific details so repeated copies
  // of the same underlying failure collapse to one signature.
  const normalized =
      result.replace(/\d+ms/g, '<TIMEOUT>').replace(/\s+/g, ' ').trim();

  return `${command} || ${normalized}`;
}

function _should_abort_repeated_failure(task, command, result, repeatedCount) {
  if (typeof result !== 'string') return false;

  // The run log shows repeated craftRecipe failures like:
  // "Event updateSlot:0 did not fire within timeout ..."
  // Those are execution-layer failures that usually do not benefit from
  // hammering the same identical craft command 5 times in a row.
  const isCraftCommand = command.startsWith('!craftRecipe(');
  const isRepeatedCraftTimeout = isCraftCommand &&
      result.includes('Event updateSlot:0 did not fire within timeout');

  if (isRepeatedCraftTimeout && repeatedCount >= 2) {
    return true;
  }

  return false;
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function _is_craft_command(command) {
  return typeof command === 'string' &&
      (command.startsWith('!craftRecipe(') ||
       command.startsWith('!smeltItem(') || command.startsWith('!smelt_item('));
}