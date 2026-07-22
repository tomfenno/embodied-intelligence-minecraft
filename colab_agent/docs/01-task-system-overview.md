# 01 — Task System Overview: structure, loading, and execution flow

This covers **how tasks are defined, loaded, how agents are created, the main execution loop, where prompts are assembled, and where success/failure is tracked.**

---

## 1. How tasks are defined (the task JSON)

A task file is a JSON object mapping `task_id → task definition`. Example files live under `tasks/` (e.g. `tasks/multiagent_crafting_tasks.json`, `tasks/cooking_tasks/...`, `tasks/construction_tasks/...`, `tasks/basic/single_agent.json`).

### Common fields (observed across task files)

| Field | Meaning | Source / consumer |
|---|---|---|
| `goal` | Natural-language objective. **String** (shared) or **object keyed by agent index** (`{"0": "...", "1": "..."}`) for per-agent goals. | `Task.getAgentGoal()` — `src/agent/tasks/tasks.js:89-129` |
| `conversation` | Seed message that kicks off the inter-bot dialogue. | `Task.initBotTask()` — `tasks.js:269-284` |
| `initial_inventory` | Object keyed by agent index → `{item: qty}`. Per-agent starting items. | `Task.initBotTask()` — `tasks.js:209-251` |
| `agent_count` | Number of bot agents required. | presence checks — `tasks.js:145-147`, `259-267` |
| `human_count`, `usernames` | Human-in-the-loop players and their MC usernames. | `tasks.js:199-240` |
| `target`, `number_of_target` | Goal item(s) and count for `techtree`/`inventory`/`cooking` scoring. `target` may be a string, array, or `{item: qty}` map. | validators (see §4) |
| `type` | Task type: `techtree`, `cooking`, `construction`, `inventory`, `advancement`. Selects the validator. | `Task` constructor — `tasks.js:47-59` |
| `blocked_actions` | Object keyed by agent index → list of disabled commands (e.g. `["!collectBlocks"]`). | `tasks.js:61-66` |
| `timeout` | Seconds before the episode is force-ended (default 300). | `tasks.js:45`, `152-158` |
| `blueprint` | (construction only) structure spec; parsed into a `Blueprint`. | `tasks.js:35-44`; `construction_tasks.js` |
| `recipes`, `blocked_access_to_recipe` | (cooking only) recipe text and which agents are denied it. See [`02`](./02-initial-agent-state.md). | cooking goal strings; `CookingTaskInitiator` |
| `requires_ctable`, `max_depth`, `depth`, `missing_items` | techtree generation metadata (mostly informational at runtime). | task-generation scripts |

**Minimal single-agent example** (`minecollab.md:16-38`, `tasks/basic/single_agent.json` → `gather_oak_logs`):
```json
{ "goal": "Collect at least four logs",
  "initial_inventory": { "0": { "wooden_axe": 1 } },
  "agent_count": 1, "target": "oak_log", "number_of_target": 4,
  "type": "techtree", "timeout": 300, "blocked_actions": { "0": [], "1": [] } }
```

> **Uncertainty.** The field set is conventional, not schema-enforced; different generators emit slightly different keys (e.g. cooking tasks add `difficulty_metrics`, `task_type`). The `Task` class only reads the subset above; unknown keys are ignored.

---

## 2. How a single task is loaded (`main.js`)

`main.js` is the Node entry point.

```js
// main.js:30-39
if (args.task_path) {
    let tasks = JSON.parse(readFileSync(args.task_path, 'utf8'));
    if (args.task_id) {
        settings.task = tasks[args.task_id];      // <-- the chosen task object
        settings.task.task_id = args.task_id;     // <-- id stamped onto it
    } else { throw new Error('task_id is required when task_path is provided'); }
}
```

So **one process runs exactly one task**, selected by `--task_id`. The task object becomes `settings.task` (`settings.js` also has a static `task` default).

Several env vars override settings (`main.js:42-65`): `MINECRAFT_PORT`, `MINDSERVER_PORT`, `PROFILES`, `INSECURE_CODING`, `BLOCKED_ACTIONS`, `MAX_MESSAGES`, `NUM_EXAMPLES`, `LOG_ALL`. These are set by the Python orchestrator (§5).

