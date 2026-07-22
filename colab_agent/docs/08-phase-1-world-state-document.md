# 08 — Phase 1 Implementation Plan: The Disclosure Loop

This is a **Phase 1 only** spec: exactly what's needed to run a rollout where agents load into the world with a real task, one of them builds a shared "world state document" by interviewing its teammate, and the process reaches a well-defined stopping point. It does **not** cover Phase 2 (plan/dependency-graph generation) or Phase 3 (execution) — those are separate, later docs.

## Concept

Before a group of collaborating agents starts working on a shared task, each one only knows its own slice of the situation — its own inventory, its own instructions, sometimes a recipe or constraint none of its teammates have. If agents start acting immediately on that partial view, they tend to duplicate effort, stall waiting on something a teammate already has, or fail outright because no single agent ever had the complete picture.

Phase 1 formalizes what a competent team already does before starting a real project: someone takes a moment to go around and ask who has what, before anyone lifts a hammer. We call this the **Disclosure Loop**. One agent is designated the coordinator. It interviews its teammate — one question at a time — reconsidering after each answer whether it now understands the team's combined resources and constraints well enough to stop, or whether it still needs to ask something else. It keeps going until it's satisfied (or a retry budget runs out). The output is a single artifact, the **world state document**, that later phases build a plan on top of.

Everything below this point is the engineering detail needed to actually build and run that loop in this codebase.

---

## 1. Definition of done

A successful Phase 1 rollout looks like this:

