import {existsSync, readFileSync, writeFileSync} from 'fs';
import path from 'path';

const RUNTIME_FILENAME = 'episode_runtime.json';

function getRuntimePath() {
  if (!process.env.BENCHMARK_EPISODE_DIR) {
    return null;
  }
  return path.join(process.env.BENCHMARK_EPISODE_DIR, RUNTIME_FILENAME);
}

function readRuntimeState(runtimePath) {
  if (!runtimePath || !existsSync(runtimePath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(runtimePath, 'utf8'));
  } catch (error) {
    console.error('Failed to read episode runtime state:', error);
    return {};
  }
}

function writeRuntimeState(runtimePath, nextState) {
  if (!runtimePath) return;

  try {
    writeFileSync(runtimePath, JSON.stringify(nextState, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to write episode runtime state:', error);
  }
}

export function recordEpisodeConnected(agentName) {
  const runtimePath = getRuntimePath();
  if (!runtimePath) return;

  const state = readRuntimeState(runtimePath);
  if (state.connected_at) return;

  const connectedAt = new Date().toISOString();
  writeRuntimeState(runtimePath, {
    ...state,
    agent_name: agentName,
    connected_at: connectedAt,
    connected_at_ms: Date.now(),
    status: 'running',
  });
}

export function recordEpisodeCompleted(agentName, {score = null, message = null} = {}) {
  const runtimePath = getRuntimePath();
  if (!runtimePath) return;

  const state = readRuntimeState(runtimePath);
  if (state.completed_at) return;

  const completedAt = new Date().toISOString();
  const completedAtMs = Date.now();
  const connectedAtMs = state.connected_at_ms ?? null;
  const durationMs =
      connectedAtMs == null ? null : Math.max(0, completedAtMs - connectedAtMs);

  writeRuntimeState(runtimePath, {
    ...state,
    agent_name: agentName,
    completed_at: completedAt,
    completed_at_ms: completedAtMs,
    episode_duration_ms: durationMs,
    episode_duration_seconds:
        durationMs == null ? null : Number((durationMs / 1000).toFixed(3)),
    score,
    completion_message: message,
    status: 'completed',
  });
}
