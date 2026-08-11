// Coordinates a single workshop-demo run: fresh world (Phase 1) -> spectator
// auto-join (Phase 5, concurrent/best-effort) -> agent launch with the
// chosen PTD forced (Phase 2) -> objective injection (Phase 2).
//
// Single-run model: this app drives one demo station, so there is exactly
// one current run tracked in module state, not a table of runs. Starting a
// new run tears down any previous one first (fresh world per selection,
// per achievement_hunter/workshop_demo/PLAN.md decision #4).

import {existsSync, unlinkSync} from 'fs';
import path from 'path';

import {clearCheckpoint} from '../../src/pipeline/checkpoint.js';
import {
  PROJECT_ROOT,
  chooseFreePort,
  launchLoggedProcess,
  terminateProcessTree,
  waitForProcessExit,
} from '../../evaluation_harness/lib/utils.js';
import {AGENT_NAME, SPECTATOR_USERNAME} from './config.js';
import {sendObjective} from './objective_injector.js';
import {
  clearRunPids,
  killOrphanedPidsFromPreviousSession,
  recordRunPids,
} from './orphan_guard.js';
import {
  listPtdFiles,
  objectiveFromPtdFilename,
  ptdRelativePath,
} from './ptd_catalog.js';
import {
  launchPrismSpectator,
  waitForPlayerLogin,
  watchBotLogins,
} from './spectator.js';
import {buildAgentLaunchEnv, launchManagedWorld} from './world_launcher.js';

const AGENT_STDOUT_PATH =
    path.join(PROJECT_ROOT, 'achievement_hunter', 'workshop_demo', '.run', 'agent_stdout.log');

// Same path index.js's GET /api/live reads (LIVE_JSON_PATH there) — written
// by rollout_logger.js's render_live(), which the newly-launched agent
// process doesn't call for the first time until its PTD stage completes
// (world boot + agent connect + objective injection all happen first). If
// left in place, /api/live would keep serving the *previous* run's graph
// during that window instead of nothing.
const LIVE_JSON_PATH = path.join(
    PROJECT_ROOT, 'achievement_hunter', 'rollout_live', 'current_rollout.json');

// Keeps the demo watchable in caves/at night without touching world time or
// lighting. Targets @a rather than a specific username so one call covers
// whichever combination of AH_Bot/spectator happens to be online at the
// moment it fires — simpler than tracking each client's own status, and the
// user explicitly said giving it to everyone is fine. Amplifier 0,
// hideParticles true (last two args) so it doesn't add visual clutter around
// either client. Best-effort: a failed console write here (e.g. server
// mid-shutdown) shouldn't fail the whole run, same rationale as the
// spectator flow's own error handling below.
async function applyNightVision(world) {
  try {
    await world.sendConsoleCommand(
        'effect give @a minecraft:night_vision infinite 0 true');
  } catch {
  }
}

// Runs once when the dashboard server starts (this module is only ever
// imported once, at boot). Cleans up any world/agent processes a prior
// dashboard process left running if it was killed without going through
// stopRun() first — see orphan_guard.js.
killOrphanedPidsFromPreviousSession();

function makeIdleState() {
  return {
    status: 'idle',
    ptdFilename: null,
    objective: null,
    error: null,
    startedAt: null,
    world: null,
    mindserverPort: null,
    spectator: {status: 'idle'},
  };
}

let current = makeIdleState();
// Live process/world handles, kept out of `current` so getStatus() only
// ever returns plain serializable data.
let handles = null;

export function getStatus() {
  const {world} = current;
  return {
    ...current,
    world: world ? {host: world.host, port: world.port} : null,
  };
}

export async function stopRun() {
  handles?.stopSpectatorWatcher?.();
  handles?.stopNightVisionWatcher?.();
  if (handles?.agentProcess) {
    terminateProcessTree(handles.agentProcess);
    // Wait for the killed process to actually exit before clearing the
    // checkpoint below — otherwise its own in-flight checkpoint write can
    // resurrect the file after we unlink it (matches
    // evaluation_harness/lib/suite.js's own teardown ordering).
    if (handles.agentProcess.exitCode === null) {
      try {
        await waitForProcessExit(handles.agentProcess, 10_000);
      } catch {
      }
    }
  }
  if (handles?.world) await handles.world.stop();
  handles = null;
  current = makeIdleState();
  clearRunPids();

  // A checkpoint left over from an interrupted prior run (this app's or
  // any other achievement_hunter run on this machine) makes the agent
  // silently resume it on spawn instead of waiting for our injected
  // objective — see PLAN.md Phase 4 for how this was discovered.
  await clearCheckpoint();

  // Same category of bug as the checkpoint above: without this, the
  // dashboard keeps serving the previous run's graph/recovery state
  // (stale but not literally invalid JSON, so nothing here would error)
  // until the newly-launched agent's PTD stage completes and overwrites
  // it — see the comment on LIVE_JSON_PATH above.
  if (existsSync(LIVE_JSON_PATH)) unlinkSync(LIVE_JSON_PATH);
}

