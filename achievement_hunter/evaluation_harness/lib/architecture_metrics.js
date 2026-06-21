import path from 'path';

import {
  buildArchitectureMetricsFromRollout,
  makeEmptyArchitectureMetrics,
  mergeArchitectureMetrics,
} from '../../src/pipeline/architecture_metrics.js';
import {normalizeEpisodeRecord} from './reports.js';
import {readJson, walkFiles} from './utils.js';

export function collectArchitectureMetricsFromRollouts(resultDir) {
  const metrics = [];

  for (const filePath of walkFiles(resultDir)) {
    if (path.basename(filePath) !== 'rollout_trace.json') continue;
    if (!filePath.includes(`${path.sep}achievement_rollouts${path.sep}`)) {
      continue;
    }
    const rollout = readJson(filePath);
    metrics.push(
        rollout?.summary?.architecture_metrics ??
        buildArchitectureMetricsFromRollout(rollout));
  }

  if (metrics.length === 0) return null;

  const merged = mergeArchitectureMetrics(metrics);
  merged.rollout_traces_found = metrics.length;
  return merged;
}

export function augmentManifestWithArchitectureMetrics(manifest, resultDir) {
  return {
    ...manifest,
    architecture_metrics:
        collectArchitectureMetricsFromRollouts(resultDir) ?? null,
  };
}

function emptySummaryRow(agentLabel) {
  return {
    agent_label: agentLabel,
    total_episodes: 0,
    episodes_with_failure_replanner: 0,
    failure_replanner_invocations: 0,
    productive_failure_replanner_invocations: 0,
    failed_failure_replanner_invocations: 0,
    successful_episodes_with_productive_recovery: 0,
    ptd_source_disk: 0,
    ptd_source_checkpoint: 0,
    ptd_source_self_refine: 0,
    ptd_source_unknown: 0,
    self_refine_runs: 0,
    self_refine_accepted_runs: 0,
    self_refine_total_rounds_used: 0,
    self_refine_avg_rounds_used: 0,
    self_refine_max_rounds_used: 0,
  };
}

function applyManifestToSummary(row, manifest) {
  const metrics = manifest.architecture_metrics ?? makeEmptyArchitectureMetrics();
  const ptd = metrics.ptd ?? makeEmptyArchitectureMetrics().ptd;
  const recovery = metrics.failure_replanner ??
      makeEmptyArchitectureMetrics().failure_replanner;
  const normalized = normalizeEpisodeRecord(manifest);

  row.total_episodes += 1;
  if ((recovery.invocations ?? 0) > 0) {
    row.episodes_with_failure_replanner += 1;
  }
  row.failure_replanner_invocations += recovery.invocations ?? 0;
  row.productive_failure_replanner_invocations +=
      recovery.productive_invocations ?? 0;
  row.failed_failure_replanner_invocations +=
      recovery.failed_invocations ?? 0;
  if (normalized.success === 1 &&
      (recovery.productive_invocations ?? 0) > 0) {
    row.successful_episodes_with_productive_recovery += 1;
  }
  row.ptd_source_disk += ptd.source_breakdown?.disk ?? 0;
  row.ptd_source_checkpoint += ptd.source_breakdown?.checkpoint ?? 0;
  row.ptd_source_self_refine += ptd.source_breakdown?.self_refine ?? 0;
  row.ptd_source_unknown += ptd.source_breakdown?.unknown ?? 0;
  row.self_refine_runs += ptd.self_refine_runs ?? 0;
  row.self_refine_accepted_runs += ptd.accepted_runs ?? 0;
  row.self_refine_total_rounds_used += ptd.total_rounds_used ?? 0;
  row.self_refine_max_rounds_used = Math.max(
      row.self_refine_max_rounds_used, ptd.max_rounds_used ?? 0);
}

function finalizeSummaryRow(row) {
  return {
    ...row,
    self_refine_avg_rounds_used: row.self_refine_runs === 0 ? 0 :
        row.self_refine_total_rounds_used / row.self_refine_runs,
  };
}

export function buildArchitectureSummaryRows(manifests) {
  const rows = new Map();

  function getRow(agentLabel) {
    if (!rows.has(agentLabel)) {
      rows.set(agentLabel, emptySummaryRow(agentLabel));
    }
    return rows.get(agentLabel);
  }

  for (const manifest of manifests ?? []) {
    applyManifestToSummary(getRow('ALL'), manifest);
    applyManifestToSummary(getRow(manifest.agent_label ?? 'unknown'), manifest);
  }

  return [...rows.values()]
      .map(finalizeSummaryRow)
      .sort((a, b) => a.agent_label.localeCompare(b.agent_label));
}
