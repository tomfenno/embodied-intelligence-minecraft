import fs from 'fs';
import path from 'path';
import {spawnSync} from 'child_process';
import {fileURLToPath} from 'url';
import {afterEach, describe, expect, it} from 'vitest';

import {loadJsonl} from '../reports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../../..');
const TMP_ROOT = path.join(__dirname, '.tmp-merge');
const MERGE_SCRIPT = path.join(
    PROJECT_ROOT, 'achievement_hunter', 'evaluation_harness', 'merge_results.js');

afterEach(() => {
  fs.rmSync(TMP_ROOT, {recursive: true, force: true});
});

function makeTempPath(name) {
  const outputPath = path.join(TMP_ROOT, name);
  fs.rmSync(outputPath, {recursive: true, force: true});
  fs.mkdirSync(outputPath, {recursive: true});
  return outputPath;
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      'utf8');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readCsv(filePath) {
  const [headerLine, ...rowLines] = fs.readFileSync(filePath, 'utf8')
      .trim()
      .split(/\r?\n/);
  const headers = headerLine.split(',');
  return rowLines.map((line) => {
    const values = line.split(',');
    return Object.fromEntries(headers.map((header, index) => {
      return [header, values[index] ?? ''];
    }));
  });
}

describe('merge_results.js', () => {
  it('merges non-overlapping shards and regenerates reduced reports', () => {
    const shardA = makeTempPath('shard-a');
    const shardB = makeTempPath('shard-b');
    const outputDir = path.join(TMP_ROOT, 'merged-output');

    writeJsonl(path.join(shardA, 'results.jsonl'), [
      {
        agent_label: 'agent_a',
        seed: 1,
        task_id: 'task_1',
        success: 1,
        episode_duration_seconds: 10,
        total_commands: 5,
      },
    ]);
    writeJson(path.join(shardB, 'agent_a', 'seed_2', 'task_1', 'episode_manifest.json'), {
      agent_label: 'agent_a',
      seed: 2,
      task_id: 'task_1',
      score: 0,
      episode_duration_seconds: 30,
      dependency_total_commands: 9,
      agent_name: 'Ignored',
    });

    const result = spawnSync(process.execPath, [
      MERGE_SCRIPT,
      '--output', path.relative(PROJECT_ROOT, outputDir),
      '--input', path.relative(PROJECT_ROOT, shardA),
      '--input', path.relative(PROJECT_ROOT, shardB),
    ], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(loadJsonl(path.join(outputDir, 'results.jsonl'))).toEqual([
      {
        agent_label: 'agent_a',
        seed: 1,
        task_id: 'task_1',
        success: 1,
        episode_duration_seconds: 10,
        total_commands: 5,
      },
      {
        agent_label: 'agent_a',
        seed: 2,
        task_id: 'task_1',
        success: 0,
        episode_duration_seconds: 30,
        total_commands: 9,
      },
    ]);

    expect(readCsv(path.join(outputDir, 'per_task.csv'))).toEqual([
      {
        agent_label: 'agent_a',
        task_id: 'task_1',
        runs: '2',
        successful_runs: '1',
        success_rate: '0.5',
        avg_episode_duration_seconds: '20',
        total_commands: '14',
      },
    ]);

    expect(readCsv(path.join(outputDir, 'summary.csv'))).toEqual([
      {
        agent_label: 'agent_a',
        runs: '2',
        successful_runs: '1',
        success_rate: '0.5',
        avg_episode_duration_seconds: '20',
        total_commands: '14',
      },
    ]);
  });

  it('fails when two inputs contain the same agent-seed-task episode', () => {
    const shardA = makeTempPath('duplicate-a');
    const shardB = makeTempPath('duplicate-b');
    const outputDir = path.join(TMP_ROOT, 'duplicate-output');

    writeJsonl(path.join(shardA, 'results.jsonl'), [{
      agent_label: 'agent_a',
      seed: 1,
      task_id: 'task_1',
      success: 1,
      episode_duration_seconds: 10,
      total_commands: 5,
    }]);
    writeJsonl(path.join(shardB, 'results.jsonl'), [{
      agent_label: 'agent_a',
      seed: 1,
      task_id: 'task_1',
      success: 0,
      episode_duration_seconds: 20,
      total_commands: 7,
    }]);

    const result = spawnSync(process.execPath, [
      MERGE_SCRIPT,
      '--output', path.relative(PROJECT_ROOT, outputDir),
      '--input', path.relative(PROJECT_ROOT, shardA),
      '--input', path.relative(PROJECT_ROOT, shardB),
    ], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
        'Duplicate benchmark episode across merge inputs for agent_a::1::task_1');
    expect(fs.existsSync(path.join(outputDir, 'results.jsonl'))).toBe(false);
  });
});
