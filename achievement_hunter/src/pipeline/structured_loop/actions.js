import {appendFileSync, mkdirSync, writeFileSync} from 'fs';
import path from 'path';

import {executeCommand as execute_command} from '../../../../src/agent/commands/index.js';
import {get_am_state, get_recovery_trace_state} from '../agent_state.js';
import {ABSTRACT_CLASS_MEMBERS, is_environmental_use_target} from '../mc_sources.js';
import {get_item_batch_size} from '../recipe_utils.js';

import {check_search_complete, parse_search_command, run_search} from './search.js';

const spl = {
  log: (...args) => console.log('[SPL]', ...args),
  warn: (...args) => console.warn('[SPL]', ...args),
  error: (...args) => console.error('[SPL]', ...args),
};

const log_source = {
  deterministic: 'deterministic',
};

const max_inner_retries = 5;
const craft_debounce_ms = 750;
const max_collect_qty = 16;

export async function execute_task_action(task, agent, log) {
  const task_trace = {
    ...(log.objective != null ? {objective: log.objective} : {}),
    task: {
      target_item: task.target_item,
      qty: task.qty,
      action_type: task.action_type,
      parameters: task.parameters,
    },
    terminal_status: null,
    terminal_reason: null,
    steps: [],
    final_state: null,
    summary: null,
  };

  let repeated_failure_signature = null;
  let repeated_failure_count = 0;

  for (let attempt = 0; attempt < max_inner_retries; attempt++) {
    const state = get_am_state(agent);
    const action = mediate_action(task, state);

    const current_step = {
      i: attempt + 1,
      state: get_recovery_trace_state(agent),
      action: serialize_am_output(action),
      result: null,
    };
    task_trace.steps.push(current_step);

    log.am(attempt + 1, serialize_am_output(action), state, {
      source: log_source.deterministic,
    });

    spl.log(
        `Action (attempt ${attempt + 1}/${max_inner_retries}):`,
        serialize_am_output(action));

    if (action.kind !== 'command') {
      spl.warn('Unexpected AM action kind:', action.kind);
      current_step.result = {
        success: false,
        kind: 'unexpected_action_kind',
        message: `Unexpected AM action kind: ${String(action.kind)}`,
      };
      continue;
    }

    const search_target = parse_search_command(action.command);
    if (search_target != null) {
      const {found, message: search_message} =
          await run_search(search_target, state, agent, log, attempt + 1);

      if (found) {
        const post_state = get_am_state(agent);
        const reached = check_search_complete(search_target, post_state);
        current_step.result = reached ? {
          success: true,
          kind: 'search_success',
          message: search_message,
        } :
                                        {
                                          success: false,
                                          kind: 'search_found_not_reached',
                                          message: search_message,
                                        };
        spl.log(
            `Search found "${search_target}", re-running AM with fresh state.`);
      } else {
        current_step.result = {
          success: false,
          kind: 'search_exhausted',
          message: search_message,
        };
        spl.warn(`Search exhausted all radii for "${
            search_target}", re-evaluating.`);
      }
      continue;
    }

    const result = await execute_command(agent, action.command);
    spl.log('Command result:', result);

    if (task.action_type === 'interact' &&
        is_successful_command_result(result)) {
      const post_state = get_am_state(agent);

      if (interact_target_satisfied(task, post_state)) {
        repeated_failure_signature = null;
        repeated_failure_count = 0;

        current_step.result = {
          success: true,
          kind: 'command_success',
          message: result.message != null ? String(result.message).trim() :
                                            null,
        };

        task_trace.terminal_status = 'success';
        task_trace.terminal_reason = 'completed';
        task_trace.final_state = get_recovery_trace_state(agent);
        task_trace.summary = build_summary(task_trace.steps, 'success');
        persist_task_trace(task_trace, log.rollout_dir);

        return 'success';
      }

      if (interact_target_collectable(task, post_state)) {
        const collect_command = `!collectBlocks("${task.target_item}", ${
            Math.min(task.qty, max_collect_qty)})`;

        const collect_step = {
          i: `${attempt + 1}a`,
          state: get_recovery_trace_state(agent),
          action: collect_command,
          result: null,
        };
        task_trace.steps.push(collect_step);

        log.am(attempt + 1, collect_command, post_state, {
          source: log_source.deterministic,
        });

        spl.log(
            'Interact produced collectable target; collecting:',
            collect_command);

        const collect_result = await execute_command(agent, collect_command);
        spl.log('Collect-after-interact result:', collect_result);

        if (is_successful_command_result(collect_result)) {
          const final_state = get_am_state(agent);
          if (interact_target_satisfied(task, final_state)) {
            repeated_failure_signature = null;
            repeated_failure_count = 0;

            collect_step.result = {
              success: true,
              kind: 'command_success',
              message: collect_result.message != null ?
                  String(collect_result.message).trim() :
                  null,
            };

            task_trace.terminal_status = 'success';
            task_trace.terminal_reason = 'completed';
            task_trace.final_state = get_recovery_trace_state(agent);
            task_trace.summary = build_summary(task_trace.steps, 'success');
            persist_task_trace(task_trace, log.rollout_dir);

            return 'success';
          }
        }

        collect_step.result = {
          success: false,
          kind: 'command_failure',
          message: collect_result?.message != null ?
              String(collect_result.message).trim() :
              null,
        };

        continue;
      }

      repeated_failure_signature = null;
      repeated_failure_count = 0;

      current_step.result = {
        success: true,
        kind: 'command_success',
        message: result.message != null ? String(result.message).trim() : null,
      };

      continue;
    }

    if (is_successful_command_result(result)) {
      repeated_failure_signature = null;
      repeated_failure_count = 0;

      current_step.result = {
        success: true,
        kind: 'command_success',
        message: result.message != null ? String(result.message).trim() : null,
      };

      if (is_craft_command(action.command)) {
        spl.log(`Craft debounce: sleeping ${
            craft_debounce_ms}ms before continuing.`);
        await sleep(craft_debounce_ms);
      }

      task_trace.terminal_status = 'success';
      task_trace.terminal_reason = 'completed';
      task_trace.final_state = get_recovery_trace_state(agent);
      task_trace.summary = build_summary(task_trace.steps, 'success');
      persist_task_trace(task_trace, log.rollout_dir);

      return 'success';
    }

    spl.warn('Command error:', result);

    current_step.result = {
      success: false,
      kind: 'command_failure',
      message: result?.message != null ? String(result.message).trim() : null,
    };

    const failure_signature =
        get_command_failure_signature(action.command, result);
    if (failure_signature == null) {
      current_step.result = {
        success: false,
        kind: 'unstructured_failure_result',
        message: 'command failed with unstructured or empty result',
      };
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

      task_trace.terminal_status = 'fail';
      task_trace.terminal_reason = 'repeated_identical_failure';
      task_trace.final_state = get_recovery_trace_state(agent);
      task_trace.summary = build_summary(task_trace.steps, 'fail');
      persist_task_trace(task_trace, log.rollout_dir);

      return 'fail';
    }
  }

  task_trace.terminal_status = 'fail';
  task_trace.terminal_reason = 'exhausted_inner_retries';
  task_trace.final_state = get_recovery_trace_state(agent);
  task_trace.summary = build_summary(task_trace.steps, 'fail');
  persist_task_trace(task_trace, log.rollout_dir);

  return 'fail';
}

