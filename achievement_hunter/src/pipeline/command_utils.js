import {executeCommand} from '../../../src/agent/commands/index.js';
import {extract_command_name, required_pre_state, snapshot_state, verify_command_outcome} from './command_verifier.js';
import {SERVER_DRIVEN_SHARDS, VERIFIER_SETTLE_TICKS} from './inventory_drops.js';
import {build_command_failure_message, build_mode_interrupted_message} from './structured_loop/result_messages.js';
// PR-A-D verification
import {verify_log} from './structured_loop/_pr_a_d_verify_log.js';

const MAX_MODE_INTERRUPTS = 5;
const MODE_IDLE_TIMEOUT_MS = 30_000;

// SERVER_DRIVEN_SHARDS and VERIFIER_SETTLE_TICKS now live in
// ./inventory_drops.js so the upstream collectBlock skill and this
// verifier path share the same settle-wait policy. See
// docs/messages/collectblocks-count-and-item-mismatch.md.

const log = (...args) => console.log('[SPL][cmd]', ...args);
const warn = (...args) => console.warn('[SPL][cmd]', ...args);

// Regex still exported because `is_pathfinding_failure` in
// `search_replanner.js` uses it to classify command_failure result
// **kinds** for the D11 escape path (a separate concern from the
// success/failure decision that used to live here).
//
// As of Phase 2 of the command_verifier rollout, no command in
// achievement_hunter uses this regex for success-flag reclassification
// anymore — every nav command has a post-condition verifier instead.
// The legacy `looks_like_pathfinder_bail_success` and
// `NAVIGATION_ONLY_COMMANDS` were dead code and have been removed.
//
// Note: `Took to long` is the literal upstream typo. Do not "fix" the
// spelling — the regex must match what the skill actually emits.
export const PATHFINDING_MESSAGE_REGEX =
    /no path|PathStopped|Could not find a path|Path not found|Pathfinding stopped|Took to long to decide path/i;

// `extract_command_name` lives in `command_verifier.js` now (imported
// above) — single source of truth for parsing command strings.

/**
 * Executes a bot command, transparently retrying if a survival mode
 * (self_preservation, unstuck, self_defense) interrupts the action.
 *
 * Mode interruptions are not counted as failures — the bot is moved to safety
 * and the same command is retried. If the mode cap is hit or the mode does not
 * idle within the timeout, the last failure result is returned so the caller
 * can handle it normally.
 *
 * On mode-interrupt exhaustion the returned result carries
 * `mode_interrupted: true` and `mode_interrupt_counts` (per-mode tallies) so the
 * SPL can attribute the failure to a specific mode (typically `unstuck`) and so
 * the failure_replanner sees enough context to choose a relocation action
 * rather than re-issuing the same command. See BUG 15.
 */
