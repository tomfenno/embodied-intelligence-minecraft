# 10 — Phase 3 Implementation Plan: The Execution Loop

This is a design doc, written *before* any Phase 3 code exists — analogous to how doc 08 was written before Phase 1 existed. It supersedes an earlier draft of this same file, which designed a bespoke per-iteration execution loop (its own structured LLM decision schema, `progress.json`, command-verification wiring, an accumulate-async-updates rewrite of `handleMessage`). That approach turned out to be reimplementing machinery the stock `Agent` already provides — command dispatch, inter-bot messaging, conversation turn-taking, task-completion detection. This version leans on that machinery directly instead. Treat the code sketches here as the plan to build against, not a description of what's already running.

## Concept

Phase 1 built a shared understanding (the world state document). Phase 2 turned that understanding into a plan (the PTD). Phase 3's job is simply to hand andy that plan and let him run it the same way every agent in this codebase already runs any goal: via `self_prompter`, the same reactive self-prompting loop jill has used since before any of this existed. The only things that change are *what's in the goal text he's given* and *no longer suppressing the stock machinery* (`checkTaskDone`, command dispatch, conversation handling) that machinery already provides for free.

Concretely: no bespoke per-iteration LLM decision call, no separate execution-decision JSON schema, no `progress.json`. The plan is rendered into one goal string and handed to `self_prompter.start()`; the existing stock reasoning loop (`handleMessage` → `promptConvo` → command execution) takes it from there, exactly as it already does for jill's task goal. This still realizes doc 06's original Coordinator/Specialist shape — it's just built on top of the framework's own agent loop instead of a parallel one.

---

## 1. Definition of done

Given `world_state.json` and a validated `ptd.json` (Phases 1-2 complete), Phase 3 renders the PTD into a natural-language goal string and calls `agent.self_prompter.start(goalText)`. From that point on, andy is a self-prompting agent like any other — his own reasoning, driven by the stock conversing template plus that goal text, decides what to do next: execute a command himself, or brief jill via a normal inter-bot conversation.

The episode ends the same way it always does for any task: `checkTaskDone()` — already polled every tick and every message by the stock `Agent.update()`/`handleMessage()` (`src/agent/agent.js:530-533`, `:260`) once `ColabCoordinatorAgent` stops overriding those methods with Phase-1/2-only logic — detects the validator succeeding or the task timing out, and calls `killAll()`. Andy's own reasoning never has to decide "we're done"; that's now true automatically, not because of a special poll we added on top.

---

## 2. Non-goals / explicit deferrals

- **`min_agents > 1`** — every vertex across all stress tests so far has been `min_agents: 1`; genuine multi-agent rendezvous is deferred, same as the original plan.
- **Configurable leader "style"** — deferred, per direct instruction, unchanged from the original plan.
- **Automatic replanning** — the stock self-prompter already has its own give-up signal (§7). Wiring that into an automatic re-plan-and-resume cycle is a natural next step, not required for a first prototype.
- **Re-validating Phase 1/2 after the leader-framing goal-text change (§9)** — still a real outstanding TODO, unrelated to this pivot.
- **Command-outcome verification** (`achievement_hunter/src/pipeline/command_verifier.js`) — not integrated. Andy's own actions are trusted the same way jill's already are: whatever the skill itself reports lands in `history`, and that's the record. This was part of the superseded design; revisit only if trust-based completion proves unreliable in testing.

---

## 3. Roles

| Agent | Responsibility |
|---|---|
| Andy (leader) | Runs Phases 1-2 as already built. Once the PTD is ready, becomes a self-prompting agent seeded with the plan instead of a plain task goal — otherwise indistinguishable from how any Mindcraft agent pursues a goal. |
| Jill (follower) | **Zero new code**, unchanged. Receives instructions via a normal bot-to-bot conversation (a stock capability any agent already has), acts on her own judgment, reports back the same way. |

---

## 4. Repo layout (new files)