1. `node main.js` (with a new `colab_agent` flag) spawns two agent processes from the existing `colab_agent/profiles/{andy,jill}.json`.
2. `andy` (`count_id 0`) is the **coordinator** and runs the Disclosure Loop.
3. `jill` (`count_id 1`) is the **responder** — completely unmodified stock `Agent`. Nothing about her code path, goal, or process changes because `colab_agent` is on.
4. The coordinator opens a conversation with `jill`, asks a series of questions, and after each answer decides whether it has enough information — stopping when it does, or after a small retry cap.
5. The final document is written to disk along with a per-question trace, and the coordinator process idles cleanly (no autonomous action — Phase 3 doesn't exist yet).

**Target validation task:** `multiagent_crafting_compass_partial_plan_requires_ctable__depth_0` (`tasks/crafting_tasks/test_tasks/2_agent.json`), verified to exist with this exact structure:

```json
{
  "goal": "Collaborate with other agents to craft a compass",
  "conversation": "Let's work together to craft a compass.",
  "initial_inventory": { "0": {"iron_ingot": 2}, "1": {"iron_ingot": 2, "redstone": 1, "crafting_table": 1} },
  "agent_count": 2, "target": "compass", "type": "techtree",
  "blocked_actions": { "0": ["!getCraftingPlan"], "1": [] }
}
```

Good first target: agent 0 can't look up the recipe itself (`!getCraftingPlan` is blocked) and doesn't have enough iron alone — so a correct world state document requires it to actually notice gaps and ask, rather than trivially declaring itself done.

---

## 2. Non-goals (explicit deferrals)

- **No plan/dependency-graph generation** — Phase 2.
- **No task execution** — Phase 1 never crafts, gathers, or moves items.
- **No >2 agent support** — `ConversationManager`'s single-active-conversation constraint (see §6) makes N>2 sequential cycling real work; deferred. Nothing here is hard-coded to two agents, but only N=2 is validated now.
- **No custom messaging transport** — reuses the existing `ConversationManager` as-is, behind a small swappable wrapper (§6) so it can be replaced later without touching the loop itself.
- **No `blocked_actions` changes / phase-gating of the responder** — trusted to behave via the coordinator's own framing for this first rollout (§9 discusses the trade-off).
- **No changes to `task.isDone()` / scoring** — Phase 1 doesn't call `checkTaskDone()` at all; there is nothing to score yet.

---

## 3. Roles

| Agent | `count_id` | Code path | Behavior |
|---|---|---|---|
| Coordinator | 0 | New `ColabCoordinatorAgent extends Agent` | Runs the Disclosure Loop (§8-9); never acts autonomously in Phase 1. |
| Responder | 1..N-1 | Unmodified stock `Agent` — byte-identical to `colab_agent: false` | Answers whatever the coordinator asks, exactly as it would answer any other bot in a normal conversation today. |

The only thing that differs anywhere in the system because `colab_agent` is on is **which class gets instantiated for `count_id 0`**. Everything else — task loading, inventory grants, teleporting, the responder's entire code path — is the same stock machinery already used by the existing 2-agent demo (doc 07).

---

## 4. Repo layout (new files)

```
colab_agent/
├── docs/
│   ├── 08-phase-1-world-state-document.md    ← this file
│   └── prompts/disclosure_loop_prompts/
│       └── assessment_prompt.md              the assessment prompt template, editable directly
├── profiles/{andy,jill}.json                 ← REUSED, unchanged
├── rollouts/                                 ← NEW, gitignored output
│   └── <task_id>/<run_id>/
│       ├── world_state.json                  final document
│       ├── iterations.jsonl                  per-question trace
│       └── memory.json                       narrative memory, separate from world_state.json (§9)
└── src/
    ├── agent/
    │   └── coordinator_agent.js              ColabCoordinatorAgent — the only agent-side file
    ├── comms/
    │   └── teammate_channel.js                askTeammate() — the swappable query abstraction
    └── pipeline/
        ├── world_state.js                     the Disclosure Loop: schema, loop, termination
        └── prompt_utils.js                     loads/fills assessment_prompt.md
```

Seven new files total. `colab_agent/src/pipeline/world_state.js` imports `LlmClient` from `achievement_hunter/src/pipeline/llm_client.js` and `get_sgsg_state` from `achievement_hunter/src/pipeline/agent_state.js` directly (not copied) — generic, agent-agnostic utilities that would just drift if duplicated. This is the one intentional cross-directory dependency colab_agent takes on.

**Prompt templates live as `.md` files under `docs/prompts/`, not inline template literals** — mirroring `achievement_hunter/docs/prompts/`'s convention exactly: `{{KEY}}` placeholders filled by a small `prompt_utils.js` (`_read_template`/`_fill`, same shape as AH's, duplicated rather than imported since AH doesn't export those two helpers). Editing the actual wording of the assessment prompt is now a plain-text edit to `assessment_prompt.md`, not a code change to `world_state.js`.

---

## 5. Wiring — one flag, one small edit, nothing else

An earlier version of this plan spawned coordinator and responder processes through a whole parallel factory (mirroring `achievement_hunter`'s `create_achievement_agent.js`/`achievement_agent_process.js`/`init_achievement_agent.js` trio). That's unnecessary here: the responder is *already* meant to be completely stock, so there's no need for AH's level of separation — a separate init script exists there because AH diverges almost completely from stock behavior. All we actually need is a way to pick a different class for `count_id 0`.

**`settings.js`** (AH-marked, one new flag):
```js
// Start of AH code
'colab_agent':
    false,  // when true, count_id 0 runs the Disclosure Loop (Phase 1); every
            // other agent is the exact stock path, untouched
// End of AH code
```

**`src/process/init_agent.js`** (AH-marked, the only other edit needed) — this is the script every agent process runs, spawned by the *existing, unmodified* `AgentProcess`/`Mindcraft.createAgent`. By the time `new Agent()` is called, `serverProxy.connect()` has already populated `settings` for this process (confirmed: it fetches settings via a `get-settings` round trip before this point), so the flag is available:

```js
import { Agent } from '../agent/agent.js';
import { serverProxy } from '../agent/mindserver_proxy.js';
import yargs from 'yargs';
// Start of AH code
import settings from '../agent/settings.js';
import { ColabCoordinatorAgent } from '../../colab_agent/src/agent/coordinator_agent.js';
// End of AH code
...
await serverProxy.connect(argv.name, argv.port);
console.log('Starting agent');
// Start of AH code
const isColabCoordinator = settings.colab_agent && argv.count_id === 0;
if (settings.colab_agent) {
    console.log(`[Disclosure Loop] colab_agent mode: count_id ${argv.count_id} is ` +
        `${isColabCoordinator ? 'the coordinator (ColabCoordinatorAgent)' : 'a responder (stock Agent)'}`);
}
const agent = isColabCoordinator
    ? new ColabCoordinatorAgent()
    : new Agent();
// End of AH code
serverProxy.setAgent(agent);
await agent.start(argv.load_memory, argv.init_message, argv.count_id);
```

The log line fires for every process when `colab_agent` is on, so a glance at the terminal confirms the wiring worked correctly before anything else happens — if it's missing, `colab_agent`/`achievement_hunter` aren't set the way you think they are (see §11's note about the two flags).

**`main.js` needs no changes at all.** It already calls `Mindcraft.createAgent(settings)` unconditionally whenever `settings.achievement_hunter` is false, for every profile — that path is untouched, so `colab_agent` mode uses the exact same spawn loop as the stock multi-agent demo in doc 07.

This also means there is no per-agent goal injection, no settings cloning, and no parallel counter to keep in sync with anything — the "wait for the coordinator" framing is delivered a different way, covered in §7.

---

## 6. `teammate_channel.js` — the swappable query abstraction

Everything above this module only ever calls `askTeammate(name, question)` — never touches `ConversationManager` directly — so swapping the transport later means rewriting this one file.

```js
// colab_agent/src/comms/teammate_channel.js
import convoManager from '../../../src/agent/conversation.js';

const QUERY_TIMEOUT_MS = 45000;

export class TeammateChannel {
  constructor() {
    this._pending = new Map(); // partnerName -> { resolve, reject, timer }
  }

  // Called from ColabCoordinatorAgent.handleMessage. Returns true if the
  // message was consumed as the answer to an outstanding query.
  tryResolve(sender, message) {
    const pending = this._pending.get(sender);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this._pending.delete(sender);
    console.log(`[Disclosure Loop] <- ${sender}: ${message}`);
    pending.resolve(message);
    return true;
  }

  async askTeammate(name, question) {
    if (this._pending.has(name)) {
      throw new Error(`Already awaiting a reply from ${name}`);
    }
    console.log(`[Disclosure Loop] -> ${name}: ${question}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(name);
        console.warn(`[Disclosure Loop] no reply from ${name} within ${QUERY_TIMEOUT_MS}ms`);
        reject(new Error(`No reply from ${name} within ${QUERY_TIMEOUT_MS}ms`));
      }, QUERY_TIMEOUT_MS);
      this._pending.set(name, { resolve, reject, timer });

      if (convoManager.inConversation(name)) {
        convoManager.sendToBot(name, question);
      } else {
        convoManager.startConversation(name, question);
      }
    });
  }

  // The real !endConversation command handler only clears local state — it
  // never notifies the other side (src/agent/commands/actions.js:514-526).
  // The "other side" mechanism is that sendToBot flags a message end:true
  // whenever its text contains the substring "!endConversation", which the
  // receiver's _handleFullInMessage acts on. So closing cleanly on both ends
  // requires both steps. Order matters: endConversation() sets
  // ignore_until_start, and sendToBot drops the message if that's already
  // set — the farewell must go out first.
  endConversation(name, farewellMessage) {
    if (!convoManager.inConversation(name)) return;
    convoManager.sendToBot(name, `${farewellMessage} !endConversation("${name}")`);
    convoManager.endConversation(name);
  }
}
```

Two behaviors of the underlying `ConversationManager` this relies on, verified against current source (`src/agent/conversation.js`):
- `startConversation` is a no-op if a conversation with that partner is already active — safe to call defensively rather than tracking conversation state ourselves.
- Incoming replies are tagged `"(FROM OTHER BOT)" + message` before reaching `handleMessage` — the coordinator strips this prefix (§8) before treating text as an answer.

This class is also the single chokepoint every question and answer passes through, so it's where the `[Disclosure Loop] ->`/`<-` console lines live — see §9's Observability subsection for the full rationale. Since `ConversationManager.sendToBot`'s default `open_chat=true` echoes most (but not the very first, intro-bearing) message to in-game chat / the MindServer UI too, most of the exchange is visible there as a bonus, but the terminal log via this class is the one channel guaranteed to show everything.

**Known, accepted edge case:** the task's own conversation seed (`data.conversation`, fired automatically by `initBotTask()` for `count_id 0` before the Disclosure Loop starts — see §8's timing note) opens the conversation and sends its canned message first. If the responder replies to *that* before the loop has asked its first real question, `tryResolve` finds nothing pending and the reply is discarded. Fine for the compass task, whose seed text is generic framing rather than a real question — documented here so it's a deliberate choice, not a silent gap.

---

## 7. Responder behavior — genuinely zero changes

The responder is not modified, configured, or specially prompted in any way. It is the identical stock `Agent`, running the identical task-derived goal, that the existing 2-agent demo already uses. The "please answer honestly and hold off acting" framing isn't injected anywhere upstream — it's simply the wording of the coordinator's first question (§9), delivered the normal way any bot delivers a message to another bot.

This is a deliberate simplification over an earlier version of this plan, which pre-loaded a "wait for the coordinator" instruction into the responder's persistent goal text before it even spawned. That's no longer necessary: the coordinator is *already* about to start a conversation as its very first action, so the same information just becomes the opening line of that conversation instead of a separate injection mechanism. The trade-off is durability — a goal set via `!goal(...)` keeps re-asserting itself through the self-prompter loop; a chat message doesn't. For Phase 1's handful of short exchanges that's an acceptable trade (and each agent only holds its own inventory slice, so the blast radius of a stray action is small); it's worth revisiting once Phase 3 needs "don't act yet" to hold up over a longer stretch.

---

## 8. `ColabCoordinatorAgent` — the one subclass

```js
// colab_agent/src/agent/coordinator_agent.js
import { Agent } from '../../../src/agent/agent.js';
import { TeammateChannel } from '../comms/teammate_channel.js';
import { runDisclosureLoop } from '../pipeline/world_state.js';

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
```

That's the entire subclass — two overrides, no others needed. Two choices worth flagging:

**Why `update()`, not `_setupEventHandlers()`, kicks off the loop.** Base `Agent.start()` calls `this._setupEventHandlers(...)` *without awaiting it*, then immediately (still synchronously) calls `this.task.initBotTask()` and `this.task.setAgentGoal()` (`agent.js:127-134`). Since `_setupEventHandlers` is itself `async`, anything placed inside it can end up racing those two calls rather than running strictly after them. That matters here because `initBotTask()` is what seeds the opening conversation and grants inventory for `count_id 0` — we need that to have actually dispatched before the loop starts touching the same `ConversationManager` singleton. `update()` is driven by a timer that can't fire until the current synchronous call stack has fully unwound, so by the first tick, `initBotTask()`/`setAgentGoal()` are guaranteed to have already been dispatched in order. Concretely: by the time the loop makes its first `askTeammate` call, the seeded conversation is already active, so `TeammateChannel` correctly detects it and just sends, rather than double-opening.

**Why `handleMessage` never calls `super.handleMessage()`.** The coordinator's replies aren't generated by the stock persona-driven prompter at all — its only job in Phase 1 is routing query answers back into the loop. Falling through to stock behavior for anything else would trigger the full reactive LLM-reply flow, including possible command execution, which has no place in a structured planning phase. So the override is a full replacement rather than a delegation.

The coordinator still needs a normal Mindcraft profile (`colab_agent/profiles/andy.json`, unchanged) purely for `name`/`skin`/`modes`, since base `Agent.start()` unconditionally constructs `this.prompter = new Prompter(this, settings.profile)` and derives `this.name` from it — even though the coordinator's actual reasoning bypasses `promptConvo` entirely.

---

## 9. `world_state.js` — the Disclosure Loop itself

### Document schema

Kept to exactly what's needed and no more: facts the coordinator can observe directly about itself, plus a running transcript of what it's learned from its teammate.

```json
{
  "task_id": "multiagent_crafting_compass_partial_plan_requires_ctable__depth_0",
  "shared_goal": "Collaborate with other agents to craft a compass",
  "self": {
    "name": "andy",
    "inventory": {"iron_ingot": 2},
    "blocked_actions": ["!getCraftingPlan"]
  },
  "teammates": {
    "jill": {
      "qna": [
        {"question": "What items do you currently have?", "answer": "I have 2 iron ingots, 1 redstone, and a crafting table."}
      ]
    }
  },
  "status": "complete"
}
```

`self.inventory`/`self.blocked_actions` come directly from `get_sgsg_state(agent)` (reused as-is from `achievement_hunter/src/pipeline/agent_state.js`) — read straight off the bot, never LLM-authored, since there's no reason to ask a model to report what code can read directly. `teammates.<name>.qna` is a plain, append-only transcript maintained by code, not something the LLM redrafts.

### Division of labor: code maintains the record, the LLM only decides what's next

An earlier version of this plan had the LLM regenerate the *entire* document every iteration (mirroring `achievement_hunter`'s `self_refine.js` "redraft, then judge" pattern). That's more machinery than this needs, and it risks the model quietly rewriting ground-truth fields (like `self.inventory`) it should never touch. Since everything in the document is either directly observed or a verbatim transcript, code alone can maintain it. That leaves the LLM with exactly one narrow decision per iteration: **given what's recorded so far, am I done — and if not, what's the next question and who is it for?**

```js
// colab_agent/src/pipeline/world_state.js (as implemented)
const FALLBACK_MODEL = 'gpt-4o-mini'; // used only if the coordinator's own profile omits "model"
const MAX_ITERATIONS = 5;
const INTRO = "Hi, I'm coordinating this task. Before anyone starts, I'm gathering " +
    "what everyone has and needs. Please hold off on taking any actions until I " +
    "share the plan. ";