export async function executeCommandWithModeRecovery(
    agent, command, maxModeInterrupts = MAX_MODE_INTERRUPTS) {
  let interrupt_count = 0;
  const interrupt_counts_by_mode = {};
  const position_before = agent.bot.entity.position.clone();

  // Pre-state snapshot for the post-condition verifier (if a verifier
  // is registered for this command). Commands without a verifier get
  // `EMPTY_NEEDS` → snapshot_state returns `{}` → no work done.
  const verifier_needs = required_pre_state(command);
  const verifier_pre_state = snapshot_state(agent, verifier_needs);

  while (true) {
    if (agent.bot._ah_death_pending) {
      log(`Bot death observed before command — aborting: ${command}`);
      return build_bot_died_result(command);
    }
    const result = await executeCommand(agent, command);
    if (agent.bot._ah_death_pending) {
      log(`Bot death observed during command — aborting: ${command}`);
      return build_bot_died_result(command);
    }

    if (result?.success === true) {
      // Post-condition verifier check. `verify_command_outcome`
      // short-circuits to `{verified: false}` for unregistered
      // commands, so this is a cheap pass-through there. Registered
      // verifiers with `needs: new Set()` (e.g. !goToSurface, which
      // reads surroundings directly off `agent`) are still consulted —
      // we don't gate on `verifier_needs.size > 0`.
      //
      // Settle wait: if the verifier reads a server-driven shard,
      // wait a few ticks before snapshotting so server response
      // packets (inventory updates after !useOn / !attack /
      // !collectBlocks, equipment changes after !equip, etc.) have
      // time to land. Without this, the verifier races the network
      // and false-fails commands that actually succeeded.
      const needs_settle = [...verifier_needs].some(
          shard => SERVER_DRIVEN_SHARDS.has(shard));
      if (needs_settle) {
        await agent.bot.waitForTicks(VERIFIER_SETTLE_TICKS);
      }
      const verifier_post_state = snapshot_state(agent, verifier_needs);
      const verdict = verify_command_outcome(
          command, verifier_pre_state, verifier_post_state, agent);
      if (verdict.verified && !verdict.ok) {
        warn(
            `Verifier reclassified "${command}" as failure: ${
                verdict.reason}`);
        // build_command_failure_message centralizes the verifier-vs-
        // skill-output reasoning: it calls parse_skill_output to
        // derive a root_cause_kind (workstation_placement_failed,
        // tool_missing, …) from the skill blob and composes a stable
        // headline the replanner can grep without parsing prose.
        const bot_pos = agent?.bot?.entity?.position ?? null;
        const reclassified_message = build_command_failure_message({
          command,
          verifier_reason: verdict.reason,
          skill_output: result.message,
          position: bot_pos,
        });
        // PR-A-D verification
        verify_log('verifier_reclassified', {
          command,
          verifier_reason: verdict.reason,
          message_prefix: reclassified_message.slice(0, 160),
        });
        return {
          ...result,
          success: false,
          message: reclassified_message,
          // Surface the verifier identifier on the result too so
          // downstream code (failure trace, tests) can read it without
          // parsing the message string.
          verifier_reason: verdict.reason,
        };
      }

      return result;
    }

    if (agent.bot.modes.isAnyModeActive()) {
      for (const name of agent.bot.modes.getActiveModeNames()) {
        interrupt_counts_by_mode[name] =
            (interrupt_counts_by_mode[name] ?? 0) + 1;
      }

      if (interrupt_count >= maxModeInterrupts) {
        warn(
            `Command interrupted by mode ${interrupt_count} time(s), treating as failure:`,
            command);
        return build_mode_interrupted_result(
            command, interrupt_counts_by_mode, position_before,
            agent.bot.entity.position, agent.bot.modes);
      }

      interrupt_count++;
      log(
          `Mode interrupted command (${interrupt_count}/${maxModeInterrupts}), waiting for idle:`,
          command);

      const idled = await agent.bot.modes.waitForIdle(MODE_IDLE_TIMEOUT_MS);
      if (agent.bot._ah_death_pending) {
        log(`Bot death observed during mode-idle wait — aborting: ${command}`);
        return build_bot_died_result(command);
      }
      if (!idled) {
        warn('Modes did not idle within timeout, treating as failure:', command);
        return build_mode_interrupted_result(
            command, interrupt_counts_by_mode, position_before,
            agent.bot.entity.position, agent.bot.modes,
            'modes did not idle within timeout');
      }

      log('Modes idle, retrying:', command);
      continue;
    }

    return result;
  }
}

function build_bot_died_result(command) {
  return {
    success: false,
    message: `bot_died: aborted ${command} after bot death — SPL will re-enter SCSG on respawn`,
    bot_died: true,
  };
}

function build_mode_interrupted_result(
    command, counts_by_mode, position_before, position_after, mode_controller,
    extra_note = null) {
  // Pull per-mode trigger reasons recorded by ah_modes.js (Step 5).
  // mode_controller exposes getLastTrigger(mode_name); missing modes
  // return null and the builder degrades gracefully (omits the
  // parenthetical reason segment for that mode).
  const mode_reasons = {};
  if (mode_controller?.getLastTrigger) {
    for (const name of Object.keys(counts_by_mode)) {
      const trigger = mode_controller.getLastTrigger(name);
      if (trigger != null) mode_reasons[name] = trigger;
    }
  }

  let message = build_mode_interrupted_message({
    command,
    mode_counts: counts_by_mode,
    position_before,
    position_after,
    mode_reasons,
  });
  if (extra_note) {
    // Pre-existing semantic: `extra_note` only fires for the
    // "modes did not idle within timeout" case. Append after the
    // builder's headline so the standard prefix remains parseable.
    message += `; ${extra_note}`;
  }

  return {
    success: false,
    message,
    mode_interrupted: true,
    mode_interrupt_counts: {...counts_by_mode},
    mode_reasons,
    position_before: {
      x: position_before.x,
      y: position_before.y,
      z: position_before.z,
    },
    position_after: {
      x: position_after.x,
      y: position_after.y,
      z: position_after.z,
    },
  };
}
