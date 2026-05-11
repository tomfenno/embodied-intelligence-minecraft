import {appendFileSync, mkdirSync, writeFileSync} from 'fs';
import path from 'path';

import {executeCommandWithModeRecovery} from '../command_utils.js';
import {get_am_state, get_recovery_trace_state} from '../agent_state.js';
import {ABSTRACT_CLASS_MEMBERS, is_environmental_use_target} from '../mc_sources.js';
import {get_item_batch_size} from '../recipe_utils.js';

import {recover_failed_task} from './failure_replanner.js';
import {make_spl} from './log.js';
import {check_search_complete, parse_search_command, run_search} from './search.js';
import {recover_failed_search} from './search_replanner.js';
import {create_command_success_result, create_step_result, normalize_result_message, project_failed_steps} from './trace.js';

const spl = make_spl('[SPL]');

const log_source = {
  deterministic: 'deterministic',
};

const max_inner_retries = 5;
const craft_debounce_ms = 750;
const max_collect_qty = 16;

// Only these kinds represent genuine command failures worth replanning.
// Search-outcome kinds (search_found_not_reached, search_exhausted, etc.)
// are navigation results, not execution failures, and should not trigger
// recovery.
const RECOVERABLE_FAILURE_KINDS = new Set([
  'command_failure',
  'mode_interrupted',
  'unstructured_failure_result',
  'runner_exception',
  'unexpected_action_kind',
]);

function has_recoverable_failure(task_trace) {
  return (task_trace.summary?.failed_steps ?? [])
      .some(s => RECOVERABLE_FAILURE_KINDS.has(s.kind));
}

