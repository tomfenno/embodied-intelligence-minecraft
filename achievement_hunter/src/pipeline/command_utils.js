import {executeCommand} from '../../../src/agent/commands/index.js';

const MAX_MODE_INTERRUPTS = 5;
const MODE_IDLE_TIMEOUT_MS = 30_000;

const log = (...args) => console.log('[SPL][cmd]', ...args);
const warn = (...args) => console.warn('[SPL][cmd]', ...args);

// Mineflayer's pathfinder skill (and its callers like searchForBlock /
// goToCoordinates / goToNearestBlock) catches its own errors and returns
// false. Upstream `runAsAction` ignores that boolean and reports
// `success: true` whenever the wrapped function completes without
// throwing — so a navigation command that bailed mid-path shows up here
// as success-with-bail-message. We reclassify those for the commands in
// `NAVIGATION_ONLY_COMMANDS` only; multi-phase commands (collectBlocks,
// craftRecipe, attack, etc.) can have pathfinder warnings appear in the
// message from an intermediate phase while ultimately succeeding, so the
// reclassification stays narrowly scoped.
//
// Note: `Took to long` is the literal upstream typo. Do not "fix" the
// spelling — the regex must match what the skill actually emits.
export const PATHFINDING_MESSAGE_REGEX =
    /no path|PathStopped|Could not find a path|Path not found|Pathfinding stopped|Took to long to decide path/i;

const NAVIGATION_ONLY_COMMANDS = new Set([
  '!goToCoordinates',
  '!moveAway',
  '!searchForBlock',
  '!searchForEntity',
  '!digDown',
  '!goToSurface',
]);

function extract_command_name(command) {
  const match = typeof command === 'string' ? command.match(/^(!\w+)/) : null;
  return match?.[1] ?? null;
}

function looks_like_pathfinder_bail_success(command, result) {
  if (result?.success !== true) return false;
  if (typeof result?.message !== 'string') return false;
  if (!NAVIGATION_ONLY_COMMANDS.has(extract_command_name(command))) return false;
  return PATHFINDING_MESSAGE_REGEX.test(result.message);
}

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

  while (true) {
    const result = await executeCommand(agent, command);

    if (result?.success === true) {
      if (looks_like_pathfinder_bail_success(command, result)) {
        warn(
            'Reclassifying pathfinder-bail "success" as failure for nav command:',
            command);
        return {...result, success: false};
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
            interrupt_counts_by_mode, position_before,
            agent.bot.entity.position);
      }

      interrupt_count++;
      log(
          `Mode interrupted command (${interrupt_count}/${maxModeInterrupts}), waiting for idle:`,
          command);

      const idled = await agent.bot.modes.waitForIdle(MODE_IDLE_TIMEOUT_MS);
      if (!idled) {
        warn('Modes did not idle within timeout, treating as failure:', command);
        return build_mode_interrupted_result(
            interrupt_counts_by_mode, position_before,
            agent.bot.entity.position, 'modes did not idle within timeout');
      }

      log('Modes idle, retrying:', command);
      continue;
    }

    return result;
  }
}

function build_mode_interrupted_result(
    counts_by_mode, position_before, position_after, extra_note = null) {
  const counts_summary = Object.entries(counts_by_mode)
                             .sort((a, b) => b[1] - a[1])
                             .map(([name, n]) => `${name}×${n}`)
                             .join(', ') ||
      'unknown';
  const dx = (position_after.x - position_before.x).toFixed(1);
  const dy = (position_after.y - position_before.y).toFixed(1);
  const dz = (position_after.z - position_before.z).toFixed(1);
  const note = extra_note ? `; ${extra_note}` : '';
  const message = `mode_interrupted: ${counts_summary}; bot Δ=(${dx},${dy},${
      dz}) over retries; command never completed${note}`;

  return {
    success: false,
    message,
    mode_interrupted: true,
    mode_interrupt_counts: {...counts_by_mode},
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
