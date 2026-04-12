import { extract_json } from './json_utils.js';
import { get_state, get_inventory_state } from './state.js';
import { enrich_subgraph, trim_graph_for_scsg } from './graph_utils.js';
import {
  fill_ptd_prompt,
  fill_scsg_prompt,
  fill_next_task_selector_prompt,
  fill_action_mediator_prompt,
} from './prompt_utils.js';
import { createRolloutLogger } from './rollout_logger.js';
import { saveCheckpoint, clearCheckpoint } from './checkpoint.js';
import { executeCommand } from '../../../src/agent/commands/index.js';

const MAX_INNER_RETRIES = 5;
const MAX_OUTER_RETRIES = 10;

// Increasing radii tried in order during search expansion.
const SEARCH_RADII = [32, 64, 128, 256, 512];

// Overworld log blocks for Java Edition 1.21.6.
// Crimson/warped stems are excluded — they are Nether wood types, not overworld logs.
// pale_oak was added in 1.21.2 and is included here.
// src/utils/mcdata.js WOOD_TYPES is not reused because it predates pale_oak and
// carries the full mineflayer import chain.
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

/**
 * Runs the Structured Prompting Loop for a primary task T.
 *
 * Flow:
 *   1. PTD  — build a full prerequisite dependency graph for T (skipped on resume)
 *   2. SCSG — prune the graph to what is still needed given current inventory
 *   3. NTS  — pick the next immediate task from the pruned graph
 *   4. AM   — convert that task into a bot command and execute it
 *              (search tasks are expanded before reaching AM — see run_expanded_search_tasks)
 *   Repeat from (2) until the SCSG signals all sinks are satisfied (r=2).
 *
 * @param {object} model   - Model instance with sendRequest(turns, systemMessage).
 * @param {object} agent   - The Mindcraft agent instance.
 * @param {string} T       - The primary task objective (e.g. "craft a diamond sword").
 * @param {object} [G]     - Pre-built PTD graph. When provided (crash resume), Phase 1
 *                           is skipped and the loop resumes from Phase 2 (SCSG) directly.
 */
export async function structuredLoop(model, agent, T, G = null) {
  const log = createRolloutLogger(T);

  // ── Phase 1: PTD ─────────────────────────────────────────────────────────
  G = await run_ptd(model, T, G, log);
  if (!G) return;
  saveCheckpoint(T, G);

  // ── Phase 2+: Outer Loop ──────────────────────────────────────────────────
  let consecutive_failures = 0;
  while (true) {

    // SCSG
    const scsg = await run_scsg(model, G, agent, log);
    if (scsg.status === 'complete') {
      clearCheckpoint();
      log.complete(scsg.reason);
      return;
    }
    if (scsg.status === 'retry') {
      if (++consecutive_failures >= MAX_OUTER_RETRIES) {
        console.error('[SPL] Max outer retries exceeded. Aborting.');
        log.complete('max outer retries exceeded');
        return;
      }
      continue;
    }

    // NTS
    const task = await run_nts(model, scsg.enriched, agent, log);
    if (!task) {
      if (++consecutive_failures >= MAX_OUTER_RETRIES) {
        console.error('[SPL] Max outer retries exceeded. Aborting.');
        log.complete('max outer retries exceeded');
        return;
      }
      continue;
    }
    consecutive_failures = 0;

    // AM — search tasks are expanded into concrete mediator calls before reaching AM.
    // Non-search tasks go directly to AM via run_am.
    const am_status = task.action_type === 'search'
      ? await run_expanded_search_tasks(model, task, agent, log)
      : await run_am(model, task, agent, log);

    if (am_status !== 'success') {
      console.log('[SPL] Task failed after max retries, re-evaluating state...');
      // Outer loop continues: re-query inventory and re-run SCSG to pick a new sub-task
    }
  }
}