```
colab_agent/
├── docs/
│   └── 10-phase-3-execution.md   ← this file
└── src/
    └── pipeline/
        └── execution.js           renderPTD(ptd) — pure string formatting of the plan only, no LLM call
```

No prompt template directory, no `LlmClient` usage — Phase 3 makes zero LLM calls of its own. The only new code is one formatting function plus a handful of lines in `coordinator_agent.js`.

---

## 5. The leadership goal text: appended to the existing goal, not reconstructed from scratch

`self_prompter.prompt` already holds a correct, stock-computed goal string by the time Phase 3 begins — `Task.setAgentGoal()` (`src/agent/tasks/tasks.js:162-177`) builds it from `getAgentGoal()` plus a collaboration sentence naming jill, and passes it through `!goal(...)`, which sets `self_prompter.prompt` to that text regardless of which internal branch it takes (`start()` or `setPromptPaused()` both assign `this.prompt = prompt`). Critically, `self_prompter.stop()` (§8) does **not** clear `.prompt` — it only resets the loop's running state. So there's no need to re-derive the objective ourselves; it's already sitting there, already correct.

`renderPTD(ptd)` is a small pure function that renders *only the plan* into prose: which vertices are andy's to perform, which are jill's, which either can do, and the dependency order (`A -> B` as plain "X before Y" sentences) — reusing `ptd.summary`, already a free byproduct of Phase 2, as an opening line. `startExecutionPhase` then composes the final goal by appending, not overwriting:

```js
const goalText = `${agent.self_prompter.prompt}\n\nHere is the plan the team agreed on:\n${renderPTD(graph)}`;
agent.self_prompter.start(goalText);
```

(Falls back to `graph.objective` if `self_prompter.prompt` is ever empty — e.g. a task type where `setAgentGoal()` early-returns — so the goal text still has a framing sentence rather than starting cold with just the plan.)

This keeps the surface where a bad translation could corrupt things as small as possible: only the plan structure is new, unverified rendering; the objective statement itself is untouched, already-correct, stock-computed text. The composed string becomes `self_prompter`'s `prompt` field and is re-injected verbatim into every self-prompt cycle's message (`src/agent/self_prompter.js:66`), living separately from `history` (its own field, persisted through `handleLoad`/save data) — so unlike a chat message, it's immune to `History.summarizeMemories` compression. The plan stays fully visible for the entire execution phase with no periodic re-injection needed.

Andy already knows the full command vocabulary (including the messaging commands in §6) the same way any agent does — via the stock `Prompter`'s own `$COMMAND_DOCS` templating. Nothing new needed there.

---

## 6. How andy directs jill

No new code. `!startConversation(player_name, message)` and `!endConversation(player_name)` are existing stock commands (`src/agent/commands/actions.js:498-525`) that call `convoManager.startConversation`/`endConversation` directly — the exact mechanism the (now-removed) `TeammateChannel` was re-implementing one layer up. Andy's self-prompted responses just use these like any agent would.

Each instructional exchange is its own bounded conversation, the same shape Phase 1 already uses: andy starts it, says what he needs, and ends it with `!endConversation` once he's said his piece — he does not leave a conversation open indefinitely waiting for a reply. `ConversationManager.receiveFromBot` already pauses andy's self-prompting for the duration of any active conversation (`src/agent/conversation.js:190-192`) and resumes it automatically ~5s after the conversation ends (`_resumeSelfPrompter`, `conversation.js:357-362`) — so andy naturally alternates between directing jill and pursuing his own vertices, with zero bespoke turn-taking logic. When jill later has something to report, she starts her own new conversation the same way any stock agent already can; that was always within her existing capability, nothing added for her.

`TeammateChannel` remains exactly as built for Phase 1, but Phase 3 doesn't use it — the blocking ask/resolve shape it provides isn't the right one for open-ended execution coordination, and it isn't needed once bounded per-exchange conversations (using stock commands directly) cover the same ground.

