# achievement_hunter/src

Custom utility modules for the Achievement Hunter project. All functions use `snake_case` naming to distinguish them from the base Mindcraft codebase.

---

## prompt_utils.js

### `extract_json(str)`
Extracts the first JSON object or array from an LLM response string. Handles arbitrary text before/after the JSON and markdown code fences.

**Parameters**
- `str` — raw LLM output string

**Returns** — parsed JS object/array, or `null` if no valid JSON found

**Example**
```js
extract_json('Here is the result: {"a": 1} and some trailing text.');
// => { a: 1 }

extract_json('```json\n{"a": 1}\n```');
// => { a: 1 }
```

---

### `save_json(str, file_path)`
Extracts the first JSON object from an LLM response string and writes it to `file_path`. Creates parent directories if they don't exist.

**Parameters**
- `str` — raw LLM output string
- `file_path` — destination file path (relative to project root)

**Returns** — parsed JS object, or `null` if extraction failed

**Example**
```js
const llm_output = await prompter.promptConvo(messages);
const obj = save_json(llm_output, 'achievement_hunter/logs/output.json');
// => { ... } or null
```

---

### `fill_ptd_prompt(objective)`
Fills the `ptd_prompt` template with an objective string. Returns the filled prompt string ready to send to an LLM.

**Parameters**
- `objective` — string describing the Minecraft objective

**Returns** — filled prompt string

**Example**
```js
const prompt = fill_ptd_prompt('Craft a stone pickaxe');
```

---

### `fill_ptd_feedback_prompt(objective, candidate_graph)`
Fills the `ptd_feedback_prompt` template. Used to validate a candidate dependency graph against an objective.

**Parameters**
- `objective` — string
- `candidate_graph` — JS object (dependency graph)

**Returns** — filled prompt string

**Example**
```js
const prompt = fill_ptd_feedback_prompt('Craft a stone pickaxe', graph_obj);
```

---

### `fill_ptd_refinement_prompt(objective, candidate_graph, validator_output)`
Fills the `ptd_refinement_prompt` template. Used to repair a candidate graph using validator feedback.

**Parameters**
- `objective` — string
- `candidate_graph` — JS object (dependency graph)
- `validator_output` — JS object (output of the feedback prompt LLM)

**Returns** — filled prompt string

**Example**
```js
const prompt = fill_ptd_refinement_prompt('Craft a stone pickaxe', graph_obj, validator_obj);
```

---

### `trim_graph_for_scsg(graph)`
Trims a PTD graph down to only the fields required by the scsg prompt, reducing token usage. Strips `item_type` and `acquisition_dependency` from vertices, and `type` from edges.

**Parameters**
- `graph` — JS object (full PTD dependency graph)

**Returns** — trimmed JS object with schema:

```json
{
  "objective": "<string>",
  "sinks": ["<vertex_id>"],
  "vertices": [{ "id": "<string>", "qty": "<int>" }],
  "edges": [{ "from": "<string>", "to": "<string>", "qty": "<int>", "consumed": "<bool>" }]
}
```