// ── Stage Helpers ─────────────────────────────────────────────────────────────

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
    console.log('[SPL] Resuming from checkpoint, skipping PTD for:', T);
    log.ptd('[loaded from checkpoint]', existing_G);
    return existing_G;
  }

  console.log('[SPL] Building PTD for:', T);
  const response = await model.sendRequest([], fill_ptd_prompt(T));
  const G = extract_json(response);
  log.ptd(response, G);

  if (!G) {
    console.error('[SPL] Failed to extract PTD graph from LLM response.');
    log.complete('PTD extraction failed');
    return null;
  }

  console.log('[SPL] PTD built.');
  return G;
}

/**
 * Phase 2 — State-Conditioned Subgraph (SCSG).
 *
 * Prunes the PTD graph to the subgraph still needed given the bot's current
 * inventory, then enriches it with metadata for NTS.
 *
 * @returns {{ status: 'complete', reason: string }}
 *            Task is finished — all sinks satisfied or subgraph is empty.
 * @returns {{ status: 'retry' }}
 *            LLM response could not be parsed — caller should retry.
 * @returns {{ status: 'continue', enriched: object }}
 *            Normal case — enriched subgraph is ready for NTS.
 */
async function run_scsg(model, G, agent, log) {
  const { inventory } = get_inventory_state(agent);
  const response = await model.sendRequest(
    [],
    fill_scsg_prompt(trim_graph_for_scsg(G), { inventory })
  );
  const result = extract_json(response);
  log.scsg(response, result);

  if (!result) {
    console.error('[SPL] Failed to extract SCSG result from LLM response, retrying...');
    return { status: 'retry' };
  }

  if (result.r === 2) {
    console.log('[SPL] Task complete — all sinks satisfied.');
    return { status: 'complete', reason: 'all sinks satisfied' };
  }

  // r=1: inventory is "Nothing" → use full original graph
  // r=0: normal pruned subgraph
  const subgraph = {
    objective: G.objective,
    sinks: result.r === 1 ? G.sinks : result.s,
    ...result.final,
  };

  if (!subgraph.vertices || subgraph.vertices.length === 0) {
    console.log('[SPL] Task complete — subgraph is empty.');
    return { status: 'complete', reason: 'subgraph empty' };
  }

  return { status: 'continue', enriched: enrich_subgraph(subgraph, G) };
}

/**
 * Phase 3 — Next Task Selector (NTS).
 *
 * Picks the single most actionable leaf task from the enriched subgraph
 * given the bot's current full state.
 *
 * @returns {object|null} The selected task object, or null if parsing failed.
 */
async function run_nts(model, enriched, agent, log) {
  const state = get_state(agent);
  const response = await model.sendRequest([], fill_next_task_selector_prompt(enriched, state));
  const task = extract_json(response);
  log.nts(response, task);

  if (!task) {
    console.error('[SPL] Failed to extract task from NTS response.');
    return null;
  }

  console.log('[SPL] Next task:', JSON.stringify(task));
  return task;
}

/**
 * Phase 4 — Action Mediator (AM), non-search path.
 *
 * Converts the selected task into a bot command and executes it, retrying
 * up to MAX_INNER_RETRIES times. Exits early if the AM signals the task is
 * already complete, or if a command executes without error.
 *
 * @returns {'success'|'fail'}
 */
async function run_am(model, task, agent, log) {
  for (let attempt = 0; attempt < MAX_INNER_RETRIES; attempt++) {
    const state = get_state(agent);
    const action = await model.sendRequest([], fill_action_mediator_prompt(task, state));
    log.am(attempt + 1, action);
    console.log(`[SPL] Action (attempt ${attempt + 1}/${MAX_INNER_RETRIES}):`, action);

    // AM signals completion when inventory already satisfies the task
    const signal = extract_json(action);
    if (signal?.status === 'TASK_COMPLETE') {
      console.log('[SPL] AM reports task already complete:', task.target_item ?? task.action_type);
      return 'success';
    }

    // executeCommand returns a string only on error (bad format, unknown command, etc.)
    // Any non-string result means the command ran successfully
    const result = await executeCommand(agent, action);
    console.log('[SPL] Command result:', result);
    if (typeof result !== 'string') return 'success';
    console.warn('[SPL] Command error:', result);
  }

  return 'fail';
}

