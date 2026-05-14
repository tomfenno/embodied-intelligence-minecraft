import fs from 'fs';
import path from 'path';

import {BENCHMARK_TASK_TYPES} from '../task_validators.js';
import {collectDependencyMetrics} from './dependency_metrics.js';
import {
  appendOrReplaceManifest,
  loadExistingManifests,
  writeResultsJsonl,
  writeSummaryReports,
} from './reports.js';
import {
  FORCED_BENCHMARK_MODEL,
  createBenchmarkProfile,
  readProfileName,
} from './profiles.js';
import {
  ACHIEVEMENT_HUNTER_ROOT,
  PROJECT_ROOT,
  chooseFreePort,
  copyFileIfExists,
  copyFilesModifiedSince,
  ensureDirectory,
  launchLoggedProcess,
  makeTempDir,
  readJson,
  readJsonIfExists,
  resolveProjectPath,
  safeRemoveTree,
  sendServerConsoleCommand,
  sleep,
  stopServerProcess,
  terminateProcessTree,
  updatePropertiesFile,
  waitForProcessExit,
  waitForServerReady,
  walkFiles,
  writeJson,
} from './utils.js';

const DEFAULT_LEVEL_NAME = 'world';
const DEFAULT_TIMEOUT_BUFFER_SECONDS = 600;
const MANAGED_WORLD_PROVIDER = 'managed_local';
const EXTERNAL_WORLD_PROVIDER = 'external';
const CHECKPOINT_PATH =
    path.join(PROJECT_ROOT, 'achievement_hunter', 'rollouts', 'checkpoint.json');

export function validateBenchmarkSuite(config, taskData, {worldOverrides = {}} = {}) {
  if (!config?.suite_name) {
    throw new Error('benchmark config is missing suite_name');
  }
  if (!config?.task_path) {
    throw new Error('benchmark config is missing task_path');
  }
  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    throw new Error('benchmark config must include at least one agent');
  }

  const world = mergeDefined(config.world || {}, worldOverrides);
  if (!Array.isArray(world.seeds) || world.seeds.length === 0) {
    throw new Error('benchmark config must include a non-empty world.seeds list');
  }

  const provider = world.provider || MANAGED_WORLD_PROVIDER;
  if (![MANAGED_WORLD_PROVIDER, EXTERNAL_WORLD_PROVIDER].includes(provider)) {
    throw new Error(`Unsupported world provider: ${provider}`);
  }
  if (provider === MANAGED_WORLD_PROVIDER && !world.server_template_path) {
    throw new Error(
        'Managed-local world mode requires world.server_template_path or a CLI override');
  }
  if (provider === EXTERNAL_WORLD_PROVIDER && !world.port) {
    throw new Error('External world mode requires world.port');
  }

  for (const agent of config.agents) {
    if (!agent.label) {
      throw new Error('Each agent config must include label');
    }
    if (!agent.profile) {
      throw new Error(`Agent ${agent.label} is missing profile`);
    }
  }

  for (const [taskId, taskDefinition] of Object.entries(taskData)) {
    if (!BENCHMARK_TASK_TYPES.has(taskDefinition.type)) {
      throw new Error(
          `Benchmark task ${taskId} must have type=inventory or type=advancement`);
    }
    if (taskDefinition.agent_count !== 1) {
      throw new Error(`Benchmark task ${taskId} must have agent_count=1`);
    }
    if (taskDefinition.type === 'advancement' && !taskDefinition.advancement_id) {
      throw new Error(`Benchmark task ${taskId} is missing advancement_id`);
    }
    if (taskDefinition.type === 'inventory') {
      if (!taskDefinition.target && !taskDefinition.target_any_of) {
        throw new Error(
            `Benchmark task ${taskId} must include target or target_any_of`);
      }
      if (taskDefinition.target_any_of &&
          (!Array.isArray(taskDefinition.target_any_of) ||
           taskDefinition.target_any_of.length === 0)) {
        throw new Error(
            `Benchmark task ${taskId} must provide a non-empty target_any_of list`);
      }
    }
  }
}

