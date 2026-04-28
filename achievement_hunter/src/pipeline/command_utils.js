import {executeCommand} from '../../../src/agent/commands/index.js';

const MAX_MODE_INTERRUPTS = 10;
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
 */
export async function executeCommandWithModeRecovery(
    agent, command, maxModeInterrupts = MAX_MODE_INTERRUPTS) {
  let interrupt_count = 0;

  while (true) {
    const result = await executeCommand(agent, command);

    if (result?.success === true) return result;

    if (agent.bot.modes.isAnyModeActive()) {
      if (interrupt_count >= maxModeInterrupts) {
        warn(
            `Command interrupted by mode ${interrupt_count} time(s), treating as failure:`,
            command);
        return {success: false, message: 'mode_interrupted'};
      }

      interrupt_count++;
      log(
          `Mode interrupted command (${interrupt_count}/${maxModeInterrupts}), waiting for idle:`,
          command);

      const idled = await agent.bot.modes.waitForIdle(MODE_IDLE_TIMEOUT_MS);
      if (!idled) {
        warn('Modes did not idle within timeout, treating as failure:', command);
        return {success: false, message: 'mode_interrupted'};
      }

      log('Modes idle, retrying:', command);
      continue;
    }

    return result;
  }
}
