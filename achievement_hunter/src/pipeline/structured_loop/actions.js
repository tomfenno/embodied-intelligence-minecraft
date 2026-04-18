import {executeCommand as execute_command} from '../../../../src/agent/commands/index.js';
import {get_am_state} from '../agent_state.js';
import {ABSTRACT_CLASS_MEMBERS, is_environmental_use_target} from '../mc_sources.js';
import {get_item_batch_size} from '../recipe_utils.js';

import {parse_search_command, run_search} from './search.js';

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

export async function execute_task_action(task, agent, log) {
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
    default:
      throw new Error(`Unsupported action_type: "${task.action_type}"`);
  }
}

export function mediate_collect(task, state) {
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
  return result != null && typeof result === 'object' &&
      result.success === true;
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
