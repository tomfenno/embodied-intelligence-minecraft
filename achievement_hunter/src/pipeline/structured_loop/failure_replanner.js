import {readFileSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

import {executeCommand} from '../../../../src/agent/commands/index.js';
import * as skills from '../../../../src/agent/library/skills.js';
import {get_recovery_trace_state, get_sgsg_state} from '../agent_state.js';
import {extract_json} from '../json_utils.js';
import {compute_scsg} from '../scsg.js';
import {fill_failure_replanner_prompt} from '../prompt_utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AVAILABLE_ACTIONS_PATH =
    path.join(__dirname, '../../../docs/prompts/failure_replanner/actions_reference.json');

const MAX_RECOVERY_ATTEMPTS = 3;
const MAX_ACTION_RETRIES = 3;

const HARD_FAILURE_KINDS =
    new Set(['runner_exception', 'invalid_command', 'unavailable_action']);

const spl = {
  log: (...args) => console.log('[SPL][recovery]', ...args),
  warn: (...args) => console.warn('[SPL][recovery]', ...args),
  error: (...args) => console.error('[SPL][recovery]', ...args),
};

let _available_actions = null;
function load_available_actions() {
  if (!_available_actions) {
    _available_actions =
        JSON.parse(readFileSync(AVAILABLE_ACTIONS_PATH, 'utf8'));
  }
  return _available_actions;
}

// Converts {name, args} into a bot command string e.g. !searchForBlock("pumpkin", 512)
function format_action_as_command(action) {
  const formatted_args = action.args.map(arg => {
    if (typeof arg === 'string') return JSON.stringify(arg);
    if (typeof arg === 'boolean') return arg ? 'true' : 'false';
    if (arg === null) return 'null';
    return String(arg);
  });
  return `${action.name}(${formatted_args.join(', ')})`;
}

async function run_action(action, agent) {
  const command = format_action_as_command(action);
  const is_lava_useOn = command.startsWith('!useOn(') && command.includes('"lava"');

  if (is_lava_useOn) agent.bot.setControlState('sneak', true);
  try {
    const env_result = await executeCommand(agent, command);
    return {
      command,
      success: env_result?.success === true,
      kind: env_result?.success === true ? 'command_success' : 'command_failure',
      message: env_result?.message ?? null,
    };
  } catch (e) {
    return {
      command,
      success: false,
      kind: 'runner_exception',
      message: String(e),
    };
  } finally {
    if (is_lava_useOn) agent.bot.setControlState('sneak', false);
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

  const failed_steps = steps.filter(s => !s.result.success).map(s => ({
    i: s.i,
    action: s.action,
    kind: s.result.kind,
    message: s.result.message,
  }));

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
      throw new Error(`Action args must be an array: ${JSON.stringify(action)}`);
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

  const in_water = block?.name === 'water' || block_above?.name === 'water';
  const in_lava  = block?.name === 'lava'  || block_above?.name === 'lava';

  if (in_water) {
    await skills.moveAway(bot, 10);
  } else if (in_lava) {
    await bot.lookAt(bot.entity.position.offset(5, 1, 0), true);
    bot.setControlState('jump', true);
    bot.setControlState('sprint', true);
    await new Promise(r => setTimeout(r, 3000));
    bot.clearControlStates();
  }
}

/**
 * Main recovery entry point. Called when a task fails in the structured loop.
 *
 * Accepts the failed trace, the live agent, and a single LlmClient (model).
 * Returns 'success' if recovery completed the task, or 'fail' otherwise.
 */
export async function recover_failed_task(failed_trace, agent, model, graph, log = null) {
  const available_actions = load_available_actions();
  const task = failed_trace.task;
  const previous_diagnoses = [];

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

    log?.recovery_attempt(attempt, task, replanner_output.diagnosis, replanner_output.actions);

    const action_results = [];
    let latest_state = null;
    let hard_failed = false;

    for (let action_index = 0; action_index < replanner_output.actions.length; action_index++) {
      const action = replanner_output.actions[action_index];

      let result = null;
      for (let retry = 0; retry < MAX_ACTION_RETRIES; retry++) {
        if (retry > 0) spl.log(`Retrying action (${retry}/${MAX_ACTION_RETRIES - 1}):`, format_action_as_command(action));
        else spl.log('Executing:', format_action_as_command(action));

        result = await run_action(action, agent);
        spl.log('Result:', result);

        log?.recovery_action_result(attempt, action_index, result);
        latest_state = get_recovery_trace_state(agent);

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
      latest_state = get_recovery_trace_state(agent);
    }

    if (hard_failed) break;

    failed_trace =
        build_failed_trace_from_attempt(failed_trace, action_results, latest_state);
  }

  spl.warn(`Recovery exhausted after ${MAX_RECOVERY_ATTEMPTS} attempts.`);
  log?.recovery_end('fail');
  return 'fail';
}
