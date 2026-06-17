# 06 — What the Tasks Demand & Coordination Structures for Agents

Purpose: understand, by broad category, **what the MineCollab tasks actually require agents to do together**, and use those demands to reason about an **organizational/coordination structure** for the agents (roles, division of labor, who-talks-to-whom). This is intentionally not exhaustive — one or two representative examples per category, focused on the coordination implications.

See [doc 02](./02-initial-agent-state.md) for how privileged info is encoded and [doc 03](./03-bot-communication.md) for the messaging channel these structures run on.

---

## The coordination primitives every task draws from

Across all categories, success requires some subset of these recurring "moves." An org structure is really a policy for *who performs which primitive, when*:

| Primitive | What it is | Forced by |
|---|---|---|
| **State disclosure** | Announce your private inventory / what you hold | split `initial_inventory` per `count_id` |
| **Knowledge disclosure** | Share a recipe/instruction the other agent lacks | `blocked_access_to_recipe`, Hell's Kitchen, blocked `!getCraftingPlan` |
| **Resource transfer** | Hand items to another agent (`!givePlayer`) | no single agent holds all inputs |
| **Consolidation / assembly** | One agent collects inputs and performs the final craft/cook | crafting table ownership; cooking "give to one bot" |
| **Sequencing** | Do dependent steps in order (intermediate → final) | multi-step recipes; "lower levels first" in construction |
| **Spatial partitioning** | Divide a physical region/structure | construction blueprints |
| **Specialization** | Own a material class / tool / dish | construction tool splits; Hell's Kitchen dish assignment |

---

## Category 1 — Crafting / Techtree

**Demand:** assemble one target item whose inputs (and sometimes the recipe knowledge) are split across agents. The world is mostly irrelevant — this is about **trading items and recipe steps**, then having *one* agent (the one with the crafting table) perform the craft.

**Example A — flat resource split (3 agents).** `multiagent_crafting_requires_ctable_dark_prismarine..._num_agents_3`:
- Goal (shared string): "craft a dark_prismarine."
- Inventory: agent 0 = `{prismarine_shard:2, black_dye:1, crafting_table:1}`, agent 1 = `{prismarine_shard:2}`, agent 2 = `{prismarine_shard:4}`.
- Coordination: everyone must funnel shards to the one agent holding the `black_dye` + `crafting_table`. → **a natural collector/crafter** (agent 0) and two suppliers.

**Example B — multi-step dependency + blocked knowledge (2 agents).** `multiagent_crafting_compass_partial_plan_requires_ctable__depth_0` (target `compass`, `max_depth:2`):
- Inventory: agent 0 = `{iron_ingot:2}`, agent 1 = `{iron_ingot:2, redstone:1, crafting_table:1}`.
- `blocked_actions`: agent 0 has `!getCraftingPlan` blocked → it **cannot look up the recipe** and must be told the plan by agent 1.
- Compass = 4 iron + 1 redstone, so inputs must be pooled *and* the multi-step plan sequenced. → one agent is the **knowledge holder + crafter**, the other a **supplier** who also depends on the holder for instructions.

**Coordination demands:** state disclosure → resource transfer → consolidation at the crafting-table owner → (sometimes) knowledge disclosure + sequencing. **Bottleneck = the crafting-table/recipe owner.**

---

## Category 2 — Cooking

**Demand:** produce one or more food items, each requiring multi-step recipes (gather crop/ingredient → process at smoker/furnace/crafting table). Ingredients are split; the world (farm, livestock, stations) supplies raw materials. For >2 agents the rules require **all food handed to one designated collector** (a bot whose name starts with "andy", per `tasks.js:96-104`).

**Example A — shared recipes, split ingredients (3 agents).** `3_agent.json` (`bread` + `golden_apple`):
- Goal (shared string) embeds **both full recipes**.
- Inventory: agent 0 = `{gold_ingot:3}`, agent 1 = `{gold_ingot:3, apple:1}`, agent 2 = `{gold_ingot:3}` (9 gold total; golden_apple needs 8 + 1 apple). Bread's wheat must be **gathered from the farm**.
- Coordination: pool gold to whoever holds the apple, craft golden_apple; someone farms wheat → bread; both delivered to the collector. → **collector + foragers/cooks**.

**Example B — Hell's Kitchen, symmetric knowledge swap (2 agents).** `2_agent_hells_kitchen.json`:
- Each agent is **assigned a dish it does not have the recipe for**, and **holds the other agent's recipe**. It may only *relay recipe steps*, not collect or cook for the partner.
- This forces **bidirectional knowledge disclosure** as a hard gate before any cooking can happen — pure communication task. → **two specialists who must teach each other**, no collector shortcut.

**Variants worth knowing (same category, different demand dial):** `_full` (everyone has all recipes — minimal knowledge sharing), `_partial`/`_block_recipe` (one agent denied a recipe — one-directional teaching), `_hells_kitchen` (symmetric teaching), `_long_timeout` (more time, harder coordination tolerated), `4_agent`/`5_agent` (more suppliers, collector role becomes essential).

**Coordination demands:** knowledge disclosure (variant-dependent) → forage/process in parallel → resource transfer → **single collector** for final hand-off. **Bottleneck = the collector + any recipe monopolist.**

---

## Category 3 — Construction

