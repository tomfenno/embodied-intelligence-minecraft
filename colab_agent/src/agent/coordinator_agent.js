import { Agent } from '../../../src/agent/agent.js';
import { TeammateChannel } from '../comms/teammate_channel.js';
import { runDisclosureLoop } from '../pipeline/world_state.js';
import { generatePTD } from '../pipeline/ptd.js';
import { startExecutionPhase } from '../pipeline/execution.js';

// The only new agent-side class for the colab_agent pipeline. Instantiated
// instead of the stock Agent for count_id 0 when settings.colab_agent is
// true (see the AH-marked edit in src/process/init_agent.js). Every other
// agent runs the unmodified stock Agent. See
// colab_agent/docs/08-phase-1-world-state-document.md §8 and
// colab_agent/docs/10-phase-3-execution.md for the full Phase 1-3 design.
export class ColabCoordinatorAgent extends Agent {
  async update(delta) {
    // Stock tick: bot.modes.update(), self_prompter.update(delta),
    // checkTaskDone(). Once Phase 3 hands control to self_prompter this is
    // what actually drives andy's execution loop and detects task
    // completion — see docs/10-phase-3-execution.md §1/§8.
    await super.update(delta);

    if (!this._loop_started) {
      this._loop_started = true;
      // Deliberately no self_prompter.stop()/pause() call here. Task.setAgentGoal()
      // already ran !goal(...) for andy at spawn like any agent, so self_prompter
      // may be PAUSED (holding the raw goal, loop never started — the common case,
      // since Task.initBotTask() seeds a conversation before setAgentGoal() runs)
      // or, less commonly, already actively looping. Either way needs no
      // intervention: startExecutionPhase's self_prompter.start(goalText) (§5/§8)
      // unconditionally overwrites .prompt before attempting to (re)start the loop,
      // so a paused prompter starts clean and an already-running one just picks up
      // the new prompt + the flipped executionStarted gate on its next iteration.
      // stop()/pause() were tried here and removed: SelfPrompter.stop() sets
      // interrupt=true then fires stopLoop() without awaiting it, and stopLoop()'s
      // own reentrancy guard (`if (this.interrupt) return`) fires immediately
      // because stop() just set it — so if the loop wasn't already actively
      // running (loop_active=false, e.g. the paused case above), interrupt gets
      // stuck at true forever, and every future startLoop() call's
      // `while (!this.interrupt)` never executes even once.
      this.teammateChannel = new TeammateChannel();
      runDisclosureLoop(this, this.teammateChannel)
        .then(({ doc, runDir }) => {
          if (doc.status !== 'complete') {
            console.log(`[PTD] skipping — Disclosure Loop ended with status "${doc.status}", not "complete"`);
            return;
          }
          return generatePTD(this, doc, runDir).then(({ graph, summary, status }) => {
            if (status !== 'complete') {
              console.log(`[Execution] skipping — PTD generation ended with status "${status}", not "complete"`);
              return;
            }
            startExecutionPhase(this, graph, summary, runDir);
          });
        })
        .catch(err => {
          console.error('[Disclosure Loop] crashed:', err);
        });
    }
  }

  async handleMessage(source, message, max_responses = null) {
    if (this.executionStarted) {
      return super.handleMessage(source, message, max_responses); // Phase 3: fully stock reasoning
    }
    if (source === 'system') return true;
    const cleaned = message.replace(/^\(FROM OTHER BOT\)/, '');
    if (this.teammateChannel?.tryResolve(source, cleaned)) return true;
    console.log(`[Disclosure Loop] ignoring unsolicited message from ${source}: ${cleaned.slice(0, 80)}`);
    return true;
  }
}
