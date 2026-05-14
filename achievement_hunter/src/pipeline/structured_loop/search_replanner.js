import {mkdirSync, readFileSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

import {get_am_state, get_recovery_trace_state, get_search_trace_state, pick_attempt_end_state} from '../agent_state.js';
import {clearActiveReplanner as clear_active_replanner, loadCheckpoint as load_checkpoint, saveRuntimeState as save_runtime_state,} from '../checkpoint.js';
import {executeCommandWithModeRecovery, PATHFINDING_MESSAGE_REGEX} from '../command_utils.js';
import {ioQueue} from '../io_queue.js';
import {extract_json} from '../json_utils.js';
import {fill_search_replanner_prompt} from '../prompt_utils.js';

import {
  ACTION_DEBOUNCE_MS,
  MAX_ACTIONS_PER_PLAN,
  MAX_SEARCH_REPLANNER_ATTEMPTS,
  SEARCH_REPLANNER_MAX_ACTION_RETRIES as MAX_ACTION_RETRIES,
} from './config.js';
import {format_action_as_command} from './failure_replanner.js';
import {make_spl} from './log.js';
import {check_search_complete, expand_search_item, run_search} from './search.js';
import {task_key} from './tasks.js';
import {create_action_result} from './trace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AVAILABLE_ACTIONS_PATH = path.join(
    __dirname,
    '../../../docs/prompts/search_replanner/actions_reference.json');

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
//   - `command_failure` whose message matches one of the mineflayer
//     pathfinder bail-out strings (see PATHFINDING_MESSAGE_REGEX in
//     failure_replanner.js). `run_action` reclassifies success-with-
//     bail-message into this category before is_pathfinding_failure runs.

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
    // executeCommandWithModeRecovery centrally reclassifies pathfinder-
    // bail "successes" for nav commands as failures (see command_utils
    // PATHFINDING_MESSAGE_REGEX + NAVIGATION_ONLY_COMMANDS), so the
    // success flag here is trustworthy. The downstream
    // is_pathfinding_failure check still fires D11 if the result is a
    // command_failure with a pathfinder-bail message.
    const env_result = await executeCommandWithModeRecovery(agent, command);
    await sleep(ACTION_DEBOUNCE_MS);
    const success = env_result?.success === true;
    // Preserve mode-interrupt classification: when the wrapper hit the
    // mode-recovery cap, env_result.mode_interrupted is true and carries
    // per-mode tallies + bot displacement. Surface those as kind
    // 'mode_interrupted' with the structured fields so the replanner's
    // mode-aware reasoning branch fires for recovery actions too — the
    // SPL outer loop in actions.js already does this; without this
    // mirror the same env_result shape collapses to plain
    // 'command_failure' inside recovery plans.
    const mode_interrupted = env_result?.mode_interrupted === true;
    const kind = success
        ? 'command_success'
        : (mode_interrupted ? 'mode_interrupted' : 'command_failure');
    const result = create_action_result(
        command, success, kind, env_result?.message ?? null);
    if (mode_interrupted) {
      result.mode_interrupt_counts = env_result.mode_interrupt_counts;
      result.position_before = env_result.position_before;
      result.position_after = env_result.position_after;
    }
    return result;
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
    await sleep(ACTION_DEBOUNCE_MS);

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

// Returns true if ANY of the candidate targets is now visible in the bot's
// nearby state. Used as the win condition: as soon as any one becomes
// reachable, the SPL outer loop can proceed via its normal
// `!collectBlocks`/`!attack` mediation. Abstract candidates (e.g.
// `any_log`) are expanded through `expand_search_item` so a concrete
// member appearing in nearby state satisfies the abstract. Targets whose
// expansion throws (e.g. `any_*` without a registered expansion) are
// soft-skipped with a warning so a misconfigured graph can't crash the
// win check — they just don't participate. `run_breadth_first_sweep`
// applies the same soft-skip semantics in Phase 0.5.
function any_target_now_in_nearby(targets, agent) {
  const state = get_am_state(agent);
  for (const target of targets) {
    let concrete_items;
    try {
      concrete_items = expand_search_item(target);
    } catch (e) {
      spl.warn(`Unsupported abstract target "${target}" — treating as ` +
               `unfindable. Add an expansion in expand_search_item to ` +
               `enable. (${e.message})`);
      continue;
    }
    for (const item of concrete_items) {
      if (check_search_complete(item, state)) return true;
    }
  }
  return false;
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
    ioQueue.append(path.join(dir, 'full_search_trace.jsonl'), trace_line);

    if (search_trace.terminal_status === 'fail') {
      const failed_dir = path.join(dir, 'failed');
      mkdirSync(failed_dir, {recursive: true});

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      // Use the first candidate as the canonical filename identifier; it's
      // vertex-order-stable so reruns of the same exhaustion produce
      // comparable filenames. The full targets array is in the JSON body.
      const primary_target = (search_trace.targets ?? ['unknown'])[0];
      const target_safe = String(primary_target)
                              .replace(/[^a-z0-9_-]/gi, '_')
                              .slice(0, 60);
      const filename = `${timestamp}__${target_safe}__fail.json`;

      ioQueue.write(
          path.join(failed_dir, filename),
          () => JSON.stringify(search_trace, null, 2));
    }
  } catch (err) {
    spl.error('Failed to persist search trace:', err.message);
  }
}