export function mediate_action(task, state) {
  switch (task.action_type) {
    case 'collect':
      return mediate_collect(task, state);
    case 'kill':
      return mediate_kill(task, state);
    case 'craft':
      return mediate_craft(task);
    case 'smelt':
      return mediate_smelt(task, state);
    case 'interact':
      return mediate_interact(task, state);
    default:
      throw new Error(`Unsupported action_type: "${task.action_type}"`);
  }
}

export function mediate_collect(task, state) {
  const {source_block, item_dependency} = task.parameters;
  const nearby_blocks = state.nearby_blocks ?? [];

  const concrete_block = resolve_concrete_block(source_block, nearby_blocks);
  if (!concrete_block) {
    return {kind: 'command', command: `!search("${source_block}")`};
  }

  return item_dependency && is_environmental_use_target(concrete_block) ?
      {
        kind: 'command',
        command: `!useOn("${item_dependency}", "${concrete_block}")`,
      } :
      {
        kind: 'command',
        command: `!collectBlocks("${concrete_block}", ${
            Math.min(task.qty, max_collect_qty)})`,
      };
}

function resolve_concrete_block(source_block, nearby_blocks) {
  if (!source_block.startsWith('any_')) {
    return nearby_blocks.includes(source_block) ? source_block : null;
  }
  const members = ABSTRACT_CLASS_MEMBERS[source_block] ?? [];
  return members.find(b => nearby_blocks.includes(b)) ?? null;
}

