import {existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Stored in rollouts/ — already mounted as a Docker volume
const CHECKPOINT_PATH = path.join(__dirname, '../../rollouts/checkpoint.json');

/**
 * Persists the current SPL objective, PTD graph, and (optionally) the
 * BreadcrumbTracker's current map to disk. Called once after PTD succeeds
 * (without breadcrumbs) and once per outer loop iteration (with the live
 * breadcrumb list) so any subsequent crash can resume both the graph and
 * the exploration map.
 */
export function saveCheckpoint(objective, graph, breadcrumbs = null) {
  mkdirSync(path.dirname(CHECKPOINT_PATH), {recursive: true});
  writeFileSync(
      CHECKPOINT_PATH,
      JSON.stringify(
          {objective, graph, breadcrumbs, saved_at: new Date().toISOString()},
          null, 2),
      'utf8');
}

/**
 * Loads a checkpoint from disk.
 * Returns { objective, graph, breadcrumbs?, saved_at } or null if none exists.
 * `breadcrumbs` may be absent or null in legacy checkpoints written before
 * persistence was added.
 */
export function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8'));
    if (!data.objective || !data.graph) return null;
    return data;
  } catch (err) {
    console.warn('[SPL] Failed to parse checkpoint, ignoring:', err.message);
    return null;
  }
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
