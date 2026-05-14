import {build_command_success_message} from './result_messages.js';

export function normalize_result_message(result) {
  return result?.message != null ? String(result.message).trim() : null;
}

export function create_step_result(success, kind, message) {
  return {success, kind, message};
}

// Per Step 7 of the action-result message plan, command_success messages
// are now plumbing-stripped + success-line-hoisted so the replanner
// reading top-down sees an unambiguous outcome first. Partial-outcome
// lines (Failed to collect X, Don't have right tools, …) are preserved
// because they carry useful signal for the next task. Falls back to the
// original message verbatim when the command/skill_output args are
// missing — the helper is defensive and won't return an empty message.
export function create_command_success_result(result, command = null) {
  const raw = normalize_result_message(result);
  if (command == null) {
    return create_step_result(true, 'command_success', raw);
  }
  return create_step_result(
      true, 'command_success',
      build_command_success_message({command, skill_output: raw}));
}

export function create_action_result(command, success, kind, message) {
  return {command, success, kind, message};
}

export function project_failed_steps(steps) {
  return steps.filter(step => step.result?.success === false).map(step => {
    const projected = {
      i: step.i,
      action: step.action,
      kind: step.result.kind,
      message: step.result.message,
    };
    // Surface mode-interrupt context (per-mode tallies + per-mode
    // trigger reasons + net bot displacement) so the replanner can
    // reason about which mode is blocking progress and pick a
    // relocation action. See BUG 15 and Step 5 of the action-result
    // message plan.
    if (step.result.mode_interrupt_counts != null) {
      projected.mode_interrupt_counts = step.result.mode_interrupt_counts;
    }
    if (step.result.mode_reasons != null) {
      projected.mode_reasons = step.result.mode_reasons;
    }
    if (step.result.position_before != null) {
      projected.position_before = step.result.position_before;
    }
    if (step.result.position_after != null) {
      projected.position_after = step.result.position_after;
    }
    // Surface verifier_reason as a structured field for verifier-
    // reclassified failures. The LLM also gets it via the message
    // headline's `verifier=<reason>` segment; this duplication exists
    // so non-prompt consumers (dashboards, downstream classifiers)
    // get direct access without parsing the message string.
    if (step.result.verifier_reason != null) {
      projected.verifier_reason = step.result.verifier_reason;
    }
    // Surface per-source outcomes for search_sweep failures so the
    // failure_replanner LLM can distinguish exhausted-at-max-radius
    // sources from found-not-reached (pathfinder failed) and
    // soft-skipped (unsupported abstract) sources, and tailor the
    // recovery plan accordingly.
    if (step.result.per_source_outcomes != null) {
      projected.per_source_outcomes = step.result.per_source_outcomes;
    }
    return projected;
  });
}