---

## 7. Ending the loop: completion, and getting stuck

- **Success** is handled entirely externally, per §1 — `checkTaskDone()`/`killAll()`, no leader judgment involved.
- **Getting stuck** is already detected by stock `self_prompter` on its own: three consecutive self-prompt cycles that don't produce a command stop the loop and announce it via chat (`self_prompter.js:63-77`, `MAX_NO_COMMAND = 3`). That's a real, code-observed signal — not a self-reported LLM declaration — and for a first prototype it's sufficient: andy stops, and the episode continues until the stock task timeout eventually closes it out. Automatically detecting that stop and re-triggering `generatePTD` for a fresh plan (reusing Phase 2's own pipeline, as the superseded design proposed) is a natural next step, not required for v1.

---

## 8. Changes to `coordinator_agent.js`

**`handleMessage` needs a phase gate.** Today it replaces stock behavior entirely (resolve a pending Phase 1 query, or discard everything else). Once Phase 3 begins, andy needs the *real* `Agent.handleMessage` — full conversational reasoning, command dispatch — not the Phase-1-only stub:

```js
async handleMessage(source, message, max_responses = null) {
  if (this.executionStarted) {
    return super.handleMessage(source, message, max_responses); // Phase 3: fully stock
  }
  if (source === 'system') return true;
  const cleaned = message.replace(/^\(FROM OTHER BOT\)/, '');
  if (this.teammateChannel?.tryResolve(source, cleaned)) return true;
  console.log(`[Disclosure Loop] ignoring unsolicited message from ${source}: ${cleaned.slice(0, 80)}`);
  return true;
}
```

`this.executionStarted` is set to `true` at the same point `self_prompter.start(goalText)` is called.

**`update()` needs to stop fully overriding the stock tick.** It should call `super.update(delta)` (restoring `bot.modes.update()`, `self_prompter.update(delta)`, and `checkTaskDone()`) and keep only the one-shot Phase 1→2→3 kickoff on top:

```js
async update(delta) {
  await super.update(delta);
  if (!this._loop_started) {
    this._loop_started = true;
    this.teammateChannel = new TeammateChannel();
    runDisclosureLoop(this, this.teammateChannel)
      .then(({ doc, runDir }) => {
        if (doc.status !== 'complete') return;
        return generatePTD(this, doc, runDir).then(graph => {
          if (!graph) return; // invalid/error — skip execution
          startExecutionPhase(this, graph, doc, runDir);
        });
      })
      .catch(err => console.error('[Disclosure Loop] crashed:', err));
  }
}
```

**No `self_prompter.stop()`/`pause()` call here, deliberately.** `Task.setAgentGoal()` (`src/agent/tasks/tasks.js:162-177`) already runs `!goal("...")` for every agent at spawn, including andy — that's stock, task-agnostic setup, not something colab_agent added. The `!goal` command (`src/agent/commands/actions.js:455-467`) either calls `self_prompter.start(prompt)` immediately, or — if the task's seeded initial conversation is still active at that moment (the common case, since `Task.initBotTask()` seeds that conversation *before* `setAgentGoal()` runs) — calls `setPromptPaused(prompt)` instead. Either way, by the time Phase 1 begins, `self_prompter.prompt` already holds `getAgentGoal()` + the collaboration sentence, which is exactly the text §5 wants to build on. No intervention is needed either way: `startExecutionPhase`'s `self_prompter.start(goalText)` unconditionally overwrites `.prompt` before attempting to (re)start the loop, so a paused prompter starts clean, and an already-running one (if `start()` fired at spawn instead) just picks up the new prompt and the flipped `executionStarted` gate on its next already-scheduled iteration.

