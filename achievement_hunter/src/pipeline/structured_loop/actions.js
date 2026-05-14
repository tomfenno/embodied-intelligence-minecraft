import {mkdirSync} from 'fs';
import path from 'path';

import {executeCommandWithModeRecovery} from '../command_utils.js';
import {get_am_state, get_recovery_trace_state} from '../agent_state.js';
import {clearActiveReplanner as clear_active_replanner, clearActiveTask as clear_active_task, loadCheckpoint as load_checkpoint, saveRuntimeState as save_runtime_state,} from '../checkpoint.js';
import {ioQueue} from '../io_queue.js';
import {ABSTRACT_CLASS_MEMBERS, is_environmental_use_target} from '../mc_sources.js';
import {get_item_batch_size} from '../recipe_utils.js';

import {
  CRAFT_DEBOUNCE_MS,
  MAX_COLLECT_QTY,
  MAX_INNER_RETRIES,
  SEARCH_RADII,
} from './config.js';
import {recover_failed_task} from './failure_replanner.js';
import {make_spl} from './log.js';
import {
  build_command_failure_message,
  build_search_already_attempted_message,
} from './result_messages.js';
import {check_search_complete, parse_search_command, run_breadth_first_sweep, run_search} from './search.js';
import {recover_failed_search} from './search_replanner.js';
import {build_dependency_context} from './dependency_context.js';
import {task_key} from './tasks.js';
import {create_command_success_result, create_step_result, normalize_result_message, project_failed_steps} from './trace.js';

const spl = make_spl('[SPL]');

