/**
 * AchievementAgent - extends the base Mindcraft Agent to drive the
 * Structured Prompting Loop (SPL). Waits for a player objective, then runs
 * structured_loop() to completion before accepting the next objective.
 */

import './commands.js';

import {Agent} from '../../../src/agent/agent.js';
import {clearCheckpoint, loadCheckpoint} from '../pipeline/checkpoint.js';
import {LlmClient} from '../pipeline/llm_client.js';
import {structured_loop} from '../pipeline/structured_loop/loop.js';
import {recordEpisodeCompleted} from '../../evaluation_harness/episode_runtime.js';
import {BENCHMARK_TASK_TYPES} from '../../evaluation_harness/task_validators.js';

import {init_ah_modes} from './ah_modes.js';

const RESTART_MSG = 'Safely restarting to update inventory.';

export class AchievementAgent extends Agent {
  async _setupEventHandlers(save_data, init_message) {
    this._init_spl_models();

    const orig_open_chat = this.openChat;
    this.openChat = async () => {};
    try {
      await super._setupEventHandlers(save_data, null);
    } finally {
      this.openChat = orig_open_chat;
    }

    init_ah_modes(this);
    this._silence_chat_listeners();
    const benchmarkTask = this.task?.data;
    this._benchmark_task_mode = BENCHMARK_TASK_TYPES.has(benchmarkTask?.type);
    this._benchmark_shutdown_requested = false;
    this._task_completion_recorded = false;

    let saved_checkpoint = loadCheckpoint();

    // In benchmark mode, a checkpoint whose objective doesn't match the
    // current task's goal is stale — leftover from a previous episode
    // whose cleanup didn't run (harness killed mid-episode, or the agent
    // was launched outside the harness). Discard it and fall through to
    // the normal benchmark-task launch path. Without this guard the
    // agent silently runs the wrong objective for the entire episode.
    if (saved_checkpoint && this._benchmark_task_mode) {
      const current_goal =
          typeof benchmarkTask?.goal === 'string' ? benchmarkTask.goal.trim() :
                                                    null;
      if (current_goal && saved_checkpoint.objective?.trim() !== current_goal) {
        console.warn(
            '[SPL] Stale checkpoint discarded: saved objective',
            JSON.stringify(saved_checkpoint.objective),
            'does not match current benchmark task',
            JSON.stringify(current_goal) + '.');
        await clearCheckpoint();
        saved_checkpoint = null;
      }
    }

    if (saved_checkpoint) {
      this._waiting_for_objective = false;
      console.log(
          '[SPL] Checkpoint found - resuming:', saved_checkpoint.objective,
          '(saved at', saved_checkpoint.saved_at + ')');
      this.openChat(`Resuming previous task: "${saved_checkpoint.objective}"`);
      this._launch_spl(saved_checkpoint.objective, saved_checkpoint.graph);
      return;
    }

    if (
      this._benchmark_task_mode &&
        typeof benchmarkTask.goal === 'string' &&
        benchmarkTask.goal.trim()
    ) {
      this._waiting_for_objective = false;
      console.log('[SPL] Starting benchmark objective:', benchmarkTask.goal);
      this._launch_spl(benchmarkTask.goal);
      return;
    }

    if (this._benchmark_task_mode) {
      console.warn(
          '[SPL] Benchmark task is missing a usable goal; ' +
          'entering interactive objective mode.');
    }

    this._waiting_for_objective = true;
    this.openChat('Achievement Hunter ready! Send me an objective to begin.');
  }

  async update(delta) {
    await this.bot.modes.update();
    if (this._benchmark_task_mode) {
      await this.checkTaskDone();
    }
  }

  async checkTaskDone() {
    if (this._task_completion_recorded) {
      return true;
    }

    if (!this.task?.data) {
      return false;
    }

    const res = this.task.isDone();
    if (!res) {
      return false;
    }

    this._task_completion_recorded = true;
    await this.history.add('system', `Task ended with score : ${res.score}`);
    await this.history.save();
    recordEpisodeCompleted(
        this.name, {score: res.score, message: res.message});
    console.log('Task finished:', res.message);
    this.killAll();
    return true;
  }

  async handleMessage(source, message, max_responses = null) {
    if (source === 'system') return true;

    if (this._waiting_for_objective && source !== this.name &&
        !message.startsWith('!')) {
      this._waiting_for_objective = false;
      console.log('[SPL] Received objective from', source, ':', message);
      this._launch_spl(message);
      return true;
    }

    if (!this._waiting_for_objective) {
      console.log(
          '[SPL] Message suppressed while SPL is running:', source, '-',
          message.slice(0, 80));
      return true;
    }

    return super.handleMessage(source, message, max_responses);
  }

  cleanKill(msg = 'Killing agent process...', code = 1) {
    if (msg === RESTART_MSG) return;
    super.cleanKill(msg, code);
  }

  killAll() {
    if (this._benchmark_task_mode) {
      if (this._benchmark_shutdown_requested) {
        return;
      }
      this._benchmark_shutdown_requested = true;
      this._disconnectHandled = true;
    }

    super.killAll();
  }

  _init_spl_models() {
    const profile = this.prompter?.profile ?? {};
    const fallback = profile.model || 'gpt-4o-mini';
    this._spl_models = {
      ptd: new LlmClient(profile.ptd_model || fallback),
      ptd_feedback: new LlmClient(
          profile.ptd_feedback_model || profile.ptd_model || fallback),
      ptd_refinement: new LlmClient(
          profile.ptd_refinement_model || profile.ptd_model || fallback),
      failure_replanner: new LlmClient(
          profile.failure_replanner_model || fallback),
      search_replanner: new LlmClient(
          profile.search_replanner_model || fallback),
    };
  }

  _launch_spl(objective, graph = null) {
    structured_loop(this._spl_models, this, objective, graph)
        .then(async () => {
          if (this._benchmark_task_mode) {
            const task_completed = await this.checkTaskDone();
            if (!task_completed && !this._benchmark_shutdown_requested) {
              console.log(
                  '[SPL] Benchmark objective complete; waiting for ' +
                  'benchmark validation/shutdown.');
            }
            return;
          }

          this._waiting_for_objective = true;
          this.openChat('Task complete! Send me a new objective.');
        })
        .catch((err) => {
          console.error('[SPL] Structured loop crashed:', err);
          if (this._benchmark_task_mode) {
            console.error(
                '[SPL] Benchmark objective crashed; waiting for task ' +
                'timeout or external shutdown.');
            return;
          }
          this._waiting_for_objective = true;
          this.openChat('SPL crashed. Send a new objective to retry.');
        });
  }

  _silence_chat_listeners() {
    this.bot.removeAllListeners('chat');
    this.bot.removeAllListeners('whisper');
  }
}
