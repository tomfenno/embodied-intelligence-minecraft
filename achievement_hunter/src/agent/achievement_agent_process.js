import { spawn } from 'child_process';
import { logoutAgent } from '../../../src/mindcraft/mindserver.js';

/**
 * AchievementAgentProcess mirrors AgentProcess but spawns
 * init_achievement_agent.js instead of init_agent.js.
 */
export class AchievementAgentProcess {
    constructor(name, port) {
        this.name = name;
        this.port = port;
    }

    start(load_memory = false, init_message = null, count_id = 0) {
        this.count_id = count_id;
        this.running = true;

        let args = ['achievement_hunter/src/agent/init_achievement_agent.js'];
        args.push('-n', this.name);
        args.push('-c', count_id);
        if (load_memory)
            args.push('-l', load_memory);
        args.push('-p', this.port);

        const agentProcess = spawn('node', args, {
            stdio: 'inherit',
            stderr: 'inherit',
        });

        let last_restart = Date.now();
        agentProcess.on('exit', (code, signal) => {
            console.log(`Achievement agent process exited with code ${code} and signal ${signal}`);
            this.running = false;
            logoutAgent(this.name);

            if (code > 1) {
                console.log('Ending task.');
                process.exit(code);
            }

            if (code !== 0 && signal !== 'SIGINT') {
                if (Date.now() - last_restart < 10000) {
                    console.error('Achievement agent process exited too quickly and will not be restarted.');
                    return;
                }
                console.log('Restarting achievement agent...');
                this.start(true, null, count_id);
                last_restart = Date.now();
            }
        });

        agentProcess.on('error', (err) => {
            console.error('Achievement agent process error:', err);
        });

        this.process = agentProcess;
    }

    stop() {
        if (!this.running) return;
        this.process.kill('SIGINT');
    }
}
