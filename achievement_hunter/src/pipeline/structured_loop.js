import {readFile} from 'fs/promises';

import {executeCommand} from '../../../src/agent/commands/index.js';

import {clearCheckpoint, saveCheckpoint} from './checkpoint.js';
import {enrich_subgraph_sources} from './graph_utils.js';
import {extract_json, strip_fences, to_snake_case} from './json_utils.js';
import {fill_action_mediator_prompt, fill_next_task_selector_prompt, fill_ptd_prompt,} from './prompt_utils.js';
import {createRolloutLogger} from './rollout_logger.js';
import {ABSTRACT_CLASS_MEMBERS, compute_scsg} from './scsg.js';
import {get_am_state, get_nts_state, get_sgsg_state} from './state.js';

const MAX_INNER_RETRIES = 5;
const MAX_OUTER_RETRIES = 10;

// Increasing radii tried in order during search expansion.
const SEARCH_RADII = [32, 64, 128, 256, 512];

// Overworld log blocks for Java Edition 1.21.6.
// Crimson/warped stems are excluded — they are Nether wood types, not overworld
// logs. pale_oak was added in 1.21.2 and is included here. src/utils/mcdata.js
// WOOD_TYPES is not reused because it predates pale_oak and carries the full
// mineflayer import chain.
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

// Prefixed console wrapper — keeps [SPL] tag out of logic code.
const spl = {
  log: (...args) => console.log('[SPL]', ...args),
  warn: (...args) => console.warn('[SPL]', ...args),
  error: (...args) => console.error('[SPL]', ...args),
};

/**
 * Runs the Structured Prompting Loop for a primary task T.
 *
 * Flow:
 *   1. PTD  — build a full prerequisite dependency graph for T (skipped on
 * resume)
 *   2. SCSG — prune the graph to what is still needed given current inventory
 *   3. NTS  — pick the next immediate task from the pruned graph
 *   4. AM   — convert that task into a bot command and execute it
 *              (!search(target) responses are intercepted and run as hardcoded
 *              searches; all other commands go to executeCommand)
 *           Repeat from (2) until the SCSG signals all sinks are satisfied
 * (r=2).
 *
 * @param {{ptd: object, nts: object, am: object}} models
 *   Per-stage model instances, each with sendRequest(turns, systemMessage).
 * @param {object} agent  The Mindcraft agent instance.
 * @param {string} T      The primary task objective (e.g. "craft a diamond
 *     sword").
 * @param {object} [G]    Pre-built PTD graph. When provided (crash resume),
 *     Phase 1
 *                        is skipped and the loop resumes from Phase 2 (SCSG)
 * directly.
 */
