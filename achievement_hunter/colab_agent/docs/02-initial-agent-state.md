# 02 — Initial Agent State & Privileged Information

This answers: **what prompt is sent to each agent at start, what info each agent has, how agents are initialized differently, and what counts as privileged (per-agent private) information.**

---

## 1. There is no single static "initial prompt" — it is assembled every call

The system prompt is **rebuilt on every model call** by `Prompter.replaceStrings()` (`src/models/prompter.js:146-213`) from a profile template. For conversation, `promptConvo()` (`prompter.js:223-271`) does:
```js
let prompt = this.profile.conversing;                       // the template
prompt = await this.replaceStrings(prompt, messages, this.convo_examples);
generation = await this.chat_model.sendRequest(messages, prompt);  // prompt = system msg
```

### Template variables and their sources (`replaceStrings`, `prompter.js:146-213`)

| Variable | Filled from |
|---|---|
| `$NAME` | `agent.name` (profile `name`) |
| `$STATS` | live `!stats` + `!entities` + `!nearbyBlocks` output |
| `$INVENTORY` | live `!inventory` output |
| `$ACTION` | `agent.actions.currentActionLabel` |
| `$COMMAND_DOCS` | `getCommandDocs(agent)` (the full command list — minus blocked) |
| `$CODE_DOCS` | RAG over skill docs (only for `!newAction` coding) |
| `$EXAMPLES` | RAG-selected few-shot examples from the profile |
| `$MEMORY` | `agent.history.memory` (compressed running memory) |
| `$CONVO` | recent conversation turns |
| `$SELF_PROMPT` | the current self-prompt **goal** string, if active: `YOUR CURRENT ASSIGNED GOAL: "..."` |
| `$LAST_GOALS`, `$BLUEPRINTS`, `$TO_SUMMARIZE` | last goal outcomes / construction blueprints / memory-save input |

**Takeaway:** an agent's view of the world (stats, inventory, nearby blocks) is **its own**, injected live. The task-specific *privileged* content reaches the agent through two channels: the **goal** (`$SELF_PROMPT`) and the **conversation seed** — both set from the task JSON per `count_id`.

---

## 2. The profile template shapes persona + rules + examples

Profiles live in `profiles/`. Task runs use `profiles/tasks/{crafting,cooking,construction}_profile.json` (selected by `--template_profile`). Key fields (`src/models/prompter.js` consumers):

- **`conversing`** — the main system-prompt template (persona, rules, and the `$...` placeholders). It differs per task:
  - Crafting (`crafting_profile.json`): "playful Minecraft bot," emphasis on sharing inventory and recipes to co-craft.
  - Cooking (`cooking_profile.json`): "task-focused," includes a long **farm-navigation guide** (how to `searchForBlocks` with radii 64/128/256, where the crafting table/furnace/smoker are, where crops/livestock are).
  - Construction (`construction_profile.json`): blueprint-collaboration framing.
- **`saving_memory`**, **`bot_responder`**, **`image_analysis`**, **`coding`** — templates for other prompt types (memory compression, should-I-reply decision, vision, code generation).
- **`modes`** — behavior toggles merged over `profiles/defaults/_default.json` (e.g. cooking sets `hunting:false, item_collecting:true`). Read via `getInitModes()` (`prompter.js:117`) → `initModes(agent)`.
- **`conversation_examples` / `coding_examples`** — few-shot banks loaded in `initExamples()` (`prompter.js:121-144`); `settings.num_examples` (=2) are RAG-selected per call and injected as `$EXAMPLES`. The crafting/construction example banks are **multi-bot dialogues** tagged `(FROM OTHER BOT)` — they teach the collaboration pattern.

Profile resolution precedence (`prompter.js:20-43`): individual profile > base profile (`survival`/`assistant`/…) > `_default.json`.

---

## 3. How each agent is initialized *differently* — `count_id` indexing

Each agent has a `count_id` (0,1,2…) assigned at spawn ([doc 01 §3](./01-task-system-overview.md)). The `Task` uses it to give each agent a **different slice** of the task JSON:

### a) Per-agent inventory — `initBotTask()` (`tasks.js:209-251`)
```js
initialInventory = this.data.initial_inventory[this.agent.count_id.toString()] || {};
for (const key of Object.keys(initialInventory))
    await this.agent.bot.chat(`/give ${this.name} ${key.toLowerCase()} ${initialInventory[key]}`);
```
Agent 0 gets `initial_inventory["0"]`, agent 1 gets `["1"]`, etc. This is a real in-world `/give` — **each agent's inventory is private** in the sense that only it knows its own contents until it shares them via chat.