const log_source = {
  deterministic: 'deterministic',
};

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
  // Multi-target search sweep tasks are inherently multi-command and
  // bypass `mediate_action` (which is single-command oriented). Handled
  // inline by handle_search_sweep before any per-attempt mediation runs.
  if (task.action_type === 'search_sweep') {
    return await handle_search_sweep(
        task, agent, log, model, graph, model_search_replanner,
        breadcrumb_tracker);
  }

  const task_trace = create_task_trace(task, log);

  // Per-attempt state cache: shared between the `get_am_state` reads at
  // the top of each iteration and the `get_recovery_trace_state` call used
  // to build the trace step (which internally also needs am_state).
  // Invalidated after each executed command — see comments on
  // `make_attempt_state_cache`.
  const state_cache = make_attempt_state_cache(agent);

  // Snapshot inventory once at task start so trace steps and the failure
  // replanner see this task's *delta* (current - baseline), not the global
  // absolute count. Without this the LLM gets confused on capped collect
  // tasks where prior tasks already pushed the global count above task.qty
  // (see BUG 11).
  const baseline_inventory = {...(state_cache.read_am().inventory ?? {})};

  // Restore inner-loop counters from the checkpoint if a prior process died
  // executing this same task. Mismatched task_key means the prior crash was
  // on a different task — overwrite with fresh state (and drop any stale
  // active_replanner, which was scoped to that prior task).
  const current_task_key = task_key(task);
  const prior_active_task =
      load_checkpoint()?.runtime_state?.active_task ?? null;
  const resume_from_crash = prior_active_task?.key === current_task_key;

  let repeated_failure_signature =
      resume_from_crash ? prior_active_task.repeated_failure_signature : null;
  let repeated_failure_count =
      resume_from_crash ? prior_active_task.repeated_failure_count ?? 0 : 0;
  const searched_targets = new Set(
      resume_from_crash ? prior_active_task.searched_targets ?? [] : []);
  // Parallel map carrying the structured outcome of each dedup-recorded
  // search. Read when the dedup short-circuit fires so the
  // `search_already_attempted` message can include the prior_kind /
  // prior_detail rather than a bare "already attempted" string. Stored
  // alongside `searched_targets` so the two stay in lockstep; persisted
  // as an entries array since Map isn't JSON-serialisable.
  const searched_targets_outcomes = new Map(
      resume_from_crash ? prior_active_task.searched_targets_outcomes ?? [] :
                          []);
  const initial_attempt_index =
      resume_from_crash ? prior_active_task.attempt_index ?? 0 : 0;

  if (resume_from_crash) {
    spl.log(`Resuming task ${current_task_key} from attempt_index=${
        initial_attempt_index} (searched=${searched_targets.size}).`);
  } else if (prior_active_task != null) {
    // Stale replanner state from a different task — drop it now so the next
    // replanner invocation starts fresh.
    clear_active_replanner();
  }

  const persist_active_task = (attempt_index) => save_runtime_state({
    active_task: {
      key: current_task_key,
      attempt_index,
      searched_targets: [...searched_targets],
      searched_targets_outcomes: [...searched_targets_outcomes.entries()],
      repeated_failure_signature,
      repeated_failure_count,
    },
  });

  try {

  for (let attempt_index = initial_attempt_index;
       attempt_index < MAX_INNER_RETRIES;
       attempt_index++) {
    persist_active_task(attempt_index);
    const attempt_number = attempt_index + 1;
    state_cache.invalidate();
    const state = state_cache.read_am();
    const action = mediate_action(task, state);

    const current_step = create_trace_step(
        attempt_number, serialize_am_output(action),
        state_cache.read_recovery(baseline_inventory), task, state, agent);
    task_trace.steps.push(current_step);

    log_am_action(log, attempt_number, action, state);
    spl.log(
        `Action (attempt ${attempt_number}/${MAX_INNER_RETRIES}):`,
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
        const prior = searched_targets_outcomes.get(search_target);
        current_step.result = create_step_result(
            false, 'search_already_attempted',
            build_search_already_attempted_message({
              target: search_target,
              prior_kind: prior?.kind,
              prior_detail: prior?.detail,
            }));
        break;
      }
      current_step.result = await handle_search_action(
          search_target, state, agent, log, attempt_number);
      if (agent.bot._ah_death_pending) {
        spl.log(`Bot death observed after handle_search_action — aborting task.`);
        return 'death';
      }
      // Both search_exhausted (no instance anywhere) and
      // search_found_not_reached (located but pathfinder failed) are
      // outcomes the search_replanner can act on. Today's routing
      // historically only fired on search_exhausted, which left the
      // located-but-unreachable case to fall straight through to the
      // failure_replanner with less context than the search_replanner
      // would have. Route both to search_replanner; if it can't recover,
      // we still fall through to failure_replanner below.
      const result_kind = current_step.result.kind;
      if (result_kind === 'search_exhausted' ||
          result_kind === 'search_found_not_reached') {
        if (model_search_replanner != null && breadcrumb_tracker != null) {
          spl.log(`Search ${result_kind === 'search_exhausted'
              ? 'exhausted'
              : 'found-not-reached'} for "${search_target}" — invoking search_replanner.`);
          const search_recovery = await recover_failed_search(
              [search_target], agent, model_search_replanner,
              breadcrumb_tracker, log, task,
              current_step.result?.message ?? null,
              /*seed_sweep_outcomes=*/ null,
              /*seed_failure_kind=*/ result_kind);
          if (agent.bot._ah_death_pending) {
            spl.log(`Bot death observed after search_replanner — aborting task.`);
            return 'death';
          }
          if (search_recovery === 'success') {
            spl.log('Search replanner relocated bot — retrying task.');
            continue;
          }
          spl.log(
              'Search replanner did not recover — falling through to failure_replanner.');
        }
        // Record the structured outcome so a later !search for the same
        // target in this task hits the dedup path with prior context.
        searched_targets.add(search_target);
        searched_targets_outcomes.set(search_target, {
          kind: result_kind,
          detail: search_step_prior_detail(current_step.result),
        });
        break;
      }
      // On search_success: don't consume an attempt slot. A successful
      // !search is preparation, not task progress — the next iteration's
      // AM will pick the actual task action once it sees the target in
      // nearby state. Decrement to compensate for the for-loop's
      // increment, so the next iteration runs at the same attempt_index.
      if (current_step.result.kind === 'search_success') {
        attempt_index--;
      }
      continue;
    }

    const command_result = await executeCommandWithModeRecovery(agent, action.command);
    state_cache.invalidate();
    spl.log('Command result:', command_result);

    if (command_result?.bot_died === true) {
      spl.log(`Bot death observed in command result — aborting task.`);
      return 'death';
    }

    if (task.action_type === 'interact' &&
        is_successful_command_result(command_result)) {
      const interact_result = await handle_interact_success(
          task, agent, log, task_trace, attempt_number, command_result,
          baseline_inventory, state_cache);
      if (agent.bot._ah_death_pending) {
        spl.log(`Bot death observed after interact success handler — aborting task.`);
        return 'death';
      }

      if (interact_result.status === 'success') {
        return finalize_task_trace(
            task_trace, agent, log, 'success', 'completed', baseline_inventory);
      }

      if (interact_result.status === 'continue') {
        current_step.result =
            create_command_success_result(command_result, action.command);
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

      current_step.result =
          create_command_success_result(command_result, action.command);

      if (is_craft_command(action.command)) {
        spl.log(`Craft debounce: sleeping ${
            CRAFT_DEBOUNCE_MS}ms before continuing.`);
        await sleep(CRAFT_DEBOUNCE_MS);
      }

      return finalize_task_trace(
          task_trace, agent, log, 'success', 'completed', baseline_inventory);
    }

    spl.warn('Command error:', command_result);

    const failure_kind = command_result?.mode_interrupted === true ?
        'mode_interrupted' :
        'command_failure';
    // command_failure messages flow from three sources:
    //   1. Verifier reclassification (command_utils.js): already
    //      composed via build_command_failure_message, signalled by
    //      command_result.verifier_reason != null.
    //   2. Skill returned success=false outright: raw skill blob in
    //      command_result.message. Wrap here so the replanner sees the
    //      same `cmd=...; verifier=n/a; root_cause=...; pos=...` shape.
    //   3. mode_interrupted: carries a structured message from
    //      build_mode_interrupted_result; keep that path untouched.
    // Without the verifier_reason discriminator, case (1) would be
    // double-wrapped: parse_skill_output on an already-formatted
    // headline returns root_cause=unknown, and the verifier reason and
    // located coords would both be lost.
    let failure_message;
    if (failure_kind === 'command_failure') {
      if (command_result?.verifier_reason != null) {
        failure_message = normalize_result_message(command_result);
      } else {
        failure_message = build_command_failure_message({
          command: action.command,
          verifier_reason: null,
          skill_output: normalize_result_message(command_result),
          position: agent?.bot?.entity?.position ?? null,
        });
      }
    } else {
      failure_message = normalize_result_message(command_result);
    }
    current_step.result = create_step_result(
        false, failure_kind, failure_message);
    if (command_result?.mode_interrupted === true) {
      // Surface per-mode tallies, per-mode trigger reasons, and net
      // displacement to the replanner so it can reason about which mode
      // (and why) is blocking progress and pick a relocation action
      // rather than re-issuing the same command.
      current_step.result.mode_interrupt_counts =
          command_result.mode_interrupt_counts;
      if (command_result.mode_reasons != null) {
        current_step.result.mode_reasons = command_result.mode_reasons;
      }
      current_step.result.position_before = command_result.position_before;
      current_step.result.position_after = command_result.position_after;
    }
    if (command_result?.verifier_reason != null) {
      // Mirror the mode_interrupt_counts pattern above: when the
      // verifier reclassified the result, surface its identifier as a
      // structured field on the trace step. The LLM still reads
      // `verifier=<reason>` from the message string, but downstream
      // consumers (project_failed_steps, dashboards) get direct
      // access without parsing prose.
      current_step.result.verifier_reason = command_result.verifier_reason;
    }

    const failure_signature =
        get_command_failure_signature(action.command, command_result);

    if (failure_signature == null) {
      // The skill returned a truthy result with no usable message
      // (success=false, no recognisable error text). Surface whatever
      // structure the raw result *does* have so the replanner gets
      // something better than an empty-feeling stock string. Lists the
      // top-level keys and serialises primitive values for each; nested
      // objects are summarised as `<object>` to keep the message short.
      current_step.result = create_step_result(
          false, 'unstructured_failure_result',
          build_unstructured_failure_message(action.command, command_result));
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
      if (model && has_recoverable_failure(task_trace)) {
        const recovery = await recover_failed_task(
            task_trace, agent, model, graph, log, baseline_inventory);
        if (agent.bot._ah_death_pending) {
          spl.log(`Bot death observed after failure_replanner — aborting task.`);
          return 'death';
        }
        return recovery;
      }
      return 'fail';
    }
  }

  finalize_task_trace(
      task_trace, agent, log, 'fail', 'exhausted_inner_retries',
      baseline_inventory);
  if (model) {
    const recovery = await recover_failed_task(
        task_trace, agent, model, graph, log, baseline_inventory);
    if (agent.bot._ah_death_pending) {
      spl.log(`Bot death observed after failure_replanner (exhausted retries) — aborting task.`);
      return 'death';
    }
    return recovery;
  }
  return 'fail';

  } finally {
    // Whichever way we exit (success, fail, recovery, exception), this task
    // is done — clear its checkpoint slice so the next task starts fresh and
    // a crash in the *next* iteration doesn't get misattributed to this one.
    clear_active_task();
    clear_active_replanner();
  }
}