export async function structuredLoop(models, agent, T, G = null) {
  const log = createRolloutLogger(T);

  // ── Phase 1: PTD ─────────────────────────────────────────────────────────
  // G = await run_ptd(models.ptd, T, G, log);
  G = await loadGraphFromFile(
      './achievement_hunter/docs/ptd_jsons/wooden_pickaxe.json');
  saveCheckpoint(T, G);

  // ── Phase 2+: Outer Loop ──────────────────────────────────────────────────
  let consecutive_failures = 0;
  while (true) {
    const scsg = run_scsg(G, agent, log);
    if (scsg.status === 'complete') {
      clearCheckpoint();
      log.complete(scsg.reason);
      return;
    }

    const task = await run_nts(models.nts, scsg.candidates, agent, log);
    if (!task) {
      if (++consecutive_failures >= MAX_OUTER_RETRIES) break;
      continue;
    }

    const am_status = await run_am(models.am, task, agent, log);
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

// ── Stage Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Phase 1 — Prerequisite Task DAG (PTD).
 *
 * Builds the full dependency graph for the objective T. When an existing
 * graph is provided (crash resume), the LLM call is skipped and the graph
 * is returned as-is.
 *
 * @returns {object|null} The PTD graph, or null if LLM extraction failed.
 */
async function run_ptd(model, T, existing_G, log) {
  if (existing_G) {
    spl.log('Resuming from checkpoint, skipping PTD for:', T);
    log.ptd('[loaded from checkpoint]', existing_G);
    return existing_G;
  }

  spl.log('Building PTD for:', T);
  const response = await model.sendRequest([], fill_ptd_prompt(T));
  const G = extract_json(response);

  log.ptd(response, G);

  if (!G) {
    spl.error('Failed to extract PTD graph from LLM response.');
    log.complete('PTD extraction failed');
    return null;
  }

  // Save ptd for later use.
  const file_path =
      'achievement_hunter/docs/ptd_jsons/' + to_snake_case(T) + '.json';

  save_json(G, file_path);

  spl.log('PTD built.');
  return G;
}

/**
 * Phase 2 — State-Conditioned Subgraph (SCSG).
 *
 * Prunes the PTD graph to the subgraph still needed given the bot's current
 * inventory using the deterministic compute_scsg algorithm, then enriches
 * it with metadata for NTS. No LLM call is made.
 *
 * @returns {{ status: 'complete', reason: string }}
 *            Task is finished — all sinks satisfied or subgraph is empty.
 * @returns {{ status: 'continue', candidates: object[] }}
 *            Normal case — enriched source candidates are ready for NTS.
 */
function run_scsg(G, agent, log) {
  const {inventory} = get_sgsg_state(agent);
  const result = compute_scsg(G, inventory);
  // Augment r=1 result with sinks so the logger can render them correctly
  // (r=1 has no `s` field; r=0 does).
  log.scsg(
      '[deterministic]', result.r === 1 ? {...result, s: G.sinks} : result);

  if (result.r === 2) {
    spl.log('Task complete — all sinks satisfied.');
    return {status: 'complete', reason: 'all sinks satisfied'};
  }

  // r=1: inventory is "Nothing" → use full original graph
  // r=0: normal pruned subgraph
  const subgraph = {
    objective: G.objective,
    sinks: result.r === 1 ? G.sinks : result.s,
    ...result.final,
  };

  if (!subgraph.vertices || subgraph.vertices.length === 0) {
    spl.log('Task complete — subgraph is empty.');
    return {status: 'complete', reason: 'subgraph empty'};
  }

  const candidates = enrich_subgraph_sources(subgraph, G);
  log.candidates(candidates);
  return {status: 'continue', candidates};
}

/**
 * Phase 3 — Next Task Selector (NTS).
 *
 * Picks the single most actionable leaf task from the enriched subgraph
 * given the bot's current full state.
 *
 * @returns {object|null} The selected task object, or null if parsing failed.
 */
async function run_nts(model, candidates, agent, log) {
  const state = get_nts_state(agent);
  const response = await model.sendRequest(
      [], fill_next_task_selector_prompt(candidates, state));
  const task = extract_json(response);
  log.nts(response, task);

  if (!task) {
    spl.error('Failed to extract task from NTS response.');
    return null;
  }

  spl.log('Next task:', JSON.stringify(task));
  return task;
}

/**
 * Phase 4 — Action Mediator (AM).
 *
 * Converts the selected task into a bot command and executes it, retrying
 * up to MAX_INNER_RETRIES times. Exits early if the AM signals the task is
 * already complete, or if a command executes without error.
 *
 * @returns {'success'|'fail'}
 */
async function run_am(model, task, agent, log) {
  for (let attempt = 0; attempt < MAX_INNER_RETRIES; attempt++) {
    const state = get_am_state(agent);

    if (_task_complete(task, state)) {
      spl.log(
          'Task already complete (hardcoded check):',
          task.target_item ?? task.action_type);
      return 'success';
    }

    const action = strip_fences(
        await model.sendRequest([], fill_action_mediator_prompt(task, state)));
    const signal = extract_json(action);
    log.am(attempt + 1, action, state);
    spl.log(`Action (attempt ${attempt + 1}/${MAX_INNER_RETRIES}):`, action);

    if (signal?.status === 'TASK_COMPLETE')
      return _handle_task_complete_signal(task, agent, log);

    const search_target = _parse_search_command(action);
    if (search_target !== null) {
      const found =
          await _run_search(search_target, state, agent, log, attempt + 1);
      found ? spl.log(`Search found "${
                  search_target}", re-running AM with fresh state.`) :
              spl.warn(`Search exhausted all radii for "${
                  search_target}", re-evaluating.`);
      continue;
    }

    const result = await executeCommand(agent, action);
    spl.log('Command result:', result);
    if (typeof result !== 'string') return 'success';
    spl.warn('Command error:', result);
  }

  return 'fail';
}

// ── Task Completion
// ───────────────────────────────────────────────────────────

/**
 * Returns true if the task is already satisfied by the current inventory,
 * without making an LLM call.
 *
 * Mirrors the AM prompt's completion rule:
 *   - concrete target_item: inventory[target_item] >= qty
 *   - abstract any_* target: sum of all concrete class members >= qty
 */
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

/**
 * Handles a TASK_COMPLETE signal from the AM. Validates the signal against
 * a fresh inventory check and logs a warning if the two disagree.
 *
 * @returns {'success'}
 */
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

// ── Search Helpers
// ────────────────────────────────────────────────────────────

/**
 * Parses a !search("target") command string and returns the target string,
 * or null if the action is not a search command.
 */
function _parse_search_command(action) {
  const match = action.trim().match(/^!search\("([^"]+)"\)$/);
  return match ? match[1] : null;
}

/**
 * Runs a hardcoded search for the given target across expanding radii.
 * Expands abstract targets (e.g. any_log → all overworld log variants).
 * Returns true as soon as any concrete target is found; false if all radii
 * are exhausted without success.
 *
 * Uses the state snapshot passed in for the fast-path check only — commands
 * are executed live against the agent.
 */
async function _run_search(target, state, agent, log, start_attempt) {
  const concrete_items = expand_search_item(target);

  // Fast-path: already visible in the current state snapshot
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
      log.am(++attempt, command);
      if (await _execute_search_command(agent, item, radius, command))
        return true;
    }
  }

  return false;
}

