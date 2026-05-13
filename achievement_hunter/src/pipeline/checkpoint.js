import {existsSync, readFileSync, unlinkSync} from 'fs';
import {mkdir, rename, writeFile} from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Stored in rollouts/ — already mounted as a Docker volume
const CHECKPOINT_PATH = path.join(__dirname, '../../rollouts/checkpoint.json');
const CHECKPOINT_TMP_PATH = `${CHECKPOINT_PATH}.tmp`;

const RUNTIME_STATE_SCHEMA_VERSION = 1;

function empty_runtime_state() {
  return {
    schema_version: RUNTIME_STATE_SCHEMA_VERSION,
    outer: {consecutive_failures: 0},
    active_task: null,
    active_replanner: null,
  };
}

// ── In-memory cache + async write queue
// ─────────────────────────────────────
//
// Production hot path (replanner action loops, breadcrumb tick) calls
// saveCheckpoint / saveRuntimeState many times per second. Going through
// `readFileSync` + `writeFileSync` + `renameSync` on every call directly
// blocks pathfinding. We replace that with:
//
//   - An in-memory mirror (`_cached_checkpoint`) so save paths never read
//     from disk after the first cold load. `loadCheckpoint` still reads
//     fresh from disk because callers (and tests) expect it to reflect
//     whatever is currently on disk, including externally-written files.
//
//   - A serial async write queue: at most one write in flight, latest
//     pending content wins. The temp-then-rename atomicity invariant
//     (preserved from the sync version) survives because each enqueued
//     write runs `writeFile(tmp)` then `rename(tmp, final)` to completion
//     before the next pending value is picked up.
//
// `saveCheckpoint` / `saveRuntimeState` return the flush promise so tests
// can `await` and assert on disk state. Production callers ignore the
// return value — fire-and-forget.

let _cached_checkpoint = null;
let _cache_loaded = false;

let _pending_data = null;
let _flush_promise = null;

function _read_disk() {
  if (!existsSync(CHECKPOINT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8'));
  } catch (err) {
    console.warn('[SPL] Failed to parse checkpoint, ignoring:', err.message);
    return null;
  }
}

// Internal read used by save paths. First call cold-loads from disk; later
// calls return the cached in-memory state, which save paths keep current.
function read_cached() {
  if (!_cache_loaded) {
    _cached_checkpoint = _read_disk();
    _cache_loaded = true;
  }
  return _cached_checkpoint;
}

function enqueue_write(data) {
  _cached_checkpoint = data;
  _cache_loaded = true;
  _pending_data = data;
  if (!_flush_promise) {
    _flush_promise = flush();
  }
  return _flush_promise;
}

async function flush() {
  while (_pending_data !== null) {
    const data = _pending_data;
    _pending_data = null;
    try {
      await mkdir(path.dirname(CHECKPOINT_PATH), {recursive: true});
      await writeFile(
          CHECKPOINT_TMP_PATH, JSON.stringify(data, null, 2), 'utf8');
      await rename(CHECKPOINT_TMP_PATH, CHECKPOINT_PATH);
    } catch (err) {
      console.warn('[SPL] Checkpoint write failed:', err.message);
    }
  }
  _flush_promise = null;
}

/**
 * Resolves once every queued checkpoint write has settled. Call at SPL
 * shutdown / test teardown so the on-disk state reflects the final
 * in-memory state.
 */
export async function drainCheckpoint() {
  while (_flush_promise) {
    await _flush_promise;
  }
}

/**
 * Persists the current SPL objective, PTD graph, and (optionally) the
 * BreadcrumbTracker's current map. Preserves any existing `runtime_state`
 * block so callers that don't know about retry counters (e.g. the
 * breadcrumb tick) don't blow it away.
 *
 * Returns the in-flight flush promise. Production callers ignore it
 * (fire-and-forget); tests can `await` to assert on disk state.
 */
export function saveCheckpoint(objective, graph, breadcrumbs = null) {
  const prior = read_cached();
  const runtime_state = prior?.runtime_state ?? empty_runtime_state();
  return enqueue_write({
    objective,
    graph,
    breadcrumbs,
    runtime_state,
    saved_at: new Date().toISOString(),
  });
}

/**
 * Loads a checkpoint from disk. Always reads fresh — this is the public
 * entry point used at SPL startup (and in tests that write the file
 * externally), so it must reflect what's actually on disk rather than the
 * in-memory cache. Populates the cache as a side effect.
 *
 * Returns { objective, graph, breadcrumbs?, runtime_state?, saved_at } or
 * null if none exists. Legacy checkpoints (no `runtime_state`, or a future
 * `schema_version` we don't recognize) are returned with
 * `runtime_state = empty_runtime_state()` so callers always see a usable
 * shape.
 */
export function loadCheckpoint() {
  const data = _read_disk();
  _cached_checkpoint = data;
  _cache_loaded = true;
  if (!data) return null;
  if (!data.objective || !data.graph) return null;
  if (data.runtime_state?.schema_version !== RUNTIME_STATE_SCHEMA_VERSION) {
    // Shallow-copy so we don't mutate the cached object.
    return {...data, runtime_state: empty_runtime_state()};
  }
  return data;
}

/**
 * Deletes the checkpoint file on successful task completion. Async because
 * we must drain any in-flight write first — otherwise a queued write could
 * resurrect the file after we unlink it.
 */
export async function clearCheckpoint() {
  _pending_data = null;
  _cached_checkpoint = null;
  _cache_loaded = true;
  if (_flush_promise) {
    try {
      await _flush_promise;
    } catch {
    }
  }
  if (existsSync(CHECKPOINT_PATH)) {
    unlinkSync(CHECKPOINT_PATH);
    console.log('[SPL] Checkpoint cleared.');
  }
}

/**
 * Shallow-merges `partial` into the current `runtime_state` and writes the
 * checkpoint back atomically (asynchronously). No-op (with a warn) if
 * there is no checkpoint yet — counter-bump callers shouldn't have to
 * guard for this themselves.
 *
 * `partial` is one or more top-level keys of runtime_state
 * (`outer`, `active_task`, `active_replanner`). For nested fields under
 * `outer`, the caller passes the *full* desired `outer` object — this
 * helper does not deep-merge.
 *
 * Returns the flush promise (see saveCheckpoint).
 */
export function saveRuntimeState(partial) {
  const prior = read_cached();
  if (!prior) {
    console.warn('[SPL] saveRuntimeState: no checkpoint to update, skipping.');
    return Promise.resolve();
  }
  const runtime_state = prior.runtime_state ?? empty_runtime_state();
  const next = {...runtime_state, ...partial};
  return enqueue_write({
    ...prior,
    runtime_state: next,
    saved_at: new Date().toISOString(),
  });
}

/** Clears the active-task slice and persists. */
export function clearActiveTask() {
  return saveRuntimeState({active_task: null});
}

/** Clears the active-replanner slice and persists. */
export function clearActiveReplanner() {
  return saveRuntimeState({active_replanner: null});
}

/**
 * Test-only: drops the in-memory cache so the next `read_cached` call
 * cold-loads from disk. Useful in tests that mutate the checkpoint file
 * externally between cases.
 */
export function _resetCheckpointCacheForTests() {
  _cached_checkpoint = null;
  _cache_loaded = false;
  _pending_data = null;
  _flush_promise = null;
}
