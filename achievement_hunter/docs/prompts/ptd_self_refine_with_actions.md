## Objective
The objective is the same as the one used to generate the DAG in the previous message.

---

## Task

Validate and correct the Minecraft DAG that was just generated.

- If incorrect → fix it and return corrected JSON
- If already optimal → respond EXACTLY with:
  DAG already optimal

---

## Core Rules

### Node Rules

For each node:
- must have: id, qty, type

Non-action nodes:
- id = lowercase snake_case

Action nodes:
- allowed ONLY if node == sink
- id = action_name(argument)

---

### Sink Correctness

Let objective = original task

- terminal action (eat, equip, place, use, enter) → sink.type = action
- process (craft, smelt, cook, brew, mine) → sink.type ≠ action
- if both → sink = final action

Action sink:
- must use function format
- argument must be minimal required item

---

## Graph Validity

- graph is acyclic
- all edge references exist
- no unused nodes

---

## Dependencies

Ensure required dependencies exist:
- tools for mining
- workstations for crafting/smelting
- fuel for smelting

No missing or invalid edges

---

## Quantities (CRITICAL)

For each node:
- produced ≥ consumed

For crafted items:

required = Σ(consumed edge qty)  
produced = recipe_output × crafts  

Choose MIN crafts such that:
- produced ≥ required
- produced is minimal

Overproduction allowed ONLY if required by recipe granularity

---

## Recipes

Use correct recipes:

- sticks: 2 planks → 4 sticks
- pickaxe: 3 material + 2 sticks
- furnace: 8 cobblestone

---

## Minimality

- remove unnecessary nodes
- remove redundant crafting
- no extra tools or materials

---

## Edge Semantics

Each edge must include:
- from, to, type, qty, consumed

Rules:
- crafting_input → consumed = true
- smelting_input → consumed = true
- fuel_input → consumed = true
- tool_required → consumed = false
- workstation_required → consumed = false

---

## Assumptions

- keep unchanged unless clearly incorrect