/**
 * Handles `action_type: 'search_sweep'` tasks (emitted by tier 4 in
 * `tasks.js:make_fallback_search_sweep_task`). The whole sweep is one
 * inner-loop attempt (D7); it runs `run_breadth_first_sweep` across the
 * full target list at breadth-first radii. Any one success exits; only
 * when every target exhausts at every radius do we escalate to
 * `search_replanner` with the full list (D3), then to `failure_replanner`
 * if that also fails.
 *
 * Trace shape: a single summary step with action
 * `search_sweep([t1, t2, …])` and a result kind of either
 * `sweep_target_found` or `sweep_exhausted`. The per-radius
 * `!searchForBlock` / `!searchForEntity` commands are logged separately
 * into the rollout_trace via `log.am(...)` calls inside the breadth-first
 * helper — they're visible in `rollout_trace.json` but don't bloat the
 * task_trace.
 */
async function handle_search_sweep(
    task, agent, log, model, graph, model_search_replanner,
    breadcrumb_tracker) {
  const task_trace = create_task_trace(task, log);
  const baseline_inventory = {...(get_am_state(agent).inventory ?? {})};

  // Record the active task so a crash mid-sweep is detected by the
  // crash-bump rule in loop.js. The sweep itself is a single inner attempt
  // with no per-attempt counter to restore, so we just persist a marker.
  const current_task_key = task_key(task);
  save_runtime_state({
    active_task: {
      key: current_task_key,
      attempt_index: 0,
      searched_targets: [],
      repeated_failure_signature: null,
      repeated_failure_count: 0,
    },
  });
  // Drop any stale active_replanner from a prior task.
  clear_active_replanner();

  try {

  const sources = task.parameters.targets.map(t => t.source);
  const targets_display = sources.join(', ');
  spl.log(`Search sweep starting: targets=[${targets_display}]`);

  const sweep_step = {
    i: 1,
    state: get_recovery_trace_state(agent, baseline_inventory),
    dependency_context: null,
    action: `search_sweep([${targets_display}])`,
    result: null,
  };
  task_trace.steps.push(sweep_step);

  const searched_targets = new Set();
  const sweep_result = await run_breadth_first_sweep(
      sources, agent, log, searched_targets, /*start_attempt=*/ 0);

  if (sweep_result.bot_died === true || agent.bot._ah_death_pending) {
    spl.log(`Bot death observed after sweep — aborting sweep task.`);
    return 'death';
  }

  if (sweep_result.found) {
    spl.log(`Sweep found "${sweep_result.item}" (from "${
        sweep_result.source}") — SPL outer loop will resume.`);
    sweep_step.result = create_step_result(
        true, 'sweep_target_found',
        `Found "${sweep_result.item}" via candidate "${sweep_result.source}"`);
    // Per-source outcomes surface which sources won, which were tried,
    // and which were never reached. Useful for offline analysis and any
    // downstream consumers (e.g. failure_replanner if a future
    // success-side recovery path is wired).
    sweep_step.result.per_source_outcomes = sweep_result.outcomes;
    return finalize_task_trace(
        task_trace, agent, log, 'success', 'sweep_target_found',
        baseline_inventory);
  }

  // All sources exhausted at all radii. Per D3, escalate to search_replanner
  // with the FULL exhausted list — the LLM picks a relocation strategy that
  // helps any one of them, rather than committing to vertex-0.
  spl.log(`Sweep exhausted: [${sweep_result.sources_exhausted.join(', ')}]`);
  sweep_step.result = create_step_result(
      false, 'sweep_exhausted',
      `sweep_exhausted: sources=[${
          sweep_result.sources_exhausted.join(',')}]; radii_tried=[${
          SEARCH_RADII.join(',')}]`);
  // Per-source outcomes distinguish exhaustion-at-max-radius from
  // found-not-reached (pathfinder failed) from soft-skipped (unsupported
  // abstract). Surfaces this info into project_failed_steps for the
  // failure_replanner fall-through.
  sweep_step.result.per_source_outcomes = sweep_result.outcomes;

  if (model_search_replanner != null && breadcrumb_tracker != null) {
    spl.log('Invoking search_replanner with full exhausted target list.');
    const recovery = await recover_failed_search(
        sweep_result.sources_exhausted, agent, model_search_replanner,
        breadcrumb_tracker, log, task,
        /*seed_failure_message=*/ null,
        /*seed_sweep_outcomes=*/ sweep_result.outcomes);
    if (agent.bot._ah_death_pending) {
      spl.log(`Bot death observed after sweep search_replanner — aborting task.`);
      return 'death';
    }
    if (recovery === 'success') {
      spl.log(
          'Search replanner relocated bot — sweep task succeeds by proxy.');
      return finalize_task_trace(
          task_trace, agent, log, 'success', 'sweep_replanner_relocated',
          baseline_inventory);
    }
    spl.log(
        'Search replanner failed — falling through to failure_replanner.');
  }

  finalize_task_trace(
      task_trace, agent, log, 'fail', 'sweep_exhausted', baseline_inventory);
  if (model) {
    const recovery = await recover_failed_task(
        task_trace, agent, model, graph, log, baseline_inventory);
    if (agent.bot._ah_death_pending) {
      spl.log(`Bot death observed after sweep failure_replanner — aborting task.`);
      return 'death';
    }
    return recovery;
  }
  return 'fail';

  } finally {
    clear_active_task();
    clear_active_replanner();
  }
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
      Math.min(task.qty, MAX_COLLECT_QTY)})`);
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

  // The legacy /Collected 0 \S/ message filter was removed when the
  // !collectBlocks verifier shipped in Phase 1 of the command_verifier
  // plan. The verifier checks the actual inventory delta in
  // `executeCommandWithModeRecovery` and flips `success: false` when no
  // blocks were collected — so this function no longer needs to detect
  // it via message regex.

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

// Compact textual summary of a search-step result, used to populate the
// `prior_detail` field of a subsequent `search_already_attempted`
// message. We don't store the full message verbatim — it's already in
// the trace — just the few fields that change the LLM's relocate/fix
// decision: located_at / distance and blocker_kind.
function search_step_prior_detail(step_result) {
  const parts = [];
  if (step_result?.message) {
    // The structured message itself ("search_exhausted: …", etc.) is the
    // best detail we have; strip the kind prefix so it composes nicely
    // inside `prior_detail="…"`.
    const idx = step_result.message.indexOf(': ');
    parts.push(idx === -1 ? step_result.message
                          : step_result.message.slice(idx + 2));
  }
  return parts.join('; ');
}

// Builds a message for the `unstructured_failure_result` kind: a command
// returned a truthy result with no recognisable error text. Surfaces the
// raw object's top-level keys + primitive values so the replanner sees
// at least the shape of what came back. Nested objects/arrays collapse
// to `<object>` / `<array>` to keep the message short and safe to log
// (no chance of circular-reference issues from JSON.stringify).
export function build_unstructured_failure_message(command, result) {
  if (result == null || typeof result !== 'object') {
    return `unstructured_failure_result: cmd=${command}; raw=${String(result)}`;
  }
  const keys = Object.keys(result);
  const parts = [];
  for (const key of keys) {
    const value = result[key];
    if (value === null || value === undefined) {
      parts.push(`${key}=${String(value)}`);
    } else if (typeof value === 'string') {
      const trimmed = value.replace(/\s+/g, ' ').trim();
      parts.push(`${key}="${
          trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed}"`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}=${String(value)}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}=<array len=${value.length}>`);
    } else {
      parts.push(`${key}=<object>`);
    }
  }
  return `unstructured_failure_result: cmd=${command}; raw_keys=[${
      keys.join(',')}]; ${parts.join('; ')}`;
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
    step_index, action_output, recovery_state, task = null, am_state = null,
    agent = null) {
  return {
    i: step_index,
    state: recovery_state,
    dependency_context:
        task && am_state ?
        build_dependency_context(task, am_state, {
          equipped_item: agent?.bot?.heldItem?.name ?? null,
        }) :
        null,
    action: action_output,
    result: null,
  };
}

