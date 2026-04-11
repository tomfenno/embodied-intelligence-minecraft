import { Agent } from '../../../src/agent/agent.js';
import { loadCheckpoint } from '../pipeline/checkpoint.js';

/**
 * AchievementAgent extends the base Agent to implement the Structured Prompting Loop.
 *
 * On spawn, instead of the default "Hello world" greeting, it announces readiness
 * and waits for a player to send an objective. The first player message received is
 * treated as the objective T and passed directly to structuredLoop().
 *
 * All subsequent messages (after the objective is received) are handled normally
 * by the base Agent's handleMessage().
 */
export class AchievementAgent extends Agent {
    async _setupEventHandlers(save_data, init_message) {
        // Temporarily suppress the default "Hello world" greeting so we can
        // send our own readiness announcement instead.
        const origOpenChat = this.openChat.bind(this);
        this.openChat = async () => {};
        await super._setupEventHandlers(save_data, null);
        this.openChat = origOpenChat;

        // Ignore all in-game chat and whispers — only handle commands from the Mindserver,
        // which calls this.respondFunc directly via the 'send-message' socket event.
        this.bot.removeAllListeners('chat');
        this.bot.removeAllListeners('whisper');

        // Check for a crash-recovery checkpoint from a previous run.
        const checkpoint = loadCheckpoint();
        if (checkpoint) {
            this._waitingForObjective = false;
            console.log('[SPL] Checkpoint found — resuming:', checkpoint.objective, '(saved at', checkpoint.saved_at + ')');
            this.openChat(`Resuming previous task: "${checkpoint.objective}"`);
            const { structuredLoop } = await import('../pipeline/structured_loop.js');
            structuredLoop(this.prompter.chat_model, this, checkpoint.objective, checkpoint.graph)
                .catch(err => {
                    console.error('[SPL] Structured loop crashed:', err);
                    this._waitingForObjective = true;
                    this.openChat('SPL crashed. Send a new objective to retry.');
                });
        } else {
            this._waitingForObjective = true;
            this.openChat('Achievement Hunter ready! Send me an objective to begin.');
        }
    }

    async update(delta) {
        // Skip self_prompter.update() — the structured loop manages its own execution.
        await this.bot.modes.update();
        await this.checkTaskDone();
    }

    async handleMessage(source, message, max_responses = null) {
        // Intercept the first player message as the structured loop objective T.
        // Skip bot commands (messages starting with '!') and system/self-messages.
        if (this._waitingForObjective && source !== 'system' && source !== this.name && !message.startsWith('!')) {
            this._waitingForObjective = false;
            console.log('[SPL] Received objective from', source, ':', message);
            const { structuredLoop } = await import('../pipeline/structured_loop.js');
            structuredLoop(this.prompter.chat_model, this, message)
                .catch(err => {
                    console.error('[SPL] Structured loop crashed:', err);
                    this._waitingForObjective = true;
                    this.openChat('SPL crashed. Send a new objective to retry.');
                });
            return true;
        }

        // While the SPL is running, intercept auto-messages posted by modes after
        // they finish a safety action (self_preservation, unstuck, self_defense, etc.).
        // The modes still perform their physical actions (dodging fire, fighting back,
        // picking up items) — we just prevent them from re-routing control away from
        // the SPL via a new handleMessage conversation. The outer loop re-evaluates
        // state naturally on the next SCSG iteration.
        if (!this._waitingForObjective && message.startsWith('(AUTO MESSAGE)')) {
            console.log('[SPL] Mode auto-message suppressed (SPL handles re-evaluation):', message.slice(0, 100));
            return true;
        }

        return super.handleMessage(source, message, max_responses);
    }
}
