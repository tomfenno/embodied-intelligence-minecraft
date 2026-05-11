import {readFileSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

import {executeCommandWithModeRecovery} from '../command_utils.js';
import * as skills from '../../../../src/agent/library/skills.js';
import {get_am_state, get_recovery_trace_state, get_sgsg_state} from '../agent_state.js';
import {extract_json} from '../json_utils.js';
import {fill_failure_replanner_prompt} from '../prompt_utils.js';
import {compute_scsg} from '../scsg.js';

import {make_spl} from './log.js';
import {check_search_complete, run_search} from './search.js';
import {create_action_result, project_failed_steps} from './trace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AVAILABLE_ACTIONS_PATH = path.join(
    __dirname,
    '../../../docs/prompts/failure_replanner/actions_reference.json');

const MAX_RECOVERY_ATTEMPTS = 3;
const MAX_ACTION_RETRIES = 3;

const craft_debounce_ms = 750;

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
function format_action_as_command(action) {
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
    const env_result = await executeCommandWithModeRecovery(agent, command);
    await sleep(craft_debounce_ms);
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

  if (searched_targets.has(target)) {
    return create_action_result(
        command, false, 'search_already_attempted',
        `Search for "${target}" already attempted in this recovery sequence`);
  }

  try {
    const state = get_am_state(agent);
    const {found, message} = await run_search(target, state, agent, log, 0);
    await sleep(craft_debounce_ms);

    if (!found) {
      searched_targets.add(target);
      return create_action_result(
          command, false, 'search_exhausted', message);
    }

    const target_reached =
        check_search_complete(target, get_am_state(agent));
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

async function ensure_safe_before_llm(agent) {
  const bot = agent.bot;
  const block = bot.blockAt(bot.entity.position);
  const block_above = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  const block_below = bot.blockAt(bot.entity.position.offset(0, -1, 0));

  const in_water =
      block_below?.name === 'water' || block_above?.name === 'water';
  const in_lava = block?.name === 'lava' || block_above?.name === 'lava';

  try {
    if (in_water) {
      await skills.moveAway(bot, 10);
    } else if (in_lava) {
      await bot.lookAt(bot.entity.position.offset(5, 1, 0), true);
      bot.setControlState('jump', true);
      bot.setControlState('sprint', true);
      await new Promise(r => setTimeout(r, 3000));
      bot.clearControlStates();
    }
  } catch (e) {
    // A mode (self_preservation) raced with this escape and won — it moved the
    // bot to safety already. Log and proceed; the mode's escape is sufficient.
    spl.warn(`ensure_safe_before_llm: escape interrupted (${
        e.message}) — mode moved bot to safety.`);
  }
}

/**
 * Main recovery entry point. Called when a task fails in the structured loop.
 *
 * Accepts the failed trace, the live agent, and a single LlmClient (model).
 * Returns 'success' if recovery completed the task, or 'fail' otherwise.
 */
export async function recover_failed_task(
    failed_trace, agent, model, graph, log = null,
    baseline_inventory = null) {
  const available_actions = load_available_actions();
  const task = failed_trace.task;
  const previous_diagnoses = [];
  const searched_targets = new Set();

  for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
    spl.log(`Attempt ${attempt}/${MAX_RECOVERY_ATTEMPTS}`);

    const prompt = fill_failure_replanner_prompt(
        failed_trace, previous_diagnoses, available_actions);

    await ensure_safe_before_llm(agent);

    let replanner_output = null;
    try {
      const raw = await model.send_prompt(prompt);
      replanner_output = extract_json(raw);
    } catch (e) {
      spl.error('LLM call failed:', e.message);
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
      break;
    }

    spl.log('Diagnosis:', replanner_output.diagnosis);

    previous_diagnoses.push({
      attempt,
      diagnosis: replanner_output.diagnosis,
      actions: replanner_output.actions,
    });

    log?.recovery_attempt(
        attempt, task, replanner_output.diagnosis, replanner_output.actions);

    const action_results = [];
    let latest_state = null;
    let hard_failed = false;

    for (let action_index = 0; action_index < replanner_output.actions.length;
         action_index++) {
      const action = replanner_output.actions[action_index];
      const action_command = format_action_as_command(action);

      let result = null;
      for (let retry = 0; retry < MAX_ACTION_RETRIES; retry++) {
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
        break;
      }
    }

    if (latest_state === null) {
      latest_state = get_recovery_trace_state(agent, baseline_inventory);
    }

    if (hard_failed) break;

    failed_trace = build_failed_trace_from_attempt(
        failed_trace, action_results, latest_state);
  }

  spl.warn(`Recovery exhausted after ${MAX_RECOVERY_ATTEMPTS} attempts.`);
  log?.recovery_end('fail');
  return 'fail';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