export async function execute_task_action(
    task, agent, log, model = null, graph = null,
    model_search_replanner = null, breadcrumb_tracker = null) {
  const task_trace = create_task_trace(task, log);

  // Snapshot inventory once at task start so trace steps and the failure
  // replanner see this task's *delta* (current - baseline), not the global
  // absolute count. Without this the LLM gets confused on capped collect
  // tasks where prior tasks already pushed the global count above task.qty
  // (see BUG 11).
  const baseline_inventory = {...(get_am_state(agent).inventory ?? {})};

  let repeated_failure_signature = null;
  let repeated_failure_count = 0;
  const searched_targets = new Set();

  for (let attempt_index = 0; attempt_index < max_inner_retries;
       attempt_index++) {
    const attempt_number = attempt_index + 1;
    const state = get_am_state(agent);
    const action = mediate_action(task, state);

    const current_step = create_trace_step(
        attempt_number, agent, serialize_am_output(action), baseline_inventory);
    task_trace.steps.push(current_step);

    log_am_action(log, attempt_number, action, state);
    spl.log(
        `Action (attempt ${attempt_number}/${max_inner_retries}):`,
        serialize_am_output(action));

    if (action.kind !== 'command') {
      spl.warn('Unexpected AM action kind:', action.kind);
      current_step.result = create_step_result(
          false, 'unexpected_action_kind',
          `Unexpected AM action kind: ${String(action.kind)}`);
      continue;
    }

    const search_target = parse_search_command(action.command);
    if (search_target != null) {
      if (searched_targets.has(search_target)) {
        spl.warn(`Search for "${search_target}" already attempted, stopping.`);
        current_step.result = create_step_result(
            false, 'search_already_attempted',
            `Search for "${
                search_target}" already attempted in this action sequence`);
        break;
      }
      current_step.result = await handle_search_action(
          search_target, state, agent, log, attempt_number);
      if (current_step.result.kind === 'search_exhausted') {
        // Search exhausted at radius 511. Before adding to searched_targets
        // and falling through to failure_replanner, give the search replanner
        // a chance to relocate the bot. On success it has moved the bot to a
        // position where the target is now in nearby state — re-enter the
        // inner attempt loop so mediation can resolve the task with the new
        // state. On failure, fall through to the existing failure-replanner
        // path (pathfinding-class failures in particular bail early from
        // recover_failed_search so failure_replanner can attempt a different
        // recovery).
        if (model_search_replanner != null && breadcrumb_tracker != null) {
          spl.log(`Search exhausted for "${
              search_target}" — invoking search_replanner.`);
          const search_recovery = await recover_failed_search(
              search_target, agent, model_search_replanner,
              breadcrumb_tracker, log, task);
          if (search_recovery === 'success') {
            spl.log('Search replanner relocated bot — retrying task.');
            continue;
          }
          spl.log(
              'Search replanner did not recover — falling through to failure_replanner.');
        }
        searched_targets.add(search_target);  // Only block re-search when not found.
        break;
      }
      // On search_success or search_found_not_reached (PathStopped): allow
      // reattempt — bot may be closer now or path obstruction may have changed.
      continue;
    }

    const command_result = await executeCommandWithModeRecovery(agent, action.command);
    spl.log('Command result:', command_result);

    if (task.action_type === 'interact' &&
        is_successful_command_result(command_result)) {
      const interact_result = await handle_interact_success(
          task, agent, log, task_trace, attempt_number, command_result,
          baseline_inventory);

      if (interact_result.status === 'success') {
        return finalize_task_trace(
            task_trace, agent, log, 'success', 'completed', baseline_inventory);
      }

      if (interact_result.status === 'continue') {
        current_step.result = create_command_success_result(command_result);
        repeated_failure_signature = null;
        repeated_failure_count = 0;
        continue;
      }

      if (interact_result.status === 'handled_by_collect') {
        repeated_failure_signature = null;
        repeated_failure_count = 0;
        continue;
      }
    }

    if (is_successful_command_result(command_result)) {
      repeated_failure_signature = null;
      repeated_failure_count = 0;

      current_step.result = create_command_success_result(command_result);

      if (is_craft_command(action.command)) {
        spl.log(`Craft debounce: sleeping ${
            craft_debounce_ms}ms before continuing.`);
        await sleep(craft_debounce_ms);
      }

      return finalize_task_trace(
          task_trace, agent, log, 'success', 'completed', baseline_inventory);
    }

    spl.warn('Command error:', command_result);

    const failure_kind = command_result?.mode_interrupted === true ?
        'mode_interrupted' :
        'command_failure';
    current_step.result = create_step_result(
        false, failure_kind, normalize_result_message(command_result));
    if (command_result?.mode_interrupted === true) {
      // Surface per-mode tallies and net displacement to the replanner so it
      // can reason about which mode (typically unstuck) is blocking progress
      // and pick a relocation action rather than re-issuing the same command.
      current_step.result.mode_interrupt_counts =
          command_result.mode_interrupt_counts;
      current_step.result.position_before = command_result.position_before;
      current_step.result.position_after = command_result.position_after;
    }

    const failure_signature =
        get_command_failure_signature(action.command, command_result);

    if (failure_signature == null) {
      current_step.result = create_step_result(
          false, 'unstructured_failure_result',
          'command failed with unstructured or empty result');
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
            action.command, command_result, repeated_failure_count)) {
      spl.warn(
          `Aborting early after repeated identical failures (${
              repeated_failure_count}) for:`,
          action.command);

      finalize_task_trace(
          task_trace, agent, log, 'fail', 'repeated_identical_failure',
          baseline_inventory);
      if (model && has_recoverable_failure(task_trace))
        return await recover_failed_task(
            task_trace, agent, model, graph, log, baseline_inventory);
      return 'fail';
    }
  }

  finalize_task_trace(
      task_trace, agent, log, 'fail', 'exhausted_inner_retries',
      baseline_inventory);
  if (model)
    return await recover_failed_task(
        task_trace, agent, model, graph, log, baseline_inventory);
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
    return create_command_action(`!search("${source_block}")`);
  }

  if (item_dependency && is_environmental_use_target(concrete_block)) {
    return create_command_action(
        `!useOn("${item_dependency}", "${concrete_block}")`);
  }

  return create_command_action(`!collectBlocks("${concrete_block}", ${
      Math.min(task.qty, max_collect_qty)})`);
}

function resolve_concrete_block(source_block, nearby_blocks) {
  if (!source_block.startsWith('any_')) {
    return nearby_blocks.includes(source_block) ? source_block : null;
  }

  const abstract_members = ABSTRACT_CLASS_MEMBERS[source_block] ?? [];
  return abstract_members.find(
             block_name => nearby_blocks.includes(block_name)) ??
      null;
}

export function mediate_kill(task, state) {
  const {source_mob} = task.parameters;
  const nearby_mobs = state.nearby_entities?.mobs ?? [];

  if (nearby_mobs.includes(source_mob)) {
    return create_command_action(`!attack("${source_mob}")`);
  }

  return create_command_action(`!search("${source_mob}")`);
}

export function mediate_craft(task) {
  const batch_size = get_item_batch_size(task.target_item);
  const craft_count =
      batch_size > 0 ? Math.ceil(task.qty / batch_size) : task.qty;

  return create_command_action(
      `!craftRecipe("${task.target_item}", ${craft_count})`);
}