### b) Per-agent goal — `getAgentGoal()` (`tasks.js:89-129`)
```js
if (typeof this.data.goal === 'object')
    return (this.data.goal[this.agent.count_id.toString()] || '') + add_string;
```
If `goal` is a **string**, all agents share it. If it's an **object** keyed by index, each agent gets its own goal text — this is the primary vehicle for **privileged per-agent instructions** (see §5).

`setAgentGoal()` (`tasks.js:162-177`) then appends a collaboration clause naming the *other* agents and issues `!goal("...")`:
```js
agentGoal += 'You have to collaborate with other agents/bots, namely '
    + this.available_agents.filter(n => n !== this.name).join(', ')
    + ' to complete the task ... by dividing the work among yourselves.';
await executeCommand(this.agent, `!goal("${agentGoal}")`);
```
> Note the **AH override**: `if (settings.achievement_hunter && isBenchmarkTaskType(this.task_type)) return;` (`tasks.js:163`) — AH benchmark tasks (`inventory`/`advancement`) skip this entirely.

### c) Per-agent blocked actions — constructor (`tasks.js:61-66`)
```js
this.blocked_actions = this.data.blocked_actions[this.agent.count_id.toString()] || [];
```
Different agents can be denied different commands (e.g. `["!collectBlocks"]`), forcing dependence on teammates.

### d) Setup steps gated to agent 0 only
`count_id === 0` exclusively: clears human inventories (`tasks.js:200`), runs the cooking-world `CookingTaskInitiator.init()` (`tasks.js:253`), and **seeds the inter-bot conversation** (`tasks.js:269-284`). So agent 0 is the de-facto "host."

---

## 4. Goal vs. Conversation seed — two different injection paths

| | **Goal** (`data.goal`) | **Conversation seed** (`data.conversation`) |
|---|---|---|
| Delivered by | `setAgentGoal()` → `!goal("...")` | agent 0 → `!startConversation(other, "...")` (`tasks.js:281`) |
| Mechanism | `SelfPrompter` **loop** — re-prompts the agent continuously (`self_prompter.js:56-87`) | a **single** message routed to the *other* bot, tagged `(FROM OTHER BOT)` |
| Audience | the agent itself (its own objective) | the partner bot |
| Who gets it | every agent | only agent 0 sends; the partner receives |
| Lifetime | until `!endGoal` (which is blocked during tasks) | one kickoff message that opens a dialogue |

So **the goal is the persistent private objective**; **the conversation is the opening line of coordination**. See [doc 03](./03-bot-communication.md) for the conversation machinery.

---

## 5. Privileged / hidden information by task type

"Privileged" = information present in one agent's goal/inventory/recipe but **not** in another's, forcing communication. Concretely:

### Crafting / techtree
- **Private inventory** is the lever. Example (`tasks/multiagent_crafting_tasks.json` → `multiagent_techtree_1_wooden_pickaxe`): agent 0 starts with `oak_planks:10`, agent 1 with `stick:10`. Neither can craft the pickaxe alone; they must trade. Both also have `!collectBlocks` blocked, removing the gather-it-yourself escape.
- The recipe/goal text is usually **shared** (both told "build a wooden pickaxe").

### Cooking — three privilege regimes
1. **Full recipes shared** (e.g. `1_agent_partial.json`, `2_agent_full.json`): every agent's `goal[i]` embeds the full recipe text. Privilege is only the split inventory.
2. **Blocked recipe access** (`blocked_access_to_recipe`): a list of agent indices denied the recipe text. Example `2_agent_block_recipe.json` has `blocked_access_to_recipe: ["0"]` — agent 0's goal is the bare *"Collaborate ... to make golden_apple, bread."* while agent 1's goal contains the **full recipe steps**. Agent 0 must ask agent 1 for instructions.
3. **Hell's Kitchen** (`*_hells_kitchen.json`): a **symmetric swap** — each agent holds the recipe for the dish the *other* must cook, and is explicitly told it may only relay recipe steps, not collect/cook. Example `2_agent_hells_kitchen.json`:
   - `goal["0"]`: *"You need to make **bread**, but you don't have the recipe ... your partner has it! Your partner needs to make **golden_apple**. You have their recipe: [golden_apple steps]. ... You can only guide your partner with recipe steps. You cannot help with ingredient collection or cooking."*
   - `goal["1"]`: the mirror image (has bread recipe, must make golden_apple).
   - The `conversation` seed states the asymmetry outright: *"You are supposed to make golden_apple and I am supposed to make bread, but I only have YOUR recipe and you only have access to MY recipe!"*

   Hell's Kitchen has special server-side bookkeeping: `hellsKitchenProgressManager` (`achievement_hunter/evaluation_harness/task_validators.js:8`) is reset per task in the `Task` constructor (`tasks.js:29-32`) and tracks which agent cooked what, so the validator can enforce "you cooked the dish you were *assigned*, using a recipe you had to be *told*."

