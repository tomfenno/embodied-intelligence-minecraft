# 05 — Interface Points for a New Collaborative Agent

This answers: **what functions/classes/config a new agent must use, what `tasks/` assumes about agent behavior, what inputs it must consume, what outputs it must produce, and where to hook in.**

---

## 1. The contract `tasks/` assumes about any agent

The task system is mostly *agnostic* to how an agent thinks, but it assumes the following lifecycle is honored. These are the load-bearing assumptions:

| Assumption | Where enforced | What a new agent must do |
|---|---|---|
| Each agent process has a stable `count_id` (0..N-1) by profile order | `mindcraft.js:40-41`; `Agent.start(count_id)` `agent.js:28` | Accept `count_id` and use it to index task data |
| A `Task` is constructed from `settings.task` and owns scoring | `agent.js:65`; `tasks.js:13` | Construct/own a `Task` (or reuse it) so `isDone()` can score |
| Inventory is granted, bots teleported, conversation seeded at spawn | `Task.initBotTask()` `tasks.js:179-286` | Either call `initBotTask()` or replicate `/give`+`/tp`+seed |
| The episode ends when `task.isDone()` returns truthy, recorded as `Task ended with score : N` | `agent.checkTaskDone()` `agent.js:546-559` | Poll `task.isDone()` and emit the score message, then `killAll()` |
| All required agents must be present or the task aborts (score 0) | `checkAllPlayersPresent` `agent.js:226-236`; `tasks.js:145-150` | Make sure all profiles connect within the grace window |
| Agents register/login to the MindServer for presence + messaging | `mindserver_proxy.js`; `mindserver.js:110-148` | Connect the socket proxy before/while running |
| Multi-agent coordination happens over the socket relay, not chat | doc 03 | Use the `chat-message` relay for inter-agent comms |

**Inputs a new agent must consume:**
1. `settings.task` (the task JSON object) and `settings.task.task_id`.
2. `count_id` → its slice of `initial_inventory` / `goal` / `blocked_actions`.
3. Live bot world-state (inventory, position, nearby blocks/entities) via Mineflayer/`agent_state.js`.
4. Inbound socket messages from teammates (`convoManager.receiveFromBot` → `handleMessage`).

**Outputs a new agent must produce:**
1. In-world actions via the command/skill layer (`executeCommand`, `src/agent/commands/index.js`) or Mineflayer directly.
2. Inter-agent messages via the socket relay (`routeResponse`/`sendToBot` or raw `chat-message`).
3. The terminal `Task ended with score : N` history entry (so the Python analyzer and `memory.json` snapshot capture the result).

---

## 2. The key functions/classes/config a new agent will touch

### Entry & process
- `main.js:67-77` — the spawn loop. Add a new branch (e.g. `if (settings.colab_agent) create_colab_agent(settings)`), mirroring the AH branch. Or reuse `settings.achievement_hunter`-style flag in `settings.js`.
- `create_achievement_agent.js` + `achievement_agent_process.js` + `init_achievement_agent.js` — **copy these three as the template** for a new `colab_agent/src/agent/` trio (process supervision + child entry).

### Agent core
- `src/agent/agent.js` — base `Agent`: `start()`, `_setupEventHandlers()`, `update()`, `checkTaskDone()`, `handleMessage()`, `routeResponse()`, `openChat()`, `killAll()`. Subclass this (as AH does) to reuse bot login, Task wiring, and messaging while overriding the decision loop.
- `src/agent/tasks/tasks.js` — `Task`: `initBotTask()`, `setAgentGoal()`, `getAgentGoal()`, `isDone()`, `updateAvailableAgents()`. **Do not bypass** `isDone()`/scoring — it is the benchmark's source of truth.

### Communication
- `src/agent/conversation.js` — `ConversationManager` (`startConversation`, `endConversation`, `sendToBot`, `receiveFromBot`). Reuse for turn-taking + coalescing, *or* listen to the raw `chat-message` socket event for a custom protocol.
- `src/agent/mindserver_proxy.js` — `sendBotChatToServer`, the socket handlers, `getNumOtherAgents`, `updateAgents`.

### Prompting & state
- `src/models/prompter.js` — `replaceStrings`, `promptConvo`. Reuse if you want the stock template-variable system; or build your own (AH builds its own JSON prompts).
- `achievement_hunter/src/pipeline/agent_state.js` — world-state extractors (recommended for grounding).
- `achievement_hunter/src/pipeline/llm_client.js` — OpenAI Responses-API client (note: OpenAI-only today; doc 04).

### Config / profiles
- `profiles/tasks/{crafting,cooking,construction}_profile.json` — the per-task-type templates and example banks; `--template_profile` selects one.
- `achievement_hunter/src/profile.json` — the AH per-stage model config; a colab agent would have its own analog.
- `settings.js` — the flag (`achievement_hunter`), default profile, ports, `max_messages`, `num_examples`.

---

## 3. Recommended hook-in strategy

**Mirror the AH pattern, but keep (rather than silence) the collaboration paths.**