---

## 3. How agents are created

After loading the task, `main.js` starts the MindServer and spawns **one agent process per profile**:

```js
// main.js:67-77
Mindcraft.init(true, settings.mindserver_port, settings.auto_open_ui);
for (let profile of settings.profiles) {
    const profile_json = JSON.parse(readFileSync(profile, 'utf8'));
    settings.profile = profile_json;
    if (settings.achievement_hunter) {
        create_achievement_agent(settings);     // AH path (see doc 04)
    } else {
        Mindcraft.createAgent(settings);         // stock path
    }
}
```

`Mindcraft.createAgent` (`src/mindcraft/mindcraft.js:30-75`):
- assigns a per-agent `agentIndex` (`agent_count++`) and a viewer port `3000 + agentIndex`,
- `registerAgent(settings, viewer_port)`,
- resolves the MC server (`getServer`),
- spawns a supervised child via `new AgentProcess(...).start(load_memory, init_message, agentIndex)` — the `agentIndex` becomes the agent's **`count_id`**.

So multi-agent tasks are run by a **single `main.js` invocation** with multiple profiles (`PROFILES` env is a JSON array). Each child process is one bot; they coordinate over the MindServer ([doc 03](./03-bot-communication.md)).

> **Key fact for the new agent:** the agent index `count_id` is assigned here by enumeration order of `settings.profiles`. It is the index used to look up that agent's inventory/goal/blocked-actions in the task JSON.

---

## 4. Where success / failure / score is tracked

### The `Task` class — `src/agent/tasks/tasks.js`

Constructed inside the base agent's `start()` (`src/agent/agent.js:65`): `this.task = new Task(this, settings.task, taskStart)`. The constructor (`tasks.js:13-76`):
- stamps `goal`, `conversation`, `taskTimeout`,
- picks the **validator** by `type` (`tasks.js:47-59`):
  - `construction` → `ConstructionTaskValidator` (`construction_tasks.js`)
  - `cooking` | `techtree` | `inventory` → `InventoryTaskValidator` (`task_validators.js`)
  - `advancement` → `AdvancementTaskValidator` (`task_validators.js`)
- filters `blocked_actions` by `count_id` (`tasks.js:61-66`),
- appends `!endGoal`/`!endConversation` to blocked actions when a goal/conversation exists (`tasks.js:68-69`).

### Scoring — `Task.isDone()` (`tasks.js:131-160`)

```js
isDone() {
  let res = this.validator ? this.validator.validate() : null;
  if (res && res.valid) { /* cleanup */ return {message:'Task successful', score: res.score}; }
  const elapsed = (Date.now() - this.taskStartTime) / 1000;
  if (agent_count>1 && elapsed>=30 && available_agents.length !== agent_count)
       return {message:'No other agents found', score: 0};   // peers never showed up
  if (elapsed >= this.taskTimeout)
       return {message:'Task timeout reached', score: res?res.score:0};
  return false;   // not done yet
}
```

- **Crafting/cooking/inventory:** `InventoryTaskValidator.validate()` → `checkItemPresence` → score `1` or `0` (`task_validators.js:229-241`, `188`).
- **Advancement:** `AdvancementTaskValidator` → score `1`/`0` (`task_validators.js:321-333`).
- **Construction:** edit-distance score, a **decimal** in `[0,1]` (`construction_tasks.js`; described in `minecollab.md:179`).

### Where `isDone()` is polled — the run loop

The base `Agent` runs an interval loop; each tick calls `update()`:
```js
// src/agent/agent.js:529-532
async update(delta) {
    await this.bot.modes.update();
    this.self_prompter.update(delta);
    await this.checkTaskDone();
}
```
`checkTaskDone()` (`agent.js:546-559`) records the terminal score into history and kills the episode:
```js
let res = this.task.isDone();
if (res) {
    await this.history.add('system', `Task ended with score : ${res.score}`);
    ... this.killAll();
}
```
The `Task ended with score : N` system message is the canonical record — it is what the Python analyzer greps for (`tasks/evaluation_script.py:42` `analyze_json_file`, looks for `"Task ended with score : 1"`). It is also persisted to each agent's `bots/<name>/memory.json` (last ~15 messages, per `minecollab.md:179`).

