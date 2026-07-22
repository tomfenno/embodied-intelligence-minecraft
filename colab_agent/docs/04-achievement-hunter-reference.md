# 04 — Achievement Hunter (AH) as a Reference Implementation

The AH agent is the closest existing example of a **custom prompting loop that replaces the stock reactive agent** while still plugging into the `tasks/` system. This documents what it does, how it hooks in, and which pieces are worth reusing — and flags the one big gap (it is single-agent).

---

## 1. How AH is selected and wired in

- **Flag:** `settings.achievement_hunter` (`settings.js:80-82`). When true, `main.js:72-76` calls `create_achievement_agent(settings)` instead of `Mindcraft.createAgent(settings)`.
- **Task handoff:** identical to stock — `--task_path` + `--task_id` populate `settings.task` (`main.js:30-39`).
- **Default profile:** `achievement_hunter/src/profile.json` (`settings.js:14`).

`create_achievement_agent` (`achievement_hunter/src/agent/create_achievement_agent.js:21-47`) is a near-clone of `Mindcraft.createAgent` (same deep-clone settings, viewer port `3000 + index`, `registerAgent`, `getServer`). **The only substantive difference is the process class it spawns:** `new AchievementAgentProcess(...)` → `init_achievement_agent.js` instead of `AgentProcess` → `init_agent.js`.

`AchievementAgentProcess` (`achievement_agent_process.js:13-90`) mirrors stock `AgentProcess` supervision (restart-on-crash, `code > 1` ⇒ end task). `init_achievement_agent.js:37-45` connects the socket proxy then instantiates `new AchievementAgent()` and calls `agent.start(load_memory, null, count_id)`.

---

## 2. Relationship to the base `Agent`

**`class AchievementAgent extends Agent`** (`achievement_hunter/src/agent/achievement_agent.js:20`) — it **subclasses** the base, reusing `this.bot`, `this.history`, `this.task`, `this.prompter`, `this.actions`, `this.bot.modes`, and the inherited `start()` (which still builds `this.task = new Task(...)`). The strategy is to **neuter the reactive loop, not remove it**:

- `_setupEventHandlers` (`achievement_agent.js:21-91`): inits the structured-loop models, **stubs `openChat`** during base setup, installs AH modes, and **silences chat/whisper listeners** (`_silence_chat_listeners`, `:207-210`). It then decides the startup mode: resume from checkpoint, launch from a benchmark goal, or wait for an interactive objective.
- `update(delta)` (`:93-98`): replaces the reactive update with `bot.modes.update()` + (benchmark mode) `checkTaskDone()`.
- `handleMessage` (`:124-143`): captures the first non-`!` message as the loop objective; suppresses messages while the loop runs.
- `checkTaskDone` (`:100-122`): records the episode via `recordEpisodeCompleted`, then `killAll()`.

**Interaction with `tasks.js`:** the AH agent relies on the override at `src/agent/tasks/tasks.js:163` (`if (settings.achievement_hunter && isBenchmarkTaskType(...)) return;`) so that `setAgentGoal()`/`initBotTask()` do **not** inject the natural-language collaboration goal or run the stock inventory/teleport setup for `inventory`/`advancement` task types (`BENCHMARK_TASK_TYPES`, `task_validators.js:4`). The AH loop drives those objectives directly from `task.data.goal`.

---

## 3. The Structured Planning Loop (SPL) — `achievement_hunter/src/pipeline/structured_loop/loop.js`

`structured_loop(models, agent, task_name, graph=null)` (`loop.js:21-201`). Per its `README.md`, **there is no LLM in the happy path** — LLMs are consulted only on failure or for graph generation.

**Setup:** acquire the Primary Task DAG (load from disk or `generate_primary_task_dag_self_refined`, `self_refine.js:170`), restore checkpoint/breadcrumbs, install a `death` handler (death is **not** a failure).

