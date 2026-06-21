function makePtdSourceBreakdown() {
  return {
    disk: 0,
    checkpoint: 0,
    self_refine: 0,
    unknown: 0,
  };
}

function makeEmptyPtdMetrics() {
  return {
    source: 'unknown',
    status: 'unknown',
    self_refine_invoked: false,
    accepted_after_round: null,
    rounds_used: 0,
    generation_calls: 0,
    validation_calls: 0,
    refinement_calls: 0,
    total_latency_ms: 0,
    source_breakdown: makePtdSourceBreakdown(),
    rollout_count: 0,
    self_refine_runs: 0,
    accepted_runs: 0,
    total_rounds_used: 0,
    max_rounds_used: 0,
  };
}

function makeEmptyFailureReplannerMetrics() {
  return {
    invocations: 0,
    productive_invocations: 0,
    failed_invocations: 0,
    incomplete_invocations: 0,
    total_attempts: 0,
    total_actions_executed: 0,
    invocations_by_trigger: {},
    sessions: [],
  };
}

export function makeEmptyArchitectureMetrics() {
  return {
    ptd: makeEmptyPtdMetrics(),
    failure_replanner: makeEmptyFailureReplannerMetrics(),
  };
}

function safeNumber(value) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function uniqueKinds(failedSteps) {
  return [...new Set(
      (failedSteps ?? [])
          .map(step => step?.kind)
          .filter(kind => typeof kind === 'string' && kind.length > 0))];
}

function chooseMergedLabel(labels, fallback = 'unknown') {
  const unique = [...new Set(labels.filter(Boolean))];
  if (unique.length === 0) return fallback;
  if (unique.length === 1) return unique[0];
  return 'mixed';
}

function normalizeSource(source) {
  if (source === 'disk' || source === 'checkpoint' ||
      source === 'self_refine') {
    return source;
  }
  return 'unknown';
}

function normalizePtdStatus(status) {
  if (typeof status !== 'string' || status.length === 0) {
    return 'unknown';
  }
  return status;
}

function defaultStatusForSource(source) {
  if (source === 'disk' || source === 'checkpoint') return 'loaded';
  if (source === 'self_refine') return 'accepted';
  return 'unknown';
}

function finalisePtdMetrics(ptd, seenSources, seenStatuses) {
  ptd.self_refine_invoked = ptd.self_refine_runs > 0;
  if (!ptd.self_refine_invoked) {
    ptd.source = chooseMergedLabel(seenSources, 'unknown');
    ptd.status = chooseMergedLabel(seenStatuses, 'unknown');
  }
  ptd.max_rounds_used = Math.max(ptd.max_rounds_used, ptd.rounds_used);
}