1. **Add a `settings.colab_agent` flag** + a `main.js` branch calling a new `create_colab_agent(settings)`. Keep everything else in `main.js` untouched (it already loads the task and spawns per profile).
2. **Subclass `Agent`** in `achievement_hunter/colab_agent/src/agent/`, copying the AH process/init trio. Override `update()`/`handleMessage()` with your loop — but **do not** call `_silence_chat_listeners()`; you want inter-agent messages.
3. **Reuse the `Task` lifecycle as-is** for non-benchmark, collaborative task types (`techtree`, `cooking`, `construction`): let `initBotTask()` grant inventory/teleport/seed-conversation and let `isDone()` score. The collaboration goal injection in `setAgentGoal()` (`tasks.js:166-176`) already names teammates — keep it, since `isBenchmarkTaskType` is false for these types so the AH early-return at `tasks.js:163` won't fire.
4. **Build the coordination layer on top of the socket relay** (doc 03): receive teammate messages via `convoManager`/`handleMessage`, decide actions with your loop, send via `routeResponse`/`sendToBot`. Privileged-info exchange (recipes in Hell's Kitchen, inventory sharing) is *application logic in your loop*, not infrastructure.
5. **Reuse AH planning utilities** where single-agent reasoning applies: `agent_state.js`, `scsg.js`, `command_verifier.js`/`command_utils.js`, `rollout_logger.js`, `checkpoint.js`. The **new** work is the multi-agent layer: teammate state modeling, task division, message protocol, and when to ask vs. act.
6. **Emit `Task ended with score : N`** through `checkTaskDone()` so results land in `memory.json` and the Python analyzer (`evaluation_script.py:42`).

> **Per the repo CLAUDE.md:** all new code lives under `achievement_hunter/colab_agent/`; any edit *outside* that dir (e.g. the `main.js` branch, a `settings.js` flag, a `tasks.js` hook) must be wrapped in `// Start of AH code` / `// End of AH code` markers and checked against `patches/` first.

---

## 4. Concrete starting checklist

- [ ] `settings.js`: add `colab_agent` flag + default profile path (AH-marked edit).
- [ ] `main.js`: add `if (settings.colab_agent) create_colab_agent(settings)` branch (AH-marked edit).
- [ ] `achievement_hunter/colab_agent/src/agent/{create,process,init}.js`: copy/adapt AH trio.
- [ ] `achievement_hunter/colab_agent/src/agent/colab_agent.js`: `extends Agent`, custom `update()`/`handleMessage()`, **keep chat listeners**.
- [ ] Decide: reuse `ConversationManager` turn-taking, or custom `chat-message` protocol.
- [ ] Decide: reuse `prompter.js` templates, or AH-style JSON prompts via `llm_client.js`.
- [ ] Verify `task.isDone()` scoring path is intact for your target task types.
- [ ] Add a colab profile + per-stage model config analog to `achievement_hunter/src/profile.json`.

---

## 5. Open questions / uncertainties to resolve before building

1. **LLM provider.** `llm_client.js` is OpenAI-Responses-only, while the stock `prompter.js` supports many providers (`profiles/*.json` set `claude-*`, `gpt-*`, etc.). Decide which client the colab agent uses; reusing AH's client locks you to OpenAI unless extended. *(Verify the current `llm_client.js` provider support before relying on this.)*
2. **Does the colab agent run as a benchmark type or a collaborative type?** `isBenchmarkTaskType` only covers `inventory`/`advancement`. The collaborative MineCollab tasks are `techtree`/`cooking`/`construction`, which go through the stock `Task` goal/score path. If you want AH-style benchmark handling *plus* collaboration, you must change the `tasks.js:163` gate — currently it short-circuits collaboration for benchmark types.
3. **Group communication for >2 agents.** There is no broadcast conversation; the system relies on the LLM cycling pairwise `startConversation`/`endConversation` (`tasks.js:100-116`). A new agent may want an explicit group protocol — that's net-new.
4. **Teammate world-state visibility.** Nothing exposes a teammate's inventory/position to another agent except what they *say*. Confirm whether the colab design should keep this (the whole point of the benchmark) or add a shared blackboard (which would change task difficulty/semantics).
5. **Construction insecure coding.** Construction tasks need `--insecure_coding` (`minecollab.md:141`) so agents can `!newAction` freeform JS. Confirm whether the colab loop will use the coder path at all.
6. **`server_data` vs AH template.** `minecollab.md:106` notes the legacy `tasks/server_data` world is superseded by `achievement_hunter/evaluation_harness/server_templates/minecraft_1_21_6_clean`. Confirm which world/launcher the colab experiments target. *(Not yet traced in this investigation.)*
7. **Hell's Kitchen enforcement details.** `hellsKitchenProgressManager` (`task_validators.js:8`) tracks per-agent cooking provenance; its exact rules weren't fully read here. Read it before building any cooking-collaboration logic.

---

## 6. Cross-references

- Task schema, loading, scoring, Python orchestrator → [`01-task-system-overview.md`](./01-task-system-overview.md)
- Per-agent initial state & privileged info → [`02-initial-agent-state.md`](./02-initial-agent-state.md)
- The socket message channel & turn-taking → [`03-bot-communication.md`](./03-bot-communication.md)
- The AH reference loop & reusable modules → [`04-achievement-hunter-reference.md`](./04-achievement-hunter-reference.md)
