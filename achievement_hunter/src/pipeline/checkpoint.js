import {existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'fs';
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

function read_raw() {
  if (!existsSync(CHECKPOINT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8'));
  } catch (err) {
    console.warn('[SPL] Failed to parse checkpoint, ignoring:', err.message);
    return null;
  }
}

// Atomic write: stage to .tmp then rename, so a crash mid-write can't leave
// a torn file.
function write_atomic(data) {
  mkdirSync(path.dirname(CHECKPOINT_PATH), {recursive: true});
  writeFileSync(CHECKPOINT_TMP_PATH, JSON.stringify(data, null, 2), 'utf8');
  renameSync(CHECKPOINT_TMP_PATH, CHECKPOINT_PATH);
}

/**
 * Persists the current SPL objective, PTD graph, and (optionally) the
 * BreadcrumbTracker's current map to disk. Preserves any existing
 * `runtime_state` block so callers that don't know about retry counters
 * (e.g. the breadcrumb tick) don't blow it away.
 */
export function saveCheckpoint(objective, graph, breadcrumbs = null) {
  const prior = read_raw();
  const runtime_state = prior?.runtime_state ?? empty_runtime_state();
  write_atomic({
    objective,
    graph,
    breadcrumbs,
    runtime_state,
    saved_at: new Date().toISOString(),
  });
}

/**
 * Loads a checkpoint from disk.
 * Returns { objective, graph, breadcrumbs?, runtime_state?, saved_at } or
 * null if none exists. Legacy checkpoints (no `runtime_state`, or a future
 * `schema_version` we don't recognize) are returned with
 * `runtime_state = empty_runtime_state()` so callers always see a usable
 * shape.
 */
export function loadCheckpoint() {
  const data = read_raw();
  if (!data) return null;
  if (!data.objective || !data.graph) return null;
  if (data.runtime_state?.schema_version !== RUNTIME_STATE_SCHEMA_VERSION) {
    data.runtime_state = empty_runtime_state();
  }
  return data;
}

/**
 * Deletes the checkpoint file on successful task completion.
 */
export function clearCheckpoint() {
  if (existsSync(CHECKPOINT_PATH)) {
    unlinkSync(CHECKPOINT_PATH);
    console.log('[SPL] Checkpoint cleared.');
  }
}

/**
 * Shallow-merges `partial` into the current `runtime_state` and writes the
 * checkpoint back atomically. No-op (with a warn) if there is no checkpoint
 * yet — counter-bump callers shouldn't have to guard for this themselves.
 *
 * `partial` is one or more top-level keys of runtime_state
 * (`outer`, `active_task`, `active_replanner`). For nested fields under
 * `outer`, the caller passes the *full* desired `outer` object — this helper
 * does not deep-merge.
 */
export function saveRuntimeState(partial) {
  const prior = read_raw();
  if (!prior) {
    console.warn('[SPL] saveRuntimeState: no checkpoint to update, skipping.');
    return;
  }
  const runtime_state = prior.runtime_state ?? empty_runtime_state();
  const next = {...runtime_state, ...partial};
  write_atomic({
    ...prior,
    runtime_state: next,
    saved_at: new Date().toISOString(),
  });
}

/** Clears the active-task slice and persists. */
export function clearActiveTask() {
  saveRuntimeState({active_task: null});
}

/** Clears the active-replanner slice and persists. */
export function clearActiveReplanner() {
  saveRuntimeState({active_replanner: null});
}