function buildPtdMetricsFromStages(stages) {
  const ptd = makeEmptyPtdMetrics();
  const seenSources = [];
  const seenStatuses = [];
  let acceptedAfterRound = null;
  let roundsUsed = 0;

  for (const stage of stages) {
    if (stage?.stage !== 'PTD') continue;
    const meta = stage.meta ?? {};
    const source = normalizeSource(meta.source);
    const stageName = meta.stage ?? null;
    const latencyMs = safeNumber(meta.latency_ms);

    if (stageName == null) {
      ptd.rollout_count += 1;
      ptd.source_breakdown[source] =
          safeNumber(ptd.source_breakdown[source]) + 1;
      seenSources.push(source);
      seenStatuses.push(normalizePtdStatus(
          meta.status ?? defaultStatusForSource(source)));
      continue;
    }

    ptd.rollout_count = Math.max(ptd.rollout_count, 1);
    if (!ptd.self_refine_invoked) {
      ptd.source_breakdown.self_refine += 1;
      ptd.self_refine_runs = 1;
      seenSources.push('self_refine');
    }

    ptd.total_latency_ms += latencyMs;

    if (stageName === 'generate') {
      ptd.generation_calls += 1;
    } else if (stageName === 'validate') {
      ptd.validation_calls += 1;
      const verdict = stage.parsed?.verdict;
      roundsUsed = Math.max(roundsUsed, safeNumber(meta.round));
      ptd.total_rounds_used = Math.max(ptd.total_rounds_used, roundsUsed);
      ptd.max_rounds_used = Math.max(ptd.max_rounds_used, roundsUsed);
      if (verdict === 'pass') {
        acceptedAfterRound = safeNumber(meta.round);
        ptd.accepted_runs = 1;
        seenStatuses.push('accepted');
      } else if (meta.error) {
        seenStatuses.push('failed');
      }
    } else if (stageName === 'refine') {
      ptd.refinement_calls += 1;
      roundsUsed = Math.max(roundsUsed, safeNumber(meta.round));
      ptd.total_rounds_used = Math.max(ptd.total_rounds_used, roundsUsed);
      ptd.max_rounds_used = Math.max(ptd.max_rounds_used, roundsUsed);
      if (meta.error) {
        seenStatuses.push('failed');
      }
    }

    if (meta.error &&
        (stageName === 'generate' || stageName === 'refine' ||
         stageName === 'validate')) {
      seenStatuses.push('failed');
    }
  }

  if (ptd.self_refine_runs > 0) {
    ptd.self_refine_invoked = true;
    ptd.source = 'self_refine';
    ptd.status = acceptedAfterRound != null ? 'accepted' :
        (seenStatuses.includes('failed') ? 'failed' : 'in_progress');
    ptd.accepted_after_round = acceptedAfterRound;
    ptd.rounds_used = roundsUsed;
    ptd.total_rounds_used = Math.max(ptd.total_rounds_used, roundsUsed);
    ptd.max_rounds_used = Math.max(ptd.max_rounds_used, roundsUsed);
    if (acceptedAfterRound != null) ptd.accepted_runs = 1;
  } else {
    ptd.accepted_after_round = null;
    ptd.rounds_used = 0;
  }

  finalisePtdMetrics(ptd, seenSources, seenStatuses);
  return ptd;
}

function blankRecoverySession(invocationId) {
  return {
    invocation_id: invocationId,
    task_key: null,
    action_type: null,
    target_item: null,
    trigger_terminal_reason: null,
    failed_step_kinds: [],
    status: 'incomplete',
    exit_status: null,
    attempts_used: 0,
    actions_executed: 0,
    resumed_from_prior_crash: false,
  };
}

function mergeSessionIntoMap(sessionMap, stage) {
  const invocationId = stage.invocation_id ??
      `missing-invocation-${sessionMap.size + 1}`;
  if (!sessionMap.has(invocationId)) {
    sessionMap.set(invocationId, blankRecoverySession(invocationId));
  }

  const session = sessionMap.get(invocationId);
  if (stage.task_key != null) session.task_key = stage.task_key;
  if (stage.action_type != null) session.action_type = stage.action_type;
  if (stage.target_item != null) session.target_item = stage.target_item;
  if (stage.trigger_terminal_reason != null) {
    session.trigger_terminal_reason = stage.trigger_terminal_reason;
  }
  if (Array.isArray(stage.failed_step_kinds) &&
      stage.failed_step_kinds.length > 0) {
    session.failed_step_kinds = uniqueKinds([
      ...session.failed_step_kinds.map(kind => ({kind})),
      ...stage.failed_step_kinds.map(kind => ({kind})),
    ]);
  }
  if (stage.status != null) session.status = stage.status;
  if (stage.exit_status != null) session.exit_status = stage.exit_status;
  if (stage.attempts_used != null) {
    session.attempts_used =
        Math.max(session.attempts_used, safeNumber(stage.attempts_used));
  }
  if (stage.attempt != null) {
    session.attempts_used =
        Math.max(session.attempts_used, safeNumber(stage.attempt));
  }
  if (stage.actions_executed != null) {
    session.actions_executed = Math.max(
        session.actions_executed, safeNumber(stage.actions_executed));
  }
  if (stage.type === 'action_result') {
    session.actions_executed += 1;
  }
  if (stage.resumed_from_prior_crash === true) {
    session.resumed_from_prior_crash = true;
  }
}

