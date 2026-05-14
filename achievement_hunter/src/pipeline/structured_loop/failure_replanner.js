import {readFileSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

import {get_am_state, get_recovery_trace_state, get_sgsg_state} from '../agent_state.js';
import {clearActiveReplanner as clear_active_replanner, loadCheckpoint as load_checkpoint, saveRuntimeState as save_runtime_state,} from '../checkpoint.js';
import {executeCommandWithModeRecovery} from '../command_utils.js';
import {extract_json} from '../json_utils.js';
import {fill_failure_replanner_prompt} from '../prompt_utils.js';
import {compute_scsg} from '../scsg.js';

import {CRAFT_DEBOUNCE_MS, FAILURE_REPLANNER_MAX_ACTION_RETRIES as MAX_ACTION_RETRIES, MAX_RECOVERY_ATTEMPTS,} from './config.js';
import {make_spl} from './log.js';
import {check_search_complete, run_search} from './search.js';
import {task_key} from './tasks.js';
import {create_action_result, project_failed_steps} from './trace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AVAILABLE_ACTIONS_PATH = path.join(
    __dirname,
    '../../../docs/prompts/failure_replanner/actions_reference.json');

const HARD_FAILURE_KINDS = new Set([
  'runner_exception',
  'invalid_command',
  'unavailable_action',
  'search_exhausted',
  'search_already_attempted',
]);

const spl = make_spl('[SPL][recovery]');

let _available_actions = null;
function load_available_actions() {
  if (!_available_actions) {
    _available_actions =
        JSON.parse(readFileSync(AVAILABLE_ACTIONS_PATH, 'utf8'));
  }
  return _available_actions;
}

// Converts {name, args} into a bot command string e.g.
// !search("pumpkin")
// Exported so search_replanner.js can reuse the same serialization.
export function format_action_as_command(action) {
  const formatted_args = action.args.map(arg => {
    if (typeof arg === 'string') return JSON.stringify(arg);
    if (typeof arg === 'boolean') return arg ? 'true' : 'false';
    if (arg === null) return 'null';
    return String(arg);
  });
  return `${action.name}(${formatted_args.join(', ')})`;
}

