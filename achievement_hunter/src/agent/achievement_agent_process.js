/**
 * AchievementAgentProcess - supervises the achievement agent as a child
 * process. Mirrors the base AgentProcess but spawns init_achievement_agent.js
 * instead of init_agent.js.
 */

import {spawn} from 'child_process';

import {logoutAgent} from '../../../src/mindcraft/mindserver.js';

const MIN_RESTART_INTERVAL_MS = 10_000;

export class AchievementAgentProcess {
  constructor(name, port) {
    this.name = name;
    this.port = port;
    this._stop_requested = false;
  }

  start(load_memory = false, count_id = 0) {
    this.count_id = count_id;
    this.running = true;
    this._stop_requested = false;

    const spawn_args = [
      'achievement_hunter/src/agent/init_achievement_agent.js',
      '-n',
      this.name,
      '-c',
      count_id,
      '-p',
      this.port,
    ];
    if (load_memory) spawn_args.push('-l', load_memory);

    const child = spawn('node', spawn_args, {
      stdio: 'inherit',
      stderr: 'inherit',
    });

    let last_restart = Date.now();

    child.on('exit', (code, signal) => {
      const stop_requested = this._stop_requested;
      console.log(`Achievement agent process exited with code ${
          code} and signal ${signal}`);
      this.running = false;
      this._stop_requested = false;
      logoutAgent(this.name);

      if (stop_requested) {
        console.log('Achievement agent stop requested; not restarting.');
        return;
      }

      if (code > 1) {
        console.log('Ending task.');
        process.exit(code);
      }

      if (this._should_restart(code, signal)) {
        if (Date.now() - last_restart < MIN_RESTART_INTERVAL_MS) {
          console.error(
              'Achievement agent process exited too quickly and will not be restarted.');
          return;
        }
        console.log('Restarting achievement agent...');
        last_restart = Date.now();
        this.start(true, count_id);
      }
    });

    child.on('error', (process_error) => {
      console.error('Achievement agent process error:', process_error);
    });

    this.process = child;
  }

  stop() {
    if (!this.running) return;
    this._stop_requested = true;
    this.process.kill('SIGINT');
  }

  _should_restart(exit_code, exit_signal) {
    return !this._stop_requested &&
        exit_code !== 0 && exit_signal !== 'SIGINT';
  }
}
