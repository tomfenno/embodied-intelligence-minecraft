## Objective
The objective is the same as the one used to generate the DAG in the previous message.

---

## Task

Validate and correct the Minecraft DAG that was just generated.

- If incorrect → fix it and return corrected JSON
- If already optimal → respond EXACTLY with:
  OPTIMAL

---

## Core Rules

### Node Rules

For each node:
- must have: id, qty, type
- id = lowercase snake_case
- Nodes must represent inventory items only, not actions, locations, or game events.
---

### Sink Correctness

Let objective = original task

- Sink nodes must ecompass every inventory item needed to complete the objective.

---

### Node Correctness

- All nodes reflect modern Java Edition recipes and drops

---

### `any_` Correctness Validation

- Use `any_` resources **if and only if** a valid interchangeable set exists

#### Rules:
- If an `any_` node is used:
  - It must map to a real set of interchangeable Minecraft items
  - All variants must:
    - produce identical outputs
    - have identical dependency chains
    - not change total resource cost
- If no valid interchangeable set exists → replace with a specific item

#### Disallowed:
- Abstracting unique items:
  - `any_crafting_table`, `any_furnace`
- Abstracting non-equivalent variants:
  - `any_fuel` when acquisition paths differ (e.g., coal vs charcoal)
- Invented or vague categories:
  - `any_metal`, `any_tool`

#### Consistency:
- Do not mix `any_` and specific variants for the same resource class
- Each `any_` node must represent a well-defined equivalence class


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