function buildFailureReplannerMetricsFromStages(stages) {
  const sessionMap = new Map();

  for (const stage of stages) {
    if (stage?.stage !== 'RECOVERY' || !stage.type) continue;
    if (stage.type === 'invocation_start' || stage.type === 'invocation_end' ||
        stage.type === 'attempt_start' || stage.type === 'action_result') {
      mergeSessionIntoMap(sessionMap, stage);
    }
  }

  const sessions = [...sessionMap.values()].map(session => ({
    ...session,
    failed_step_kinds: uniqueKinds(
        session.failed_step_kinds.map(kind => ({kind}))),
    status: session.status ?? 'incomplete',
    exit_status: session.exit_status ?? null,
  })).sort((a, b) => a.invocation_id.localeCompare(b.invocation_id));

  const metrics = makeEmptyFailureReplannerMetrics();
  metrics.sessions = sessions;
  metrics.invocations = sessions.length;
  metrics.productive_invocations =
      sessions.filter(session => session.status === 'success').length;
  metrics.failed_invocations =
      sessions.filter(session => session.status === 'fail').length;
  metrics.incomplete_invocations =
      sessions.filter(session => session.status === 'incomplete').length;
  metrics.total_attempts = sessions.reduce(
      (sum, session) => sum + safeNumber(session.attempts_used), 0);
  metrics.total_actions_executed = sessions.reduce(
      (sum, session) => sum + safeNumber(session.actions_executed), 0);
  for (const session of sessions) {
    const trigger = session.trigger_terminal_reason ?? 'unknown';
    metrics.invocations_by_trigger[trigger] =
        safeNumber(metrics.invocations_by_trigger[trigger]) + 1;
  }
  return metrics;
}

export function buildArchitectureMetricsFromRollout(rollout) {
  const stages = Array.isArray(rollout?.stages) ? rollout.stages : [];
  return {
    ptd: buildPtdMetricsFromStages(stages),
    failure_replanner: buildFailureReplannerMetricsFromStages(stages),
  };
}

function mergeFailureSession(existing, incoming) {
  if (!existing) {
    return {
      ...incoming,
      failed_step_kinds: [...(incoming.failed_step_kinds ?? [])],
    };
  }

  const merged = {
    ...existing,
    task_key: incoming.task_key ?? existing.task_key,
    action_type: incoming.action_type ?? existing.action_type,
    target_item: incoming.target_item ?? existing.target_item,
    trigger_terminal_reason:
        incoming.trigger_terminal_reason ?? existing.trigger_terminal_reason,
    status: incoming.status === 'success' ? 'success' :
        (incoming.status === 'fail' && existing.status !== 'success' ? 'fail' :
         existing.status),
    exit_status: incoming.exit_status ?? existing.exit_status,
    attempts_used: Math.max(
        safeNumber(existing.attempts_used), safeNumber(incoming.attempts_used)),
    actions_executed: Math.max(
        safeNumber(existing.actions_executed),
        safeNumber(incoming.actions_executed)),
    resumed_from_prior_crash:
        existing.resumed_from_prior_crash === true ||
        incoming.resumed_from_prior_crash === true,
  };
  merged.failed_step_kinds = uniqueKinds([
    ...(existing.failed_step_kinds ?? []).map(kind => ({kind})),
    ...(incoming.failed_step_kinds ?? []).map(kind => ({kind})),
  ]);
  return merged;
}