// Memoizes `get_am_state` across reads that fall between executed commands.
// `get_am_state` walks inventory, nearby blocks (32-block radius), and
// nearby entities — non-trivial work, and within a single attempt the
// world state doesn't change until `executeCommandWithModeRecovery` runs.
// Callers `invalidate()` after every awaited command and at the top of
// each attempt iteration. `read_recovery_state` threads the cached
// `am_state` into `get_recovery_trace_state` so its internal
// `get_am_state` call hits the same cache.
function make_attempt_state_cache(agent) {
  let am = null;
  const read_am = () => {
    if (am === null) am = get_am_state(agent);
    return am;
  };
  const read_recovery = baseline_inventory =>
      get_recovery_trace_state(agent, baseline_inventory, read_am());
  const invalidate = () => {
    am = null;
  };
  return {read_am, read_recovery, invalidate};
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
  const search_result =
      await run_search(search_target, state, agent, log, attempt_number);

  if (search_result.found) {
    // Trust run_search's classification: it already checked
    // check_search_complete post-skill before returning. Re-running it
    // here would be redundant and only ever drift when the bot moved
    // between reads — handled by the next AM iteration.
    spl.log(`Search found "${search_target}", re-running AM with fresh state.`);
    return create_step_result(true, 'search_success', search_result.message);
  }

  // run_search distinguishes 'absent' (no instance found anywhere)
  // from 'found_not_reached' (located but pathfinder failed). Route
  // both kinds through; the SPL outer loop now invokes the search
  // replanner for either, but the kind label and the structured
  // message tell the LLM which case it is.
  const kind = search_result.outcome === 'found_not_reached'
      ? 'search_found_not_reached'
      : 'search_exhausted';
  if (kind === 'search_exhausted') {
    spl.warn(`Search exhausted all radii for "${search_target}", re-evaluating.`);
  } else {
    spl.warn(`Search located "${search_target}" but bot did not reach it — invoking search_replanner.`);
  }
  return create_step_result(false, kind, search_result.message);
}

