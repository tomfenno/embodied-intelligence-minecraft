import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {afterEach, describe, expect, it} from 'vitest';

import {
  loadJsonl,
  writeResultsJsonl,
  writeSummaryReports,
} from '../reports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = path.join(__dirname, '.tmp');

afterEach(() => {
  fs.rmSync(TMP_ROOT, {recursive: true, force: true});
});

function makeSuiteRoot(name) {
  const suiteRoot = path.join(TMP_ROOT, name);
  fs.rmSync(suiteRoot, {recursive: true, force: true});
  fs.mkdirSync(suiteRoot, {recursive: true});
  return suiteRoot;
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

describe('writeResultsJsonl', () => {
  it('writes only the compact per-episode fields', () => {
    const suiteRoot = makeSuiteRoot('compact-results');
    const resultsPath = path.join(suiteRoot, 'results.jsonl');

    writeResultsJsonl(resultsPath, [{
      agent_label: 'baseline_andy',
      seed: 42,
      task_id: 'pork_chop',
      score: 1,
      episode_duration_seconds: 12.5,
      dependency_total_commands: 17,
      agent_name: 'Andy',
      mode: 'achievement_hunter',
      result_dir: '/tmp/ignored',
    }]);

    expect(loadJsonl(resultsPath)).toEqual([{
      agent_label: 'baseline_andy',
      seed: 42,
      task_id: 'pork_chop',
      success: 1,
      episode_duration_seconds: 12.5,
      total_commands: 17,
    }]);
  });
});

describe('writeSummaryReports', () => {
  it('aggregates compact episode records into the reduced csv schemas', () => {
    const suiteRoot = makeSuiteRoot('minimal-records');

    writeSummaryReports(suiteRoot, [
      {
        agent_label: 'agent_a',
        seed: 1,
        task_id: 'task_1',
        success: 1,
        episode_duration_seconds: 10,
        total_commands: 4,
      },
      {
        agent_label: 'agent_a',
        seed: 2,
        task_id: 'task_1',
        success: 0,
        episode_duration_seconds: 20,
        total_commands: 6,
      },
      {
        agent_label: 'agent_a',
        seed: 1,
        task_id: 'task_2',
        success: 1,
        episode_duration_seconds: 15,
        total_commands: 5,
      },
      {
        agent_label: 'agent_b',
        seed: 1,
        task_id: 'task_1',
        success: 1,
        episode_duration_seconds: 30,
        total_commands: 8,
      },
    ]);

    expect(readCsv(path.join(suiteRoot, 'per_task.csv'))).toEqual([
      {
        agent_label: 'agent_a',
        task_id: 'task_1',
        runs: '2',
        successful_runs: '1',
        success_rate: '0.5',
        avg_episode_duration_seconds: '15',
        total_commands: '10',
      },
      {
        agent_label: 'agent_a',
        task_id: 'task_2',
        runs: '1',
        successful_runs: '1',
        success_rate: '1',
        avg_episode_duration_seconds: '15',
        total_commands: '5',
      },
      {
        agent_label: 'agent_b',
        task_id: 'task_1',
        runs: '1',
        successful_runs: '1',
        success_rate: '1',
        avg_episode_duration_seconds: '30',
        total_commands: '8',
      },
    ]);

    expect(readCsv(path.join(suiteRoot, 'summary.csv'))).toEqual([
      {
        agent_label: 'agent_a',
        runs: '3',
        successful_runs: '2',
        success_rate: '0.6666666666666666',
        avg_episode_duration_seconds: '15',
        total_commands: '15',
      },
      {
        agent_label: 'agent_b',
        runs: '1',
        successful_runs: '1',
        success_rate: '1',
        avg_episode_duration_seconds: '30',
        total_commands: '8',
      },
    ]);
  });

  it('accepts legacy detailed manifests and defaults missing metrics to zero', () => {
    const suiteRoot = makeSuiteRoot('legacy-manifests');

    writeSummaryReports(suiteRoot, [
      {
        agent_label: 'legacy_agent',
        seed: 7,
        task_id: 'task_a',
        score: 1,
        episode_duration_seconds: 9,
        dependency_total_commands: 11,
        agent_name: 'Ignored Name',
      },
      {
        agent_label: 'legacy_agent',
        seed: 8,
        task_id: 'task_a',
        score: 0,
      },
    ]);

    expect(readCsv(path.join(suiteRoot, 'per_task.csv'))).toEqual([
      {
        agent_label: 'legacy_agent',
        task_id: 'task_a',
        runs: '2',
        successful_runs: '1',
        success_rate: '0.5',
        avg_episode_duration_seconds: '4.5',
        total_commands: '11',
      },
    ]);

    expect(readCsv(path.join(suiteRoot, 'summary.csv'))).toEqual([
      {
        agent_label: 'legacy_agent',
        runs: '2',
        successful_runs: '1',
        success_rate: '0.5',
        avg_episode_duration_seconds: '4.5',
        total_commands: '11',
      },
    ]);
  });
});
