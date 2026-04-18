/**
 * Entry point for the achievement agent child process.
 * Parses CLI args, connects to the Mindserver, and starts the AchievementAgent.
 */

import yargs from 'yargs';

import {serverProxy} from '../../../src/agent/mindserver_proxy.js';

import {AchievementAgent} from './achievement_agent.js';

const argv = yargs(process.argv.slice(2))
                 .option('name', {
                   alias: 'n',
                   type: 'string',
                   description: 'Name of the agent',
                 })
                 .option('port', {
                   alias: 'p',
                   type: 'number',
                   description: 'Port of the Mindserver',
                 })
                 .option('load_memory', {
                   alias: 'l',
                   type: 'boolean',
                   description: 'Load agent memory from file on startup',
                 })
                 .option('count_id', {
                   alias: 'c',
                   type: 'number',
                   default: 0,
                   description: 'Identifying index for multi-agent scenarios',
                 })
                 .demandOption(['name', 'port'])
                 .argv;

async function main() {
  console.log('Connecting to MindServer');
  await serverProxy.connect(argv.name, argv.port);

  console.log('Starting achievement agent');
  const agent = new AchievementAgent();
  serverProxy.setAgent(agent);
  await agent.start(argv.load_memory, null, argv.count_id);
}

main().catch(err => {
  console.error('Failed to start achievement agent process:\n', err.stack);
  process.exit(1);
});