async function handle_interact_success(
    task, agent, log, task_trace, attempt_number, command_result,
    baseline_inventory = null, state_cache = null) {
  // Caller (the main attempt loop) invalidated the cache after the
  // command that triggered this success path, so `read_am()` here is the
  // fresh post-command state. The two reads inside this function (post-
  // command satisfaction check + trace step) share that snapshot.
  const post_command_state =
      state_cache ? state_cache.read_am() : get_am_state(agent);

  if (interact_target_satisfied(task, post_command_state)) {
    return {status: 'success'};
  }

  if (!interact_target_collectable(task, post_command_state)) {
    return {status: 'continue'};
  }

  const collect_command = `!collectBlocks("${task.target_item}", ${
      Math.min(task.qty, MAX_COLLECT_QTY)})`;

  const collect_step = {
    i: `${attempt_number}a`,
    state: state_cache ? state_cache.read_recovery(baseline_inventory) :
                         get_recovery_trace_state(agent, baseline_inventory),
    dependency_context: build_dependency_context(
        {
          target_item: task.target_item,
          qty: task.qty,
          action_type: 'collect',
          parameters: {
            source_block: task.target_item,
            item_dependency: null,
            tool: null,
          },
        },
        post_command_state, {equipped_item: agent?.bot?.heldItem?.name ?? null}),
    action: collect_command,
    result: null,
  };
  task_trace.steps.push(collect_step);

  log.am(attempt_number, collect_command, post_command_state, {
    source: log_source.deterministic,
  });

  spl.log('Interact produced collectable target; collecting:', collect_command);

  const collect_result = await executeCommandWithModeRecovery(agent, collect_command);
  if (state_cache) state_cache.invalidate();
  spl.log('Collect-after-interact result:', collect_result);

  if (is_successful_command_result(collect_result)) {
    const final_state =
        state_cache ? state_cache.read_am() : get_am_state(agent);
    if (interact_target_satisfied(task, final_state)) {
      collect_step.result =
          create_command_success_result(collect_result, collect_command);
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
    ioQueue.append(
        path.join(full_trace_dir, 'full_task_trace.jsonl'), trace_line);

    const datasets_dir = path.join(parent_rollouts_dir, '_datasets');
    mkdirSync(datasets_dir, {recursive: true});

    const dataset_file = task_trace.terminal_status === 'success' ?
        'success_task_traces.jsonl' :
        'failure_task_traces.jsonl';
    ioQueue.append(path.join(datasets_dir, dataset_file), trace_line);

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

      ioQueue.write(
          path.join(failed_trace_dir, filename),
          () => JSON.stringify(task_trace, null, 2));
    }
  } catch (err) {
    spl.error('Failed to persist task trace:', err.message);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
