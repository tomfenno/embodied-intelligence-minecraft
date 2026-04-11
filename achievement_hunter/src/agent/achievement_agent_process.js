import { spawn } from 'child_process';
import { logoutAgent } from '../../../src/mindcraft/mindserver.js';

const MIN_RESTART_INTERVAL_MS = 10_000;

/**
 * Manages the achievement agent as a child process. Mirrors the base
 * AgentProcess but spawns init_achievement_agent.js instead of init_agent.js.
 */
export class AchievementAgentProcess {
    constructor(name, port) {
        this.name = name;
        this.port = port;
    }

    start(load_memory = false, count_id = 0) {
        this.count_id = count_id;
        this.running = true;

        const spawn_args = [
            'achievement_hunter/src/agent/init_achievement_agent.js',
            '-n', this.name,
            '-c', count_id,
            '-p', this.port,
        ];
        if (load_memory) spawn_args.push('-l', load_memory);

        const child_process = spawn('node', spawn_args, {
            stdio: 'inherit',
            stderr: 'inherit',
        });

        let last_restart = Date.now();

        child_process.on('exit', (code, signal) => {
            console.log(`Achievement agent process exited with code ${code} and signal ${signal}`);
            this.running = false;
            logoutAgent(this.name);

            if (code > 1) {
                console.log('Ending task.');
                process.exit(code);
            }

            if (this._should_restart(code, signal)) {
                if (Date.now() - last_restart < MIN_RESTART_INTERVAL_MS) {
                    console.error('Achievement agent process exited too quickly and will not be restarted.');
                    return;
                }
                console.log('Restarting achievement agent...');
                last_restart = Date.now();
                this.start(true, count_id);
            }
        });

        child_process.on('error', (process_error) => {
            console.error('Achievement agent process error:', process_error);
        });

        this.process = child_process;
    }

    stop() {
        if (!this.running) return;
        this.process.kill('SIGINT');
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Returns true if the process should be restarted after exiting.
     * A non-zero exit code that was not caused by SIGINT (user-initiated stop)
     * is treated as an unexpected crash warranting a restart.
     */
    _should_restart(exit_code, exit_signal) {
        return exit_code !== 0 && exit_signal !== 'SIGINT';
    }
}