export function selectBenchmarkMatrix(config, taskData, filters = {}) {
  const requestedAgentLabels = new Set(filters.agent_labels || []);
  const requestedSeeds = new Set((filters.seeds || []).map(Number));
  const requestedTaskIds = new Set(filters.task_ids || []);

  const agents = config.agents.filter((agent) => {
    return requestedAgentLabels.size === 0 ||
        requestedAgentLabels.has(agent.label);
  });
  const seeds = config.world.seeds.filter((seed) => {
    return requestedSeeds.size === 0 || requestedSeeds.has(Number(seed));
  });
  const tasks = Object.entries(taskData).filter(([taskId]) => {
    return requestedTaskIds.size === 0 || requestedTaskIds.has(taskId);
  });

  return {agents, seeds, tasks};
}

export function detectServerTemplateVersion(serverTemplatePath) {
  if (!serverTemplatePath || !fs.existsSync(serverTemplatePath)) {
    return null;
  }

  const directJarMatch = path.basename(serverTemplatePath)
      .match(/^server-(\d+\.\d+(?:\.\d+)?)\.jar$/);
  if (directJarMatch) {
    return directJarMatch[1];
  }

  const versionsRoot = path.join(serverTemplatePath, 'versions');
  if (!fs.existsSync(versionsRoot) || !fs.statSync(versionsRoot).isDirectory()) {
    return null;
  }

  for (const entry of fs.readdirSync(versionsRoot, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;

    const versionDirName = entry.name;
    if (/^\d+\.\d+(?:\.\d+)?$/.test(versionDirName)) {
      return versionDirName;
    }

    const jarMatch = versionDirName.match(/(\d+\.\d+(?:\.\d+)?)/);
    if (jarMatch) {
      return jarMatch[1];
    }
  }

  return null;
}

export async function runBenchmarkSuite({
  configPath,
  filters = {},
  worldOverrides = {},
  suiteNameOverride = null,
} = {}) {
  const resolvedConfigPath = resolveProjectPath(configPath);
  const config = readJson(resolvedConfigPath);
  if (suiteNameOverride) {
    config.suite_name = suiteNameOverride;
  }

  const taskPath = resolveProjectPath(config.task_path);
  const taskData = readJson(taskPath);
  validateBenchmarkSuite(config, taskData, {worldOverrides});

  config.world = mergeDefined(config.world || {}, worldOverrides);
  const matrix = selectBenchmarkMatrix(config, taskData, filters);

  if (matrix.agents.length === 0) {
    throw new Error('No agents matched the provided filters');
  }
  if (matrix.seeds.length === 0) {
    throw new Error('No seeds matched the provided filters');
  }
  if (matrix.tasks.length === 0) {
    throw new Error('No tasks matched the provided filters');
  }

  const suiteRoot = path.join(
      ACHIEVEMENT_HUNTER_ROOT, 'evaluation_harness', 'experiments',
      config.suite_name);
  ensureDirectory(suiteRoot);

  // Clear any leftover Achievement Hunter checkpoint at the start of every
  // experiment. The per-episode clears below should normally keep this
  // file gone, but a prior run killed mid-episode can leave one behind
  // and the agent-side stale-checkpoint guard would then have to fire on
  // the first episode. Unconditional suite-level clear avoids that.
  if (fs.existsSync(CHECKPOINT_PATH)) {
    console.log(
        `[suite] Clearing leftover Achievement Hunter checkpoint from prior run: ${
            CHECKPOINT_PATH}`);
    clearAchievementHunterCheckpoint();
  }

  let manifests = loadExistingManifests(suiteRoot);
  for (const agentConfig of matrix.agents) {
    for (const seed of matrix.seeds) {
      for (const [taskId, taskDefinition] of matrix.tasks) {
        console.log(
            `Running benchmark episode agent=${agentConfig.label} seed=${seed} task=${taskId}`);
        const manifest = await runSingleBenchmarkEpisode({
          suiteRoot,
          taskPath,
          taskId,
          taskData: taskDefinition,
          agentConfig,
          seed,
          worldConfig: config.world,
        });
        manifests = appendOrReplaceManifest(manifests, manifest);
        writeResultsJsonl(path.join(suiteRoot, 'results.jsonl'), manifests);
        writeSummaryReports(suiteRoot, manifests);
      }
    }
  }

  return manifests;
}

async function runSingleBenchmarkEpisode({
  suiteRoot,
  taskPath,
  taskId,
  taskData,
  agentConfig,
  seed,
  worldConfig,
}) {
  const agentLabel = agentConfig.label;
  const sourceProfilePath = resolveProjectPath(agentConfig.profile);
  const agentName = readProfileName(sourceProfilePath);
  const resultDir = path.join(suiteRoot, agentLabel, `seed_${seed}`, taskId);
  ensureDirectory(path.dirname(resultDir));
  safeRemoveTree(resultDir, suiteRoot);
  ensureDirectory(resultDir);

  const episodeStartMs = Date.now();
  const provider = worldConfig.provider || MANAGED_WORLD_PROVIDER;
  const levelName = worldConfig.level_name || DEFAULT_LEVEL_NAME;
  const serverRuntime = {
    host: worldConfig.host || '127.0.0.1',
    port: worldConfig.port ?? null,
    serverRoot: null,
    worldPath: worldConfig.world_path ?
      resolveProjectPath(worldConfig.world_path) :
      null,
  };

  const settingsOverride = buildEpisodeSettings(agentConfig, worldConfig);
  const mode =
      settingsOverride.achievement_hunter ? 'achievement_hunter' :
                                            'standard_task';
  const benchmarkProfilePath = createBenchmarkProfile({
    sourceProfilePath,
    outputDir: resultDir,
    achievementHunter: settingsOverride.achievement_hunter,
  });

  let serverHandle = null;
  let nodeHandle = null;
  let nodeExitCode = null;
  let exitStatus = 'failed';
  let errorMessage = null;
  let serverOutputHandle = null;
  let nodeOutputHandle = null;
  let startTime = new Date().toISOString();
  let endTime = startTime;

  try {
    if (provider === MANAGED_WORLD_PROVIDER) {
      serverRuntime.serverRoot = makeTempDir('benchmark_server_');
      serverRuntime.port = await chooseFreePort();
      serverRuntime.worldPath =
          path.join(serverRuntime.serverRoot, levelName);
      prepareManagedServer(serverRuntime.serverRoot, worldConfig, seed,
          serverRuntime.port);

      const serverStdoutPath = path.join(resultDir, 'server_stdout.log');
      const launchedServer = launchLoggedProcess({
        command: ['java', '-jar', 'server.jar', 'nogui'],
        cwd: serverRuntime.serverRoot,
        outputPath: serverStdoutPath,
      });
      serverHandle = launchedServer.child;
      serverOutputHandle = launchedServer.outputHandle;
      await waitForServerReady({
        host: serverRuntime.host,
        port: serverRuntime.port,
        process: serverHandle,
        outputPath: serverStdoutPath,
      });
      await sendServerConsoleCommand(serverHandle, 'gamerule spawnRadius 0');
    }

    if (settingsOverride.achievement_hunter) {
      clearAchievementHunterCheckpoint();
    }

    const mindserverPort = await chooseFreePort();
    const env = {
      ...process.env,
      LOG_ALL: 'true',
      MINECRAFT_PORT: String(serverRuntime.port),
      MINDSERVER_PORT: String(mindserverPort),
      SETTINGS_JSON: JSON.stringify({
        ...settingsOverride,
        auto_open_ui: false,
        host: serverRuntime.host,
        minecraft_version: worldConfig.minecraft_version || '1.21.6',
      }),
      BENCHMARK_EPISODE_MODE: 'true',
      BENCHMARK_EPISODE_DIR: resultDir,
      // Per-episode envelope for the action-message log. See
      // achievement_hunter/docs/action_message_logging_plan.md and
      // achievement_hunter/src/agent/_action_message_log.js.
      BENCHMARK_AGENT_LABEL: agentLabel,
      BENCHMARK_SEED: String(seed),
      BENCHMARK_TASK_ID: taskId,
      TASK_SERVER_ROOT: serverRuntime.serverRoot ?? '',
      TASK_WORLD_PATH: serverRuntime.worldPath ?? '',
    };

    const nodeStdoutPath = path.join(resultDir, 'runner_stdout.log');
    const launchedNode = launchLoggedProcess({
      command: [
        'node',
        'main.js',
        '--task_path',
        taskPath,
        '--task_id',
        taskId,
        '--profiles',
        benchmarkProfilePath,
      ],
      cwd: PROJECT_ROOT,
      outputPath: nodeStdoutPath,
      env,
    });
    nodeHandle = launchedNode.child;
    nodeOutputHandle = launchedNode.outputHandle;

    const timeoutMs =
        ((taskData.timeout ?? 1_200) + DEFAULT_TIMEOUT_BUFFER_SECONDS) * 1_000;
    try {
      nodeExitCode = await waitForProcessExit(nodeHandle, timeoutMs);
      exitStatus = nodeExitCode === 0 ? 'completed' : 'failed';
    } catch (error) {
      exitStatus = 'timeout';
      errorMessage = error.message;
      terminateProcessTree(nodeHandle);
      await sleep(3_000);
    }

    await sleep(3_000);
  } catch (error) {
    errorMessage = error.message;
    exitStatus = 'error';
    if (nodeHandle) terminateProcessTree(nodeHandle);
    if (serverHandle) terminateProcessTree(serverHandle);
  } finally {
    endTime = new Date().toISOString();
    if (nodeHandle && nodeHandle.exitCode === null) {
      try {
        await waitForProcessExit(nodeHandle, 30_000);
      } catch {}
    }
    nodeOutputHandle?.end();
    if (serverHandle) {
      await stopServerProcess(serverHandle);
    }
    serverOutputHandle?.end();
    if (settingsOverride.achievement_hunter) {
      clearAchievementHunterCheckpoint();
    }

    copyServerArtifacts(serverRuntime.serverRoot, resultDir);
    copyAgentArtifacts(agentName, resultDir, episodeStartMs);
    if (settingsOverride.achievement_hunter) {
      copyAchievementHunterArtifacts(resultDir, episodeStartMs);
    }

    const episodeRuntime =
        readJsonIfExists(path.join(resultDir, 'episode_runtime.json'));
    if (settingsOverride.achievement_hunter && episodeRuntime) {
      mirrorEpisodeTimingIntoAchievementRollouts(resultDir, episodeRuntime);
    }

    const dependencySummary = collectDependencyMetrics(resultDir, {
      preferTaskTraces: settingsOverride.achievement_hunter,
    });
    const initialSpawn =
        extractFirstLoginSpawnFromServerLog(
            path.join(resultDir, 'server_stdout.log'), agentName);
    const score = resolveBenchmarkScore({
      resultDir,
      serverRoot: serverRuntime.serverRoot,
      worldPath: serverRuntime.worldPath,
      agentName,
      taskData,
      episodeRuntime,
    });

    const manifest = {
      agent_label: agentLabel,
      agent_name: agentName,
      mode,
      profile_source: sourceProfilePath,
      benchmark_profile_path: benchmarkProfilePath,
      forced_model: FORCED_BENCHMARK_MODEL,
      seed,
      task_id: taskId,
      task_path: taskPath,
      task_type: taskData.type,
      target: taskData.target ?? null,
      target_any_of: taskData.target_any_of ?? null,
      advancement_id: taskData.advancement_id ?? null,
      start_time: startTime,
      end_time: endTime,
      exit_status: exitStatus,
      exit_code: nodeExitCode,
      error: errorMessage,
      score,
      connected_at: episodeRuntime?.connected_at ?? null,
      completed_at: episodeRuntime?.completed_at ?? null,
      episode_duration_ms: episodeRuntime?.episode_duration_ms ?? null,
      episode_duration_seconds:
          episodeRuntime?.episode_duration_seconds ?? null,
      dependency_failures: dependencySummary.dependencyFailures,
      dependency_total_commands: dependencySummary.totalCommands,
      dependency_error_rate: dependencySummary.dependencyErrorRate,
      dependency_unparseable_command_records:
          dependencySummary.unparseable_command_records,
      dependency_source: dependencySummary.source,
      trusted_dependency_available:
          dependencySummary.trusted_dependency_available,
      trusted_dependency_failures:
          dependencySummary.trusted_dependency_failures,
      trusted_dependency_total_commands:
          dependencySummary.trusted_dependency_total_commands,
      trusted_dependency_error_rate:
          dependencySummary.trusted_dependency_error_rate,
      trusted_dependency_incidents:
          dependencySummary.trusted_dependency_incidents,
      trusted_dependency_ambiguous_events:
          dependencySummary.trusted_dependency_ambiguous_events,
      world_provider: provider,
      world_host: serverRuntime.host,
      world_port: serverRuntime.port,
      minecraft_version: worldConfig.minecraft_version || '1.21.6',
      initial_spawn: initialSpawn,
      result_dir: resultDir,
    };
    writeJson(path.join(resultDir, 'episode_manifest.json'), manifest);

    if (serverRuntime.serverRoot) {
      safeRemoveTree(serverRuntime.serverRoot, path.join(PROJECT_ROOT, 'tmp'));
    }
  }

  return readJson(path.join(resultDir, 'episode_manifest.json'));
}

function buildEpisodeSettings(agentConfig, worldConfig) {
  return {
    achievement_hunter: false,
    allow_insecure_coding: false,
    auth: 'offline',
    auto_open_ui: false,
    host: worldConfig.host || '127.0.0.1',
    load_memory: false,
    minecraft_version: worldConfig.minecraft_version || '1.21.6',
    ...(agentConfig.settings_override || {}),
  };
}

function prepareManagedServer(serverRoot, worldConfig, seed, serverPort) {
  const serverTemplatePath = resolveProjectPath(worldConfig.server_template_path);
  if (!fs.existsSync(serverTemplatePath)) {
    throw new Error(
        `Managed server template path does not exist: ${serverTemplatePath}`);
  }

  const expectedVersion = worldConfig.minecraft_version || '1.21.6';
  const detectedVersion = detectServerTemplateVersion(serverTemplatePath);
  if (detectedVersion && detectedVersion !== expectedVersion) {
    throw new Error(
        `Managed server template version mismatch: expected ${expectedVersion}, ` +
        `detected ${detectedVersion} from ${serverTemplatePath}`);
  }

  fs.cpSync(serverTemplatePath, serverRoot, {recursive: true});
  updatePropertiesFile(path.join(serverRoot, 'server.properties'), {
    'allow-cheats': worldConfig.allow_cheats ?? false,
    difficulty: worldConfig.difficulty || 'peaceful',
    'enable-command-block': false,
    'force-gamemode': false,
    gamemode: worldConfig.gamemode || 'survival',
    'generate-structures': worldConfig.generate_structures ?? true,
    'generator-settings': '',
    'level-name': worldConfig.level_name || DEFAULT_LEVEL_NAME,
    'level-seed': seed,
    'level-type': 'minecraft:normal',
    'online-mode': false,
    'server-port': serverPort,
    'spawn-protection': 0,
  });
}

function clearAchievementHunterCheckpoint() {
  if (fs.existsSync(CHECKPOINT_PATH)) {
    fs.rmSync(CHECKPOINT_PATH, {force: true});
  }
}

function copyAgentArtifacts(agentName, resultDir, episodeStartMs) {
  const agentRoot = path.join(PROJECT_ROOT, 'bots', agentName);
  const artifactRoot = path.join(resultDir, 'agent_artifacts', agentName);
  ensureDirectory(artifactRoot);

  for (const fileName of ['memory.json', 'last_profile.json', 'profile.json']) {
    copyFileIfExists(
        path.join(agentRoot, fileName),
        path.join(artifactRoot, fileName));
  }

  copyFilesModifiedSince(
      path.join(agentRoot, 'histories'),
      path.join(artifactRoot, 'histories'),
      episodeStartMs);
  copyFilesModifiedSince(
      path.join(agentRoot, 'logs'),
      path.join(artifactRoot, 'logs'),
      episodeStartMs);
}

function copyServerArtifacts(serverRoot, resultDir) {
  if (!serverRoot) return;

  copyFileIfExists(
      path.join(serverRoot, 'logs', 'latest.log'),
      path.join(resultDir, 'latest.log'));
  copyFileIfExists(
      path.join(serverRoot, 'server.properties'),
      path.join(resultDir, 'server.properties'));
  copyFileIfExists(
      path.join(serverRoot, 'usercache.json'),
      path.join(resultDir, 'usercache.json'));
}

function copyAchievementHunterArtifacts(resultDir, episodeStartMs) {
  copyFilesModifiedSince(
      path.join(PROJECT_ROOT, 'achievement_hunter', 'rollouts'),
      path.join(resultDir, 'achievement_rollouts'),
      episodeStartMs,
      {exclude: ['_datasets', 'checkpoint.json']});
}

function mirrorEpisodeTimingIntoAchievementRollouts(resultDir, episodeRuntime) {
  for (const filePath of walkFiles(resultDir)) {
    if (path.basename(filePath) !== 'rollout_trace.json') continue;
    if (!filePath.includes(`${path.sep}achievement_rollouts${path.sep}`)) continue;
    const rolloutTrace = readJson(filePath);
    rolloutTrace.benchmark_episode_timing = episodeRuntime;
    writeJson(filePath, rolloutTrace);
  }
}

export function resolveBenchmarkScore({
  resultDir,
  serverRoot,
  worldPath,
  agentName,
  taskData,
  episodeRuntime = null,
}) {
  const runtimeScore = normalizeBenchmarkScore(episodeRuntime?.score);
  if (runtimeScore != null) return runtimeScore;

  const score = extractResultRecursive(resultDir);
  if (score != null) return score;

  if (taskData.type === 'advancement' && serverRoot && worldPath) {
    return inspectAdvancementCompletion(
        serverRoot, worldPath, agentName, taskData.advancement_id);
  }

  return 0;
}

function extractResultRecursive(rootPath) {
  let bestScore = null;
  for (const filePath of walkFiles(rootPath)) {
    if (path.extname(filePath) !== '.json') continue;
    const score = analyzeJsonFile(filePath);
    if (score == null) continue;
    bestScore = bestScore == null ? score : Math.max(bestScore, score);
  }
  return bestScore;
}

function analyzeJsonFile(filePath) {
  try {
    const data = readJson(filePath);
    let bestScore = null;
    for (const turns of extractTurnCollections(data)) {
      const score = extractScoreFromTurns(turns);
      if (score == null) continue;
      bestScore = bestScore == null ? score : Math.max(bestScore, score);
    }
    return bestScore;
  } catch {
    return null;
  }
}

function normalizeBenchmarkScore(value) {
  if (value == null || value === '') return null;
  const numericScore = Number(value);
  return Number.isFinite(numericScore) ? numericScore : null;
}

function extractTurnCollections(data) {
  const turnCollections = [];
  if (Array.isArray(data)) {
    turnCollections.push(data);
  }
  if (data && typeof data === 'object' && Array.isArray(data.turns)) {
    turnCollections.push(data.turns);
  }
  return turnCollections;
}

function extractScoreFromTurns(turns) {
  let bestScore = null;
  for (const turn of turns) {
    if (turn?.role !== 'system' || typeof turn.content !== 'string') continue;
    const match = turn.content.match(/Task ended with score : ([0-9.]+)/);
    if (!match) continue;
    const numericScore = normalizeBenchmarkScore(match[1]);
    if (numericScore == null) continue;
    bestScore = bestScore == null ? numericScore :
                                   Math.max(bestScore, numericScore);
  }
  return bestScore;
}

function inspectAdvancementCompletion(serverRoot, worldPath, agentName, advancementId) {
  const usercachePath = path.join(serverRoot, 'usercache.json');
  if (!fs.existsSync(usercachePath)) return 0;

  try {
    const usercache = readJson(usercachePath);
    const userEntry = usercache.find((entry) => entry?.name === agentName);
    if (!userEntry?.uuid) return 0;

    const advancementPath =
        path.join(worldPath, 'advancements', `${userEntry.uuid}.json`);
    if (!fs.existsSync(advancementPath)) return 0;

    const advancementData = readJson(advancementPath);
    return advancementData?.[advancementId]?.done === true ? 1 : 0;
  } catch {
    return 0;
  }
}

export function extractFirstLoginSpawnFromServerLog(serverLogPath, agentName) {
  if (!serverLogPath || !agentName || !fs.existsSync(serverLogPath)) {
    return null;
  }

  const escapedAgentName = escapeRegex(agentName);
  const loginPattern = new RegExp(
      `\\]: ${escapedAgentName}\\[[^\\]]*\\] logged in with entity id ` +
      `\\d+ at \\(([^,]+),\\s*([^,]+),\\s*([^)]+)\\)`);

  const lines = fs.readFileSync(serverLogPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(loginPattern);
    if (!match) continue;

    const x = Number(match[1]);
    const y = Number(match[2]);
    const z = Number(match[3]);
    if (![x, y, z].every(Number.isFinite)) {
      return null;
    }

    return {x, y, z};
  }

  return null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mergeDefined(base, overrides) {
  return Object.fromEntries(
      Object.entries({...base, ...overrides})
          .filter(([, value]) => value !== undefined));
}