async function run_action(action, agent, log, searched_targets) {
  if (action.name === '!search') {
    return await run_search_action(action, agent, log, searched_targets);
  }

  const command = format_action_as_command(action);
  try {
    // executeCommandWithModeRecovery centrally reclassifies pathfinder-
    // bail "successes" for nav commands as failures, so we can trust the
    // success flag here without per-callsite regex filtering.
    const env_result = await executeCommandWithModeRecovery(agent, command);
    await sleep(CRAFT_DEBOUNCE_MS);
    const success = env_result?.success === true;
    // Preserve mode-interrupt classification: the SPL outer loop in
    // actions.js distinguishes mode_interrupted from command_failure and
    // attaches mode counts + bot displacement; mirror that here so
    // recovery actions get the same classification when the wrapper
    // hits the mode-recovery cap.
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

  if (searched_targets.has(target)) {
    return create_action_result(
        command, false, 'search_already_attempted',
        `Search for "${target}" already attempted in this recovery sequence`);
  }

  try {
    const state = get_am_state(agent);
    const {found, message} = await run_search(target, state, agent, log, 0);
    await sleep(CRAFT_DEBOUNCE_MS);

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

function result_indicates_hard_failure(result) {
  return HARD_FAILURE_KINDS.has(result.kind);
}

function scsg_task_complete_check(task, graph, agent) {
  const {inventory} = get_sgsg_state(agent);
  const result = compute_scsg(graph, inventory);

  if (result.r === 2) return true;

  const remaining_ids = new Set((result.final?.vertices ?? []).map(v => v.id));
  return !remaining_ids.has(task.target_item);
}

function infer_terminal_reason(action_results) {
  if (!action_results.length) return 'no_actions_executed';

  const failed = action_results.filter(r => !r.success);
  if (failed.length) return failed.at(-1).kind ?? 'recovery_action_failed';

  return 'recovery_sequence_completed_but_task_not_done';
}

function build_failed_trace_from_attempt(
    original_failed_trace, action_results, latest_state) {
  const steps = action_results.map((result, i) => ({
                                     i: i + 1,
                                     action: result.command,
                                     result: {
                                       success: result.success,
                                       kind: result.kind,
                                       message: result.message,
                                     },
                                   }));

  const failed_steps = project_failed_steps(steps);

  return {
    objective: original_failed_trace.objective,
    task: original_failed_trace.task,
    terminal_status: 'fail',
    terminal_reason: infer_terminal_reason(action_results),
    steps,
    final_state: latest_state,
    summary: {
      step_count: steps.length,
      last_action: steps.at(-1)?.action ?? null,
      last_result_kind: steps.at(-1)?.result?.kind ?? null,
      failed_steps,
    },
  };
}

function validate_replanner_output(output, available_actions) {
  if (!output || typeof output !== 'object') {
    throw new Error('Replanner output must be a JSON object.');
  }

  const keys = Object.keys(output);
  if (!keys.includes('diagnosis') || !keys.includes('actions') ||
      keys.length !== 2) {
    throw new Error(
        'Replanner output must contain exactly "diagnosis" and "actions".');
  }

  if (typeof output.diagnosis !== 'string') {
    throw new Error('diagnosis must be a string.');
  }

  if (!Array.isArray(output.actions)) {
    throw new Error('actions must be an array.');
  }

  if (output.actions.length < 1 || output.actions.length > 8) {
    throw new Error('actions must contain between 1 and 8 items.');
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

/**
 * Main recovery entry point. Called when a task fails in the structured loop.
 *
 * Accepts the failed trace, the live agent, and a single LlmClient (model).
 * Returns 'success' if recovery completed the task, or 'fail' otherwise.
 */
export async function recover_failed_task(
    failed_trace, agent, model, graph, log = null, baseline_inventory = null) {
  const available_actions = load_available_actions();
  const task = failed_trace.task;
  const previous_diagnoses = [];
  const searched_targets = new Set();

  // Restore the outer-attempt counter from a prior crash within this same
  // recovery, so the MAX_RECOVERY_ATTEMPTS budget is preserved across crashes
  // (policy (c): the prior plan body is discarded; we just don't reset the
  // attempt count to 1).
  const current_task_key = task_key(task);
  const prior_replanner =
      load_checkpoint()?.runtime_state?.active_replanner ?? null;
  const resume_attempt = (prior_replanner?.kind === 'failure' &&
                          prior_replanner.task_key === current_task_key) ?
      Math.max(1, prior_replanner.outer_attempt ?? 1) :
      1;
  if (resume_attempt > 1) {
    spl.log(`Resuming failure recovery at attempt ${resume_attempt}/${
        MAX_RECOVERY_ATTEMPTS} (prior crash, plan discarded).`);
  }

  // Tracks how the attempt loop exited so the post-loop log can be honest
  // about it. `null` means the loop ran to MAX_RECOVERY_ATTEMPTS without
  // success; any non-null value is set at the corresponding `break`.
  let exit_status = null;
  let exit_attempt = resume_attempt - 1;
  let exit_detail = null;

  try {
    for (let attempt = resume_attempt; attempt <= MAX_RECOVERY_ATTEMPTS;
         attempt++) {
      exit_attempt = attempt;
      save_runtime_state({
        active_replanner: {
          kind: 'failure',
          task_key: current_task_key,
          outer_attempt: attempt,
          action_index: 0,
          action_retry: 0,
          plan: null,
        },
      });
      spl.log(`Attempt ${attempt}/${MAX_RECOVERY_ATTEMPTS}`);

      const prompt = fill_failure_replanner_prompt(
          failed_trace, previous_diagnoses, available_actions);

      let replanner_output = null;
      try {
        const raw = await model.send_prompt(prompt);
        replanner_output = extract_json(raw);
      } catch (e) {
        spl.error('LLM call failed:', e.message);
        exit_status = 'llm_error';
        exit_detail = e.message;
        break;
      }

      if (replanner_output === null) {
        spl.warn('LLM returned null or unparseable output, skipping attempt.');
        continue;
      }

      try {
        validate_replanner_output(replanner_output, available_actions);
      } catch (e) {
        spl.warn('Validation failed:', e.message);
        exit_status = 'validation_failed';
        exit_detail = e.message;
        break;
      }

      spl.log('Diagnosis:', replanner_output.diagnosis);

      // Build the diagnosis entry up front but defer pushing it into
      // `previous_diagnoses` until the action loop completes so we can
      // attach per-action `results` to it. Without `results`, prior
      // recovery attempts only told the LLM what was tried, not what
      // happened — the message-quality work in later steps would be
      // invisible across attempts.
      const attempt_entry = {
        attempt,
        diagnosis: replanner_output.diagnosis,
        actions: replanner_output.actions,
        results: null,
      };

      log?.recovery_attempt(
          attempt, task, replanner_output.diagnosis, replanner_output.actions);

      const action_results = [];
      let latest_state = null;
      let hard_failed = false;

      for (let action_index = 0; action_index < replanner_output.actions.length;
           action_index++) {
        save_runtime_state({
          active_replanner: {
            kind: 'failure',
            task_key: current_task_key,
            outer_attempt: attempt,
            action_index,
            action_retry: 0,
            plan: null,
          },
        });
        const action = replanner_output.actions[action_index];
        const action_command = format_action_as_command(action);

        let result = null;
        for (let retry = 0; retry < MAX_ACTION_RETRIES; retry++) {
          save_runtime_state({
            active_replanner: {
              kind: 'failure',
              task_key: current_task_key,
              outer_attempt: attempt,
              action_index,
              action_retry: retry,
              plan: null,
            },
          });
          if (retry > 0)
            spl.log(
                `Retrying action (${retry}/${MAX_ACTION_RETRIES - 1}):`,
                action_command);
          else
            spl.log('Executing:', action_command);

          result = await run_action(action, agent, log, searched_targets);
          spl.log('Result:', result);

          log?.recovery_action_result(attempt, action_index, result);
          latest_state = get_recovery_trace_state(agent, baseline_inventory);

          if (scsg_task_complete_check(task, graph, agent)) {
            spl.log('Task complete after recovery.');
            log?.recovery_end('success');
            return 'success';
          }

          if (result.success || result_indicates_hard_failure(result)) break;
        }

        action_results.push(result);

        if (result_indicates_hard_failure(result)) {
          spl.warn('Hard failure, stopping action sequence:', result.kind);
          hard_failed = true;
          exit_detail = result.kind;
          break;
        }
      }

      if (latest_state === null) {
        latest_state = get_recovery_trace_state(agent, baseline_inventory);
      }

      // Attach the per-action results to this attempt's diagnosis entry
      // and push it. This runs on every non-early-return exit from the
      // action loop, including the `hard_failed` break below — so even
      // attempts that hit a hard failure are visible to subsequent
      // recovery attempts.
      attempt_entry.results = action_results.map(r => ({...r}));
      previous_diagnoses.push(attempt_entry);

      if (hard_failed) {
        exit_status = 'hard_failure';
        break;
      }

      failed_trace = build_failed_trace_from_attempt(
          failed_trace, action_results, latest_state);
    }

    if (exit_status === null) {
      spl.warn(
          `Recovery exhausted: ran all ${MAX_RECOVERY_ATTEMPTS} attempts without success.`);
    } else {
      spl.warn(`Recovery aborted at attempt ${exit_attempt}/${
          MAX_RECOVERY_ATTEMPTS} (${exit_status}${
          exit_detail ? `: ${exit_detail}` : ''}).`);
    }
    log?.recovery_end('fail');
    return 'fail';

  } finally {
    clear_active_replanner();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
