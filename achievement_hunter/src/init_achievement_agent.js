import { AchievementAgent } from './achievement_agent.js';
import { serverProxy } from '../../src/agent/mindserver_proxy.js';
import yargs from 'yargs';

const args = process.argv.slice(2);
if (args.length < 1) {
    console.log('Usage: node init_achievement_agent.js -n <agent_name> -p <port> -l <load_memory> -c <count_id>');
    process.exit(1);
}

const argv = yargs(args)
    .option('name', {
        alias: 'n',
        type: 'string',
        description: 'name of agent'
    })
    .option('load_memory', {
        alias: 'l',
        type: 'boolean',
        description: 'load agent memory from file on startup'
    })
    .option('count_id', {
        alias: 'c',
        type: 'number',
        default: 0,
        description: 'identifying count for multi-agent scenarios',
    })
    .option('port', {
        alias: 'p',
        type: 'number',
        description: 'port of mindserver'
    })
    .argv;

(async () => {
    try {
        console.log('Connecting to MindServer');
        await serverProxy.connect(argv.name, argv.port);
        console.log('Starting achievement agent');
        const agent = new AchievementAgent();
        serverProxy.setAgent(agent);
        await agent.start(argv.load_memory, null, argv.count_id);
    } catch (error) {
        console.error('Failed to start achievement agent process:');
        console.error(error.message);
        console.error(error.stack);
        process.exit(1);
    }
})();