export async function runDisclosureLoop(agent, teammateChannel) {
  const llm = new LlmClient(agent.prompter.profile.model || FALLBACK_MODEL);
  const runDir = makeRunDir(agent.task.data.task_id);
  console.log(`[Disclosure Loop] starting for ${agent.name}, logging to ${runDir}`);

  const teammates = await waitForTeammates(agent);
  console.log(`[Disclosure Loop] teammates found: ${teammates.join(', ')}`);

  await waitForInventory(agent);
  const doc = seedDocument(agent);
  writeDocument(runDir, doc);

  let lastSummary = null;
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const round = { iteration };
    let decision;
    try {
      const raw = await llm.send_prompt(fill_assessment_prompt(doc, teammates));
      decision = parseDecision(raw, teammates);
      round.status = decision.status;
      round.summary = decision.summary;
      lastSummary = decision.summary;
    } catch (err) {
      console.error(`[Disclosure Loop] iteration ${iteration} assessment failed:`, err.message);
      round.error = err.message;
      appendRound(runDir, round);
      doc.status = 'error';
      break;
    }

    if (decision.status === 'complete') {
      console.log(`[Disclosure Loop] iteration ${iteration}: adequate, stopping`);
      appendRound(runDir, round);
      doc.status = 'complete';
      break;
    }

    const { target_agent, question } = decision.next_query;
    const questionText = iteration === 1 ? INTRO + question : question;
    round.target_agent = target_agent;
    round.question_sent = questionText;
    console.log(`[Disclosure Loop] iteration ${iteration}: asking ${target_agent}`);

    doc.teammates[target_agent] ??= { qna: [] };
    try {
      const answer = await teammateChannel.askTeammate(target_agent, questionText);
      round.answer = answer;
      doc.teammates[target_agent].qna.push({ question, answer });
    } catch (err) {
      console.warn(`[Disclosure Loop] query to ${target_agent} failed:`, err.message);
      round.error = err.message;
      doc.teammates[target_agent].qna.push({ question, answer: null, error: err.message });
    }

    appendRound(runDir, round);
    writeDocument(runDir, doc); // incremental save so a crash mid-loop doesn't lose progress
  }

  doc.status = doc.status ?? 'incomplete';
  for (const name of Object.keys(doc.teammates)) {
    teammateChannel.endConversation(name, "Thanks, that's everything I need for now — standing by.");
  }
  writeDocument(runDir, doc);

  agent.memoryLog = agent.memoryLog || [];
  const memoryEntry = {
    phase: 'phase_1',
    status: doc.status,
    summary: lastSummary ?? `Phase 1 ended in ${doc.status} before any assessment completed.`,
  };
  agent.memoryLog.push(memoryEntry);
  writeFileSync(path.join(runDir, 'memory.json'), JSON.stringify(agent.memoryLog, null, 2));
  console.log(`[Disclosure Loop] memory recorded: ${memoryEntry.summary}`);

  const totalQuestions = Object.values(doc.teammates).reduce((n, t) => n + t.qna.length, 0);
  console.log(`[Disclosure Loop] finished (${doc.status}) after ${totalQuestions} question(s). ` +
      `Document at ${path.join(runDir, 'world_state.json')}`);
  return doc;
}