**Main loop** (`while(true)`, `loop.js:136-193`), each iteration:
1. **SCSG** — `build_state_conditioned_subgraph` → `compute_scsg(graph, inventory)` (`scsg.js`): the deterministic diff between current inventory and goal. `r === 2` ⇒ all goals satisfied ⇒ done.
2. **Source candidates** — `get_source_candidates`: subgraph vertices with no remaining inputs, annotated with nearby grounded sources (`mc_sources.js`).
3. **Task selection** — `get_next_task` → `select_next_task` (`tasks.js`): a deterministic **4-tier** policy (craft/smelt → nearby acquire → interact → multi-target search sweep).
4. **Execution** — `execute_task_action` (`actions.js`) → a single bot command (`!collectBlocks`, `!craftRecipe`, `!smelt_item`, `!attack`, `!useOn`, `!placeHere`, `!search…`), verified by post-conditions, retried, and **re-planned via LLM only on failure** (`failure_replanner.js`, `search_replanner.js`). Returns `'success' | 'fail' | 'death'`.

**Termination:** all goals satisfied ⇒ `clear_checkpoint` + `log.complete`; or `consecutive_failures >= MAX_OUTER_RETRIES (10)` ⇒ abort.

---

## 4. Reusable modules (all under `achievement_hunter/src/pipeline/`)

| Module | What it gives you |
|---|---|
| `agent_state.js` | **World-state extractors** at several granularities: `get_sgsg_state` (inventory+armor), `get_nts_state` (craftable/nearby blocks/mobs), `get_am_state` (full action-mediation state), `get_recovery_trace_state`. The cleanest way to ground a prompt in live bot state. |
| `llm_client.js` | `LlmClient` — thin OpenAI **Responses API** wrapper, `send_prompt(prompt)`, per-stage model selection. **OpenAI-only**; model choices come from `profile.json`. |
| `command_verifier.js` + `command_utils.js` | Per-command **post-condition registry** (e.g. `!collectBlocks` checks inventory delta incl. block drops) and `executeCommandWithModeRecovery` (verification + mode-interrupt recovery). Turns a "reported success" into a real success/failure. |
| `rollout_logger.js` (+ `io_queue.js`, `graph_utils.js`) | Structured stage tracing (`PTD`/`SCSG`/`CANDIDATES`/`TASK`/`AM`/`RECOVERY`), per-task `.jsonl` traces, dataset files, live dashboard, mermaid graph export. |
| `checkpoint.js` | Crash-resume: `saveCheckpoint`/`loadCheckpoint`/`saveRuntimeState`, in-memory mirror + async writes. |
| `scsg.js` | `compute_scsg` — deterministic state-vs-goal diff (the core "what's left to do" computation). |
| `structured_loop/graph.js`, `breadcrumbs.js`, `mc_sources.js` | Pure DAG helpers; exploration breadcrumb map; world-source resolution. |
| `self_refine.js`, `failure_replanner.js`, `search_replanner.js`, `prompt_utils.js`, `json_utils.js` | Prompt assembly + iterative refine + JSON extraction/validation patterns. |

Models are instantiated per-stage in `achievement_agent.js:_init_spl_models` (`:162-176`) from `profile.json` overrides (`ptd_model`, `failure_replanner_model`, …).

---

## 5. The big gap: AH is single-agent only

**There is no collaboration logic anywhere in `achievement_hunter/src/`.** Evidence:
- The SPL signature `structured_loop(models, agent, task_name, graph)` operates over **one** `agent`/`bot` — no teammate state, message passing, or task division.
- `count_id` appears only for **viewer-port/process identity** (`create_achievement_agent.js:14,26`; `init_achievement_agent.js` comment "Identifying index for multi-agent scenarios"), not coordination.
- AH **actively disables** the base collaboration paths: `_silence_chat_listeners()` removes chat/whisper (`achievement_agent.js:207-210`), `handleMessage` suppresses inter-agent messages during the loop (`:135-140`), and `tasks.js:163` skips the "collaborate with other agents… divide the work" goal injection for AH benchmark tasks.
- The base `Agent` still has the multi-agent machinery (`checkAllPlayersPresent` over `task.agent_names` at `agent.js:226-236`, `convoManager`, `serverProxy.getNumOtherAgents()`), but the AH subclass neither uses nor extends it.

**Consequence for the colab agent:** AH gives you a proven pattern for *replacing the reactive loop* and a strong library of *single-agent* planning/state/verification/logging utilities — but the **multi-agent coordination layer (teammate modeling, messaging, task division, privileged-info exchange) is entirely new work**. See [doc 05](./05-interface-points-for-new-agent.md).