export function mergeArchitectureMetrics(metricsList) {
  const merged = makeEmptyArchitectureMetrics();
  const seenPtdSources = [];
  const seenPtdStatuses = [];
  const sessionMap = new Map();

  for (const metrics of metricsList ?? []) {
    if (!metrics || typeof metrics !== 'object') continue;

    const ptd = metrics.ptd ?? {};
    merged.ptd.rollout_count += safeNumber(ptd.rollout_count);
    merged.ptd.self_refine_runs += safeNumber(ptd.self_refine_runs);
    merged.ptd.accepted_runs += safeNumber(ptd.accepted_runs);
    merged.ptd.generation_calls += safeNumber(ptd.generation_calls);
    merged.ptd.validation_calls += safeNumber(ptd.validation_calls);
    merged.ptd.refinement_calls += safeNumber(ptd.refinement_calls);
    merged.ptd.total_latency_ms += safeNumber(ptd.total_latency_ms);
    merged.ptd.total_rounds_used += safeNumber(ptd.total_rounds_used);
    merged.ptd.max_rounds_used = Math.max(
        merged.ptd.max_rounds_used, safeNumber(ptd.max_rounds_used));
    for (const source of ['disk', 'checkpoint', 'self_refine', 'unknown']) {
      merged.ptd.source_breakdown[source] +=
          safeNumber(ptd.source_breakdown?.[source]);
    }
    if (ptd.source != null) seenPtdSources.push(ptd.source);
    if (ptd.status != null) seenPtdStatuses.push(ptd.status);
    if (ptd.accepted_after_round != null &&
        merged.ptd.accepted_after_round == null) {
      merged.ptd.accepted_after_round = ptd.accepted_after_round;
    }

    for (const session of metrics.failure_replanner?.sessions ?? []) {
      sessionMap.set(
          session.invocation_id,
          mergeFailureSession(sessionMap.get(session.invocation_id), session));
    }
  }

  merged.ptd.self_refine_invoked = merged.ptd.self_refine_runs > 0;
  merged.ptd.source = chooseMergedLabel(
      seenPtdSources.filter(source => source !== 'unknown'),
      merged.ptd.rollout_count > 0 ? 'unknown' : 'unknown');
  merged.ptd.status = chooseMergedLabel(
      seenPtdStatuses.filter(status => status !== 'unknown'),
      merged.ptd.rollout_count > 0 ? 'unknown' : 'unknown');
  merged.ptd.rounds_used =
      merged.ptd.self_refine_runs <= 1 ? merged.ptd.total_rounds_used : null;
  if (merged.ptd.self_refine_runs === 0) {
    merged.ptd.accepted_after_round = null;
    merged.ptd.rounds_used = 0;
  }

  merged.failure_replanner.sessions =
      [...sessionMap.values()].sort((a, b) => a.invocation_id.localeCompare(
          b.invocation_id));
  merged.failure_replanner.invocations =
      merged.failure_replanner.sessions.length;
  merged.failure_replanner.productive_invocations =
      merged.failure_replanner.sessions.filter(
          session => session.status === 'success').length;
  merged.failure_replanner.failed_invocations =
      merged.failure_replanner.sessions.filter(
          session => session.status === 'fail').length;
  merged.failure_replanner.incomplete_invocations =
      merged.failure_replanner.sessions.filter(
          session => session.status === 'incomplete').length;
  merged.failure_replanner.total_attempts =
      merged.failure_replanner.sessions.reduce(
          (sum, session) => sum + safeNumber(session.attempts_used), 0);
  merged.failure_replanner.total_actions_executed =
      merged.failure_replanner.sessions.reduce(
          (sum, session) => sum + safeNumber(session.actions_executed), 0);
  for (const session of merged.failure_replanner.sessions) {
    const trigger = session.trigger_terminal_reason ?? 'unknown';
    merged.failure_replanner.invocations_by_trigger[trigger] =
        safeNumber(merged.failure_replanner.invocations_by_trigger[trigger]) + 1;
  }

  return merged;
}
