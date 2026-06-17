# Colab Agent — Context / Handoff File

> **Audience:** an LLM assistant (or future session) picking this work up cold. Read this first, then the docs it points to. Everything here was true as of **2026-06-10**, branch **`colab-agent-init`**. Verify file/line citations before relying on them — the code may have moved.

---

## 1. What this project is

This repo is a fork of **Mindcraft** (LLM agents that play Minecraft via [Mineflayer](https://github.com/PrismarineJS/mineflayer)) with an **Achievement Hunter (AH)** layer on top. All AH work lives under `achievement_hunter/`.

The **colab_agent** sub-project (this directory, `achievement_hunter/colab_agent/`) is a *new, not-yet-built* effort. The goal: build a **structured prompting loop for multi-agent collaboration** that can complete the collaborative tasks in `tasks/` (crafting, cooking, construction). The existing AH agent is the closest reference, but it is **single-agent only** — the multi-agent coordination layer is the new work.

**Current phase: investigation + documentation only.** No new agent has been built. No task behavior has been changed.

---

## 2. What exists right now (created in prior sessions)

Everything is under `achievement_hunter/colab_agent/`:

```
colab_agent/
├── CONTEXT.md                      ← you are here
├── docs/                           ← all investigation output (read these)
│   ├── README.md                   ← index of the docs below
│   ├── 01-task-system-overview.md  ← task JSON, loading, Task class, scoring, exec flow
│   ├── 02-initial-agent-state.md   ← per-agent prompt/goal/inventory + privileged info
│   ├── 03-bot-communication.md     ← out-of-band socket relay (NOT in-game chat)
│   ├── 04-achievement-hunter-reference.md  ← AH agent as a reference impl (single-agent)
│   ├── 05-interface-points-for-new-agent.md ← where/how a new agent hooks in + open Qs
│   ├── 06-task-demands-and-coordination.md  ← what tasks demand → agent org structure
│   └── 07-running-and-visualizing.md        ← how to run+watch a 2-agent task
├── profiles/                       ← created for running a demo task
│   ├── andy.json                   ← agent 0, crafting prompt, model gpt-4o-mini
│   └── jill.json                   ← agent 1, same prompt
└── src/                            ← EMPTY. The new agent will go here. Nothing built yet.
```

The `docs/` are the real deliverable so far. `docs/README.md` is the table of contents.

### About `profiles/`
`profiles/andy.json` and `profiles/jill.json` are **standard Mindcraft agent profiles** (same shape as `profiles/tasks/crafting_profile.json`), created only to **run and watch the demo collaborative task** in [doc 07](./docs/07-running-and-visualizing.md). `main.js` spawns one bot process per profile listed in `settings.profiles`; the run command points `PROFILES` at these two files, so a 2-agent task needs exactly these two. Each profile's `name` becomes the bot's in-game identity and `count_id` is assigned by list order (andy=0, jill=1).

They are faithful copies of the crafting collaboration profile (the `conversing` template, multi-bot `conversation_examples`, and `modes`) with two changes: a **distinct `name`** per file, and **`model: "gpt-4o-mini"`** instead of the template's `claude-3-5-sonnet-latest` (because `keys.json` only has `OPENAI_API_KEY` set).

**Important:** these are inputs to the *existing stock Mindcraft* multi-agent path — they have **nothing to do with the new colab-agent loop** being designed (that code goes in the empty `src/`). They also carry the **crafting** prompt specifically; cooking/construction would need profile pairs built from `cooking_profile.json` / `construction_profile.json` (not yet created — see §7).

---

## 3. The 10 things an LLM must know to be useful here

These are the load-bearing facts. Each links to the doc with full citations.

1. **A "task" is a JSON object** (`tasks/**/*.json`) keyed by `task_id`, with `goal`, `initial_inventory`, `agent_count`, `target`, `type`, `blocked_actions`, `timeout`, etc. Per-agent data is keyed by **`count_id`** (0,1,2…). → [doc 01](./docs/01-task-system-overview.md)

2. **`main.js` runs ONE task** (`--task_path` + `--task_id` → `settings.task`) and spawns **one child process per profile** in `settings.profiles`. Multi-agent = multiple profiles in one `main.js` invocation. → [doc 01 §2-3]

3. **`count_id` indexes everything per-agent**: inventory (`initial_inventory[count_id]`), goal (`goal[count_id]` if goal is an object), blocked actions. It's assigned by profile order. → [doc 02 §3]

4. **Privileged info = per-`count_id` differences in the task JSON.** There is no separate hidden-state store. Examples: split inventories (crafting), `blocked_access_to_recipe` (cooking), symmetric recipe swap (Hell's Kitchen). → [doc 02 §5]

5. **Agents coordinate over an out-of-band socket.io relay through the MindServer — NOT Minecraft chat.** Open chat is explicitly ignored in multi-agent mode (`src/agent/agent.js:189-193`). Protocol = directed `chat-message` events `{message, start, end}` + a sender arg. → [doc 03]

6. **`settings.achievement_hunter` is a hard switch.** `true` → AH single-agent structured loop (only handles `inventory`/`advancement` task types, *disables* collaboration). `false` → stock Mindcraft multi-agent path that drives the collaborative `techtree`/`cooking`/`construction` tasks. **For collaborative work this MUST be `false`.** → [doc 04 §4]

7. **The AH agent is the reference but is single-agent only.** `AchievementAgent extends Agent`, neuters the reactive loop, runs a deterministic plan loop (`achievement_hunter/src/pipeline/structured_loop/loop.js`). It *silences* chat listeners. Reusable AH modules: `agent_state.js`, `scsg.js`, `command_verifier.js`, `rollout_logger.js`, `checkpoint.js`, `llm_client.js` (OpenAI-only). → [doc 04]

8. **Tasks cluster into two coordination archetypes:** *Converge-to-one* (crafting/cooking — funnel inputs/recipes to one assembler/collector) and *Partition-and-parallelize* (construction — material specialists + spatial plan). Suggested roles: Coordinator / Specialist-Worker / Knowledge-broker, plus an opening "disclosure round." → [doc 06]

9. **Scoring:** `Task.isDone()` (`src/agent/tasks/tasks.js`) is polled each tick by `Agent.checkTaskDone()`. Crafting/cooking/inventory → 0/1 via `InventoryTaskValidator`; construction → decimal edit-distance. Terminal record = a history line `Task ended with score : N`. → [doc 01 §4]

10. **Repo convention (from root `CLAUDE.md`):** all AH code lives in `achievement_hunter/`. Any edit *outside* it (e.g. a `main.js` branch, a `settings.js` flag) must be wrapped in `// Start of AH code` / `// End of AH code` markers and checked against `patches/` first. Files inside `achievement_hunter/` don't use the markers.

---

## 4. Environment facts (this machine, macOS/darwin)

- ✅ Node v20, Java 22, bundled Minecraft **1.21.6** `server.jar` at `achievement_hunter/evaluation_harness/server_templates/minecraft_1_21_6_clean/`.
- ✅ `keys.json` has **`OPENAI_API_KEY` set** (Anthropic/others empty) → use **OpenAI models** (`gpt-4o-mini` for the stock collaborative path; the AH profiles use `gpt-5` via the Responses API).
- ❌ **`tmux` not installed** → the Python batch driver `tasks/evaluation_script.py` won't run as-is (`brew install tmux` to fix).
- ❌ **`tasks/server_data/` is missing** → the Python driver's world launch needs it (or adapt to the committed template above).
- ⚠️ `settings.js` defaults: `host: 'host.docker.internal'` (Docker — use `127.0.0.1` locally), `achievement_hunter: true` (turn off for collaboration).
- The user **has a Minecraft 1.21.6 client** and wants to watch tasks live.

---

## 5. How to run a collaborative task (verified plumbing, not yet run live)

Hosting the world from the user's own client with **Open-to-LAN + Allow Cheats ON** is the simplest path: cheats become available to all LAN players, so the bots' `/give`/`/tp` setup works with no operator/tmux/Python needed. Full steps + visualization + troubleshooting in **[doc 07](./docs/07-running-and-visualizing.md)**. The command (no `settings.js` edits; env overrides keep AH config intact):

```bash
cd /Users/Matthew/Desktop/AH-Hunter/embodied-intelligence-minecraft
SETTINGS_JSON='{"host":"127.0.0.1","achievement_hunter":false}' \
PROFILES='["./achievement_hunter/colab_agent/profiles/andy.json","./achievement_hunter/colab_agent/profiles/jill.json"]' \
node main.js \
  --task_path tasks/crafting_tasks/test_tasks/2_agent.json \
  --task_id multiagent_crafting_pink_wool_full_plan__depth_0
```
Watch via: the user's client (they host the world), MindServer UI `http://localhost:8080`, and optional per-bot views `localhost:3000`/`3001` (`render_bot_view:true`).

> **Verified:** env overrides resolve correctly (`host=127.0.0.1`, `achievement_hunter=false`, two valid profiles `andy`/`jill`), and the task id exists with `agent_count: 2`. **Not verified:** an actual in-game episode — that requires the user's client hosting the world.

---

## 6. What was done across these sessions

1. Investigated `tasks/` + `achievement_hunter/` and wrote **docs 01–05** (how the task system works, agent init, communication, AH reference, interface points).
2. Wrote **doc 06** — analyzed what each task category demands of agents and proposed an agent *coordination/organizational structure* (the user's stated end goal).
3. Wrote **doc 07** + created `profiles/andy.json` and `profiles/jill.json` — a runnable, watchable 2-agent crafting demo via Open-to-LAN, no tmux/Python, no `settings.js` edits.
4. Wrote this `CONTEXT.md`.

---

## 7. What is NOT done / open questions / likely next steps

**Not done:** no actual colab agent code exists (`colab_agent/src/` is empty); no live in-game episode has been run/confirmed; cooking/construction profile pairs not yet made (only crafting).

**Open design questions** (fuller list in [doc 05 §5](./docs/05-interface-points-for-new-agent.md)):
- **LLM client:** AH's `llm_client.js` is OpenAI-Responses-only; stock `prompter.js` is multi-provider. Pick one for the colab agent.
- **Benchmark vs collaborative task types:** `isBenchmarkTaskType` only covers `inventory`/`advancement`; collaborative tasks are `techtree`/`cooking`/`construction` and go through the stock goal/score path. AH-style handling + collaboration would require changing the gate at `src/agent/tasks/tasks.js:163`.
- **Group comms for >2 agents:** no broadcast; the system relies on pairwise `startConversation`/`endConversation`. A group protocol is net-new.
- **Teammate visibility:** nothing exposes a teammate's inventory/recipes except what they *say* — that's the point of the benchmark; don't accidentally add a shared blackboard that trivializes it.
- **Construction scoring detail:** the edit-distance partial-credit claim in doc 06 was inferred from `minecollab.md` + the decimal score, not read line-by-line in `ConstructionTaskValidator`. Confirm before leaning on it.

**Likely next step** (per [doc 05 §3](./docs/05-interface-points-for-new-agent.md)): mirror the AH pattern — add a `settings.colab_agent` flag + a `main.js` branch (AH-marked), copy the AH process/init trio into `colab_agent/src/agent/`, subclass `Agent` but **keep** the chat listeners, reuse the `Task` lifecycle + scoring, and build the coordination layer (disclosure round, roles, task division) on top of the existing socket relay.

---

## 8. Key file map (outside colab_agent)

| Path | What |
|---|---|
| `main.js` | Entry; loads task, spawns one process per profile, AH-vs-stock branch (`:72-76`) |
| `settings.js` | Global settings incl. `achievement_hunter` flag (`:80`); honors `SETTINGS_JSON` env (`:86`) |
| `src/agent/agent.js` | Base `Agent`: `start()`, update loop, `checkTaskDone()`, messaging |
| `src/agent/tasks/tasks.js` | `Task` class: init, per-`count_id` goal/inventory, `isDone()` scoring |
| `src/agent/conversation.js`, `mindserver_proxy.js`, `src/mindcraft/mindserver.js` | Inter-agent socket relay |
| `src/models/prompter.js` | Stock system-prompt assembly (`replaceStrings`) |
| `achievement_hunter/src/agent/` + `.../src/pipeline/` | AH agent + structured loop (reference) |
| `achievement_hunter/evaluation_harness/task_validators.js` | Validators, `isBenchmarkTaskType`, Hell's Kitchen progress |
| `tasks/evaluation_script.py` | Python batch driver (tmux; auto world+ops+scoring) |
| `minecollab.md` (repo root) | Upstream docs on the benchmark + running tasks |
| `CLAUDE.md` (repo root) | Repo conventions (AH dir, patch markers) |