/**
 * Main entry point. Called by `actions.js` when an in-task `!search` (or a
 * search_sweep task — see `handle_search_sweep`) has exhausted its full
 * 511-block radius without finding any of the candidate targets.
 *
 * `targets` is a non-empty array of target names. Single-target callers
 * (the non-sweep `search_exhausted` branch in actions.js) pass an array
 * of length 1. Multi-target callers (the sweep handler) pass the full
 * exhausted candidate list and let the LLM pick a relocation strategy
 * that helps any one of them.
 *
 * Returns `'success'` if a plan relocated the bot to a position where
 * ANY candidate target is now in nearby state (the SPL outer loop can
 * then resume normal task mediation). Returns `'fail'` otherwise —
 * `actions.js` falls through to the existing `failure_replanner`.
 * Returns early on pathfinding-class failures (D11) so the failure
 * replanner can attempt a different recovery.
 */
export async function recover_failed_search(
    targets, agent, model, breadcrumb_tracker, log, task = null,
    seed_failure_message = null) {
  if (!Array.isArray(targets) || targets.length === 0) {
    spl.warn('recover_failed_search called with empty targets list — fail.');
    return 'fail';
  }

  const available_actions = load_available_actions();
  const previous_summaries = [];
  const started_at = new Date().toISOString();
  const initial_state = get_recovery_trace_state(agent);
  const attempts_log = [];
  const targets_display = targets.join(', ');

  // Seed previous_summaries with the original !search that triggered
  // recovery (attempt: 0) so the LLM has concrete evidence of why it was
  // called — not just world state. Only added for single-target callers
  // where there's a meaningful per-target message; the sweep caller
  // passes null since per-source messages aren't captured.
  if (seed_failure_message != null) {
    const seed_search_state =
        get_search_trace_state(agent, breadcrumb_tracker);
    previous_summaries.push({
      attempt: 0,
      summary: `Original !search("${targets[0]}") exhausted across the ` +
          `full radius schedule, triggering recovery.`,
      actions: [{name: '!search', args: [targets[0]]}],
      results: [{
        command: `!search("${targets[0]}")`,
        success: false,
        kind: 'search_exhausted',
        message: seed_failure_message,
      }],
      end_state: pick_attempt_end_state(seed_search_state),
    });
  }

  const finalize = (terminal_status, terminal_reason) => {
    const search_trace = {
      targets,
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

  // Restore the outer-attempt counter from a prior crash within this same
  // search recovery so the MAX_SEARCH_REPLANNER_ATTEMPTS budget is preserved
  // across crashes (policy (c): prior plan body is discarded).
  const current_task_key = task_key(task);
  const prior_replanner =
      load_checkpoint()?.runtime_state?.active_replanner ?? null;
  const resume_attempt =
      (prior_replanner?.kind === 'search' &&
       prior_replanner.task_key === current_task_key) ?
      Math.max(1, prior_replanner.outer_attempt ?? 1) :
      1;
  if (resume_attempt > 1) {
    spl.log(`Resuming search recovery at attempt ${resume_attempt}/${
        MAX_SEARCH_REPLANNER_ATTEMPTS} (prior crash, plan discarded).`);
  }

  try {

  spl.log(`Starting recovery for: ${targets_display}`);

  for (let attempt = resume_attempt; attempt <= MAX_SEARCH_REPLANNER_ATTEMPTS;
       attempt++) {
    save_runtime_state({
      active_replanner: {
        kind: 'search',
        task_key: current_task_key,
        outer_attempt: attempt,
        action_index: 0,
        action_retry: 0,
        plan: null,
      },
    });
    spl.log(`Attempt ${attempt}/${MAX_SEARCH_REPLANNER_ATTEMPTS}`);

    const search_trace_state = get_search_trace_state(agent, breadcrumb_tracker);
    const prompt = fill_search_replanner_prompt(
        targets, search_trace_state, previous_summaries, available_actions);

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
        attempt, task, targets_display, replanner_output.summary,
        replanner_output.actions);

    const action_results = [];
    const searched_targets = new Set();
    let attempt_outcome = null;

    for (let i = 0; i < replanner_output.actions.length; i++) {
      save_runtime_state({
        active_replanner: {
          kind: 'search',
          task_key: current_task_key,
          outer_attempt: attempt,
          action_index: i,
          action_retry: 0,
          plan: null,
        },
      });
      const action = replanner_output.actions[i];
      let result = null;

      for (let retry = 0; retry <= MAX_ACTION_RETRIES; retry++) {
        save_runtime_state({
          active_replanner: {
            kind: 'search',
            task_key: current_task_key,
            outer_attempt: attempt,
            action_index: i,
            action_retry: retry,
            plan: null,
          },
        });
        if (retry > 0) {
          spl.log(`Retry ${retry}/${MAX_ACTION_RETRIES} on action ${i + 1}`);
        } else {
          spl.log('Executing:', format_action_as_command(action));
        }

        result = await run_action(action, agent, log, searched_targets);
        spl.log('Result:', result);
        log?.search_recovery_action_result?.(attempt, i, result);

        if (result.success) break;
        if (PLAN_TERMINATING_KINDS.has(result.kind)) break;
        // Pathfinding failures (mode_interrupted / runner_exception /
        // command_failure with bail message) used to break out here. They
        // now fall through into the retry loop — the wasted attempts are
        // bounded by MAX_ACTION_RETRIES and the small chance of a
        // different outcome (slightly different bot position, world
        // state) is worth it before abandoning the plan.
      }

      action_results.push(result);

      // Win check: as soon as ANY candidate target is visible in nearby
      // state, the SPL outer loop can resume normal task mediation.
      // Catches search_success AND incidental encounters (e.g. !digDown
      // that broke through to one of the candidates). Handles abstract
      // candidates via expand_search_item.
      if (any_target_now_in_nearby(targets, agent)) {
        attempt_outcome = 'success';
        break;
      }

      // Pathfinding failures and plan-terminating kinds both end the
      // current plan, but neither aborts the recovery. The outer
      // attempt loop continues with a fresh LLM-generated plan
      // informed by previous_summaries — only after exhausting
      // MAX_SEARCH_REPLANNER_ATTEMPTS does the recovery bail to
      // failure_replanner via finalize('fail', ...). This is the
      // current iteration of D11 (the original D11 short-circuited
      // immediately on pathfinding failure; that was too aggressive
      // and burned through legitimate recovery opportunities).
      if (is_pathfinding_failure(result)) break;
      if (PLAN_TERMINATING_KINDS.has(result.kind)) break;
    }

    attempts_log.push({
      attempt,
      summary: replanner_output.summary,
      plan_actions: replanner_output.actions,
      results: action_results,
    });

    if (attempt_outcome === 'success') {
      spl.log(`A candidate from [${targets_display}] is now in nearby state — success.`);
      return finalize('success', 'target_reached');
    }

    // Plan ended without finding any candidate. Push the summary, the
    // per-action results, and an end-of-attempt state snapshot so the
    // next attempt's LLM call can decide whether to craft/smelt/collect
    // from the post-attempt position rather than re-derive context
    // from a delta. If this was the last attempt, the for-loop exits
    // and falls through to the exhausted-recovery path below.
    const end_state =
        pick_attempt_end_state(get_search_trace_state(agent, breadcrumb_tracker));
    log?.search_recovery_attempt_end?.(attempt, end_state);
    previous_summaries.push({
      attempt,
      summary: replanner_output.summary,
      actions: replanner_output.actions,
      results: action_results.map(r => ({
        command: r.command,
        success: r.success,
        kind: r.kind,
        message: r.message,
      })),
      end_state,
    });
  }

  spl.warn(`Recovery exhausted after ${MAX_SEARCH_REPLANNER_ATTEMPTS} attempts.`);
  return finalize('fail', 'search_replanner_exhausted');

  } finally {
    clear_active_replanner();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