**Example**
```js
const trimmed = trim_graph_for_scsg(ptd_graph);
const prompt = fill_scsg_prompt(trimmed, state);

---

### `enrich_subgraph(subgraph, original_graph)`
Restores the fields stripped by `trim_graph_for_scsg` back onto a pruned subgraph, using the original PTD graph as the source of truth. Also adds a `satisfied_inputs` array to each vertex listing any dependencies that were pruned (already satisfied by the bot's current state). Matches vertices by `id` and edges by `(from, to, consumed)`. Warns if a match is not found.

**Parameters**
- `subgraph` — trimmed/pruned subgraph (e.g. scsg output)
- `original_graph` — the original full PTD graph

**Returns** — enriched JS object with full vertex and edge fields restored, plus `satisfied_inputs` on each vertex:

```json
{
  "objective": "<string>",
  "sinks": ["<vertex_id>"],
  "vertices": [
    {
      "id": "<string>",
      "qty": "<int>",
      "item_type": "<string>",
      "acquisition_dependency": "<string>",
      "satisfied_inputs": [
        { "from": "<string>", "type": "<string>", "qty": "<int>", "consumed": "<bool>" }
      ]
    }
  ],
  "edges": [{ "from": "<string>", "to": "<string>", "qty": "<int>", "consumed": "<bool>", "type": "<string>" }]
}
```

`satisfied_inputs` lists the edges from the original PTD graph that pointed to this vertex but whose `from` vertex was pruned (already satisfied by the bot's current state). Empty array if none.

**Example**
```js
const trimmed = trim_graph_for_scsg(ptd_graph);
// ... run scsg to get subgraph ...
const enriched = enrich_subgraph(subgraph, ptd_graph);
```

---

### `fill_scsg_prompt(graph, state)`
Fills the `scsg_prompt` template. Used to compute a state-conditioned subgraph given a dependency graph and current bot state.

**Parameters**
- `graph` — JS object (dependency graph)
- `state` — JS object (bot state, e.g. from `get_inventory_state`)

**Returns** — filled prompt string

**Example**
```js
const state = get_inventory_state(agent);
const prompt = fill_scsg_prompt(graph_obj, state);
```

---

### `fill_scsg_feedback_prompt(task_prompt, candidate_answer)`
Fills the `scsg_feedback_prompt` template. Used to validate a candidate scsg answer. `task_prompt` is typically the output of `fill_scsg_prompt`.

**Parameters**
- `task_prompt` — string (filled scsg prompt)
- `candidate_answer` — JS object (LLM answer to the scsg task)

**Returns** — filled prompt string

**Example**
```js
const task_prompt = fill_scsg_prompt(graph_obj, state);
const prompt = fill_scsg_feedback_prompt(task_prompt, candidate_answer_obj);
```

---

### `fill_scsg_refiner_prompt(task_prompt, previous_candidate, audit_report)`
Fills the `scsg_refiner_prompt` template. Used to repair a candidate scsg answer using audit feedback. `task_prompt` is typically the output of `fill_scsg_prompt`.

**Parameters**
- `task_prompt` — string (filled scsg prompt)
- `previous_candidate` — JS object (previous LLM answer)
- `audit_report` — JS object (output of the feedback prompt LLM)

**Returns** — filled prompt string

**Example**
```js
const task_prompt = fill_scsg_prompt(graph_obj, state);
const prompt = fill_scsg_refiner_prompt(task_prompt, previous_candidate_obj, audit_report_obj);
```

---

### `fill_action_mediator_prompt(task, state)`
Fills the `action_mediator` prompt template with a task object and a state object. Returns the filled prompt string.

**Parameters**
- `task` — JS object (task output from the next task selector LLM)
- `state` — JS object (bot state, e.g. from `get_state`)

**Returns** — filled prompt string

**Example**
```js
const prompt = fill_action_mediator_prompt(task_obj, state_obj);
```

---

### `fill_next_task_selector_prompt(enriched_subgraph, state)`
Fills the `next_task_selector` prompt template with an enriched subgraph object and a state object. Returns the filled prompt string.

**Parameters**
- `enriched_subgraph` — JS object (enriched subgraph, e.g. from `enrich_subgraph`)
- `state` — JS object (bot state, e.g. from `get_state`)

**Returns** — filled prompt string

**Example**
```js
const enriched = enrich_subgraph(subgraph, ptd_graph);
const state = get_state(agent);
const prompt = fill_next_task_selector_prompt(enriched, state);
```

---

### `get_state(agent)`
Returns the full bot state as a plain JS object. Mirrors the `!state` command.

**Parameters**
- `agent` — Mindcraft agent instance

**Returns** — JS object with the following schema:

```json
{
  "position": {
    "x": 0.0,
    "y": 0.0,
    "z": 0.0
  },
  "status": {
    "health": "20/20",
    "hunger": "20/20",
    "biome": "plains",
    "weather": "clear | rain | thunderstorm",
    "time_of_day": "morning | afternoon | night",
    "current_action": "idle | <action_label>"
  },
  "inventory": {
    "<item_name>": "<count>"
  },
  "wearing": ["<item_name>"],
  "craftable_items": ["<item_name>"],
  "nearby_blocks": ["<block_name>"],
  "relative_blocks": {
    "below": "<block_name>",
    "legs": "<block_name>",
    "head": "<block_name>",
    "above_head_solid": "<block_name> (<N> blocks up) | null"
  },
  "nearby_entities": {
    "human_players": ["<player_name>"],
    "mobs": {
      "<mob_name>": "<count>"
    },
    "bot_players": ["<bot_name>"]
  }
}
```

**Example**
```js
import { get_state } from './src/prompt_utils.js';
const state = get_state(agent);
```

---

### `get_inventory_state(agent)`
Returns the bot's inventory and worn equipment as a plain JS object. Mirrors the `!inventoryState` command.

**Parameters**
- `agent` — Mindcraft agent instance

**Returns** — JS object with the following schema:

```json
{
  "inventory": {
    "<item_name>": "<count>"
  }
}
```

Or if the inventory is empty:
```json
{
  "inventory": "Nothing"
}
```

**Example**
```js
import { get_inventory_state } from './src/prompt_utils.js';
const inv = get_inventory_state(agent);
```