/**
 * Phase 4 — Action Mediator (AM), search-expansion path.
 *
 * NTS emits planner-level search tasks that may contain abstract targets
 * (e.g. any_log) or multiple targets in a targets[] array. AM requires
 * exactly one concrete target and one search_radius per call. This function
 * bridges that contract by:
 *   1. Normalizing the NTS targets into a flat ordered list
 *   2. Expanding abstract items (any_log → all overworld log variants)
 *   3. Trying each concrete target at increasing radii via AM + executeCommand
 *   4. Stopping immediately after the first successful command execution
 *
 * State is snapshotted once before the loop — no refresh between attempts —
 * because all attempts target the same planner task and a state refresh
 * would add latency with no benefit for sequential search probes.
 *
 * @returns {'success'|'fail'}
 */
async function run_expanded_search_tasks(model, task, agent, log) {
  const search_items = normalize_search_items(task);

  if (search_items.length === 0) {
    console.error('[SPL] Search task has no targets — NTS output may be malformed.');
    return 'fail';
  }

  // Snapshot state once for all search attempts
  const state = get_state(agent);
  let attempt = 0;

  for (const radius of SEARCH_RADII) {
    for (const item of search_items) {
      const concrete_items = expand_search_item(item);

      for (const concrete_item of concrete_items) {
        const search_task = create_search_task(concrete_item, radius, task);
        const action = await model.sendRequest([], fill_action_mediator_prompt(search_task, state));
        log.am(++attempt, action);
        console.log(`[SPL] Search action (${concrete_item} r=${radius}):`, action);

        // AM may signal the target is already present — honour it before executing a command
        const signal = extract_json(action);
        if (signal?.status === 'TASK_COMPLETE') {
          console.log(`[SPL] Search already complete: ${concrete_item} found in current state.`);
          return 'success';
        }

        const result = await executeCommand(agent, action);
        console.log('[SPL] Search result:', result);

        // executeCommand returns a string only on error.
        // A non-string result means the command executed — stop all loops immediately.
        if (typeof result !== 'string') {
          console.log(`[SPL] Search succeeded: ${concrete_item} at radius ${radius}.`);
          return 'success';
        }
        console.warn('[SPL] Search failed:', result);
      }
    }
  }

  return 'fail';
}

// ── Search Expansion Helpers ──────────────────────────────────────────────────

/**
 * Reads the planner-level targets from an NTS search task and returns a flat,
 * deduplicated, ordered list of search item strings.
 *
 * NTS emits: { parameters: { targets: [{ target, match_mode }] } }
 */
function normalize_search_items(task) {
  const targets = task.parameters?.targets ?? [];
  const seen = new Set();
  const result = [];
  for (const t of targets) {
    if (!seen.has(t.target)) {
      seen.add(t.target);
      result.push(t.target);
    }
  }
  return result;
}

/**
 * Expands a single planner-level search item into concrete world targets.
 *
 * any_log expands to all overworld log blocks. Stems (crimson_stem,
 * warped_stem) are excluded because they are Nether wood types, not valid
 * overworld log search targets in 1.21.6.
 *
 * Unknown any_* abstracts are rejected — AM must never receive an abstract
 * target, and silently passing one through would violate the search contract.
 */
function expand_search_item(item) {
  if (item === 'any_log') return ANY_LOG_SEARCH_TARGETS;
  if (item.startsWith('any_')) {
    throw new Error(`[SPL] Unsupported abstract search item: "${item}". Add an expansion to expand_search_item.`);
  }
  return [item];
}

/**
 * Builds a mediator-level search task with exactly one concrete target and
 * one search_radius. AM expects this flat shape — no targets array, no
 * match_mode, no abstract ids.
 */
function create_search_task(target, search_radius, base_task) {
  return {
    action_type: 'search',
    parameters: { target, search_radius },
    rationale: base_task.rationale,
  };
}
