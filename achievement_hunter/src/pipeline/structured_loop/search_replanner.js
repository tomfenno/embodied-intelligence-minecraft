import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

import {get_am_state, get_recovery_trace_state, get_search_trace_state} from '../agent_state.js';
import {executeCommandWithModeRecovery} from '../command_utils.js';
import {extract_json} from '../json_utils.js';
import {fill_search_replanner_prompt} from '../prompt_utils.js';

import {ensure_safe_before_llm, format_action_as_command} from './failure_replanner.js';
import {make_spl} from './log.js';
import {check_search_complete, run_search} from './search.js';
import {create_action_result} from './trace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AVAILABLE_ACTIONS_PATH = path.join(
    __dirname,
    '../../../docs/prompts/search_replanner/actions_reference.json');

const MAX_SEARCH_REPLANNER_ATTEMPTS = 3;
const MAX_ACTIONS_PER_PLAN = 10;
const MAX_ACTION_RETRIES = 2;

const action_debounce_ms = 750;

// Plan-terminating but NOT recovery-terminating: the current plan ends, but
// the outer attempt loop continues (the LLM may produce a better plan next).
const PLAN_TERMINATING_KINDS = new Set([
  'invalid_command',
  'unavailable_action',
  'search_already_attempted',
]);

// Pathfinding-class failures bail the entire recovery (D11). `actions.js`
// then routes the original task to `failure_replanner` via its existing
// fall-through. Caught here:
//   - `mode_interrupted`: bot stuck in survival-mode livelock during a
//     navigation command (unstuck/self_preservation took over).
//   - `runner_exception`: thrown error from the bot command — pathfinder
//     death, world unloaded, etc.
//   - `command_failure` with a pathfinder-style message ("PathStopped",
//     "Could not find a path", "no path").
const PATHFINDING_MESSAGE_REGEX = /no path|PathStopped|Could not find a path/i;

function is_pathfinding_failure(result) {
  if (result == null) return false;
  if (result.kind === 'mode_interrupted') return true;
  if (result.kind === 'runner_exception') return true;
  if (result.kind === 'command_failure' &&
      typeof result.message === 'string' &&
      PATHFINDING_MESSAGE_REGEX.test(result.message)) {
    return true;
  }
  return false;
}

const spl = make_spl('[SPL][search]');

let _available_actions = null;
function load_available_actions() {
  if (!_available_actions) {
    _available_actions =
        JSON.parse(readFileSync(AVAILABLE_ACTIONS_PATH, 'utf8'));
  }
  return _available_actions;
}

function validate_search_replanner_output(output, available_actions) {
  if (!output || typeof output !== 'object') {
    throw new Error('Search-replanner output must be a JSON object.');
  }

  const keys = Object.keys(output);
  if (!keys.includes('summary') || !keys.includes('actions') ||
      keys.length !== 2) {
    throw new Error(
        'Search-replanner output must contain exactly "summary" and "actions".');
  }

  if (typeof output.summary !== 'string') {
    throw new Error('summary must be a string.');
  }

  if (!Array.isArray(output.actions)) {
    throw new Error('actions must be an array.');
  }

  if (output.actions.length < 1 ||
      output.actions.length > MAX_ACTIONS_PER_PLAN) {
    throw new Error(`actions must contain between 1 and ${
        MAX_ACTIONS_PER_PLAN} items.`);
  }

  const allowed_names = new Set(available_actions.map(a => a.name));

  for (const action of output.actions) {
    if (!action || typeof action !== 'object') {
      throw new Error('Each action must be an object.');
    }

    const action_keys = Object.keys(action);
    if (!action_keys.includes('name') || !action_keys.includes('args') ||
        action_keys.length !== 2) {
      throw new Error('Each action must contain exactly "name" and "args".');
    }

    if (!allowed_names.has(action.name)) {
      throw new Error(`Action not available: ${action.name}`);
    }

    if (!Array.isArray(action.args)) {
      throw new Error(
          `Action args must be an array: ${JSON.stringify(action)}`);
    }

    for (const arg of action.args) {
      if (arg !== null && typeof arg !== 'string' && typeof arg !== 'number' &&
          typeof arg !== 'boolean') {
        throw new Error(`Invalid action arg type: ${JSON.stringify(arg)}`);
      }
    }
  }
}

