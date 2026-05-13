/**
 * Baseline tests for saveCheckpoint, loadCheckpoint, clearCheckpoint.
 *
 * Note: CHECKPOINT_PATH is hardcoded inside checkpoint.js relative to its own
 * __dirname. These tests use the same resolved path, save any pre-existing
 * checkpoint in beforeEach, and restore it in afterEach so real state is never
 * lost. A future improvement is to make the path configurable so tests can use
 * a temp directory.
 */
import {existsSync, readFileSync, unlinkSync, writeFileSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  _resetCheckpointCacheForTests,
  clearCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
} from '../checkpoint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Mirrors the path resolution inside checkpoint.js:
//   __dirname of checkpoint.js = achievement_hunter/src/pipeline
//   ../../rollouts = achievement_hunter/rollouts
const CHECKPOINT_PATH =
    path.resolve(__dirname, '../../../rollouts/checkpoint.json');

const OBJECTIVE = '__vitest_checkpoint_objective__';
const GRAPH = {
  objective: OBJECTIVE,
  sinks: ['test_item'],
  vertices: [{id: 'test_item', qty: 1}],
  edges: [],
};

let saved_prior = null;

beforeEach(async () => {
  // Drain any orphan write from the previous test before snapshotting the
  // file, so a fire-and-forget save can't land between snapshot and the
  // next test starting.
  await _resetCheckpointCacheForTests();
  // Preserve any real checkpoint that may already exist
  saved_prior = existsSync(CHECKPOINT_PATH) ?
      readFileSync(CHECKPOINT_PATH, 'utf8') :
      null;
});

afterEach(async () => {
  // Drain in-flight writes first — otherwise an orphan flush from the
  // test could rename(tmp, final) after our writeFileSync(saved_prior)
  // restoration, clobbering it with stale data.
  await _resetCheckpointCacheForTests();
  // Restore or remove to leave the filesystem exactly as found
  if (saved_prior !== null) {
    writeFileSync(CHECKPOINT_PATH, saved_prior, 'utf8');
  } else if (existsSync(CHECKPOINT_PATH)) {
    unlinkSync(CHECKPOINT_PATH);
  }
});

// ── saveCheckpoint ──────────────────────────────────────────────────────────

describe('saveCheckpoint', () => {
  it('creates the checkpoint file', async () => {
    await saveCheckpoint(OBJECTIVE, GRAPH);
    expect(existsSync(CHECKPOINT_PATH)).toBe(true);
  });

  it('writes objective and graph into the file', async () => {
    await saveCheckpoint(OBJECTIVE, GRAPH);
    const data = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8'));
    expect(data.objective).toBe(OBJECTIVE);
    expect(data.graph).toEqual(GRAPH);
  });

  it('writes a valid ISO saved_at timestamp', async () => {
    await saveCheckpoint(OBJECTIVE, GRAPH);
    const data = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8'));
    expect(data.saved_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('overwrites an existing checkpoint', async () => {
    await saveCheckpoint(OBJECTIVE, GRAPH);
    const updated_graph = {...GRAPH, sinks: ['different_item']};
    await saveCheckpoint(OBJECTIVE, updated_graph);
    const data = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8'));
    expect(data.graph.sinks).toEqual(['different_item']);
  });
});

// ── loadCheckpoint ──────────────────────────────────────────────────────────

describe('loadCheckpoint', () => {
  it('returns null when no file exists', () => {
    if (existsSync(CHECKPOINT_PATH)) unlinkSync(CHECKPOINT_PATH);
    expect(loadCheckpoint()).toBeNull();
  });

  it('returns the saved objective and graph', async () => {
    await saveCheckpoint(OBJECTIVE, GRAPH);
    const result = loadCheckpoint();
    expect(result.objective).toBe(OBJECTIVE);
    expect(result.graph).toEqual(GRAPH);
  });

  it('returns a saved_at field', async () => {
    await saveCheckpoint(OBJECTIVE, GRAPH);
    const result = loadCheckpoint();
    expect(result.saved_at).toBeDefined();
  });

  it('returns null when objective field is missing', () => {
    writeFileSync(CHECKPOINT_PATH, JSON.stringify({graph: GRAPH}), 'utf8');
    expect(loadCheckpoint()).toBeNull();
  });

  it('returns null when graph field is missing', () => {
    writeFileSync(
        CHECKPOINT_PATH, JSON.stringify({objective: OBJECTIVE}), 'utf8');
    expect(loadCheckpoint()).toBeNull();
  });

  it('returns null and emits a warning when the file contains invalid JSON',
     () => {
       const warn_spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
       writeFileSync(CHECKPOINT_PATH, 'this is not json', 'utf8');
       expect(loadCheckpoint()).toBeNull();
       expect(warn_spy).toHaveBeenCalled();
       warn_spy.mockRestore();
     });
});

// ── clearCheckpoint ─────────────────────────────────────────────────────────

describe('clearCheckpoint', () => {
  it('deletes the checkpoint file', async () => {
    await saveCheckpoint(OBJECTIVE, GRAPH);
    expect(existsSync(CHECKPOINT_PATH)).toBe(true);
    await clearCheckpoint();
    expect(existsSync(CHECKPOINT_PATH)).toBe(false);
  });

  it('does not throw when no checkpoint file exists', async () => {
    if (existsSync(CHECKPOINT_PATH)) unlinkSync(CHECKPOINT_PATH);
    await expect(clearCheckpoint()).resolves.not.toThrow();
  });
});