// task.agent_names (referenced by the stock agent.js:227 players-present check)
// is never actually populated anywhere in this codebase — a latent no-op we
// discovered while implementing this. So teammate discovery instead polls the
// presence roster ConversationManager already maintains for its own routing.
async function waitForTeammates(agent, timeoutMs = TEAMMATE_WAIT_TIMEOUT_MS) {
  const expected = (agent.task.data.agent_count || 2) - 1;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = convoManager.getInGameAgents().filter(name => name !== agent.name);
    if (found.length >= expected) return found;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for teammates (expected ${expected})`);
}

// /give is fire-and-forget — there's no confirmation that the server has
// processed it and mineflayer's bot.inventory reflects it. Waits for the
// specific quantities initial_inventory promised (not a generic "non-empty"
// check, which would hang forever for an agent whose slice is legitimately
// empty); returns immediately when nothing was promised.
async function waitForInventory(agent, timeoutMs = INVENTORY_WAIT_TIMEOUT_MS) {
  const expected = agent.task.data.initial_inventory?.[String(agent.count_id)] || {};
  const expectedEntries = Object.entries(expected);
  if (expectedEntries.length === 0) return;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const inventory = get_sgsg_state(agent).inventory;
    const counts = inventory === 'Nothing' ? {} : inventory;
    if (expectedEntries.every(([item, count]) => (counts[item] || 0) >= count)) {
      console.log('[Disclosure Loop] initial inventory confirmed');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  console.warn(`[Disclosure Loop] initial_inventory grant not confirmed within ${timeoutMs}ms; seeding self-state anyway`);
}

function seedDocument(agent) {
  const goal = agent.task.data.goal;
  return {
    task_id: agent.task.data.task_id,
    shared_goal: typeof goal === 'string' ? goal : goal['0'],
    self: { name: agent.name, ...get_sgsg_state(agent), blocked_actions: agent.task.blocked_actions },
    teammates: {},
    status: null,
  };
}
```

The `INTRO` prepend on the first question only is deliberate: it's the one piece of framing that actually matters for responder behavior (§7), so it's guaranteed verbatim by code rather than left to the model to remember to phrase correctly every time.

(`parseDecision`/`makeRunDir`/`appendRound`/`writeDocument` are straightforward and omitted here — see the actual file. `fill_assessment_prompt` lives in `prompt_utils.js` and loads `docs/prompts/disclosure_loop_prompts/assessment_prompt.md` — see §4. The prompt asks for `{status: "complete", summary}` or `{status: "need_info", summary, next_query: {target_agent, question}}` as JSON, instructed to ask about only genuinely missing information.)

### Narrative memory — separate from the document, on purpose

`world_state.json`/`self`/`teammates.qna` are precise structured facts — the whole point of §9's "division of labor" is that nothing in there gets rewritten or summarized by the LLM. But that leaves no room for something genuinely useful across phases: a short narrative of *what the coordinator concluded and why*, for Phase 2/3 (once built) to orient against without re-parsing the full structured document. That's a different concern, so it gets a different artifact.

`assessment_prompt.md`'s schema requires a `summary` field on **every** response, not only on `"complete"` — one or two sentences of the model's current understanding, distinct from a restatement of the raw data it was just given. The loop tracks `lastSummary` across iterations and, whichever iteration turns out to be the last one (`complete`, or `MAX_ITERATIONS` exhausted while still `need_info`), that's what gets recorded — no separate handling needed per exit path. Only a genuine `error` (the assessment call itself never parsed) has no summary to use, and gets a one-line deterministic note instead.

This is the same trick `achievement_hunter`'s `failure_replanner.js` already uses for its own `previous_diagnoses` list: the `diagnosis` field there isn't produced by a dedicated "please summarize" call — it's just part of the structured output a call is already producing for its primary purpose (deciding what to try next). Applying that here means **zero new LLM calls** for memory. The entry (`{phase: 'phase_1', status, summary}`) is pushed onto `agent.memoryLog` — an array living on the coordinator instance, so it's readable in-process by whatever Phase 2 code eventually runs there — and persisted to `memory.json` in the same run directory, genuinely separate from `world_state.json`/`iterations.jsonl` on disk, not just a differently-named field inside them.

One gap knowingly left open: `agent.memoryLog` only survives in-process. If the coordinator's process crash-restarts (`AgentProcess`'s restart path spins up a brand-new instance), the in-memory array is gone, though `memory.json` on disk isn't — a future phase that needs restart-resilience would reload it from disk on startup, mirroring `achievement_hunter/src/pipeline/checkpoint.js`'s already-proven pattern for exactly this problem. Not built now since nothing consumes it yet.

