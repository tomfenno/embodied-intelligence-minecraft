// Per-episode action-message log used by the evaluation harness to
// compare `our_agent` and `baseline_andy` command outcomes
// apples-to-apples. Hooked at `src/agent/commands/index.js:executeCommand`
// so both agent code paths flow through the same emit point with the
// same envelope.
//
// Enabled only when BENCHMARK_EPISODE_DIR is set (i.e. inside an eval
// episode launched by `achievement_hunter/evaluation_harness/lib/suite.js`).
// Outside eval (dev runs, tests), the helper is a no-op and never
// touches disk.
//
// See `achievement_hunter/docs/action_message_logging_plan.md` for the
// full design rationale and removal plan.

import {appendFileSync} from 'fs';
import path from 'path';

const AGENT_LABEL = process.env.BENCHMARK_AGENT_LABEL ?? null;
const SEED = process.env.BENCHMARK_SEED ?? null;
const TASK_ID = process.env.BENCHMARK_TASK_ID ?? null;
const EPISODE_DIR = process.env.BENCHMARK_EPISODE_DIR;
const ENABLED = !!EPISODE_DIR;
const LOG_PATH = ENABLED
    ? path.join(EPISODE_DIR, 'action_messages.jsonl')
    : null;

/**
 * Append one JSON object per command-dispatch result.
 *
 * `executeCommand` (src/agent/commands/index.js) returns three shapes:
 *   1. {success: false, message: '<parse error>'} — parseCommandMessage failed.
 *   2. {success: false, message: '<arg count error>'} — arg validation failed.
 *   3. {success: bool, message: string} — action command (via runAsAction).
 *   4. plain string — query command result (e.g. !stats, !inventory).
 *
 * We treat the string case as a successful query so query commands log
 * as `{success: true, message: <string>}`. Structured failures log
 * uniformly as `{success: false, message: <string|null>}`.
 *
 * Logging failures never throw to the caller — the function is wrapped
 * in a try/catch so a disk error or full disk can't break command
 * dispatch.
 */
export function log_action_result(command, result) {
  if (!ENABLED) return;
  try {
    const isString = typeof result === 'string';
    const success = isString ? true : result?.success === true;
    const message = isString
        ? result
        : (typeof result?.message === 'string' ? result.message : null);
    const line = JSON.stringify({
                   ts: new Date().toISOString(),
                   agent_label: AGENT_LABEL,
                   seed: SEED,
                   task_id: TASK_ID,
                   command,
                   success,
                   message,
                 }) +
        '\n';
    appendFileSync(LOG_PATH, line);
  } catch (e) {
    console.warn('[action_message_log] append failed:', e?.message);
  }
}
