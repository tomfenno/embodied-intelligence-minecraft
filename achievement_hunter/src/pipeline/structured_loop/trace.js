export function normalize_result_message(result) {
  return result?.message != null ? String(result.message).trim() : null;
}

export function create_step_result(success, kind, message) {
  return {success, kind, message};
}

export function create_command_success_result(result) {
  return create_step_result(
      true, 'command_success', normalize_result_message(result));
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
    // Surface mode-interrupt context (per-mode tallies + net bot
    // displacement) so the replanner can reason about which mode is
    // blocking progress and pick a relocation action. See BUG 15.
    if (step.result.mode_interrupt_counts != null) {
      projected.mode_interrupt_counts = step.result.mode_interrupt_counts;
    }
    if (step.result.position_before != null) {
      projected.position_before = step.result.position_before;
    }
    if (step.result.position_after != null) {
      projected.position_after = step.result.position_after;
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
