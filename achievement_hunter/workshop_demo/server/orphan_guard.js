// Recovers from the dashboard server itself being killed (crash, manual
// `kill`, closed terminal) without going through stopRun() first — which
// would otherwise leave the world/agent child processes running forever,
// since they're spawned detached (see world_launcher.js / orchestrator.js).
// A leftover agent in particular can silently corrupt the *next* run by
// resurrecting achievement_hunter/rollouts/checkpoint.json after it's
// cleared — this is what happens in practice, not a hypothetical.
//
// Deliberately PID-based, not a process-name search: this app records the
// exact PIDs it spawns to a small file on disk (independent of in-memory
// state, so a freshly-started dashboard process can find its predecessor's
// orphans), and only ever kills PIDs it wrote itself. A broad pattern like
// `pkill -f "node main.js"` would risk matching an unrelated process on
// the presenter's machine — this can't, by construction.

import {existsSync, readFileSync, unlinkSync, writeFileSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.join(__dirname, '../.run/pids.json');

export function recordRunPids(pids) {
  writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
}

export function clearRunPids() {
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
}

// Call once when the dashboard server starts, before accepting any run.
export function killOrphanedPidsFromPreviousSession() {
  if (!existsSync(PID_FILE)) return;

  let pids;
  try {
    pids = JSON.parse(readFileSync(PID_FILE, 'utf8'));
  } catch {
    unlinkSync(PID_FILE);
    return;
  }

  for (const pid of Object.values(pids)) {
    if (!pid) continue;
    try {
      // Negative pid targets the whole process group — these were spawned
      // detached (their own session/group leader), matching
      // terminateProcessTree()'s convention in evaluation_harness/lib/utils.js.
      process.kill(-pid, 'SIGTERM');
      console.log(`[orphan_guard] Killed leftover process group ${pid} from a prior dashboard session.`);
    } catch {
      // Already dead, or never existed — nothing left to do for this pid.
    }
  }

  unlinkSync(PID_FILE);
}