export function mediate_smelt(task, state) {
  const smelting_input = task.parameters.smelting_inputs?.[0];
  if (!smelting_input) {
    throw new Error(
        `Smelt task missing smelting_inputs: ${JSON.stringify(task)}`);
  }

  const fuel_name = resolve_smelt_fuel_name(task, state);
  const command = fuel_name ?
      `!smelt_item("${smelting_input.item}", ${smelting_input.qty}, "${
          fuel_name}")` :
      `!smelt_item("${smelting_input.item}", ${smelting_input.qty})`;

  return create_command_action(command);
}

export function mediate_interact(task, state) {
  const {tool, target} = task.parameters ?? {};

  if (!tool || !target) {
    throw new Error(
        `Interact task missing tool/target: ${JSON.stringify(task)}`);
  }

  const inventory = state.inventory ?? {};
  const nearby_blocks = state.nearby_blocks ?? [];

  // Intentional behavior: if the target is already in inventory, place it here.
  if ((inventory[target] ?? 0) > 0) {
    return create_command_action(`!placeHere("${target}")`);
  }

  if (nearby_blocks.includes(target)) {
    return create_command_action(`!useOn("${tool}", "${target}")`);
  }

  return create_command_action(`!search("${target}")`);
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

  for (const fuel_member of ABSTRACT_CLASS_MEMBERS[fuel_input.item] ?? []) {
    if ((inventory[fuel_member] ?? 0) > 0) {
      return fuel_member;
    }
  }

  return null;
}

export function serialize_am_output(action) {
  if (action.kind === 'task_complete') {
    return '{"status":"TASK_COMPLETE"}';
  }

  if (action.kind === 'command') {
    return action.command;
  }

  return JSON.stringify(action);
}

export function is_successful_command_result(result) {
  if (result == null || typeof result !== 'object' || result.success !== true) {
    return false;
  }

  if (/Collected 0 \S/.test(result.message ?? '')) {
    return false;
  }

  return true;
}

export function get_command_failure_signature(command, result) {
  if (is_successful_command_result(result)) {
    return null;
  }

  // mode_interrupted messages embed per-retry counts and a numeric
  // displacement (e.g. "unstuck×10; bot Δ=(5.2,3.0,-1.5)..."). Those numbers
  // change between attempts even when the underlying failure is the same, so
  // they would defeat repeated_failure_signature matching. Use a stable
  // signature derived from the structural flag + sorted mode names instead.
  if (result?.mode_interrupted === true) {
    const mode_names =
        Object.keys(result.mode_interrupt_counts ?? {}).sort().join(',');
    return `${command} || mode_interrupted:${mode_names || 'unknown'}`;
  }

  const message = (result?.message ?? String(result ?? ''))
                      .replace(/\d+ms/g, '<TIMEOUT>')
                      .replace(/\s+/g, ' ')
                      .trim();

  return message ? `${command} || ${message}` : null;
}

export function should_abort_repeated_failure(command, result, repeated_count) {
  const message = result?.message ?? '';

  // Fix B for BUG 15 (tightened): a single mode_interrupted failure already
  // represents MAX_MODE_INTERRUPTS (=5) consecutive mode firings on the same
  // command within one SPL attempt. That alone is conclusive evidence of a
  // livelock — there is no information gained by waiting for a second outer
  // attempt to reproduce it. Short-circuit to the failure_replanner so it can
  // choose a relocation action.
  if (result?.mode_interrupted === true && repeated_count >= 1) {
    return true;
  }

  return command.startsWith('!craftRecipe(') &&
      message.includes('Event updateSlot:0 did not fire within timeout') &&
      repeated_count >= 2;
}

export function is_craft_command(command) {
  return typeof command === 'string' &&
      (command.startsWith('!craftRecipe(') ||
       command.startsWith('!smeltItem(') || command.startsWith('!smelt_item('));
}

