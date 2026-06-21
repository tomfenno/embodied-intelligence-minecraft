import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('../agent_state.js', () => ({
  get_am_state: vi.fn(() => ({position: {x: 0, y: 64, z: 0}})),
  get_recovery_trace_state: vi.fn(() => ({
    position: {x: 0, y: 64, z: 0},
    inventory: {},
  })),
  get_sgsg_state: vi.fn(() => ({inventory: {}})),
}));

vi.mock('../checkpoint.js', () => ({
  clearActiveReplanner: vi.fn(),
  loadCheckpoint: vi.fn(() => null),
  saveRuntimeState: vi.fn(),
}));

vi.mock('../command_utils.js', () => ({
  executeCommandWithModeRecovery: vi.fn(),
}));

vi.mock('../json_utils.js', () => ({
  extract_json: vi.fn((raw) => JSON.parse(raw)),
}));

vi.mock('../prompt_utils.js', () => ({
  fill_failure_replanner_prompt: vi.fn(() => 'prompt'),
}));

vi.mock('../scsg.js', () => ({
  compute_scsg: vi.fn(),
}));

vi.mock('../structured_loop/config.js', () => ({
  CRAFT_DEBOUNCE_MS: 0,
  FAILURE_REPLANNER_MAX_ACTION_RETRIES: 1,
  MAX_RECOVERY_ATTEMPTS: 2,
}));

vi.mock('../structured_loop/result_messages.js', () => ({
  build_command_failure_message: vi.fn(
      ({command}) => `command_failure: cmd=${command}`),
  build_runner_exception_message: vi.fn(
      ({command}) => `runner_exception: cmd=${command}`),
  build_search_already_attempted_message: vi.fn(
      ({target}) => `search_already_attempted: ${target}`),
}));

vi.mock('../structured_loop/search.js', () => ({
  run_search: vi.fn(),
}));

vi.mock('../structured_loop/tasks.js', () => ({
  task_key: vi.fn(() => 'collect::oak_log'),
}));

vi.mock('../structured_loop/trace.js', () => ({
  create_action_result: vi.fn((command, success, kind, message) => ({
    command,
    success,
    kind,
    message,
  })),
  project_failed_steps: vi.fn((steps) => steps
      .filter(step => step.result?.success === false)
      .map(step => ({kind: step.result.kind, message: step.result.message}))),
}));

import {get_recovery_trace_state} from '../agent_state.js';
import {saveRuntimeState} from '../checkpoint.js';
import {executeCommandWithModeRecovery} from '../command_utils.js';
import {compute_scsg} from '../scsg.js';
import {recover_failed_task} from '../structured_loop/failure_replanner.js';

function makeFailedTrace() {
  return {
    objective: 'Collect an oak log',
    task: {
      action_type: 'collect',
      target_item: 'oak_log',
      qty: 1,
      parameters: {},
    },
    terminal_status: 'fail',
    terminal_reason: 'exhausted_inner_retries',
    summary: {
      failed_steps: [{kind: 'command_failure'}],
    },
  };
}

function makeAgent() {
  return {
    bot: {
      _ah_death_pending: false,
      entity: {position: {x: 0, y: 64, z: 0}},
    },
  };
}

function makeLog() {
  return {
    recovery_invocation_start: vi.fn(),
    recovery_attempt: vi.fn(),
    recovery_action_result: vi.fn(),
    recovery_invocation_end: vi.fn(),
    recovery_end: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(get_recovery_trace_state).mockReturnValue({
    position: {x: 0, y: 64, z: 0},
    inventory: {},
  });
});

describe('recover_failed_task telemetry', () => {
  it('logs a productive invocation when recovery completes the task', async () => {
    vi.mocked(executeCommandWithModeRecovery).mockResolvedValue({
      success: true,
      message: 'ok',
    });
    vi.mocked(compute_scsg).mockReturnValue({r: 2});

    const log = makeLog();
    const model = {
      send_prompt: vi.fn(async () => JSON.stringify({
        diagnosis: 'Stop and let the outer loop recompute.',
        actions: [{name: '!stop', args: []}],
      })),
    };

    const result = await recover_failed_task(
        makeFailedTrace(), makeAgent(), model, {objective: 'test'}, log, {});

    expect(result).toBe('success');
    expect(log.recovery_invocation_start).toHaveBeenCalledWith(expect.objectContaining({
      task_key: 'collect::oak_log',
      action_type: 'collect',
      target_item: 'oak_log',
      trigger_terminal_reason: 'exhausted_inner_retries',
      failed_step_kinds: ['command_failure'],
    }));
    expect(log.recovery_attempt).toHaveBeenCalledTimes(1);
    expect(log.recovery_action_result).toHaveBeenCalledTimes(1);
    expect(log.recovery_invocation_end).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success',
      exit_status: 'success',
      attempts_used: 1,
      actions_executed: 1,
    }));
    expect(log.recovery_end).toHaveBeenCalledWith('success');
    expect(saveRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      active_replanner: expect.objectContaining({
        invocation_id: expect.any(String),
      }),
    }));
  });

  it('logs a failed invocation when recovery exhausts its attempts', async () => {
    vi.mocked(executeCommandWithModeRecovery).mockResolvedValue({
      success: false,
      message: 'blocked',
    });
    vi.mocked(compute_scsg).mockReturnValue({
      r: 1,
      final: {vertices: [{id: 'oak_log'}], edges: []},
    });

    const log = makeLog();
    const model = {
      send_prompt: vi.fn(async () => JSON.stringify({
        diagnosis: 'Try a direct stop before re-planning.',
        actions: [{name: '!stop', args: []}],
      })),
    };

    const result = await recover_failed_task(
        makeFailedTrace(), makeAgent(), model, {objective: 'test'}, log, {});

    expect(result).toBe('fail');
    expect(log.recovery_attempt).toHaveBeenCalledTimes(2);
    expect(log.recovery_action_result).toHaveBeenCalledTimes(2);
    expect(log.recovery_invocation_end).toHaveBeenCalledWith(expect.objectContaining({
      status: 'fail',
      exit_status: 'exhausted',
      attempts_used: 2,
      actions_executed: 2,
      failed_step_kinds: ['command_failure'],
    }));
    expect(log.recovery_end).toHaveBeenCalledWith('fail');
  });
});