/**
 * Executes a single search command and returns true if the target was found.
 */
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

/**
 * Expands a single search target into concrete world targets.
 *
 * any_log expands to all overworld log blocks (crimson/warped stems excluded —
 * they are Nether wood types). Unknown any_* abstracts throw rather than
 * silently pass through.
 */
function expand_search_item(item) {
  if (item === 'any_log') return ANY_LOG_SEARCH_TARGETS;
  if (item.startsWith('any_')) {
    throw new Error(`Unsupported abstract search target: "${item}". Add an expansion to expand_search_item.`);
  }
  return [item];
}

// Mob names that can appear as concrete search targets from PTD graphs.
// Everything not in this set is treated as a block target.
const MOB_SEARCH_TARGETS = new Set([
  // Overworld hostile
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
  // Overworld passive / neutral
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

/**
 * Returns true if the concrete search target should use !searchForEntity.
 * Returns false if it should use !searchForBlock.
 */
export function is_entity_target(target) {
  return MOB_SEARCH_TARGETS.has(target);
}

/**
 * Returns true if the concrete target is already evidenced in the current
 * state snapshot — equivalent to the AM's TASK_COMPLETE check for search.
 *
 * Block targets: present in state.nearby_blocks.
 * Entity targets: present with count > 0 in state.nearby_entities.mobs.
 */
export function check_search_complete(target, state) {
  if (is_entity_target(target)) {
    return state.nearby_entities?.mobs?.includes(target) ?? false;
  }
  return state.nearby_blocks?.includes(target) ?? false;
}

/**
 * Builds the bot command string for a concrete search target at a given
 * radius. No LLM involved — command family is determined by is_entity_target.
 */
export function make_search_command(target, radius) {
  if (is_entity_target(target)) {
    return `!searchForEntity("${target}", ${radius})`;
  }
  return `!searchForBlock("${target}", ${radius})`;
}

/** Loads a PTD graph from a JSON file. Throws with a clear message on failure. */
async function loadGraphFromFile(file_path) {
  try {
    const text = await readFile(file_path, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to load PTD graph from "${file_path}": ${err.message}`);
  }
}
