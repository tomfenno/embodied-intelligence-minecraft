/**
 * Unit tests for AchievementAgentProcess._should_restart.
 *
 * _should_restart is a pure decision function — no I/O, no state — so it is
 * ideal to characterize before refactoring to lock in the restart policy.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock(
    '../../../../src/mindcraft/mindserver.js', () => ({logoutAgent: vi.fn()}));

import {AchievementAgentProcess} from '../achievement_agent_process.js';

let proc;

beforeEach(() => {
  proc = new AchievementAgentProcess('test-agent', 8080);
});

describe('AchievementAgentProcess._should_restart', () => {
  it('returns true when exit code is non-zero and signal is not SIGINT', () => {
    expect(proc._should_restart(1, null)).toBe(true);
  });

  it('returns false on exit code 0 (clean exit)', () => {
    expect(proc._should_restart(0, null)).toBe(false);
  });

  it('returns false when stopped via SIGINT regardless of exit code', () => {
    expect(proc._should_restart(1, 'SIGINT')).toBe(false);
    expect(proc._should_restart(0, 'SIGINT')).toBe(false);
  });

  it('returns true on unexpected signals like SIGTERM', () => {
    expect(proc._should_restart(null, 'SIGTERM')).toBe(true);
  });

  it('returns true on exit code 1 with no signal (typical crash)', () => {
    expect(proc._should_restart(1, undefined)).toBe(true);
  });
});