export async function startRun(ptdFilename) {
  if (!listPtdFiles().includes(ptdFilename)) {
    throw new Error(`Unknown PTD: ${ptdFilename}`);
  }

  await stopRun();

  const objective = objectiveFromPtdFilename(ptdFilename);
  current = {
    ...makeIdleState(),
    status: 'launching_world',
    ptdFilename,
    objective,
    startedAt: Date.now(),
  };

  // Fire and let the caller poll getStatus() — a demo run takes long enough
  // (world boot, agent connect) that the HTTP request shouldn't block on it.
  runInBackground(ptdFilename, objective)
      .catch((err) => {
        current = {...current, status: 'error', error: err.message};
      });

  return getStatus();
}

async function runInBackground(ptdFilename, objective) {
  const world = await launchManagedWorld();
  handles = {world, agentProcess: null};
  current = {...current, status: 'starting_agent', world};
  recordRunPids({serverPid: world.serverProcess.pid, agentPid: null});

  // Independent of the spectator flow below (which only runs if Prism is
  // configured) — this way the bot itself always gets night vision even on
  // a machine with no spectator client set up. Fires on the bot's initial
  // login and every reconnect (crash, "Safely restarting..."), since a
  // fresh login resets applied effects.
  handles.stopNightVisionWatcher =
      watchBotLogins(world.outputPath, AGENT_NAME, () => applyNightVision(world));

  // Fire-and-forget: the spectator join runs concurrently with agent
  // startup below and never blocks it — a Prism/client hiccup shouldn't
  // stall the actual demo run. Progress is tracked in current.spectator so
  // the dashboard can show it, but nothing here is awaited by the main
  // chain.
  runSpectatorFlow(world).catch((err) => {
    current = {...current, spectator: {status: 'error', error: err.message}};
  });

  const mindserverPort = await chooseFreePort();
  const env = buildAgentLaunchEnv({
    host: world.host,
    port: world.port,
    mindserverPort,
  });
  env.AH_PTD_JSON_OVERRIDE_PATH = ptdRelativePath(ptdFilename);
  env.AH_ENABLE_LIVE_VIEWER = '1';

  const {child: agentProcess} = launchLoggedProcess({
    command: ['node', 'main.js'],
    cwd: PROJECT_ROOT,
    outputPath: AGENT_STDOUT_PATH,
    env,
  });
  handles.agentProcess = agentProcess;
  recordRunPids({serverPid: world.serverProcess.pid, agentPid: agentProcess.pid});
  current = {...current, status: 'injecting_objective', mindserverPort};

  await sendObjective({mindserverPort, agentName: AGENT_NAME, objective});

  current = {...current, status: 'running'};
}

async function runSpectatorFlow(world) {
  const launch = await launchPrismSpectator({host: world.host, port: world.port});
  if (!launch.launched) {
    current = {...current, spectator: {status: 'skipped', error: launch.reason}};
    return;
  }

  current = {...current, spectator: {status: 'launching'}};

  const joined = await waitForPlayerLogin(world.outputPath, SPECTATOR_USERNAME);
  if (!joined) {
    current = {...current, spectator: {status: 'timeout'}};
    return;
  }

  try {
    await world.sendConsoleCommand(`gamemode spectator ${SPECTATOR_USERNAME}`);
  } catch (err) {
    current = {
      ...current,
      spectator: {status: 'joined', gamemode_error: err.message},
    };
    return;
  }

  // Covers the spectator specifically — the bot's own watcher above only
  // re-fires on a bot login/reconnect, which may not happen again after the
  // spectator joins (the common case: spectator launch is the slower of the
  // two, per PLAN.md, so it usually joins after the bot already has it).
  await applyNightVision(world);
  current = {...current, spectator: {status: 'joined'}};

  // Re-issues /spectate on every AH_Bot login, not just the first: vanilla
  // Minecraft drops the camera lock whenever the spectated entity leaves
  // the world (crash, "Safely restarting to update inventory", any other
  // reconnect), so without this the presenter's view silently falls back
  // to free-fly the moment the bot reconnects.
  handles.stopSpectatorWatcher = watchBotLogins(world.outputPath, AGENT_NAME, () => {
    world.sendConsoleCommand(`spectate ${AGENT_NAME} ${SPECTATOR_USERNAME}`)
        .then(() => {
          current = {
            ...current,
            spectator: {status: 'joined', spectating: true, spectate_error: null},
          };
        })
        .catch((err) => {
          current = {
            ...current,
            spectator: {status: 'joined', spectate_error: err.message},
          };
        });
  });
}