### Construction
- **Blueprint + materials split**: per `minecollab.md:69-70`, agents are each given part of the materials and the tool-expertise for *one* material class (e.g. one handles stone, the other wood), so neither can build the whole blueprint alone. The blueprint text itself is appended to both the goal and the conversation seed in the `Task` constructor (`tasks.js:35-44`).

> **Where to look to enumerate privilege for a given task:** compare `goal["0"]` vs `goal["1"]`, the `initial_inventory` split, `blocked_actions` per index, and (cooking) `blocked_access_to_recipe`. There is no separate "hidden state" store — privilege is entirely encoded as per-`count_id` differences in the task JSON, materialized into each agent's goal/inventory at `initBotTask`/`setAgentGoal` time.

---

## 6. The actual initial state of each agent (canonical definition)

Strip away the perception machinery (§1–§2) and the per-agent initial **task state** is five things, all keyed by `count_id`. The first three are the common mental model (objective, inventory, constraints); the last two are easy to miss but matter for design.

### A. An objective (`goal`) — delivered privately, sometimes asymmetric
Injected into the agent's own self-prompt loop via `!goal(...)` (`getAgentGoal`/`setAgentGoal`, `tasks.js:89-177`). It is **not broadcast** — there is no shared-objective channel; each agent receives its own.
- **Shared case:** `data.goal` is a single string → every agent gets the *same* base objective (most crafting/techtree tasks).
- **Asymmetric case:** `data.goal` is an object keyed by `count_id` → each agent gets a *different, possibly partial* objective (cooking, esp. Hell's Kitchen — §5).
- Either way a per-agent **collaboration clause** is appended naming *the other* agents, so even the "shared" goal text is not byte-identical across agents.

### B. An inventory (`initial_inventory[count_id]`)
Actually `/give`-n into the bot in-world at spawn (`initBotTask`, `tasks.js:209-251`). Each agent only knows its **own** contents.

### C. Constraints
- **Blocked actions:** `data.blocked_actions[count_id]` merged with the global `settings.blocked_actions`, plus `!endGoal`/`!endConversation` auto-blocked while a task is active (`tasks.js:61-69`; applied in `agent.js` via `blacklistCommands`). Removed from `$COMMAND_DOCS`, so they don't even appear as options. This encodes **who cannot do what** (e.g. `!collectBlocks` blocked → must rely on a teammate).
- **`restrict_to_inventory`** flag, when set (`tasks.js:67`).

### D. Knowledge (recipes) — a *separate axis* from inventory
What an agent "knows how to make" is given or withheld **independently** of what items it holds. In cooking, recipe text is embedded *inside the goal string*, and `blocked_access_to_recipe` decides whether that agent's goal includes it (§5). This is the lever behind blocked-recipe and Hell's Kitchen tasks — an agent can hold all the ingredients yet lack the recipe, or vice-versa.

### E. Identity / role / teammates
- Its own `count_id` and name; it is teleported next to the others; and it is told the **names of its teammates** (via the collaboration clause and the `available_agents` presence list).
- **Leader asymmetry:** only `count_id 0` seeds the opening conversation (`!startConversation`, `tasks.js:269-284`) and runs one-time world setup (cooking init, human-inventory clearing — §3d). This is the closest thing to a built-in "leader" hook today.

> Underneath these five sits the **perception layer** (§1–§2): the profile/system prompt (persona, rules, full command docs, examples) plus the agent's **live self-observation** (`$STATS`/`$INVENTORY`/nearby blocks) re-injected every LLM call. That's *how* the agent perceives, identical per agent in a run — not task-specific privileged state.

### Canonical statement (use this in design docs)

> Each agent `i` starts with: a private **goal** `goal[i]` (possibly shared, possibly partial); a private **inventory** `inventory[i]` (placed in-world); a set of **constraints** `blocked_actions[i]`; possibly some **recipe knowledge** embedded in its goal; and **identity** (`count_id`, name, teammate names, and — if `i == 0` — the leader/conversation-seeding role). It has **no visibility** into any other agent's goal, inventory, constraints, or knowledge.

### What is explicitly NOT in any agent's initial state (the gaps Phase 1 closes)
Other agents' inventories, other agents' goals (in the asymmetric case), other agents' blocked actions/capabilities, and any recipe withheld from it. There is no shared or global view — all of it must be obtained through the conversation channel ([doc 03](./03-bot-communication.md)).