---

## 5. The Python orchestrator — `tasks/evaluation_script.py`

This is the **outer experiment driver** (not used by `main.js`; it *calls* `main.js`). Run as `python tasks/evaluation_script.py --task_path ... --model ... --template_profile ...` (`minecollab.md:116`).

Flow (entry `main()` at `evaluation_script.py:728`):
1. Parse args (`--task_path`, `--num_agents`, `--num_exp`, `--num_parallel`, `--model`, `--api`, `--template_profile`, `--insecure_coding`, `--max_messages`, `--num_examples`, `--usernames`, `--s3`, …) — `:732-753`.
2. Read all `task_id`s from the task file (`:787` `for task_id in task.keys()`).
3. `launch_parallel_experiments(...)` (`:244`) → per parallel world, `launch_server_experiment(...)` (`:348`):
   - copies server template into `server_data_i`, sets `server-port` (`:384`),
   - computes `mindserver_port = server_port - 55916 + 8080` (`:385`),
   - `make_profiles(...)` writes per-agent profile JSONs from the `--template_profile`,
   - launches the MC server in a `server_i` tmux shell and the agents in a `i` tmux shell,
   - sets env vars (`MINECRAFT_PORT`, `MINDSERVER_PORT`, `PROFILES`, `MAX_MESSAGES`, `NUM_EXAMPLES`, `LOG_ALL`, `INSECURE_CODING`) on the tmux session (`:425-434`),
   - `make_ops(...)` runs a throwaway `debug_*_agent_timeout` task to make agents server operators (`:512-520`).
4. `run_script(...)` (`:460`) builds a shell script that, **per `task_id`, repeats `num_exp` times**:
   ```
   node main.js --task_path '<path>' --task_id <task_id>
   sleep 2
   cp bots/<agent>/memory.json <experiments_folder>/<task_id>/<agent>_<run>.json
   ```
   (`:470-505`) — i.e. it runs each task as a fresh `node main.js` and snapshots each agent's `memory.json` afterward.
5. The driver polls `aggregate_results(...)` while running (`:325-326`) and writes `experiments/exp_*/results.txt` plus per-task folders (`minecollab.md:177-179`).

**Blocked-action presets** per task type are hardcoded in the script (`BLOCKED_ACTIONS_COOKING/CRAFTING/CONSTRUCTION`, `evaluation_script.py:14-41`) and pushed in via the `BLOCKED_ACTIONS` env var path.

> **Windows / no-tmux alternative:** `tasks/run_task_file.py` runs a task file directly without tmux (`minecollab.md:165-171`).

---

## 6. End-to-end execution flow (single episode)

```
evaluation_script.py
   └─ tmux: node main.js --task_path X --task_id T            (one episode)
        ├─ load tasks[T] → settings.task                       main.js:30-39
        ├─ Mindcraft.init() → start MindServer                 mindcraft.js:12-28
        └─ for each profile: createAgent()                     main.js:69-77
              └─ AgentProcess child → init_agent.js → Agent.start(count_id)
                    ├─ new Prompter(profile) ; initExamples()  agent.js:33,52
                    ├─ new Task(this, settings.task)           agent.js:65
                    ├─ initBot(name) → mineflayer login        agent.js:70
                    └─ on 'spawn':                              agent.js:113-149
                          ├─ task.initBotTask()                give inventory, teleport,
                          │                                     seed !startConversation
                          ├─ task.setAgentGoal() → !goal(...)   start self-prompt loop
                          └─ checkAllPlayersPresent()
                    ── run loop: update() every tick ──────────agent.js:511-532
                          └─ checkTaskDone() → task.isDone()    score 0/1/decimal
                                └─ on done: history "Task ended with score : N"; killAll()
```

See [doc 02](./02-initial-agent-state.md) for what `initBotTask`/`setAgentGoal` actually put in front of each agent, [doc 03](./03-bot-communication.md) for the conversation channel, and [doc 04](./04-achievement-hunter-reference.md) for how the AH agent overrides the run loop.