async function run_action(action, agent, log, searched_targets) {
  if (action.name === '!search') {
    return await run_search_action(action, agent, log, searched_targets);
  }

  const command = format_action_as_command(action);
  try {
    const env_result = await executeCommandWithModeRecovery(agent, command);
    await sleep(action_debounce_ms);
    const success = env_result?.success === true;
    return create_action_result(
        command, success, success ? 'command_success' : 'command_failure',
        env_result?.message ?? null);
  } catch (e) {
    return create_action_result(command, false, 'runner_exception', String(e));
  }
}

async function run_search_action(action, agent, log, searched_targets) {
  const command = format_action_as_command(action);
  const target = action.args?.[0];

  if (typeof target !== 'string' || target.length === 0) {
    return create_action_result(
        command, false, 'invalid_command',
        '!search requires a non-empty string target');
  }

  // Per-plan dedup. A relocation between plans clears this set (the search
  // replanner resets `searched_targets` for each new attempt), so the LLM
  // can re-search the same target after the bot has moved.
  if (searched_targets.has(target)) {
    return create_action_result(
        command, false, 'search_already_attempted',
        `Search for "${target}" already attempted in this plan`);
  }

  try {
    const state = get_am_state(agent);
    const {found, message} = await run_search(target, state, agent, log, 0);
    await sleep(action_debounce_ms);

    if (!found) {
      searched_targets.add(target);
      return create_action_result(command, false, 'search_exhausted', message);
    }

    const target_reached = check_search_complete(target, get_am_state(agent));
    return target_reached ?
        create_action_result(command, true, 'search_success', message) :
        create_action_result(
            command, false, 'search_found_not_reached', message);
  } catch (e) {
    return create_action_result(command, false, 'runner_exception', String(e));
  }
}

// Returns true if `target` is now visible in the bot's nearby state. Used as
// the win condition: as soon as the target is reachable, the SPL outer loop
// can proceed via its normal `!collectBlocks`/`!attack` mediation.
function target_now_in_nearby(target, agent) {
  return check_search_complete(target, get_am_state(agent));
}

function persist_search_trace(search_trace, rollout_dir) {
  if (!rollout_dir) {
    spl.warn('No rollout_dir available; skipping search trace persistence.');
    return;
  }

  try {
    const trace_line = JSON.stringify(search_trace) + '\n';
    const dir = path.join(rollout_dir, 'search_traces');
    mkdirSync(dir, {recursive: true});
    appendFileSync(
        path.join(dir, 'full_search_trace.jsonl'), trace_line, 'utf8');

    if (search_trace.terminal_status === 'fail') {
      const failed_dir = path.join(dir, 'failed');
      mkdirSync(failed_dir, {recursive: true});

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target_safe = String(search_trace.target ?? 'unknown')
                              .replace(/[^a-z0-9_-]/gi, '_')
                              .slice(0, 60);
      const filename = `${timestamp}__${target_safe}__fail.json`;

      writeFileSync(
          path.join(failed_dir, filename),
          JSON.stringify(search_trace, null, 2), 'utf8');
    }
  } catch (err) {
    spl.error('Failed to persist search trace:', err.message);
  }
}

/**
 * Main entry point. Called by `actions.js` when an in-task `!search` exhausts
 * its full 511-block radius without finding the target.
 *
 * Returns `'success'` if a plan relocated the bot to a position where the
 * target is now in nearby state (the SPL outer loop can then resume normal
 * task mediation). Returns `'fail'` otherwise — `actions.js` falls through
 * to the existing `failure_replanner`. Returns early on pathfinding-class
 * failures (D11) so the failure replanner can attempt a different recovery.
 */
