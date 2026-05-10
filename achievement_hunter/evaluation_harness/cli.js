import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {runBenchmarkSuite} from './lib/suite.js';

const argv = await yargs(hideBin(process.argv))
    .option('config', {
      type: 'string',
      demandOption: true,
      describe: 'Path to the benchmark suite config JSON',
    })
    .option('seed', {
      type: 'number',
      array: true,
      describe: 'Optional seed filter; repeatable',
    })
    .option('agent', {
      type: 'string',
      array: true,
      describe: 'Optional agent label filter; repeatable',
    })
    .option('task', {
      type: 'string',
      array: true,
      describe: 'Optional task id filter; repeatable',
    })
    .option('world-provider', {
      type: 'string',
      choices: ['managed_local', 'external'],
      describe: 'Override the suite world provider',
    })
    .option('server-template-path', {
      type: 'string',
      describe: 'Override the managed-local server template path',
    })
    .option('host', {
      type: 'string',
      describe: 'Override the external world host',
    })
    .option('port', {
      type: 'number',
      describe: 'Override the external world port',
    })
    .option('suite-name', {
      type: 'string',
      describe: 'Optional override for the output suite name',
    })
    .strict()
    .help()
    .parse();

try {
  await runBenchmarkSuite({
    configPath: argv.config,
    filters: {
      agent_labels: argv.agent,
      seeds: argv.seed,
      task_ids: argv.task,
    },
    worldOverrides: Object.fromEntries(Object.entries({
      provider: argv['world-provider'],
      server_template_path: argv['server-template-path'],
      host: argv.host,
      port: argv.port,
    }).filter(([, value]) => value !== undefined)),
    suiteNameOverride: argv['suite-name'] || null,
  });
} catch (error) {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}
