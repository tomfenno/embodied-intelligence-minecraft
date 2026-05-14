// PR-A-D verification — TEMPORARY instrumentation.
//
// Gated by AH_VERIFY_PR_A_D=1; otherwise every call is a cheap no-op.
// Appends one JSON object per line to pr_a_d_verification.jsonl at the
// repo root (cwd at run time).
//
// REMOVAL: when the user confirms outputs are correct, delete this file
// and every line tagged `// PR-A-D verification` across the codebase.
// `git grep "PR-A-D verification"` lists every site.

import {appendFileSync} from 'fs';
import path from 'path';

// TEMPORARY: default-on for the PR A-D verification eval. Revert to
// `process.env.AH_VERIFY_PR_A_D === '1'` once outputs are confirmed.
const ENABLED = process.env.AH_VERIFY_PR_A_D !== '0';
const LOG_PATH = path.resolve(process.cwd(), 'pr_a_d_verification.jsonl');

export function verify_log(event, fields = {}) {
  if (!ENABLED) return;
  try {
    const line = JSON.stringify({
                   ts: new Date().toISOString(),
                   event,
                   ...fields,
                 }) +
        '\n';
    appendFileSync(LOG_PATH, line);
  } catch (e) {
    console.warn('[PR-A-D verify_log] failed:', e?.message);
  }
}

// Convenience for `action_result` events — extracts structured-field
// presence flags from a result object so the verification log shows
// which signal channels are populated for each result.
export function verify_log_action_result(source, result) {
  if (!ENABLED) return;
  if (result == null) {
    verify_log('action_result', {source, kind: null});
    return;
  }
  verify_log('action_result', {
    source,
    kind: result.kind ?? null,
    success: result.success ?? null,
    message_prefix: typeof result.message === 'string'
        ? result.message.slice(0, 120)
        : null,
    has_mode_reasons: result.mode_reasons != null,
    has_mode_interrupt_counts: result.mode_interrupt_counts != null,
    has_verifier_reason: result.verifier_reason != null,
    has_located_at: result.located_at != null,
    has_located_distance: result.located_distance != null,
    has_blocker_kind: result.blocker_kind != null,
  });
}