### Observability

Two gaps surfaced only once this was actually implemented, both fixed before considering it done:

1. **Nothing was logged to the console during the loop, only to the trace file** — meaning watching the terminal live (the whole point of doc 07's setup) would show nothing between "starting" and "finished" unless something crashed. Fixed by having `TeammateChannel` itself log every `->`/`<-` message (§6) and `runDisclosureLoop` log teammate discovery and each iteration's decision — so the terminal now shows the entire negotiation as it happens, not just the outcome.
2. **The document was only written once, at the very end** — a crash mid-loop would lose every answer gathered so far, leaving nothing to inspect. Fixed by writing `world_state.json` after every iteration (`writeDocument(runDir, doc)` inside the loop, not just after it), and by logging each full round (decision + the actual question sent, with the `INTRO` prepend included + the answer or error) to `iterations.jsonl`, not just the bare status/next_query as originally sketched.

### First live rollout — findings

The observability work above paid off immediately: the first real run against the compass task (host client + gpt-4o-mini) completed with `status: "complete"` after exactly one question, and reading `iterations.jsonl` back showed jill's real inventory (`iron_ingot`, `redstone`, `crafting_table`) had actually been captured — the core loop worked as designed. But the persisted `world_state.json` also showed `"self": {"inventory": "Nothing"}` for andy, despite the log confirming `Gave andy 2 iron_ingot` had fired. Root cause: `/give` is a fire-and-forget chat command (`initBotTask()` does `await this.agent.bot.chat(...)`, but `bot.chat()` doesn't return a promise that resolves on server confirmation) — `seedDocument()` was reading `get_sgsg_state(agent)` before the grant's server round trip had landed in `bot.inventory`. Fixed with `waitForInventory()` (above): polls for the *specific* quantities `initial_inventory[count_id]` promised, rather than a generic delay or a "non-empty" check (which would hang for any agent whose slice is legitimately empty) — same structural pattern as `waitForTeammates`, applied to the second place the same class of async-effects-aren't-confirmed problem showed up.