This was tried the other way first — an explicit `self_prompter.stop()` at the top of Phase 1, reasoning that it would deterministically clear any spawn-time state — and it caused a real bug: `SelfPrompter.stop()` sets `interrupt = true` and then calls `stopLoop()` without awaiting it; `stopLoop()`'s own reentrancy guard (`if (this.interrupt) return`) fires immediately, because `stop()` just set that flag a line earlier, so `stopLoop()` returns before ever reaching its own `interrupt = false` reset. If the loop wasn't already actively running at that moment — true in the common `setPromptPaused` case above, since `startLoop()` was never even called — nothing else is left to ever reset `interrupt` back to `false`. It stays stuck at `true` permanently, so every later `self_prompter.start()` call's `while (!this.interrupt)` loop condition never executes even once. Andy would generate a valid PTD and then simply never act on it. Worth remembering if a future change is tempted to add a "just to be safe" `stop()`/`pause()` call anywhere near this: it's a real footgun in the stock `SelfPrompter`, not a hypothetical one.

---

## 9. Leader framing

Unchanged from the original plan: persistent goal text for jill via the AH-marked edit in `src/process/init_agent.js`, naming andy as leader — still worth doing regardless of how andy's own loop is implemented, motivated by the same repeated evidence of jill acting autonomously before receiving direction. One thing dropped: a separate "conversational reminder at Phase 3 start" is no longer its own step — andy's first conversation with jill, produced naturally from the leadership goal text, already serves that purpose.

---

## 10. Memory continuity

`startExecutionPhase` pushes one `{phase: 'phase_3', status: 'started', summary: ptd.summary}` entry to `memory.json` at the moment execution begins — reusing Phase 2's own `summary` again, no new summarization call. There's no matching "finished" entry: per §1/§7, nothing reliably runs after the episode's real end (`killAll()` cuts the process), so the actual outcome lives where it always has — the `Task ended with score : X` line `checkTaskDone()` already writes to `history` (`agent.js:550`).

---

## 11. Known risks

- **Jill's execution reliability is still fundamentally trust-based** — same category of risk as before, unchanged by this pivot.
- **Andy's own action completion is now trust-based too, matching jill's** — a deliberate simplification, not an oversight. Revisit only if testing shows it's a real problem.
- **`MAX_NO_COMMAND = 3` is a stock, un-tuned constant.** It might stop andy's self-prompting after fewer (or more) failures than actually indicates "stuck" for a multi-step Minecraft task — worth watching in early tests, not something to pre-tune blind.
- **`renderPTD`'s rendering is the one point where a bad translation can quietly corrupt the plan** (dropping a vertex, mis-describing eligibility) — there's no schema validation on it the way `ptd.json` itself has, since it's just a string by design. Narrower than it might sound: the objective statement itself is untouched, stock-computed text (§5), so a rendering bug can only garble the *plan*, not what the team is actually trying to achieve.
- **`min_agents > 1` and automatic replanning remain deferred**, per §2.

---

## 12. Build checklist

- [x] `colab_agent/src/pipeline/execution.js`: `renderPTD(graph, summary, selfName)` — plan-only rendering, no LLM call.
- [x] `coordinator_agent.js`: `update()` calls `super.update(delta)` and chains `startExecutionPhase` in after `generatePTD` resolves with a valid graph. No `self_prompter.stop()` call — see §8, it's a real footgun in the stock `SelfPrompter`, not just unnecessary.
- [x] `coordinator_agent.js`: `handleMessage()` phase gate (`this.executionStarted`) per §8.
- [x] `startExecutionPhase(agent, graph, summary, runDir)`: sets `executionStarted = true`, writes the `phase_3` memory entry (§10), composes `goalText` by appending `renderPTD(...)` to `agent.self_prompter.prompt` (falling back to `graph.objective` if empty) per §5, and calls `self_prompter.start(goalText)`.
- [x] Leader-framing goal-text append in `src/process/init_agent.js` (§9).
- [ ] **Re-run the compass baseline and a cooking stress test**, to confirm no regression to Phase 1/2 disclosure behavior and that Phase 3 actually engages (see `colab_agent/docs/11-test-commands.md`).
