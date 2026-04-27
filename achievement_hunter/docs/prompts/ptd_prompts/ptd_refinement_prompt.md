Repair a candidate JSON graph using:
1. the validation specification
2. the original objective
3. the current candidate graph
4. a validator output with `definite_issues` and `possible_issues`

Goal:
Return a corrected graph that fixes all `definite_issues` while preserving all valid parts of the candidate graph whenever possible.

Core role:
- You are not a second validator.
- Treat `definite_issues` as the repair contract.
- Fix every `definite_issue`.
- Do not independently search for new issues beyond the validator output.
- Ignore `possible_issues` unless a definite repair requires a directly related change.
- Make only the follow-on edits needed to keep the graph valid after repairing the definite issues.

Refinement rules:
- Use the validation specification as the source of truth.
- Preserve valid vertices, edges, and sinks unless they must change to repair a definite issue or maintain consistency after that repair.
- For quantities, preserve them only outside the impacted repair region. For impacted vertices, recompute quantities from the repaired graph state as specified below.
- Prefer local repairs over broad rewrites.
- Do not regenerate from scratch unless the graph is fundamentally unsalvageable.
- Return raw JSON only.
- Do not output explanations, markdown, comments, or chain-of-thought.

How to use validator fields:
- `message` = what is wrong
- `evidence` = where the problem is
- `suggested_fix` = default minimal repair direction
- `repair_scope` = intended repair size: `local`, `local_with_quantity_recompute`, `structural`
- `root_cause_key` = fix grouped issues together
- `affected_vertices` / `affected_edges` = primary repair targets
- `possible_issues` = not repair targets unless a definite repair necessarily touches them

Repair policy:
1. Apply the smallest set of edits needed to fix all `definite_issues`.
2. Start from `affected_vertices`, `affected_edges`, and `suggested_fix`.
3. If multiple `definite_issues` share a `root_cause_key`, resolve them with one coherent repair.
4. Do not modify unrelated valid parts of the graph.
5. Do not clean up beyond what the definite issues require.
6. If a repair changes or removes a vertex or edge, make all necessary follow-on consistency updates.
7. If a repair changes consumed demand, recompute impacted produced quantities and any upstream batch-produced prerequisites affected by that demand change using the quantity recomputation procedure below.
8. Remove invalid or duplicate edges rather than preserving them.
9. Do not introduce new vertices or edges unless required to:
   - fix a definite issue
   - restore completeness after a definite repair
   - restore consistency after a definite repair
10. Preserve `G.objective` exactly.
11. Preserve sink identity unless a definite issue shows the sinks are wrong.

Quantity recomputation procedure:
- After applying all structural, edge, and vertex repairs, freeze the repaired graph state first.
- Identify the impacted subgraph: every repaired target and every upstream producer whose outgoing consumed demand changes because of the repair.
- Recompute impacted quantities from scratch using only the repaired graph state.
- Do not use pre-repair quantities, pre-repair consumed demand, or stale dependency semantics during recomputation.
- For each impacted recipe-produced vertex, recompute required demand as the sum of its outgoing consumed edge quantities in the repaired graph.
- Then set that vertex `qty` to the smallest batch-valid quantity that satisfies the repaired demand.
- If repaired demand decreases, lowering impacted quantities is required repair, not optional cleanup.
- Do not preserve higher pre-repair quantities for impacted vertices if they are no longer required by the repaired graph.
- Keep quantity recomputation scoped to the impacted subgraph.

Quantity policy:
- Change quantities only when:
  - a definite issue explicitly requires it, or
  - a repair changes consumed demand, recipe counts, fuel usage, or prerequisite completeness so quantity updates are necessary.
- When consumed demand changes, recompute impacted quantities upward or downward to the minimum valid batch-sized amounts required by the repaired graph.
- For impacted vertices, minimum valid repaired quantities take precedence over preserving old quantities.

Post-repair checks:
Use these only to ensure the returned graph is self-consistent after the required repairs, not to invent unrelated new repairs.
- no duplicate `(from, to, type)` edges
- graph acyclic
- every sink exists and has no outgoing edges
- every edge endpoint exists
- unique vertex ids
- every vertex satisfies `qty >= sum(outgoing consumed edge qty)` in the repaired graph
- every impacted recipe-produced vertex uses the minimum batch-valid quantity required by the repaired graph
- repaired or affected smelting outputs have `smelting_input`, `fuel_input`, and `workstation_dependency`
- repaired reusable prerequisites use non-consumed dependency edges where appropriate
- all required fields present
- final output is exactly one JSON object with top-level keys `objective`, `sinks`, `vertices`, `edges`

Output:
Return exactly one corrected JSON object `G` and nothing else.

VALIDATION SPEC:
## Validation Spec

Validate candidate JSON graph `G` for objective `O` under Minecraft Java Edition 1.21.6 survival-start rules.

### Output Contract
`G` must be exactly one JSON object with top-level keys:
- `objective`
- `sinks`
- `vertices`
- `edges`

