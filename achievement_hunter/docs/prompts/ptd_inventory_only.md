## Objective (INPUT)
<INSERT OBJECTIVE HERE>

---

## Task
Construct a Directed Acyclic Graph (DAG) representing the minimal resource and dependency chain required to achieve the objective from a fresh survival start in modern Minecraft Java Edition.

---

## Output Format (STRICT)

Return ONLY valid JSON:

{
  "objective": "string",
  "sink": ["node_id"],
  "nodes": [
    {
      "id": "string",
      "qty": number,
      "type": "raw_resource | crafted_item | tool | workstation | smelted_item "
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
- "id" = a minecraft inventory item
- "qty" = total produced, gathered, or performed
- "type"

- Non-action node "id" must be lowercase snake_case  

Each directed edge (A → B) means:
- A is required to produce or perform B

Node Types:
raw_resource | crafted_item | tool | workstation | smelted_item

---

## Node Constraints
- Nodes must represent inventory items only, not actions, locations, or game events.

### Sink node(s)
- Must represent the inventory required to complete the true objective.
- If there are multiple needed items for the true objective then there must be a sink node for every item.

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

- Fuel nodes represent acquired items, and fuel_input qty represents actual item units consumed to satisfy the smelting requirement.

### Inventory crafting
- 2×2 recipes do NOT require crafting_table

### Abstract Resource Convention

* Resource IDs may use the prefix `any_` to represent a class of interchangeable items.
* `any_` nodes denote **abstract resource types** where any valid in-game equivalent satisfies the requirement.

#### Rules:

* `any_` resources must only be used when all valid variants:

  * are functionally identical for the objective
  * do not change total resource cost or dependency structure

* Do NOT include specific variants (e.g., `oak_log`, `spruce_log`) when an `any_` version is used
* Downstream crafted items should remain unchanged unless they are also interchangeable
* Prefer any_ abstraction over choosing an arbitrary specific variant whenever variants are interchangeable and cost-equivalent.

#### Examples:

* `any_log` → represents any overworld log (oak, birch, spruce, etc.)
* `any_planks` → represents any plank type derived from logs
* `any_fuel` → represents any valid smelting fuel *only if* fuel choice does not affect total resource minimality

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

- Modern Java Edition recipes and drops
- Fresh survival start
- No loot, trading, structures, or RNG shortcuts

---

## Constraints

- All dependencies must be explicit
- Prefer the simplest valid solution
- Use lowercase snake_case IDs 