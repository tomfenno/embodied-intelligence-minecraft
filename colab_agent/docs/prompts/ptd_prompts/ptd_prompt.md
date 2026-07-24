## Objective
`O = "{{OBJECTIVE}}"`

---

## Team
`{{WORLD_STATE}}`

The object above is the world state document produced by Phase 1 (the Disclosure Loop): the coordinator's own inventory and blocked actions, and everything learned from each teammate (their reported inventory, blocked actions, and any goal or knowledge differences). Treat it as ground truth about the team's actual current situation — not a fresh-start assumption.

---

## Task
Construct a Directed Acyclic Graph `G`: a plan of atomic actions required to achieve objective `O`, given the team above.

---

## Available Commands
`{{COMMAND_DOCS}}`

This is the complete command vocabulary available to the team, unfiltered by any individual agent's restrictions — those are handled separately, in `eligible_agents` below.

---

## Vertices
Vertices must be atomic actions only — single steps executable by one or more agents using the commands above, never abstract goals, multi-step processes, or intentions. A vertex is atomic if it corresponds to a single command from the list above — if a candidate step would actually require more than one command to carry out, split it into multiple vertices connected in sequence instead.

Vertex fields:
- `id`: short, unique, descriptive `snake_case` slug for the action
- `description`: natural-language description of the action, specific enough that an agent could execute it directly once its dependencies are satisfied
- `eligible_agents`: the agent name(s) who can perform this action, or the literal string `"any"` if every current team member can
- `min_agents`: integer, how many agents must perform this action simultaneously (almost always `1`; use a higher number only when the action genuinely cannot be done by fewer agents at once)

### Determining `eligible_agents`
- Base eligibility on structural, persistent facts from the Team section above: an agent's blocked actions, and any stated goal or knowledge difference (e.g. only one agent knows a recipe, or has been told not to perform a certain action).
- Do **not** restrict eligibility based on who currently holds a particular item, tool, or workstation. Items can be transferred; treat that as freely possible rather than a constraint on who is allowed to act. (A transfer, if one is actually needed, is its own atomic vertex — e.g. `!givePlayer` — not a restriction on a later vertex.)
- If nothing in the Team section distinguishes agents' ability to perform the action, set `eligible_agents` to `"any"`.

---

## Edges
`A -> B` means `A` must be completed before `B` can begin.

Edge fields:
- `from`: source vertex `id`
- `to`: target vertex `id`

That is the entire edge schema — no type, quantity, or consumption bookkeeping. This graph tracks *order*, not *materials*.

---

## Sinks
In the final `G`, each sink is a terminal action whose completion fulfills objective `O`.

Rules:
- If the objective requires multiple independent outcomes, create one sink per outcome.
- A sink must have no outgoing edges — nothing in `G` depends on a sink.

---

## Assumptions
- Use Minecraft Java Edition 1.21.6 mechanics and recipes for reasoning about what an action requires.
- Use the team's actual current inventories, blocked actions, and goals as given above, not a fresh-start assumption.
- Do not track exact item quantities, recipe batch sizes, or aggregate demand — that is deliberately out of scope for this graph. If an action needs an item to exist first, represent that as a prerequisite vertex; do not compute how many.

---

## Constraints
- Represent every required dependency explicitly as a vertex and edge.
- Vertex `id` values must be unique.
- If the same atomic action would be required by more than one downstream vertex, represent it once and connect every dependent to that single vertex — do not create duplicate vertices for the same action.
- Every edge's `from` and `to` must reference an existing vertex `id`.
- All vertex `id` values must use lowercase `snake_case`.
- Do not create duplicate edges. For any `(from, to)` pair, there must be at most one edge in `G`.

---

## Consistency
- The graph must be acyclic.

---

## Procedure

### 1. Interpret the objective
Convert objective `O`, in light of the Team section, into one or more terminal outcomes.

### 2. Seed sink vertices
For each terminal outcome, create a sink vertex and add it to `G.vertices` and `G.sinks`.

### 3. Expand prerequisites until complete
For each vertex `v` (starting from the sinks), determine what must happen before `v` can be performed — this may include information the team is still missing, an item that needs to move from one agent to another, or a preceding action that produces something `v` needs.

For each prerequisite:
- Reuse an existing vertex if the same atomic action is already represented; otherwise create a new vertex.
- Apply the atomicity rule: if a prerequisite would take more than one command to carry out, decompose it into multiple vertices in sequence rather than one coarse vertex.
- Determine `eligible_agents` and `min_agents` for each new vertex as it's created, per the rules above.
- Add the edge from the prerequisite vertex to `v`, unless that exact edge already exists.

Do not stop expanding while any vertex still has an unmet prerequisite that isn't yet represented by its own vertex and edge.

### 4. Return the final graph
Return `G` only after all of the following are true:
- every required prerequisite is represented in `G`
- no vertex is missing a required prerequisite vertex or edge
- every vertex has `eligible_agents` and `min_agents` assigned
- no duplicate vertices or edges exist

---

## Output
Alongside the graph, include a `summary` field: one or two sentences stating what the plan actually is, in plain language (e.g. who gives what to whom, and who ends up performing the terminal action). This is a narrative note for later reference, not a restatement of the graph's structure.

Return exactly one JSON object `G` with this structure:

```json
{
  "objective": "<objective_string>",
  "summary": "<one or two sentence account of the plan>",
  "sinks": ["<sink_vertex_id>"],
  "vertices": [
    {
      "id": "<vertex_id>",
      "description": "<what this action is>",
      "eligible_agents": ["<agent_name>", "..."],
      "min_agents": <integer>
    }
  ],
  "edges": [
    {
      "from": "<vertex_id>",
      "to": "<vertex_id>"
    }
  ]
}
```