Rules:
- `objective` must equal the input objective exactly.
- `sinks` must be an array of sink vertex ids.
- `vertices` must contain one object per unique vertex id.
- No extra prose, markdown, citations, or non-JSON content may appear.

### Vertices
Vertices must be inventory items only.

Required fields:
- `id`: Minecraft Java Edition 1.21.6 inventory item, lowercase `snake_case`
- `qty`
- `item_type`: `resource | item | tool | workstation`
- `acquisition_dependency`: `water_source | lava_source | mob | none`

Rules:
- `resource` = gathered directly from the world
- `item` = produced, crafted, smelted, or otherwise transformed from other inventory items
- `tool` = reusable tool
- `workstation` = workstation
- `acquisition_dependency` is vertex-local and applies only to obtaining that item itself
- Use `acquisition_dependency` only for required world interactions not represented by inventory-item vertices
- If obtaining an item also requires another inventory item, represent that requirement as an explicit dependency vertex and edge
- Never inherit `acquisition_dependency` from a consumer

Examples:
- `any_log`, `cobblestone`, `raw_iron` -> `resource`
- `any_plank`, `stick`, `iron_ingot` -> `item`
- `bucket` -> `none`
- `water_bucket` -> `water_source`
- `lava_bucket` -> `lava_source`
- `bone` -> `mob`

### Edges
`A -> B` means `A` is required for `B`.

Required fields:
- `from`
- `to`
- `type`
- `qty`
- `consumed`

Allowed types:
- `crafting_input`
- `smelting_input`
- `fuel_input`
- `item_dependency`
- `tool_dependency`
- `workstation_dependency`

Rules:
- `consumed = true` only for `crafting_input`, `smelting_input`, `fuel_input`
- `consumed = false` only for `item_dependency`, `tool_dependency`, `workstation_dependency`
- `workstation_dependency` = required workstation
- `tool_dependency` = required tool
- `item_dependency` = reusable inventory item required for the target but not consumed into it
- `crafting_input` = recipe-based inventory transformation, including 2x2, 3x3, and simple conversions
- No duplicate edges for the same `(from, to, type)`

Examples:
- `bucket -> water_bucket` = `crafting_input`, consumed
- `bucket -> lava_bucket` = `crafting_input`, consumed
- `water_bucket -> obsidian` = `item_dependency`, not consumed

### Sinks
Rules:
- Every sink id must correspond to a vertex
- Every sink must have no outgoing edges
- Multiple distinct required items -> one sink per item
- Multiple copies of the same item -> one sink vertex with aggregated `qty`
- For transformed-item objectives, the sink must be the final transformed item

### Modeling Rules
- Include all required intermediate items, tools, fuel, and workstations
- Recipes craftable in the 2x2 inventory grid do not require `crafting_table`
- If a gathered or dropped item requires a tool, model the gathered item as the vertex and connect the tool with `tool_dependency`
- Never create action, location, or game-event vertices
- If the same item is required in multiple places, use one shared vertex and aggregate quantity

### Smelting Rules
Every smelted output requires:
- `smelting_input`
- `fuel_input`
- `workstation_dependency`

Rules:
- Fuel vertices are acquired inventory items
- `fuel_input.qty` is actual fuel item units consumed

### Quantity Rules
- No fractional crafts
- Respect batch sizes
- For each recipe- or fixed-output-produced vertex, choose the smallest batch-valid quantity such that `produced >= sum(outgoing consumed edge qty)`
- Overproduction is allowed only when forced by batch size
- Non-consumed dependencies are not multiplied unless multiple copies are explicitly required
- Sink quantities are fixed by the objective
- For every vertex: `qty >= sum(outgoing consumed edge qty)`

Example:
- If `any_plank` is consumed by `crafting_table: 4`, `stick: 2`, `wooden_pickaxe: 3`, total demand is 9; if produced in batches of 4, minimum valid `qty` is 12

### Abstract Resource Convention
- Use `any_` only when grouped variants are truly interchangeable for the specific recipe or dependency

Examples:
- `oak_log` -> `any_log`
- `oak_plank` -> `any_plank`

### Assumptions
- Use Minecraft Java Edition 1.21.6 mechanics, recipes, and drops
- Assume a new survival world with no preexisting inventory, storage, infrastructure, or placed workstations
- Do not rely on loot, trading, structures, or chance-dependent shortcuts unless explicitly required

### Graph Integrity
- Graph must be acyclic
- Vertex ids must be unique
- Every edge endpoint must reference an existing vertex id
- All vertex ids must use lowercase `snake_case`

### Objective Correctness
- Sinks must correctly represent the objective
- Required prerequisites must be complete
- Prefer valid, achievable, standard survival-obtainable prerequisite sets
- Prefer the minimally sufficient prerequisite tier when a stronger tier is not required
- Do not mark a graph wrong solely because another valid graph could also satisfy the objective

OBJECTIVE:
`{{OBJECTIVE}}`

CURRENT CANDIDATE GRAPH:
```json
{{CANDIDATE GRAPH}}
````

VALIDATOR OUTPUT:

```json
{{VALIDATOR OUTPUT}}
```