A second issue from the same run: the coordinator never explicitly ended the conversation after capturing an answer, which left jill's side thinking she was still awaiting a reply — the stock 30s/60s "hasn't responded" monitor fired and drove her self-prompter to act on its own (checking `!entities`, then asking the human player for help). Root cause traced to `src/agent/commands/actions.js:514-526`: the real `!endConversation` command only clears local state and never notifies the other side — the actual "tell the other party" mechanism is that `sendToBot` flags a message `end: true` whenever its text contains the substring `!endConversation`, which the receiver's `_handleFullInMessage` acts on. Fixed with `TeammateChannel.endConversation()` (§6), called once per teammate at the end of `runDisclosureLoop` (§9) regardless of outcome — sends a farewell containing that substring, then clears local state (in that order, since clearing first would cause the farewell to be silently dropped).

An alternative was considered and rejected: having the *responder* end the conversation herself (e.g. instructed to say `!endConversation` once she's answered). Two problems ruled it out. First, she has no visibility into whether the coordinator wants a follow-up, so she can't know the actual right moment to end it — that decision belongs to whoever runs the adequacy check. Second, and more concretely: if her reply bundles the answer and `!endConversation` in one message (a likely combination), `_handleFullInMessage` rewrites the message's `source` to `'system'` before it reaches `ColabCoordinatorAgent.handleMessage`, whose first line (`if (source === 'system') return true;`) discards it — silently losing the answer entirely, a strictly worse failure than the one being fixed.

Net effect: `init_agent.js` logs which class it picked for each `count_id` at startup (§5), `TeammateChannel` logs every message in real time, and `world_state.json`/`iterations.jsonl` are both readable at any point during the run, not just after it finishes successfully.

A second live run (with the Bug 1/Bug 2 fixes above applied) surfaced a third gap, this time in the assessment prompt itself: `world_state.json` recorded jill's inventory but nothing about her `blocked_actions` or whether her goal differed from andy's — the loop declared `"complete"` after asking only about inventory. The schema wasn't at fault (`teammates.<name>.qna` is a plain transcript; nothing stops a `blocked_actions` question from landing there same as inventory did) — the assessment prompt's own bar for "done" was too vague ("your team's combined inventory and constraints") to reliably make gpt-4o-mini think to ask about the other two canonical categories doc 02/06 already established (inventory, blocked actions, goal asymmetry). The tempting wrong fix — read jill's `blocked_actions`/goal directly off the shared task JSON, which every process technically has loaded — was explicitly rejected: that's exactly the "shared blackboard" doc 05 warned against, and would make the Disclosure Loop's reason for existing (having to *ask*) meaningless. Fixed instead by adding a short "Context" paragraph to `assessment_prompt.md` naming all three categories explicitly and reframing the completion bar around them ("a complete picture of your team's inventories, blocked actions, and goals") — a pure prompt-wording change, no schema or code changes. Verified against the real model in three scenarios: fresh start (now asks about inventory *and* blocked actions in one question), inventory-only-known (the exact point the original run stopped early — now correctly identifies the gap and asks about blocked actions), and all-three-covered (correctly reports `"complete"` rather than looping unnecessarily).

### Termination

- **Adequate:** the LLM's own assessment returns `status: "complete"`.
- **Runaway guard:** `MAX_ITERATIONS = 5` — generous for a task that realistically needs 2-3 exchanges, small enough to fail loudly rather than loop indefinitely. On exhaustion, the document is written with `status: "incomplete"` rather than looping forever.
- **After completion:** write the file, log it, and stop. No `killAll()`, no `task.isDone()` — Phase 1 isn't scored and Phase 2/3 don't exist yet. This is a placeholder ending to revisit once Phase 2 exists.

**The coordinator's model is chosen via its own Mindcraft profile** (`colab_agent/profiles/andy.json`'s `"model"` field), not a separate `colab_agent/src/profile.json`-style config. This wasn't the original plan — `DEFAULT_MODEL` was initially a hardcoded constant, on the reasoning that a dedicated config file would be pure ceremony for one model choice. But the coordinator already has a per-agent profile file, and it already has a `"model"` field (it's simply not read by the coordinator's own reasoning, since that bypasses the stock `Prompter` entirely) — so reusing it costs nothing new and gets the actual thing wanted for free: editing `andy.json`'s `"model"` to something more capable (e.g. `gpt-5`) now controls only the coordinator's reasoning, completely independent of `jill.json`'s `"model"`, which already independently controlled her stock reactive path. `FALLBACK_MODEL` only matters if a profile ever omits `"model"` entirely.

