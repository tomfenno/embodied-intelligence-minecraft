// Coordinates a single workshop-demo run: fresh world (Phase 1) -> spectator
// auto-join (Phase 5, concurrent/best-effort) -> agent launch with the
// chosen PTD forced (Phase 2) -> objective injection (Phase 2).
//
// Single-run model: this app drives one demo station, so there is exactly
// one current run tracked in module state, not a table of runs. Starting a
// new run tears down any previous one first (fresh world per selection,
// per achievement_hunter/workshop_demo/PLAN.md decision #4).

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
