import fs from 'fs';
import path from 'path';

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {buildArchitectureSummaryRows} from './lib/architecture_metrics.js';
import {loadJsonl} from './lib/reports.js';
import {ensureDirectory, resolveProjectPath, walkFiles} from './lib/utils.js';

const HEADERS = [
  'agent_label',
  'total_episodes',
  'episodes_with_failure_replanner',
  'failure_replanner_invocations',
  'productive_failure_replanner_invocations',
  'failed_failure_replanner_invocations',
  'successful_episodes_with_productive_recovery',
  'ptd_source_disk',
  'ptd_source_checkpoint',
  'ptd_source_self_refine',
  'ptd_source_unknown',
  'self_refine_runs',
  'self_refine_accepted_runs',
  'self_refine_total_rounds_used',
  'self_refine_avg_rounds_used',
  'self_refine_max_rounds_used',
];

const argv = await yargs(hideBin(process.argv))
    .option('input', {
      type: 'string',
      array: true,
      demandOption: true,
      describe: 'Input results.jsonl files, episode manifests, or directories',
    })
    .option('output', {
      type: 'string',
      describe: 'Optional output directory for CSV/Markdown reports',
    })
    .strict()
    .help()
    .parse();

try {
  const manifests = [];
  for (const inputValue of argv.input) {
    manifests.push(...loadInputManifests(resolveProjectPath(inputValue)));
  }

  const rows = buildArchitectureSummaryRows(manifests);
  const markdown = renderMarkdown(rows);
  const csv = renderCsv(rows);

  console.log(markdown);

  if (argv.output) {
    const outputDir = resolveProjectPath(argv.output);
    ensureDirectory(outputDir);
    fs.writeFileSync(
        path.join(outputDir, 'architecture_metrics_summary.md'),
        `${markdown}\n`,
        'utf8');
    fs.writeFileSync(
        path.join(outputDir, 'architecture_metrics_summary.csv'),
        `${csv}\n`,
        'utf8');
  }
} catch (error) {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}

function loadInputManifests(inputPath) {
  if (fs.existsSync(inputPath) && fs.statSync(inputPath).isFile()) {
    if (path.basename(inputPath) === 'results.jsonl') {
      return loadJsonl(inputPath);
    }
    if (path.basename(inputPath) === 'episode_manifest.json') {
      return [JSON.parse(fs.readFileSync(inputPath, 'utf8'))];
    }
    throw new Error(`Unsupported input file: ${inputPath}`);
  }

  const manifests = [];
  for (const filePath of walkFiles(inputPath)) {
    if (path.basename(filePath) !== 'episode_manifest.json') continue;
    manifests.push(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  }
  if (manifests.length > 0) return manifests;

  if (fs.existsSync(path.join(inputPath, 'results.jsonl'))) {
    return loadJsonl(path.join(inputPath, 'results.jsonl'));
  }
  return manifests;
}

function renderCsv(rows) {
  const lines = [
    HEADERS.join(','),
    ...rows.map(
        row => HEADERS.map(header => escapeCsv(row[header])).join(',')),
  ];
  return lines.join('\n');
}

function renderMarkdown(rows) {
  const header = '| ' + HEADERS.join(' | ') + ' |';
  const divider = '| ' + HEADERS.map(() => '---').join(' | ') + ' |';
  const body = rows.map((row) => {
    return '| ' + HEADERS.map(header => formatMarkdownValue(row[header]))
               .join(' | ') +
        ' |';
  });
  return ['# Architecture Metrics Summary', '', header, divider, ...body].join(
      '\n');
}

function formatMarkdownValue(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(3);
  }
  return String(value ?? '');
}

function escapeCsv(value) {
  if (value == null) return '';
  const text =
      typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(6) :
      String(value);
  if (!text.includes(',') && !text.includes('"') && !text.includes('\n')) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}