---

## 10. Known risks

- **Responder restraint is a single framing sentence, not a persistent instruction.** Nothing stops the responder's self-prompter from acting instead of waiting once the conversation moves on — a known general risk with self-prompt loops, and slightly more exposed than before now that the framing isn't reinforced by persistent goal text (§7's trade-off). Blast radius stays low (each agent only has its own inventory slice); watch for this in the first rollout and fall back to `blocked_actions` if it's actually disruptive.
- **LLM self-assessment could falsely declare "complete."** No adversarial check on completeness in v1 — Phase 2's plan generation will surface real gaps concretely if they exist.
- **Single-active-conversation ceiling.** Confirmed in `ConversationManager.receiveFromBot` — a message from any partner other than the current active one is auto-rejected. Fine at N=2; blocks scaling without more work.
- **Query timeout (45s) is a guess**, cheap to tune once real model latency is observed.

---

## 11. Build checklist

- [ ] `settings.js`: add `colab_agent: false` flag (AH-marked).
- [ ] `src/process/init_agent.js`: add the flag-guarded class selection + import (AH-marked). No other stock file changes — `main.js` is untouched.
- [ ] `colab_agent/src/agent/coordinator_agent.js`: `ColabCoordinatorAgent`.
- [ ] `colab_agent/src/comms/teammate_channel.js`: `TeammateChannel`.
- [ ] `colab_agent/src/pipeline/world_state.js`: `runDisclosureLoop` + schema.
- [ ] `colab_agent/src/pipeline/prompt_utils.js` + `colab_agent/docs/prompts/disclosure_loop_prompts/assessment_prompt.md`: the assessment prompt template + loader.
- [ ] `colab_agent/rollouts/` created (gitignored).
- [ ] Run against `multiagent_crafting_compass_partial_plan_requires_ctable__depth_0` per doc 07's launch pattern, with the new flag. Note `achievement_hunter` still defaults to `true` in `settings.js` and `main.js`'s branch checks it first (untouched, per §5) — `colab_agent:true` alone does nothing unless `achievement_hunter:false` is also set:
  ```bash
  SETTINGS_JSON='{"host":"127.0.0.1","achievement_hunter":false,"colab_agent":true}' \
  PROFILES='["./colab_agent/profiles/andy.json","./colab_agent/profiles/jill.json"]' \
  node main.js \
    --task_path tasks/crafting_tasks/test_tasks/2_agent.json \
    --task_id multiagent_crafting_compass_partial_plan_requires_ctable__depth_0
  ```
- [ ] Inspect `colab_agent/rollouts/.../world_state.json` and `iterations.jsonl` to confirm the document actually captured jill's inventory/constraints, not just the shared goal text.
- [ ] Inspect `colab_agent/rollouts/.../memory.json` to confirm it holds a genuine narrative summary (not a restatement of `world_state.json`'s raw fields), separate from the structured document.
