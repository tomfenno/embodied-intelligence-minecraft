import { Agent } from '../../../src/agent/agent.js';
import { TeammateChannel } from '../comms/teammate_channel.js';
import { runDisclosureLoop } from '../pipeline/world_state.js';

// The only new agent-side class for Phase 1. Instantiated instead of the
// stock Agent for count_id 0 when settings.colab_agent is true (see the
// AH-marked edit in src/process/init_agent.js). Every other agent runs the
// unmodified stock Agent. See colab_agent/docs/08-phase-1-world-state-document.md §8.
export class ColabCoordinatorAgent extends Agent {
  async update(delta) {
    await this.bot.modes.update(); // keep safety nets (self-preservation, unstuck, etc.)

    if (!this._loop_started) {
      this._loop_started = true;
      this.teammateChannel = new TeammateChannel();
      runDisclosureLoop(this, this.teammateChannel).catch(err => {
        console.error('[Disclosure Loop] crashed:', err);
      });
    }
  }

  async handleMessage(source, message, max_responses = null) {
    if (source === 'system') return true;
    const cleaned = message.replace(/^\(FROM OTHER BOT\)/, '');
    if (this.teammateChannel?.tryResolve(source, cleaned)) return true;
    console.log(`[Disclosure Loop] ignoring unsolicited message from ${source}: ${cleaned.slice(0, 80)}`);
    return true;
  }
}
