/**
 * AchievementAgent — extends the base Mindcraft Agent to drive the
 * Structured Prompting Loop (SPL). Waits for a player objective, then runs
 * structuredLoop() to completion before accepting the next objective.
 */

import './commands.js'; // registers ah_commands into the base command map

import {readFileSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

import {Agent} from '../../../src/agent/agent.js';
import {loadCheckpoint} from '../pipeline/checkpoint.js';
import {LlmClient} from '../pipeline/llm_client.js';
import {structured_loop} from '../pipeline/structured_loop/loop.js';

import {init_ah_modes} from './ah_modes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Matches the restart message in src/agent/library/skills.js; suppressed so the
// SPL manages its own inventory reads.
const RESTART_MSG = 'Safely restarting to update inventory.';

/**
 * Achievement Hunter agent. Overrides the base Agent to replace the
 * free-form conversation loop with the Structured Prompting Loop.
 */
export class AchievementAgent extends Agent {
  /**
   * Initialises SPL models, wires the base agent, then starts or resumes the
   * SPL.
   */
  async _setupEventHandlers(save_data, init_message) {
    this._init_spl_models();

    // Suppress the default "Hello world" greeting during base setup.
    // try/finally ensures openChat is always restored even if base setup
    // throws.
    const orig_open_chat = this.openChat.bind(this);
    this.openChat = async () => {};
    try {
      await super._setupEventHandlers(save_data, null);
    } finally {
      this.openChat = orig_open_chat;
    }

    init_ah_modes(this);
    this._silence_chat_listeners();

    const saved_checkpoint = loadCheckpoint();
    if (saved_checkpoint) {
      this._waiting_for_objective = false;
      console.log(
          '[SPL] Checkpoint found — resuming:', saved_checkpoint.objective,
          '(saved at', saved_checkpoint.saved_at + ')');
      this.openChat(`Resuming previous task: "${saved_checkpoint.objective}"`);
      this._launch_spl(saved_checkpoint.objective, saved_checkpoint.graph);
    } else {
      this._waiting_for_objective = true;
      this.openChat('Achievement Hunter ready! Send me an objective to begin.');
    }
  }

  /**
   * Overrides the base tick to skip self_prompter and checkTaskDone.
   * The SPL owns execution and task completion; the base implementations would
   * disconnect the bot or conflict with per-stage model assignment.
   */
  async update(delta) {
    await this.bot.modes.update();
  }

  /**
   * Intercepts the first player message as the SPL objective, then suppresses
   * all further messages while the loop is running. Suppression prevents the
   * base LLM path from issuing conflicting commands via executeCommand.
   */
  async handleMessage(source, message, max_responses = null) {
    if (this._waiting_for_objective && source !== 'system' &&
        source !== this.name && !message.startsWith('!')) {
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

  /**
   * Suppresses the post-completion inventory restart so the SPL re-reads
   * inventory itself.
   */
  cleanKill(msg = 'Killing agent process...', code = 1) {
    if (msg === RESTART_MSG) return;
    super.cleanKill(msg, code);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Reads profile.json and instantiates LlmClient instances for each SPL
   * stage.
   */
  _init_spl_models() {
    const profile = JSON.parse(
        readFileSync(path.join(__dirname, '../profile.json'), 'utf8'));
    const fallback = profile.model || 'gpt-4o-mini';
    this._spl_models = {
      ptd: new LlmClient(profile.ptd_model || fallback),
      ptd_feedback: new LlmClient(
          profile.ptd_feedback_model || profile.ptd_model || fallback),
      ptd_refinement: new LlmClient(
          profile.ptd_refinement_model || profile.ptd_model || fallback),
    };
  }

  /**
   * Runs the structured loop for the given objective, optionally resuming from
   * a saved PTD graph. Resets to the waiting state and notifies the player on
   * completion or crash.
   */
  _launch_spl(objective, graph = null) {
    structured_loop(this._spl_models, this, objective, graph)
        .then(() => {
          this._waiting_for_objective = true;
          this.openChat('Task complete! Send me a new objective.');
        })
        .catch(err => {
          console.error('[SPL] Structured loop crashed:', err);
          this._waiting_for_objective = true;
          this.openChat('SPL crashed. Send a new objective to retry.');
        });
  }

  /**
   * Removes in-game chat/whisper listeners so the agent only responds via the
   * Mindserver socket.
   */
  _silence_chat_listeners() {
    this.bot.removeAllListeners('chat');
    this.bot.removeAllListeners('whisper');
  }
}
