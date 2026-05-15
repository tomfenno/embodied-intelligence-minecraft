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

// Action-command results carry one of two prefixes produced by
// `src/agent/action_manager.js:getBotOutputSummary`:
//
//   - 'Action output:\n...'                              (short, bot.output ≤ 500 chars)
//   - 'Action output is very long (<N> chars)...'        (long, truncated)
//
// Both come from the same `if/else` (action_manager.js:157-163). The
// `dependency_error_classifier.js` already carries matching templates
// for both variants (`wrap.action_output_prefix`,
// `wrap.action_output_truncated`). Aligning here so the two stay in
// sync: if upstream ever renames the prefix, classifier templates and
// this filter break together and get fixed together. Anchored with
// `^` to avoid false-positive matches on query results that happen to
// contain the substring further into their text.
const ACTION_OUTPUT_PREFIX_RE = /^Action output(?::|\s+is very long\b)/;

/**
 * Append one JSON object per command-dispatch result.
 *
 * `executeCommand` (src/agent/commands/index.js) returns four shapes:
 *   1. {success: false, message: '<parse error>'} — parseCommandMessage failed.
 *   2. {success: false, message: '<arg count error>'} — arg validation failed.
 *   3. {success: bool, message: string} — action command (via runAsAction).
 *   4. plain string — query command result (e.g. !stats, !inventory).
 *
 * For agent-vs-agent comparison we only want entries where BOTH agents
 * could plausibly have emitted the same kind of event. `our_agent`'s
 * SPL only ever issues action commands routed through `runAsAction`,
 * which wraps every output via `action_manager.js:getBotOutputSummary`
 * (see ACTION_OUTPUT_PREFIX_RE above for the exact prefix contract).
 * So:
 *
 *   - Keep:  action commands (shape 3) whose message matches the
 *            action_manager-produced prefix — including failure cases
 *            and the long-output truncated variant.
 *   - Drop:  parse errors, arg-count errors, query results,
 *            interrupted actions (empty message), and meta commands
 *            (e.g. !goal returning null). The baseline emits these,
 *            our_agent never does; logging them would surface a
 *            comparison asymmetry that isn't agent behaviour but rather
 *            agent-control-style mismatch.
 *
 * The structural action-vs-not distinction is invisible at this level
 * (the `wrappedAction` wrapper at `actions.js:25-27` strips
 * `interrupted` and `timedout` from the action_manager result before
 * returning, so action commands and parse/arg errors are both
 * `{success, message}` shape). The prefix is the only signal.
 *
 * Logging failures never throw to the caller — the function is wrapped
 * in a try/catch so a disk error or full disk can't break command
 * dispatch.
 */
export function log_action_result(command, result) {
  if (!ENABLED) return;
  try {
    if (result == null || typeof result === 'string') return;
    const message = result.message;
    if (typeof message !== 'string' ||
        !ACTION_OUTPUT_PREFIX_RE.test(message)) {
      return;
    }
    const line = JSON.stringify({
                   ts: new Date().toISOString(),
                   agent_label: AGENT_LABEL,
                   seed: SEED,
                   task_id: TASK_ID,
                   command,
                   success: result.success === true,
                   message,
                 }) +
        '\n';
    appendFileSync(LOG_PATH, line);
  } catch (e) {
    console.warn('[action_message_log] append failed:', e?.message);
  }
}
