import {existsSync, readFileSync, writeFileSync} from 'fs';
import path from 'path';

const STATS_FILENAME = 'episode_command_stats.json';

function getStatsPath() {
  if (!process.env.BENCHMARK_EPISODE_DIR) {
    return null;
  }
  return path.join(process.env.BENCHMARK_EPISODE_DIR, STATS_FILENAME);
}

function readStatsState(statsPath) {
  if (!statsPath || !existsSync(statsPath)) {
    return {total_commands: 0, commands_by_agent: {}, commands_by_name: {}};
  }

  try {
    return JSON.parse(readFileSync(statsPath, 'utf8'));
  } catch (error) {
    console.error('Failed to read episode command stats:', error);
    return {total_commands: 0, commands_by_agent: {}, commands_by_name: {}};
  }
}

function writeStatsState(statsPath, state) {
  if (!statsPath) return;

  try {
    writeFileSync(statsPath, JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to write episode command stats:', error);
  }
}

export function recordCommandIssued(agentName, commandName) {
  const statsPath = getStatsPath();
  if (!statsPath) return;

  const state = readStatsState(statsPath);

  state.total_commands = (state.total_commands ?? 0) + 1;
  state.commands_by_agent[agentName] = (state.commands_by_agent[agentName] ?? 0) + 1;
  state.commands_by_name[commandName] = (state.commands_by_name[commandName] ?? 0) + 1;

  writeStatsState(statsPath, state);
}
