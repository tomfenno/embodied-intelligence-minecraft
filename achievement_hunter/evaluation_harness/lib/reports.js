import fs from 'fs';
import path from 'path';

import {readJson, walkFiles} from './utils.js';

const PER_TASK_HEADERS = [
  'agent_label',
  'task_id',
  'runs',
  'successful_runs',
  'success_rate',
  'avg_episode_duration_seconds',
  'total_commands',
];

const SUMMARY_HEADERS = [
  'agent_label',
  'runs',
  'successful_runs',
  'success_rate',
  'avg_episode_duration_seconds',
  'total_commands',
];

export function buildEpisodeKey(record) {
  return [
    record.agent_label,
    record.seed,
    record.task_id,
  ].join('::');
}

export function appendOrReplaceManifest(manifests, newManifest) {
  const key = buildEpisodeKey(newManifest);

  const filtered = manifests.filter((manifest) => {
    return buildEpisodeKey(manifest) !== key;
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

export function normalizeEpisodeRecord(record) {
  return {
    agent_label: record.agent_label,
    seed: record.seed,
    task_id: record.task_id,
    success: normalizeSuccess(record),
    episode_duration_seconds:
        normalizeNumber(record.episode_duration_seconds),
    total_commands:
        normalizeNumber(record.total_commands ??
            record.dependency_total_commands),
  };
}

export function writeResultsJsonl(resultsPath, manifests) {
  const content = manifests
      .map((manifest) => JSON.stringify(normalizeEpisodeRecord(manifest)))
      .join('\n');
  fs.writeFileSync(resultsPath, `${content}${content ? '\n' : ''}`, 'utf8');
}

export function writeSummaryReports(suiteRoot, manifests) {
  const perTaskRows = new Map();
  const summaryRows = new Map();

  for (const manifest of manifests.map(normalizeEpisodeRecord)) {
    const perTaskKey = [manifest.agent_label, manifest.task_id].join('::');
    if (!perTaskRows.has(perTaskKey)) {
      perTaskRows.set(perTaskKey, {
        agent_label: manifest.agent_label,
        task_id: manifest.task_id,
        runs: 0,
        successful_runs: 0,
        total_episode_duration_seconds: 0,
        total_commands: 0,
      });
    }
    const perTaskRow = perTaskRows.get(perTaskKey);
    perTaskRow.runs += 1;
    perTaskRow.successful_runs += manifest.success;
    perTaskRow.total_episode_duration_seconds +=
        manifest.episode_duration_seconds;
    perTaskRow.total_commands += manifest.total_commands;

    const summaryKey = manifest.agent_label;
    if (!summaryRows.has(summaryKey)) {
      summaryRows.set(summaryKey, {
        agent_label: manifest.agent_label,
        runs: 0,
        successful_runs: 0,
        total_episode_duration_seconds: 0,
        total_commands: 0,
      });
    }
    const summaryRow = summaryRows.get(summaryKey);
    summaryRow.runs += 1;
    summaryRow.successful_runs += manifest.success;
    summaryRow.total_episode_duration_seconds +=
        manifest.episode_duration_seconds;
    summaryRow.total_commands += manifest.total_commands;
  }

  writeCsv(path.join(suiteRoot, 'per_task.csv'), PER_TASK_HEADERS,
      [...perTaskRows.values()].sort((a, b) => {
        return compareTuple(
            [a.agent_label, a.task_id],
            [b.agent_label, b.task_id]);
      }).map((row) => formatAggregateRow(row)));

  writeCsv(path.join(suiteRoot, 'summary.csv'), SUMMARY_HEADERS,
      [...summaryRows.values()].sort((a, b) => {
        return compareTuple(
            [a.agent_label],
            [b.agent_label]);
      }).map((row) => formatAggregateRow(row)));
}

function formatAggregateRow(row) {
  const runs = row.runs || 0;
  return {
    ...row,
    success_rate: runs === 0 ? 0 : row.successful_runs / runs,
    avg_episode_duration_seconds:
        runs === 0 ? 0 : row.total_episode_duration_seconds / runs,
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

function normalizeSuccess(record) {
  if (record.success != null) {
    const value = String(record.success).trim().toLowerCase();
    if (value === '1' || value === 'true') return 1;
    if (value === '0' || value === 'false') return 0;
    const numeric = Number(record.success);
    if (Number.isFinite(numeric)) {
      return numeric >= 1 ? 1 : 0;
    }
  }

  return Number((record.score ?? 0) >= 1);
}

function normalizeNumber(value) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}