**Demand:** build a structure matching a blueprint. Materials **and tool/expertise** are split so no agent can build the whole thing. Scored by edit distance to the blueprint (partial credit), so *throughput and correct placement* matter, not just a final craft.

**Example — `pyramid_three_agents` (3 agents, 5-level blueprint).**
- Each agent gets diamond tools **plus a distinct material set**: agent 0 = granite/andesite/diorite (polished), agent 1 = gold/quartz/quartz_pillar, agent 2 = stone_bricks/stone/glowstone.
- The blueprint has 5 `levels` and a `materials` map; the goal says build it, and the Task appends *"place the lower levels first"* (`tasks.js:37-38`).
- Coordination: agents must agree **who places which blocks/regions**, sequence **bottom-up**, and avoid colliding in space. Whoever owns the material a given cell needs must place (or hand off) that block. → **spatial/material specialization with a shared build order**.

**Coordination demands:** specialization (material class) → shared spatial plan (region or level assignment) → sequencing (lower levels first) → occasional resource transfer when one agent's material is needed in another's region. **Bottleneck = agreeing on the partition and the level ordering; physical interference.**

---

## Category 4 — Single-agent / Basic (baseline, no coordination)

`tasks/basic/single_agent.json` (gather oak logs), `tasks/single_agent/crafting_train.json`, and the `1_agent_*` variants in every family. **No coordination primitives** — these are the control/baseline and the natural target for the AH single-agent loop ([doc 04](./04-achievement-hunter-reference.md)). Useful for validating an agent's *individual* competence before layering coordination on top.

---

## What the demands imply for an organizational structure

The tasks cluster into **two coordination archetypes**, which suggests the agent organization should be able to operate in (at least) two modes:

### Archetype A — Converge-to-one (crafting & cooking)
Inputs/knowledge are scattered; success = funnel everything to **one assembler** who performs the terminal action. This maps cleanly to a **coordinator / collector role**:
- **Coordinator (the assembler)** — holds (or is given) the crafting table / is the "andy" collector; tracks the global goal, requests missing inputs, performs final craft/cook, owns the success condition.
- **Suppliers** — disclose inventory, forage/process their part, transfer to the coordinator on request.
- **Knowledge holders** — when a recipe is monopolized (blocked-recipe / Hell's Kitchen), the holder must *teach* before assembly can proceed; in Hell's Kitchen this is mutual, so "coordinator" and "knowledge holder" roles are split across both agents.

The system *already nudges this*: agent `count_id 0` is the host (seeds the conversation, runs cooking-world init — [doc 02 §3d](./02-initial-agent-state.md)), and cooking >2 designates "andy" as collector. A natural design is to **make `count_id 0` (or the table/recipe owner) the elected coordinator**.

### Archetype B — Partition-and-parallelize (construction)
Work is spatially divisible and specialization is imposed by material/tool ownership. This maps to **functional/spatial roles with a light plan-sync**:
- A **planner** (again likely `count_id 0`) proposes a partition (by region or by level) and the bottom-up build order.
- Each agent is a **specialist builder** for its material class, executing within its assignment, requesting a block hand-off when a cell needs a material it lacks.

### The cross-cutting requirement: an opening sync round
Every collaborative task begins with **hidden state** (private inventory; sometimes private recipes). A structure that **front-loads a disclosure round** — each agent announces inventory + known recipes/abilities before work starts — directly attacks the dominant failure mode (acting before anyone knows who has what). This is application logic the colab loop must add; the infrastructure (the socket relay, [doc 03](./03-bot-communication.md)) already supports it. Note the current default for >2 agents is *pairwise sequential* conversation (`tasks.js:114-116`), so a disclosure round has to be orchestrated deliberately (e.g., coordinator polls each agent in turn).

### Suggested minimal role set to design against
1. **Coordinator** — elected (default `count_id 0` / table or recipe owner). Maintains the shared goal/plan, runs the disclosure round, assigns subtasks, is the assembly/collection point. (For Hell's Kitchen, coordination is symmetric — both agents coordinate.)
2. **Specialist / Worker** — executes its slice (gather, craft-intermediate, build-region) and reports completion + transfers outputs.
3. **Knowledge broker** — any agent holding info another needs; obligated to disclose on request (or proactively in the opening round).

These three roles, plus the opening disclosure round and a per-archetype assignment policy (converge-to-one vs partition-and-parallelize), cover every collaborative task family above. The next design step is choosing **how roles are elected and how the plan/assignments are represented and synced** — see the open questions in [doc 05 §5](./05-interface-points-for-new-agent.md).

---

## Quick reference: demand profile per category

| Category | Split | Knowledge gate | Terminal action | Best-fit archetype | Key role |
|---|---|---|---|---|---|
| Crafting/techtree | inventory (+ sometimes recipe) | sometimes (blocked plan) | one final craft | Converge-to-one | crafter/coordinator (table owner) |
| Cooking | ingredients (+ recipe variants) | variant-dependent (none → 1-way → mutual) | hand all dishes to collector | Converge-to-one | collector ("andy" / `count_id 0`) |
| Construction | materials + tools/expertise | none (blueprint shared) | place all blocks (partial credit) | Partition-and-parallelize | planner + material specialists |
| Single/basic | none | none | individual goal | n/a (solo) | — |
