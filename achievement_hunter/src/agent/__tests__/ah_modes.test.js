/**
 * Characterization tests for ModeController state methods.
 *
 * These tests lock in the public API that base agent.js calls on bot.modes
 * (getMiniDocs, getDocs, getJson, loadJson, flushBehaviorLog, exists, etc.)
 * so the _agent threading refactor cannot accidentally break it.
 *
 * We test via init_ah_modes() rather than new ModeController() directly so
 * the tests remain valid both before and after the constructor signature
 * changes.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('../../../../src/agent/library/skills.js', () => ({}));
vi.mock('../../../../src/agent/library/world.js', () => ({}));
vi.mock('../../../../src/utils/mcdata.js', () => ({}));
vi.mock(
    '../../../../src/agent/settings.js',
    () => ({default: {narrate_behavior: false}}));
vi.mock(
    '../../../../src/agent/conversation.js',
    () => ({default: {inConversation: () => false}}));

import {init_ah_modes} from '../ah_modes.js';

function make_mock_agent() {
  return {
    bot: {modes: null},
    task: null,
    prompter: {getInitModes: () => null},
    isIdle: () => true,
    actions: {currentActionLabel: null},
  };
}

let agent;
let modes;
let original_json;

beforeEach(() => {
  agent = make_mock_agent();
  init_ah_modes(agent);
  modes = agent.bot.modes;
  original_json = modes.getJson();
});

afterEach(() => {
  // Restore mode on-states so module-level mode objects don't leak between
  // tests.
  modes.loadJson(original_json);
});

// ── flushBehaviorLog ────────────────────────────────────────────────────────

describe('flushBehaviorLog', () => {
  it('returns empty string when nothing logged', () => {
    expect(modes.flushBehaviorLog()).toBe('');
  });

  it('returns accumulated log content', () => {
    modes.behavior_log = 'line1\nline2\n';
    expect(modes.flushBehaviorLog()).toBe('line1\nline2\n');
  });

  it('clears the log after flushing', () => {
    modes.behavior_log = 'something';
    modes.flushBehaviorLog();
    expect(modes.flushBehaviorLog()).toBe('');
  });
});

// ── exists ──────────────────────────────────────────────────────────────────

describe('exists', () => {
  it('returns true for built-in mode names', () => {
    for (const name
             of ['self_preservation', 'unstuck', 'cowardice', 'self_defense',
                 'hunting', 'item_collecting', 'torch_placing', 'elbow_room',
                 'idle_staring', 'cheat']) {
      expect(modes.exists(name), `expected exists('${name}') to be true`)
          .toBe(true);
    }
  });

  it('returns false for unknown mode names', () => {
    expect(modes.exists('__nonexistent__')).toBe(false);
    expect(modes.exists('')).toBe(false);
  });
});

// ── setOn / isOn ────────────────────────────────────────────────────────────

describe('setOn / isOn', () => {
  it('turns a mode off', () => {
    modes.setOn('unstuck', false);
    expect(modes.isOn('unstuck')).toBe(false);
  });

  it('turns a mode back on', () => {
    modes.setOn('unstuck', false);
    modes.setOn('unstuck', true);
    expect(modes.isOn('unstuck')).toBe(true);
  });

  it('cheat mode starts off', () => {
    expect(modes.isOn('cheat')).toBe(false);
  });
});

// ── pause / unpause ─────────────────────────────────────────────────────────

describe('pause / unpause', () => {
  it('does not turn a mode off when paused', () => {
    modes.pause('cowardice');
    expect(modes.isOn('cowardice')).toBe(true);
  });

  it('unpauses without throwing', () => {
    modes.pause('unstuck');
    expect(() => modes.unpause('unstuck')).not.toThrow();
  });

  it('unpause on an already-unpaused mode does not throw', () => {
    expect(() => modes.unpause('cowardice')).not.toThrow();
  });
});

// ── getJson / loadJson ──────────────────────────────────────────────────────

describe('getJson / loadJson', () => {
  it('getJson returns an object with boolean values for all modes', () => {
    const json = modes.getJson();
    expect(typeof json).toBe('object');
    for (const val of Object.values(json)) {
      expect(typeof val).toBe('boolean');
    }
  });

  it('loadJson applies on-state overrides', () => {
    modes.loadJson({unstuck: false, cowardice: false});
    expect(modes.isOn('unstuck')).toBe(false);
    expect(modes.isOn('cowardice')).toBe(false);
  });

  it('loadJson ignores keys that are not mode names', () => {
    expect(() => modes.loadJson({__unknown__: true})).not.toThrow();
  });

  it('round-trips on/off state through getJson + loadJson', () => {
    modes.setOn('hunting', false);
    const snapshot = modes.getJson();
    modes.setOn('hunting', true);
    modes.loadJson(snapshot);
    expect(modes.isOn('hunting')).toBe(false);
  });
});

// ── getMiniDocs / getDocs ───────────────────────────────────────────────────

describe('getMiniDocs / getDocs', () => {
  it('getMiniDocs contains all built-in mode names', () => {
    const docs = modes.getMiniDocs();
    for (const name of ['unstuck', 'cowardice', 'self_defense', 'hunting']) {
      expect(docs).toContain(name);
    }
  });

  it('getMiniDocs shows ON/OFF status', () => {
    modes.setOn('hunting', false);
    expect(modes.getMiniDocs()).toMatch(/hunting\(OFF\)/);
    modes.setOn('hunting', true);
    expect(modes.getMiniDocs()).toMatch(/hunting\(ON\)/);
  });

  it('getDocs contains mode descriptions', () => {
    const docs = modes.getDocs();
    expect(docs).toMatch(/Attempt to get unstuck/);
    expect(docs).toMatch(/Run away from enemies/);
  });
});

// ── init_ah_modes wiring ────────────────────────────────────────────────────

describe('init_ah_modes', () => {
  it('assigns a ModeController to agent.bot.modes', () => {
    expect(agent.bot.modes).toBeDefined();
    expect(typeof agent.bot.modes.update).toBe('function');
  });

  it('applies initial modes from prompter.getInitModes when provided', () => {
    const agent2 = make_mock_agent();
    agent2.prompter.getInitModes = () => ({hunting: false});
    init_ah_modes(agent2);
    expect(agent2.bot.modes.isOn('hunting')).toBe(false);
  });
});
