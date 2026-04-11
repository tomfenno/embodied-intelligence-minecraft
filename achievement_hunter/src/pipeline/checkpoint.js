import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Stored in rollouts/ — already mounted as a Docker volume
const CHECKPOINT_PATH = path.join(__dirname, '../../rollouts/checkpoint.json');

/**
 * Persists the current SPL objective and PTD graph to disk.
 * Called immediately after PTD succeeds so any subsequent crash
 * can resume from the outer SCSG loop without rebuilding the graph.
 */
export function saveCheckpoint(objective, graph) {
    mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
    writeFileSync(
        CHECKPOINT_PATH,
        JSON.stringify({ objective, graph, saved_at: new Date().toISOString() }, null, 2),
        'utf8'
    );
    console.log('[SPL] Checkpoint saved.');
}

/**
 * Loads a checkpoint from disk.
 * Returns { objective, graph, saved_at } or null if none exists.
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
