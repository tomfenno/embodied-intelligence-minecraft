import { Agent } from '../../../src/agent/agent.js';
import { loadCheckpoint } from '../pipeline/checkpoint.js';
import { structuredLoop } from '../pipeline/structured_loop.js';

const AUTO_MESSAGE_PREFIX = '(AUTO MESSAGE)';

/**
 * AchievementAgent extends the base Agent to implement the Structured Prompting Loop.
 *
 * On spawn, it announces readiness and waits for a player to send an objective.
 * The first player message received is treated as the objective T and passed to
 * structuredLoop(). If a crash-recovery checkpoint exists, the loop resumes
 * automatically without waiting for a new objective.
 */
export class AchievementAgent extends Agent {
    async _setupEventHandlers(save_data, init_message) {
        // Suppress the default "Hello world" greeting, run base setup, then restore.
        const orig_open_chat = this.openChat.bind(this);
        this.openChat = async () => {};
        await super._setupEventHandlers(save_data, null);
        this.openChat = orig_open_chat;

        this._silence_chat_listeners();

        const saved_checkpoint = loadCheckpoint();
        if (saved_checkpoint) {
            this._waiting_for_objective = false;
            console.log('[SPL] Checkpoint found — resuming:', saved_checkpoint.objective, '(saved at', saved_checkpoint.saved_at + ')');
            this.openChat(`Resuming previous task: "${saved_checkpoint.objective}"`);
            this._launch_spl(saved_checkpoint.objective, saved_checkpoint.graph);
        } else {
            this._waiting_for_objective = true;
            this.openChat('Achievement Hunter ready! Send me an objective to begin.');
        }
    }

    async update(delta) {
        // Skip self_prompter.update() — the structured loop manages its own execution.
        await this.bot.modes.update();
        await this.checkTaskDone();
    }

    async handleMessage(source, message, max_responses = null) {
        // Intercept the first player message as the structured loop objective.
        // Ignore bot commands ('!'), system messages, and self-messages.
        if (this._waiting_for_objective && source !== 'system' && source !== this.name && !message.startsWith('!')) {
            this._waiting_for_objective = false;
            console.log('[SPL] Received objective from', source, ':', message);
            this._launch_spl(message);
            return true;
        }

        // Suppress auto-messages from safety modes (self_preservation, unstuck, etc.)
        // while the SPL is running. The modes still act physically — we just prevent
        // them from hijacking control flow. The outer loop re-evaluates on the next iteration.
        if (!this._waiting_for_objective && message.startsWith(AUTO_MESSAGE_PREFIX)) {
            console.log('[SPL] Mode auto-message suppressed:', message.slice(0, 100));
            return true;
        }

        return super.handleMessage(source, message, max_responses);
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Starts the structured loop for the given objective, optionally resuming
     * from a pre-built PTD graph (crash recovery). Resets to the waiting state
     * and notifies the player if the loop crashes.
     */
    _launch_spl(objective, graph = null) {
        structuredLoop(this.prompter.chat_model, this, objective, graph)
            .catch(err => {
                console.error('[SPL] Structured loop crashed:', err);
                this._waiting_for_objective = true;
                this.openChat('SPL crashed. Send a new objective to retry.');
            });
    }

    /**
     * Removes all in-game chat and whisper listeners so the agent only responds
     * to commands routed through the Mindserver's 'send-message' socket event.
     */
    _silence_chat_listeners() {
        this.bot.removeAllListeners('chat');
        this.bot.removeAllListeners('whisper');
    }
}