export function mediate_kill(task, state) {
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

export function mediate_craft(task) {
  const batch_size = get_item_batch_size(task.target_item);
  const crafts = batch_size > 0 ? Math.ceil(task.qty / batch_size) : task.qty;

  return {
    kind: 'command',
    command: `!craftRecipe("${task.target_item}", ${crafts})`,
  };
}

export function mediate_smelt(task, state) {
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

export function mediate_interact(task, state) {
  const {tool, target} = task.parameters ?? {};

  if (!tool || !target) {
    throw new Error(
        `Interact task missing tool/target: ${JSON.stringify(task)}`);
  }

  const inventory = state.inventory ?? {};
  const nearby_blocks = state.nearby_blocks ?? [];

  if ((inventory[target] ?? 0) > 0) {
    return {
      kind: 'command',
      command: `!placeHere("${target}")`,
    };
  }

  if (nearby_blocks.includes(target)) {
    return {
      kind: 'command',
      command: `!useOn("${tool}", "${target}")`,
    };
  }

  return {
    kind: 'command',
    command: `!search("${target}")`,
  };
}

function interact_target_satisfied(task, state) {
  const inventory = state.inventory ?? {};
  return (inventory[task.target_item] ?? 0) >= task.qty;
}

function interact_target_collectable(task, state) {
  const nearby_blocks = state.nearby_blocks ?? [];
  return nearby_blocks.includes(task.target_item);
}

export function resolve_smelt_fuel_name(task, state) {
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

export function serialize_am_output(action) {
  return action.kind === 'task_complete' ? '{"status":"TASK_COMPLETE"}' :
      action.kind === 'command'          ? action.command :
                                           JSON.stringify(action);
}

export function is_successful_command_result(result) {
  if (result == null || typeof result !== 'object' || result.success !== true)
    return false;
  if (/Collected 0 \S/.test(result.message ?? '')) return false;
  return true;
}

export function get_command_failure_signature(command, result) {
  if (is_successful_command_result(result)) return null;
  const message = (result?.message ?? String(result ?? ''))
                      .replace(/\d+ms/g, '<TIMEOUT>')
                      .replace(/\s+/g, ' ')
                      .trim();
  return message ? `${command} || ${message}` : null;
}

export function should_abort_repeated_failure(
    task, command, result, repeated_count) {
  const message = result?.message ?? '';
  return command.startsWith('!craftRecipe(') &&
      message.includes('Event updateSlot:0 did not fire within timeout') &&
      repeated_count >= 2;
}

export function is_craft_command(command) {
  return typeof command === 'string' &&
      (command.startsWith('!craftRecipe(') ||
       command.startsWith('!smeltItem(') || command.startsWith('!smelt_item('));
}

function build_summary(steps, terminal_status) {
  const last = steps.at(-1);
  const summary = {
    step_count: steps.length,
    last_action: last?.action ?? null,
    last_result_kind: last?.result?.kind ?? null,
  };

  if (terminal_status === 'fail') {
    summary.failed_steps = steps.filter(s => s.result?.success === false)
                               .map(s => ({
                                      i: s.i,
                                      action: s.action,
                                      kind: s.result.kind,
                                      message: s.result.message,
                                    }));
  }

  return summary;
}

function sanitize_filename_component(s) {
  return String(s ?? 'unknown').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
}

function persist_task_trace(task_trace, rollout_dir) {
  if (!rollout_dir) {
    spl.warn('No rollout_dir available; skipping task trace persistence.');
    return;
  }

  try {
    const line = JSON.stringify(task_trace) + '\n';
    const rollouts_dir = path.dirname(rollout_dir);

    const full_trace_dir = path.join(rollout_dir, 'task_traces');
    mkdirSync(full_trace_dir, {recursive: true});
    appendFileSync(
        path.join(full_trace_dir, 'full_task_trace.jsonl'), line, 'utf8');

    const datasets_dir = path.join(rollouts_dir, '_datasets');
    mkdirSync(datasets_dir, {recursive: true});
    const dataset_file = task_trace.terminal_status === 'success' ?
        'success_task_traces.jsonl' :
        'failure_task_traces.jsonl';
    appendFileSync(path.join(datasets_dir, dataset_file), line, 'utf8');

    if (task_trace.terminal_status === 'fail') {
      const failed_dir = path.join(rollout_dir, 'task_traces', 'failed');
      mkdirSync(failed_dir, {recursive: true});
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const action_type =
          sanitize_filename_component(task_trace.task.action_type);
      const target_item =
          sanitize_filename_component(task_trace.task.target_item);
      const filename = `${ts}__${action_type}__${target_item}__fail.json`;
      writeFileSync(
          path.join(failed_dir, filename), JSON.stringify(task_trace, null, 2),
          'utf8');
    }
  } catch (err) {
    spl.error('Failed to persist task trace:', err.message);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}