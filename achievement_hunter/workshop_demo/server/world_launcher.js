// Fresh peaceful-survival Minecraft world spin-up for the workshop demo.
// Reuses the eval harness's managed_local server machinery (see
// achievement_hunter/workshop_demo/PLAN.md, Phase 1) rather than
// reimplementing server-template handling.

import path from 'path';

import {prepareManagedServer} from '../../evaluation_harness/lib/suite.js';
import {
  PROJECT_ROOT,
  chooseFreePort,
  launchLoggedProcess,
  makeTempDir,
  safeRemoveTree,
  sendServerConsoleCommand,
  terminateProcessTree,
  waitForProcessExit,
  waitForServerReady,
} from '../../evaluation_harness/lib/utils.js';
import {WORLD_CONFIG, WORLD_SEEDS} from './config.js';

// Evaluated fresh on every call that doesn't pass an explicit `seed`
// (JS default-parameter expressions re-run per call, not once at
// definition time) — see config.js's WORLD_SEEDS for why a curated list
// beats a fully random seed here.
function pickRandomSeed() {
  return WORLD_SEEDS[Math.floor(Math.random() * WORLD_SEEDS.length)];
}

/**
 * Spins up a fresh managed-local Minecraft server. Port is chosen
 * dynamically (not pinned) to avoid colliding with a not-yet-reaped
 * process from a prior demo run; the caller reads `.port` off the
 * returned handle to pass along to the agent launch and the spectator
 * client join. `worldConfig` overrides individual fields of config.js's
 * WORLD_CONFIG for one-off callers (e.g. tests). `seed` defaults to a
 * random pick from WORLD_SEEDS but can still be pinned explicitly, e.g.
 * to reproduce a specific run.
 */
export async function launchManagedWorld(worldConfig = {}, seed = pickRandomSeed()) {
  const mergedConfig = {...WORLD_CONFIG, ...worldConfig};
  const host = '127.0.0.1';
  const serverRoot = makeTempDir('workshop_demo_server_');
  const port = await chooseFreePort();

  // Printed here rather than left to only appear in server.properties —
  // this is the one thing about a given run's world that isn't visible
  // anywhere else in the demo's own output, and knowing it lets the
  // presenter (or the seed list itself, see config.js's WORLD_SEEDS) be
  // debugged/reproduced without digging through the ephemeral serverRoot.
  console.log(`Launching Minecraft world with seed ${seed}`);
  prepareManagedServer(serverRoot, mergedConfig, seed, port);

  const outputPath = path.join(serverRoot, 'server_stdout.log');
  const {child: serverProcess} = launchLoggedProcess({
    command: ['java', '-jar', mergedConfig.server_jar_name, 'nogui'],
    cwd: serverRoot,
    outputPath,
  });

  await waitForServerReady({host, port, process: serverProcess, outputPath});
  await sendServerConsoleCommand(serverProcess, 'gamerule spawnRadius 0');

  return {
    host,
    port,
    serverRoot,
    outputPath,
    serverProcess,
    sendConsoleCommand: (command, opts) =>
        sendServerConsoleCommand(serverProcess, command, opts),
    async stop() {
      // Not stopServerProcess() (utils.js): that helper sends a graceful
      // 'stop' console command and waits up to 60s for the world to save
      // before falling back to a kill, which is right for the eval
      // harness's real benchmark runs but pointlessly slow here — this
      // whole directory gets deleted on the next line regardless, so
      // there's no save worth waiting for. terminateProcessTree() (SIGTERM)
      // plus a short bounded wait is enough.
      terminateProcessTree(serverProcess);
      if (serverProcess.exitCode === null) {
        try {
          await waitForProcessExit(serverProcess, 5_000);
        } catch {
        }
      }
      safeRemoveTree(serverRoot, path.join(PROJECT_ROOT, 'tmp'));
    },
  };
}

/**
 * Env overrides for a `node main.js` child process to connect it to a
 * specific managed world. Required outside Docker: settings.js defaults
 * `host` to 'host.docker.internal', which only resolves inside a Docker
 * container. Mirrors the technique evaluation_harness/lib/suite.js already
 * uses for its own agent launches (suite.js:315-325).
 */
export function buildAgentLaunchEnv({
  host,
  port,
  mindserverPort,
  minecraftVersion = WORLD_CONFIG.minecraft_version,
  settingsOverride = {},
}) {
  return {
    ...process.env,
    // Node's default libuv threadpool (4 workers) is shared by every
    // fs/dns/crypto call in the process. Set as a real env var on the
    // spawned child here (not e.g. `process.env.UV_THREADPOOL_SIZE = ...`
    // inside main.js itself) because it only takes effect if set before
    // libuv creates the pool on first use — an ES module's top-level
    // `import`s already run before any of main.js's own statements, so
    // setting it there wouldn't reliably beat whatever those imports do.
    // Doesn't fix genuine system-level I/O contention (this demo often
    // runs two Minecraft JVMs plus multiple Node processes on one laptop
    // — see achievement_hunter/src/pipeline/io_queue.js's self-healing
    // write-timeout addition for that), but it's a free, harmless way to
    // reduce one plausible contributing factor.
    UV_THREADPOOL_SIZE: '8',
    MINECRAFT_PORT: String(port),
    MINDSERVER_PORT: String(mindserverPort),
    SETTINGS_JSON: JSON.stringify({
      auto_open_ui: false,
      host,
      minecraft_version: minecraftVersion,
      ...settingsOverride,
    }),
  };
}
