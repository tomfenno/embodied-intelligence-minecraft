## Objective (INPUT)
<INSERT OBJECTIVE HERE>

---

## Task
Construct a Directed Acyclic Graph (DAG) representing the minimal resource and dependency chain required to achieve the objective from a fresh survival start.

---

## Output Format (STRICT)

Return ONLY valid JSON:

{
  "objective": "string",
  "sink": "node_id",
  "nodes": [
    {
      "id": "string",
      "qty": number,
      "type": "raw_resource | crafted_item | tool | workstation | smelted_item | action"
    }
  ],
  "edges": [
    {
      "from": "node_id",
      "to": "node_id",
      "type": "string",
      "qty": number,
      "consumed": boolean
    }
  ],
  "assumptions": {
    "start_state": "fresh survival start",
    "allow_loot": false,
    "allow_trading": false,
    "allow_structures": false,
    "allow_rng_shortcuts": false,
    "optimization_goal": "minimum total required resources",
    "notes": []
  }
}

---

## Definitions

Each node must include:
- "id"
- "qty" = total produced, gathered, or performed
- "type"

- Non-action node "id" must be lowercase snake_case  
- Action node "id" must be: action_name(argument)

Each directed edge (A → B) means:
- A is required to produce or perform B

Node Types:
raw_resource | crafted_item | tool | workstation | smelted_item | action

---

## Node Constraints

### Non-sink nodes
- Must NOT be "type": "action"

### Sink node
- Must represent the true objective outcome

#### Terminal Action Objectives
- Sink MUST be "type": "action" if the objective explicitly requires a terminal action (eat, equip, place, use, enter)
- Argument must be minimal required item/state

Examples:
- eat porkchop → eat(cooked_porkchop)
- equip iron armor → equip(iron_armor)

#### Production / Process Objectives
- Sink MUST NOT be "type": "action" if the objective is a process (craft, smelt, cook, brew, mine)
- Sink must be the resulting item

Examples:
- smelt iron ingot → iron_ingot
- cook porkchop → cooked_porkchop
- craft furnace → furnace

#### Multi-step Objectives
- If both process + action exist:
  - Sink = final action

Example:
- cook and eat porkchop → eat(cooked_porkchop)

---

## Resource Rules

- Include all required intermediate items
- Include tools and fuel when required

### Workstations
- Required via "workstation_required"
- Not consumed

### Tools
- Required via "tool_required"
- Not consumed

### Smelting
- Requires:
  - "smelting_input"
  - "fuel_input"
  - "workstation_required"

### Inventory crafting
- 2×2 recipes do NOT require crafting_table

---

## Quantities (CRITICAL)

- "qty" = total produced (not just consumed)
- No fractional crafting
- Respect recipe outputs

### Recipe Minimality Rule

For each crafted item:

1. required = sum of all consuming edge qty
2. produced = recipe_output × crafts
3. choose MIN crafts such that:
   - produced ≥ required
   - produced is minimal

- Overproduction allowed ONLY if required by recipe granularity

Example:
- sticks: 2 planks → 4 sticks
  - need 4 → 1 craft ✓
  - need 5 → 2 crafts ✓
  - need 4 → 2 crafts ✗

---

## Edge Semantics

Each edge must include:
- "from"
- "to"
- "type"
- "qty"
- "consumed"

Types:
- crafting_input
- workstation_required
- tool_required
- fuel_input
- smelting_input
- other

Consumption:
- true: crafting_input, smelting_input, fuel_input, action use
- false: tool_required, workstation_required

---

## Consistency

- Graph must be acyclic
- produced ≥ consumed for every node

---

## Assumptions

- Fresh survival start
- No loot, trading, structures, or RNG shortcuts

---

## Constraints

- All dependencies must be explicit
- Prefer the simplest valid solution
- Use lowercase snake_case IDs for non-action nodes