function create_task_trace(task, log) {
  return {
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
}

function create_trace_step(
    step_index, agent, action_output, baseline_inventory = null) {
  return {
    i: step_index,
    state: get_recovery_trace_state(agent, baseline_inventory),
    action: action_output,
    result: null,
  };
}

function create_command_action(command) {
  return {
    kind: 'command',
    command,
  };
}

function log_am_action(log, attempt_number, action, state) {
  log.am(attempt_number, serialize_am_output(action), state, {
    source: log_source.deterministic,
  });
}

async function handle_search_action(
    search_target, state, agent, log, attempt_number) {
  const {found, message: search_message} =
      await run_search(search_target, state, agent, log, attempt_number);

  if (found) {
    const post_search_state = get_am_state(agent);
    const target_reached =
        check_search_complete(search_target, post_search_state);

    spl.log(`Search found "${search_target}", re-running AM with fresh state.`);

    return target_reached ?
        create_step_result(true, 'search_success', search_message) :
        create_step_result(false, 'search_found_not_reached', search_message);
  }

  spl.warn(`Search exhausted all radii for "${search_target}", re-evaluating.`);

  return create_step_result(false, 'search_exhausted', search_message);
}

async function handle_interact_success(
    task, agent, log, task_trace, attempt_number, command_result,
    baseline_inventory = null) {
  const post_command_state = get_am_state(agent);

  if (interact_target_satisfied(task, post_command_state)) {
    return {status: 'success'};
  }

  if (!interact_target_collectable(task, post_command_state)) {
    return {status: 'continue'};
  }

  const collect_command = `!collectBlocks("${task.target_item}", ${
      Math.min(task.qty, max_collect_qty)})`;

  const collect_step = {
    i: `${attempt_number}a`,
    state: get_recovery_trace_state(agent, baseline_inventory),
    action: collect_command,
    result: null,
  };
  task_trace.steps.push(collect_step);

  log.am(attempt_number, collect_command, post_command_state, {
    source: log_source.deterministic,
  });

  spl.log('Interact produced collectable target; collecting:', collect_command);

  const collect_result = await executeCommandWithModeRecovery(agent, collect_command);
  spl.log('Collect-after-interact result:', collect_result);

  if (is_successful_command_result(collect_result)) {
    const final_state = get_am_state(agent);
    if (interact_target_satisfied(task, final_state)) {
      collect_step.result = create_command_success_result(collect_result);
      return {status: 'success'};
    }
  }

  collect_step.result = create_step_result(
      false, 'command_failure', normalize_result_message(collect_result));

  return {status: 'handled_by_collect'};
}

function finalize_task_trace(
    task_trace, agent, log, terminal_status, terminal_reason,
    baseline_inventory = null) {
  task_trace.terminal_status = terminal_status;
  task_trace.terminal_reason = terminal_reason;
  task_trace.final_state = get_recovery_trace_state(agent, baseline_inventory);
  task_trace.summary = build_summary(task_trace.steps, terminal_status);

  persist_task_trace(task_trace, log.rollout_dir);

  return terminal_status;
}

function build_summary(steps, terminal_status) {
  const last_step = steps.at(-1);
  const summary = {
    step_count: steps.length,
    last_action: last_step?.action ?? null,
    last_result_kind: last_step?.result?.kind ?? null,
  };

  if (terminal_status === 'fail') {
    summary.failed_steps = project_failed_steps(steps);
  }

  return summary;
}

function sanitize_filename_component(value) {
  return String(value ?? 'unknown').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
}

function persist_task_trace(task_trace, rollout_dir) {
  if (!rollout_dir) {
    spl.warn('No rollout_dir available; skipping task trace persistence.');
    return;
  }

  try {
    const trace_line = JSON.stringify(task_trace) + '\n';
    const parent_rollouts_dir = path.dirname(rollout_dir);

    const full_trace_dir = path.join(rollout_dir, 'task_traces');
    mkdirSync(full_trace_dir, {recursive: true});
    appendFileSync(
        path.join(full_trace_dir, 'full_task_trace.jsonl'), trace_line, 'utf8');

    const datasets_dir = path.join(parent_rollouts_dir, '_datasets');
    mkdirSync(datasets_dir, {recursive: true});

    const dataset_file = task_trace.terminal_status === 'success' ?
        'success_task_traces.jsonl' :
        'failure_task_traces.jsonl';
    appendFileSync(path.join(datasets_dir, dataset_file), trace_line, 'utf8');

    if (task_trace.terminal_status === 'fail') {
      const failed_trace_dir = path.join(rollout_dir, 'task_traces', 'failed');
      mkdirSync(failed_trace_dir, {recursive: true});

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const action_type =
          sanitize_filename_component(task_trace.task.action_type);
      const target_item =
          sanitize_filename_component(task_trace.task.target_item);
      const filename =
          `${timestamp}__${action_type}__${target_item}__fail.json`;

      writeFileSync(
          path.join(failed_trace_dir, filename),
          JSON.stringify(task_trace, null, 2), 'utf8');
    }
  } catch (err) {
    spl.error('Failed to persist task trace:', err.message);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}