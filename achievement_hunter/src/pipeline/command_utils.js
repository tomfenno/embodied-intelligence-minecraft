import {executeCommand} from '../../../src/agent/commands/index.js';

const MAX_MODE_INTERRUPTS = 5;
const MODE_IDLE_TIMEOUT_MS = 30_000;

const log = (...args) => console.log('[SPL][cmd]', ...args);
const warn = (...args) => console.warn('[SPL][cmd]', ...args);

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

    if (result?.success === true) return result;

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
