import { Agent } from '../agent/agent.js';
import { serverProxy } from '../agent/mindserver_proxy.js';
import yargs from 'yargs';
// Start of AH code
import { readFileSync } from 'fs';
import settings from '../agent/settings.js';
import { ColabCoordinatorAgent } from '../../colab_agent/src/agent/coordinator_agent.js';
// End of AH code

const args = process.argv.slice(2);
if (args.length < 1) {
    console.log('Usage: node init_agent.js -n <agent_name> -p <port> -l <load_memory> -m <init_message> -c <count_id>');
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
    .option('init_message', {
        alias: 'm',
        type: 'string',
        description: 'automatically prompt the agent on startup'
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
        console.log('Starting agent');
        // Start of AH code
        const isColabCoordinator = settings.colab_agent && argv.count_id === 0;
        if (settings.colab_agent) {
            console.log(`[Disclosure Loop] colab_agent mode: count_id ${argv.count_id} is ` +
                `${isColabCoordinator ? 'the coordinator (ColabCoordinatorAgent)' : 'a responder (stock Agent)'}`);
        }
        // Leader framing as persistent goal text, not just a one-time chat
        // message — goal text re-injects on every self-prompt cycle, so it
        // survives history compression on long episodes. Motivated by
        // repeated evidence of non-coordinator agents acting autonomously
        // before receiving direction. See
        // colab_agent/docs/10-phase-3-execution.md §9.
        if (settings.colab_agent && !isColabCoordinator && settings.task?.goal != null) {
            try {
                const leaderProfile = JSON.parse(readFileSync(settings.profiles[0], 'utf8'));
                const leaderName = leaderProfile.name;
                if (leaderName) {
                    const note = `\n${leaderName} is the leader for this task. Wait for ` +
                        `${leaderName} to tell you what to do before acting, and follow ` +
                        `their direction throughout.`;
                    const agentId = String(argv.count_id);
                    const baseGoal = typeof settings.task.goal === 'string'
                        ? settings.task.goal
                        : (settings.task.goal[agentId] || '');
                    settings.task.goal = { [agentId]: baseGoal + note };
                }
            } catch (err) {
                console.warn('[Disclosure Loop] could not resolve leader name for goal framing:', err.message);
            }
        }
        const agent = isColabCoordinator
            ? new ColabCoordinatorAgent()
            : new Agent();
        // End of AH code
        serverProxy.setAgent(agent);
        await agent.start(argv.load_memory, argv.init_message, argv.count_id);
    } catch (error) {
        console.error('Failed to start agent process:');
        console.error(error.message);
        console.error(error.stack);
        process.exit(1);
    }
})();
