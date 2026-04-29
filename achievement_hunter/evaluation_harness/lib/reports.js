import fs from 'fs';
import path from 'path';

import {readJson, walkFiles} from './utils.js';

export function appendOrReplaceManifest(manifests, newManifest) {
  const key = [
    newManifest.agent_label,
    newManifest.seed,
    newManifest.task_id,
  ].join('::');

  const filtered = manifests.filter((manifest) => {
    return [
      manifest.agent_label,
      manifest.seed,
      manifest.task_id,
    ].join('::') !== key;
  });
  filtered.push(newManifest);
  filtered.sort((a, b) => {
    return compareTuple(
        [a.agent_label, a.seed, a.task_id],
        [b.agent_label, b.seed, b.task_id]);
  });
  return filtered;
}

export function loadExistingManifests(suiteRoot) {
  const resultsPath = path.join(suiteRoot, 'results.jsonl');
  if (fs.existsSync(resultsPath)) {
    return loadJsonl(resultsPath);
  }

  const manifests = [];
  for (const filePath of walkFiles(suiteRoot)) {
    if (path.basename(filePath) !== 'episode_manifest.json') continue;
    try {
      manifests.push(readJson(filePath));
    } catch (error) {
      console.warn(`Skipping unreadable manifest ${filePath}: ${error}`);
    }
  }
  manifests.sort((a, b) => {
    return compareTuple(
        [a.agent_label, a.seed, a.task_id],
        [b.agent_label, b.seed, b.task_id]);
  });
  return manifests;
}

export function loadJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
}

export function writeResultsJsonl(resultsPath, manifests) {
  const content = manifests
      .map((manifest) => JSON.stringify(manifest))
      .join('\n');
  fs.writeFileSync(resultsPath, `${content}${content ? '\n' : ''}`, 'utf8');
}

export function writeSummaryReports(suiteRoot, manifests) {
  const perTaskRows = new Map();
  const summaryRows = new Map();

  for (const manifest of manifests) {
    const success = Number((manifest.score ?? 0) >= 1);
    const durationSeconds = manifest.episode_duration_seconds ?? 0;
    const dependencyFailures = manifest.dependency_failures ?? 0;
    const totalCommands = manifest.dependency_total_commands ?? 0;
    const unparseable = manifest.dependency_unparseable_command_records ?? 0;
    const target = serializeMetadataValue(manifest.target);
    const targetAnyOf = serializeMetadataValue(manifest.target_any_of);

    const perTaskKey = [
      manifest.agent_label,
      manifest.agent_name,
      manifest.mode,
      manifest.task_id,
      manifest.task_type,
      target,
      targetAnyOf,
    ].join('::');
    if (!perTaskRows.has(perTaskKey)) {
      perTaskRows.set(perTaskKey, {
        agent_label: manifest.agent_label,
        agent_name: manifest.agent_name,
        mode: manifest.mode,
        task_id: manifest.task_id,
        task_type: manifest.task_type,
        target,
        target_any_of: targetAnyOf,
        runs: 0,
        successful_runs: 0,
        total_episode_duration_seconds: 0,
        total_dependency_failures: 0,
        total_commands: 0,
        total_unparseable_command_records: 0,
      });
    }
    const perTaskRow = perTaskRows.get(perTaskKey);
    perTaskRow.runs += 1;
    perTaskRow.successful_runs += success;
    perTaskRow.total_episode_duration_seconds += durationSeconds;
    perTaskRow.total_dependency_failures += dependencyFailures;
    perTaskRow.total_commands += totalCommands;
    perTaskRow.total_unparseable_command_records += unparseable;

    const summaryKey =
        [manifest.agent_label, manifest.agent_name, manifest.mode].join('::');
    if (!summaryRows.has(summaryKey)) {
      summaryRows.set(summaryKey, {
        agent_label: manifest.agent_label,
        agent_name: manifest.agent_name,
        mode: manifest.mode,
        runs: 0,
        successful_runs: 0,
        total_episode_duration_seconds: 0,
        total_dependency_failures: 0,
        total_commands: 0,
        total_unparseable_command_records: 0,
      });
    }
    const summaryRow = summaryRows.get(summaryKey);
    summaryRow.runs += 1;
    summaryRow.successful_runs += success;
    summaryRow.total_episode_duration_seconds += durationSeconds;
    summaryRow.total_dependency_failures += dependencyFailures;
    summaryRow.total_commands += totalCommands;
    summaryRow.total_unparseable_command_records += unparseable;
  }

  writeCsv(path.join(suiteRoot, 'per_task.csv'), [
    'agent_label',
    'agent_name',
    'mode',
    'task_id',
    'task_type',
    'target',
    'target_any_of',
    'runs',
    'successful_runs',
    'success_rate',
    'avg_episode_duration_seconds',
    'total_dependency_failures',
    'total_commands',
    'dependency_error_rate',
    'total_unparseable_command_records',
  ], [...perTaskRows.values()].sort((a, b) => {
    return compareTuple(
        [a.agent_label, a.task_id],
        [b.agent_label, b.task_id]);
  }).map((row) => formatSummaryRow(row)));

  writeCsv(path.join(suiteRoot, 'summary.csv'), [
    'agent_label',
    'agent_name',
    'mode',
    'runs',
    'successful_runs',
    'success_rate',
    'avg_episode_duration_seconds',
    'total_dependency_failures',
    'total_commands',
    'dependency_error_rate',
    'total_unparseable_command_records',
  ], [...summaryRows.values()].sort((a, b) => {
    return compareTuple(
        [a.agent_label, a.agent_name],
        [b.agent_label, b.agent_name]);
  }).map((row) => formatSummaryRow(row)));
}

export function serializeMetadataValue(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatSummaryRow(row) {
  const runs = row.runs || 0;
  const totalCommands = row.total_commands || 0;
  return {
    ...row,
    success_rate: runs === 0 ? 0 : row.successful_runs / runs,
    avg_episode_duration_seconds:
        runs === 0 ? 0 : row.total_episode_duration_seconds / runs,
    dependency_error_rate:
        totalCommands === 0 ? 0 : row.total_dependency_failures / totalCommands,
  };
}

function writeCsv(filePath, headers, rows) {
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => escapeCsv(row[header])).join(',')),
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function escapeCsv(value) {
  if (value == null) return '';
  const text = String(value);
  if (!text.includes(',') && !text.includes('"') && !text.includes('\n')) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function compareTuple(aTuple, bTuple) {
  for (let index = 0; index < Math.max(aTuple.length, bTuple.length); index++) {
    const aValue = aTuple[index] ?? '';
    const bValue = bTuple[index] ?? '';
    if (aValue < bValue) return -1;
    if (aValue > bValue) return 1;
  }
  return 0;
}
