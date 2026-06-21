import fs from 'fs';
import os from 'os';
import path from 'path';

import {describe, expect, it} from 'vitest';

import {
  augmentManifestWithArchitectureMetrics,
} from '../architecture_metrics.js';

describe('augmentManifestWithArchitectureMetrics', () => {
  it('injects architecture metrics for timeout episodes from copied rollout traces', () => {
    const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'ah-architecture-metrics-'));
    const rolloutDir =
        path.join(tempRoot, 'achievement_rollouts', 'run_001');
    fs.mkdirSync(rolloutDir, {recursive: true});
    fs.writeFileSync(
        path.join(rolloutDir, 'rollout_trace.json'),
        JSON.stringify({
          status: 'running',
          stages: [
            {
              stage: 'PTD',
              parsed: {objective: 'Acquire a diamond'},
              meta: {source: 'disk', status: 'loaded'},
            },
            {
              stage: 'RECOVERY',
              type: 'invocation_start',
              invocation_id: 'recovery-1',
              task_key: 'collect::diamond_ore',
              action_type: 'collect',
              target_item: 'diamond_ore',
              trigger_terminal_reason: 'repeated_identical_failure',
              failed_step_kinds: ['command_failure'],
            },
            {
              stage: 'RECOVERY',
              type: 'attempt_start',
              invocation_id: 'recovery-1',
              attempt: 1,
            },
            {
              stage: 'RECOVERY',
              type: 'action_result',
              invocation_id: 'recovery-1',
              attempt: 1,
              action_index: 0,
              result: {success: false},
            },
            {
              stage: 'RECOVERY',
              type: 'invocation_end',
              invocation_id: 'recovery-1',
              status: 'fail',
              exit_status: 'hard_failure',
              attempts_used: 1,
              actions_executed: 1,
            },
          ],
        }, null, 2),
        'utf8');

    const manifest = augmentManifestWithArchitectureMetrics({
      agent_label: 'our_agent',
      seed: 123,
      task_id: 'diamonds',
      exit_status: 'timeout',
      score: 0,
    }, tempRoot);

    expect(manifest.architecture_metrics).not.toBeNull();
    expect(manifest.architecture_metrics.rollout_traces_found).toBe(1);
    expect(manifest.architecture_metrics.ptd.source).toBe('disk');
    expect(manifest.architecture_metrics.failure_replanner.invocations).toBe(1);
    expect(manifest.architecture_metrics.failure_replanner.failed_invocations)
        .toBe(1);
    expect(manifest.architecture_metrics.failure_replanner.sessions[0]
        .trigger_terminal_reason).toBe('repeated_identical_failure');

    fs.rmSync(tempRoot, {recursive: true, force: true});
  });
});
