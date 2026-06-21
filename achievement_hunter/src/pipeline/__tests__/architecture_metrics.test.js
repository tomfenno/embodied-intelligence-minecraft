import {describe, expect, it} from 'vitest';

import {
  buildArchitectureMetricsFromRollout,
} from '../architecture_metrics.js';

describe('buildArchitectureMetricsFromRollout', () => {
  it('captures disk-loaded PTD bypass without self-refine activity', () => {
    const metrics = buildArchitectureMetricsFromRollout({
      stages: [{
        stage: 'PTD',
        parsed: {objective: 'craft a torch'},
        meta: {source: 'disk', status: 'loaded'},
      }],
    });

    expect(metrics.ptd.source).toBe('disk');
    expect(metrics.ptd.status).toBe('loaded');
    expect(metrics.ptd.self_refine_invoked).toBe(false);
    expect(metrics.ptd.source_breakdown.disk).toBe(1);
  });

  it('captures checkpoint PTD resumes as non-self-refine runs', () => {
    const metrics = buildArchitectureMetricsFromRollout({
      stages: [{
        stage: 'PTD',
        parsed: {objective: 'smelt an iron ingot'},
        meta: {source: 'checkpoint', status: 'loaded'},
      }],
    });

    expect(metrics.ptd.source).toBe('checkpoint');
    expect(metrics.ptd.status).toBe('loaded');
    expect(metrics.ptd.self_refine_invoked).toBe(false);
    expect(metrics.ptd.source_breakdown.checkpoint).toBe(1);
  });

  it('reports self-refine acceptance at validation round 0', () => {
    const metrics = buildArchitectureMetricsFromRollout({
      stages: [
        {
          stage: 'PTD',
          parsed: {objective: 'mine coal'},
          meta: {
            source: 'self_refine',
            stage: 'generate',
            round: 0,
            latency_ms: 125,
          },
        },
        {
          stage: 'PTD',
          parsed: {
            verdict: 'pass',
            definite_issues: [],
            possible_issues: [],
            summary: 'good',
          },
          meta: {
            source: 'self_refine',
            stage: 'validate',
            round: 0,
            latency_ms: 95,
          },
        },
      ],
    });

    expect(metrics.ptd.source).toBe('self_refine');
    expect(metrics.ptd.status).toBe('accepted');
    expect(metrics.ptd.self_refine_invoked).toBe(true);
    expect(metrics.ptd.accepted_after_round).toBe(0);
    expect(metrics.ptd.rounds_used).toBe(0);
    expect(metrics.ptd.generation_calls).toBe(1);
    expect(metrics.ptd.validation_calls).toBe(1);
    expect(metrics.ptd.refinement_calls).toBe(0);
    expect(metrics.ptd.total_latency_ms).toBe(220);
  });

  it('reports self-refine acceptance after a refinement round', () => {
    const metrics = buildArchitectureMetricsFromRollout({
      stages: [
        {
          stage: 'PTD',
          parsed: {objective: 'bake bread'},
          meta: {
            source: 'self_refine',
            stage: 'generate',
            round: 0,
            latency_ms: 100,
          },
        },
        {
          stage: 'PTD',
          parsed: {
            verdict: 'fail',
            definite_issues: ['missing wheat'],
            possible_issues: [],
            summary: 'incomplete',
          },
          meta: {
            source: 'self_refine',
            stage: 'validate',
            round: 0,
            latency_ms: 80,
          },
        },
        {
          stage: 'PTD',
          parsed: {objective: 'bake bread'},
          meta: {
            source: 'self_refine',
            stage: 'refine',
            round: 1,
            latency_ms: 90,
          },
        },
        {
          stage: 'PTD',
          parsed: {
            verdict: 'pass',
            definite_issues: [],
            possible_issues: [],
            summary: 'fixed',
          },
          meta: {
            source: 'self_refine',
            stage: 'validate',
            round: 1,
            latency_ms: 70,
          },
        },
      ],
    });

    expect(metrics.ptd.source).toBe('self_refine');
    expect(metrics.ptd.status).toBe('accepted');
    expect(metrics.ptd.accepted_after_round).toBe(1);
    expect(metrics.ptd.rounds_used).toBe(1);
    expect(metrics.ptd.generation_calls).toBe(1);
    expect(metrics.ptd.validation_calls).toBe(2);
    expect(metrics.ptd.refinement_calls).toBe(1);
    expect(metrics.ptd.max_rounds_used).toBe(1);
  });

  it('tracks productive failure-replanner sessions', () => {
    const metrics = buildArchitectureMetricsFromRollout({
      stages: [
        {
          stage: 'RECOVERY',
          type: 'invocation_start',
          invocation_id: 'r1',
          task_key: 'collect::oak_log',
          action_type: 'collect',
          target_item: 'oak_log',
          trigger_terminal_reason: 'repeated_identical_failure',
          failed_step_kinds: ['mode_interrupted'],
        },
        {
          stage: 'RECOVERY',
          type: 'attempt_start',
          invocation_id: 'r1',
          attempt: 1,
        },
        {
          stage: 'RECOVERY',
          type: 'action_result',
          invocation_id: 'r1',
          attempt: 1,
          action_index: 0,
          result: {success: true},
        },
        {
          stage: 'RECOVERY',
          type: 'invocation_end',
          invocation_id: 'r1',
          status: 'success',
          exit_status: 'success',
          attempts_used: 1,
          actions_executed: 1,
        },
      ],
    });

    expect(metrics.failure_replanner.invocations).toBe(1);
    expect(metrics.failure_replanner.productive_invocations).toBe(1);
    expect(metrics.failure_replanner.failed_invocations).toBe(0);
    expect(metrics.failure_replanner.total_attempts).toBe(1);
    expect(metrics.failure_replanner.total_actions_executed).toBe(1);
    expect(metrics.failure_replanner.invocations_by_trigger)
        .toEqual({repeated_identical_failure: 1});
  });

  it('tracks failed failure-replanner sessions and their exit status', () => {
    const metrics = buildArchitectureMetricsFromRollout({
      stages: [
        {
          stage: 'RECOVERY',
          type: 'invocation_start',
          invocation_id: 'r2',
          task_key: 'craft::stick',
          action_type: 'craft',
          target_item: 'stick',
          trigger_terminal_reason: 'exhausted_inner_retries',
          failed_step_kinds: ['command_failure'],
        },
        {
          stage: 'RECOVERY',
          type: 'attempt_start',
          invocation_id: 'r2',
          attempt: 1,
        },
        {
          stage: 'RECOVERY',
          type: 'action_result',
          invocation_id: 'r2',
          attempt: 1,
          action_index: 0,
          result: {success: false},
        },
        {
          stage: 'RECOVERY',
          type: 'attempt_start',
          invocation_id: 'r2',
          attempt: 2,
        },
        {
          stage: 'RECOVERY',
          type: 'action_result',
          invocation_id: 'r2',
          attempt: 2,
          action_index: 0,
          result: {success: false},
        },
        {
          stage: 'RECOVERY',
          type: 'invocation_end',
          invocation_id: 'r2',
          status: 'fail',
          exit_status: 'exhausted',
          attempts_used: 2,
          actions_executed: 2,
        },
      ],
    });

    expect(metrics.failure_replanner.invocations).toBe(1);
    expect(metrics.failure_replanner.productive_invocations).toBe(0);
    expect(metrics.failure_replanner.failed_invocations).toBe(1);
    expect(metrics.failure_replanner.total_attempts).toBe(2);
    expect(metrics.failure_replanner.total_actions_executed).toBe(2);
    expect(metrics.failure_replanner.sessions[0].exit_status).toBe('exhausted');
  });
});