export async function recover_failed_search(
    target, agent, model, breadcrumb_tracker, log, task = null) {
  const available_actions = load_available_actions();
  const previous_summaries = [];
  const started_at = new Date().toISOString();
  const initial_state = get_recovery_trace_state(agent);
  const attempts_log = [];

  const finalize = (terminal_status, terminal_reason) => {
    const search_trace = {
      target,
      task,
      started_at,
      ended_at: new Date().toISOString(),
      terminal_status,
      terminal_reason,
      attempts: attempts_log,
      initial_state,
      final_state: get_recovery_trace_state(agent),
    };
    persist_search_trace(search_trace, log?.rollout_dir);
    log?.search_recovery_end?.(terminal_status);
    return terminal_status;
  };

  spl.log(`Starting recovery for "${target}".`);

  for (let attempt = 1; attempt <= MAX_SEARCH_REPLANNER_ATTEMPTS; attempt++) {
    spl.log(`Attempt ${attempt}/${MAX_SEARCH_REPLANNER_ATTEMPTS}`);

    const search_trace_state = get_search_trace_state(agent, breadcrumb_tracker);
    const prompt = fill_search_replanner_prompt(
        target, search_trace_state, previous_summaries, available_actions);

    await ensure_safe_before_llm(agent);

    let replanner_output = null;
    try {
      const raw = await model.send_prompt(prompt);
      replanner_output = extract_json(raw);
    } catch (e) {
      spl.error('LLM call failed:', e.message);
      return finalize('fail', 'llm_failed');
    }

    if (replanner_output == null) {
      spl.warn('LLM returned null or unparseable output.');
      return finalize('fail', 'invalid_llm_output');
    }

    try {
      validate_search_replanner_output(replanner_output, available_actions);
    } catch (e) {
      spl.warn('Validation failed:', e.message);
      return finalize('fail', 'validation_failed');
    }

    spl.log('Summary:', replanner_output.summary);
    log?.search_recovery_attempt?.(
        attempt, task, target, replanner_output.summary,
        replanner_output.actions);

    const action_results = [];
    const searched_targets = new Set();
    let attempt_outcome = null;

    for (let i = 0; i < replanner_output.actions.length; i++) {
      const action = replanner_output.actions[i];
      let result = null;

      for (let retry = 0; retry <= MAX_ACTION_RETRIES; retry++) {
        if (retry > 0) {
          spl.log(`Retry ${retry}/${MAX_ACTION_RETRIES} on action ${i + 1}`);
        } else {
          spl.log('Executing:', format_action_as_command(action));
        }

        result = await run_action(action, agent, log, searched_targets);
        spl.log('Result:', result);
        log?.search_recovery_action_result?.(attempt, i, result);

        if (result.success) break;
        if (is_pathfinding_failure(result)) break;
        if (PLAN_TERMINATING_KINDS.has(result.kind)) break;
        // else: retry
      }

      action_results.push(result);

      // Win check: as soon as the target is visible in nearby state, the SPL
      // outer loop can resume normal task mediation. Catches search_success
      // AND incidental encounters (e.g. !digDown that broke through to the
      // target).
      if (target_now_in_nearby(target, agent)) {
        attempt_outcome = 'success';
        break;
      }

      if (is_pathfinding_failure(result)) {
        attempt_outcome = 'pathfinding_bail';
        break;
      }

      if (PLAN_TERMINATING_KINDS.has(result.kind)) {
        // End this plan, but continue to the next attempt with the same
        // summary added to previous_summaries below.
        break;
      }
    }

    attempts_log.push({
      attempt,
      summary: replanner_output.summary,
      plan_actions: replanner_output.actions,
      results: action_results,
    });

    if (attempt_outcome === 'success') {
      spl.log(`Target "${target}" now in nearby state — success.`);
      return finalize('success', 'target_reached');
    }

    if (attempt_outcome === 'pathfinding_bail') {
      spl.warn('Pathfinding failure during plan — bailing to failure_replanner.');
      return finalize('fail', 'pathfinding_failure');
    }

    previous_summaries.push({
      attempt,
      summary: replanner_output.summary,
      actions: replanner_output.actions,
    });
  }

  spl.warn(`Recovery exhausted after ${MAX_SEARCH_REPLANNER_ATTEMPTS} attempts.`);
  return finalize('fail', 'search_replanner_exhausted');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
