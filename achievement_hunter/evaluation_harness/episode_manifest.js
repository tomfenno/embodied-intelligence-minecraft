import path from 'path';
import {execFileSync} from 'child_process';

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {extractActionName} from './lib/dependency_metrics.js';
import {readJson, readJsonIfExists, writeJson, PROJECT_ROOT} from './lib/utils.js';

const argv = await yargs(hideBin(process.argv))
    .option('episode_dir', {type: 'string', demandOption: true})
    .option('task_id', {type: 'string', demandOption: true})
    .option('seed', {type: 'number', demandOption: true})
    .option('team_condition', {type: 'string', demandOption: true})
    .option('team_size', {type: 'number', demandOption: true})
    .option('domain', {type: 'string', demandOption: true})
    .option('agent_files', {type: 'string', array: true, demandOption: true})
    .option('task_timeout_seconds', {type: 'number', default: null})
    .strict()
    .help()
    .parse();

function agentNameFromFile(filePath) {
  const base = path.basename(filePath, '.json');
  const match = base.match(/^(.*)_\d+$/);
  return match ? match[1] : base;
}

function collectCommandCounts(agentFiles) {
  let totalCommands = 0;
  const commandsByAgent = {};
  const commandsByName = {};

  for (const filePath of agentFiles) {
    const agentName = agentNameFromFile(filePath);
    let data;
    try {
      data = readJson(filePath);
    } catch (error) {
      console.error(`Failed to read agent file ${filePath}:`, error);
      continue;
    }

    const turns = Array.isArray(data?.turns) ? data.turns : [];
    for (const turn of turns) {
      if (turn?.role !== 'assistant' || typeof turn.content !== 'string') continue;
      const actionName = extractActionName(turn.content);
      if (!actionName) continue;

      totalCommands += 1;
      commandsByAgent[agentName] = (commandsByAgent[agentName] ?? 0) + 1;
      commandsByName[actionName] = (commandsByName[actionName] ?? 0) + 1;
    }
  }

  return {totalCommands, commandsByAgent, commandsByName};
}

function parseEpisodeScore(agentFiles) {
  const args = agentFiles.flatMap((filePath) => ['--agent_file', filePath]);
  const output = execFileSync(
      'python', [path.join(PROJECT_ROOT, 'tasks', 'parse_episode_score.py'), ...args],
      {encoding: 'utf8'});
  return JSON.parse(output).score;
}

function main() {
  const episodeDir = path.resolve(argv.episode_dir);
  const runtime = readJsonIfExists(path.join(episodeDir, 'episode_runtime.json')) ?? {};
  const llmUsage = readJsonIfExists(path.join(episodeDir, 'episode_llm_usage.json')) ?? {};

  const {totalCommands, commandsByAgent, commandsByName} =
      collectCommandCounts(argv.agent_files);

  const taskScore = parseEpisodeScore(argv.agent_files);
  const success = taskScore != null && taskScore >= 1 ? 1 : 0;

  const durationSeconds = runtime.episode_duration_seconds ?? null;
  const timeoutSeconds = argv.task_timeout_seconds;
  let timeoutUsedPct = null;
  if (timeoutSeconds != null) {
    timeoutUsedPct = success && durationSeconds != null ?
        Number((100 * durationSeconds / timeoutSeconds).toFixed(2)) :
        100;
  }

  const manifest = {
    agent_label: argv.team_condition,
    team_condition: argv.team_condition,
    team_size: argv.team_size,
    domain: argv.domain,
    task_id: argv.task_id,
    seed: argv.seed,
    task_score: taskScore,
    success,
    episode_duration_seconds: durationSeconds,
    task_timeout_seconds: timeoutSeconds,
    timeout_used_pct: timeoutUsedPct,
    total_commands: totalCommands,
    commands_by_agent: commandsByAgent,
    commands_by_name: commandsByName,
    total_llm_requests: llmUsage.total_requests ?? 0,
    total_input_tokens: llmUsage.total_input_tokens ?? 0,
    total_output_tokens: llmUsage.total_output_tokens ?? 0,
    total_tokens: (llmUsage.total_input_tokens ?? 0) + (llmUsage.total_output_tokens ?? 0),
    total_cost_usd: llmUsage.total_cost_usd ?? null,
  };

  writeJson(path.join(episodeDir, 'episode_manifest.json'), manifest);
  console.log(`Wrote ${path.join(episodeDir, 'episode_manifest.json')}`);
}

main();
