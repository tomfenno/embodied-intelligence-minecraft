# `tasks/` System Documentation — for the Colab Agent project

This directory documents how the Mindcraft/MineCollab **task system** (`tasks/` + `src/agent/tasks/`) works, so a new collaborative agent ("colab agent") can be built to plug into it. It also describes the existing **Achievement Hunter (AH)** agent as a reference implementation.

> **Scope & status.** This is investigation/documentation only — no task behavior was changed. Every claim below cites a file and (where useful) line numbers, gathered by reading the code on branch `colab-agent-init` (2026-06-10). Open questions and uncertainties are called out explicitly.

## How to read these docs

| File | What it covers | Key questions answered |
|---|---|---|
| [`01-task-system-overview.md`](./01-task-system-overview.md) | Task JSON schema, the `Task` class, loading, validators/scoring, the Python orchestrator, full execution flow | "Task structure and execution flow" |
| [`02-initial-agent-state.md`](./02-initial-agent-state.md) | What each agent receives at spawn: system prompt assembly, per-agent goal/inventory/blocked actions, and **privileged information** per task type (incl. Hell's Kitchen) | "Initial agent state" / privileged info |
| [`03-bot-communication.md`](./03-bot-communication.md) | The out-of-band socket.io relay through the MindServer, message protocol, turn-taking, `!startConversation`/`!endConversation` | "Bot-to-bot communication" |
| [`04-achievement-hunter-reference.md`](./04-achievement-hunter-reference.md) | How the AH agent replaces the stock reactive loop with a deterministic structured planning loop; which modules are reusable | reference implementation |
| [`05-interface-points-for-new-agent.md`](./05-interface-points-for-new-agent.md) | Where a new agent hooks in, the contract `tasks/` assumes, recommendations, and open questions | "Interface points for a new agent" |
| [`06-task-demands-and-coordination.md`](./06-task-demands-and-coordination.md) | What each task category actually demands of agents, and the coordination/role structures those demands imply | designing an agent organizational structure |
| [`07-running-and-visualizing.md`](./07-running-and-visualizing.md) | Copy-pasteable guide to run a 2-agent collaborative task and watch it in Minecraft 1.21.6 (no tmux/Python, no settings.js edits) | running & visualizing a task |

## One-paragraph summary

A **task** is a JSON object (e.g. in `tasks/cooking_tasks/...`) describing a goal, per-agent initial inventories, per-agent goals, blocked actions, a target/blueprint/recipe, and a timeout. `main.js` loads one task by `--task_id` into `settings.task`. Each agent runs in its **own OS process** (one `node main.js` per profile is not how it works — see below; rather `main.js` spawns one child process per profile). The base `Agent` (`src/agent/agent.js`) constructs a `Task` (`src/agent/tasks/tasks.js`), which uses the agent's **`count_id`** (0,1,2…) to pick that agent's slice of inventory/goal/blocked-actions, gives items via `/give`, teleports bots together, seeds an inter-bot conversation, and issues the goal via the `!goal(...)` command. Agents coordinate over an **out-of-band socket.io channel** routed by a central **MindServer** — *not* primarily through Minecraft chat. A `validator` polls every tick for success; the episode ends on success or timeout. The **AH agent** swaps the reactive chat loop for a deterministic planner but is **single-agent only** today — multi-agent collaboration would be new work.

## Most important file paths (quick index)

- `main.js` — entry; loads task, spawns one agent process per profile.
- `src/agent/tasks/tasks.js` — the `Task` class (init, goal, scoring hook, teleport, conversation seed).
- `src/agent/tasks/cooking_tasks.js`, `construction_tasks.js` — task-type-specific initiators/validators.
- `achievement_hunter/evaluation_harness/task_validators.js` — `InventoryTaskValidator`, `AdvancementTaskValidator`, Hell's Kitchen progress, `isBenchmarkTaskType`.
- `src/agent/agent.js` — base `Agent`: `start()`, update loop, `checkTaskDone()`.
- `src/models/prompter.js` — system-prompt assembly (`replaceStrings`).
- `src/agent/conversation.js`, `src/agent/mindserver_proxy.js`, `src/mindcraft/mindserver.js` — inter-agent messaging.
- `tasks/evaluation_script.py` — the Python tmux orchestrator that runs many episodes and scores them.
- `achievement_hunter/src/agent/` + `achievement_hunter/src/pipeline/` — the AH reference agent and its structured loop.
