# `structured_loop/` — Structured Planning Loop (SPL)

This directory implements the **Structured Planning Loop** (SPL), the deterministic
control loop that drives an Achievement Hunter (AH) agent from an initial
state to a completed Minecraft objective. It is the runtime entry point for
executing a Primary Task DAG (PTD) against a live `mineflayer` agent.

This document is written for future LLMs that need to read or modify code
here. Read it before changing anything in this directory.

---

## 1. High-level picture

Given:
- A **PTD graph** (`graph.json`) — a DAG of items/resources/tools with typed
  edges (`crafting_input`, `smelting_input`, `fuel_input`,
  `workstation_dependency`, `tool_dependency`, `item_dependency`) leading to
  one or more `sinks` (the objective items).
- A live `agent` (a `mineflayer` bot wrapper).
- A models bundle (currently only `models.failure_replanner` is used).

The loop repeatedly:

1. Computes a **State-Conditioned Sub-Graph (SCSG)** — the part of the PTD
   that is *not yet satisfied* by the current inventory.
2. Builds **source candidates** — vertices in the SCSG that have all of their
   incoming dependencies already satisfied (i.e., have no remaining incoming
   edges inside the SCSG).
3. **Selects one task** from those candidates via a tiered priority policy.
4. Executes the task. Most tasks are **mediated into a single bot command**
   (`!collectBlocks`, `!craftRecipe`, `!smelt_item`, `!attack`, `!useOn`,
   `!placeHere`, or `!search…`). One task type, `'search_sweep'` (emitted
   by tier 4 when no immediate craft / collect / interact is available),
   is inherently multi-command and bypasses mediation — it runs a
   breadth-first sweep of `!searchForBlock` / `!searchForEntity` across
   every eligible resource candidate at each radius, returning success the
   moment any one is found and reached.
5. If a `!search` exhausts all radii without finding the target (or if the
   sweep exhausts every candidate at every radius), the **search
   replanner** (an LLM) is invoked — it proposes a short navigation-only
   plan (`!goToCoordinates`, `!digDown`, `!goToSurface`, `!search`) to
   relocate the bot. For sweep exhaustion, the full list of exhausted
   candidates is passed to the replanner so the LLM can pick a relocation
   strategy that helps any one of them. If any candidate ends up in
   nearby state, control returns to the inner attempt loop. If the
   replanner exhausts or hits a pathfinding-class failure, fall through
   to step 6.
6. If the command fails after inner retries (or step 5 fell through), the
   **failure replanner** (an LLM) is invoked to propose a short corrective
   action sequence.
7. Loops until SCSG is empty (all sinks satisfied), or until
   `max_outer_retries` (10) consecutive failures are accumulated, or until
   `recover_failed_task` returns `fail` after a hard error.

The loop is otherwise fully deterministic: there is **no LLM in the happy
path**. The LLMs are only consulted on failure — search replanner on
search exhaustion, failure replanner on any other recoverable command
failure.

---

## 2. File-by-file

### `loop.js` — the outer driver

`structured_loop(models, agent, task_name, graph?)`

- Loads a PTD graph either from disk (default; `load_graph = true` is
  hardcoded and intentional — do not "fix" it) or by calling
  `generate_primary_task_dag_self_refined`.
- Persists a checkpoint of the graph via `save_checkpoint`; clears it on
  successful completion.
- Subscribes to `bot.on('death', …)`. On death, the loop sets a
  `death_pending` flag, awaits respawn + a 500 ms settle delay, then
  *continues* without counting the death as a consecutive failure.
- The main loop body, per iteration:
  1. `build_state_conditioned_subgraph(graph, agent, log)` →
     calls `compute_scsg(graph, inventory)` from `../scsg.js`.
     - `result.r === 2` ⇒ all sinks satisfied → log `complete` and return.
     - Otherwise build a sub-graph `{objective, sinks, vertices, edges}`.
     - Empty `vertices` ⇒ also complete.
  2. `get_source_candidates(subgraph, original_graph, agent, log)` →
     for each subgraph vertex with no remaining incoming subgraph edges,
     produce a candidate object containing:
     - `id`, `qty`, `item_type`, `acquisition_dependency`
     - `satisfied_inputs` — edges that are in `original_graph` but **not** in
       the current subgraph (i.e., inputs the bot already has)
     - `source_hint`, `source_kind`, `grounded_nearby_source` — derived from
       `mc_sources.js`
  3. `get_next_task(candidates, agent, log)` → calls `select_next_task`
     (see `tasks.js`); on success, fires `log.task(task)` which both records
     a `TASK` stage in the rollout trace and resets the live AM history so
     the "Current Action" panel only shows attempts belonging to this task.
  4. `execute_task_action(task, agent, log, models.failure_replanner, graph)`
     — see `actions.js`. Returns `'success'` or `'fail'`.
- Tracks `consecutive_failures`; aborts after `max_outer_retries = 10`.

**Critical invariants:**

- A returned task of `null` from `select_next_task` counts as a consecutive
  failure but does **not** abort immediately — the loop re-evaluates SCSG
  (the agent may have moved/found something new).
- Death resets `consecutive_failures` to 0 — it is treated as an external
  perturbation, not a logical failure.

### `graph.js` — graph helpers

Pure helpers, no I/O, no state:

- `build_incoming_edge_map(edges)` — `Map<vertex_id, edge[]>`.
- `edge_key(from, to, type)` — canonical string key for set membership.
- `edge_in_subgraph(edge, set)` — membership test against an edge-key set.
- `get_satisfied_inputs_by_type(candidate, type)` — pull `{item, qty}` from a
  candidate's `satisfied_inputs` for a given edge type.
- `get_single_satisfied_input_item(candidate, type)` — the first such item
  name, or `null`.
- `resolve_concrete_craft_target(candidate_id, craftable_items)` — if
  candidate is an abstract class (`any_*`), pick the first member that the
  bot can craft right now; otherwise return the id if craftable.

### `tasks.js` — tiered task selection

`select_next_task(candidates, state)` runs **four tiers** in order; the first
to produce a task wins.

| Tier | What it tries                                              | Helper                              |
|------|------------------------------------------------------------|-------------------------------------|
| 1    | Crafting / smelting (only items, tools, workstations)      | `try_make_craft_task` / `try_make_smelt_task` |
| 2    | Immediate nearby acquisition for `resource` candidates     | `try_make_immediate_acquisition_task` |
| 3    | Interaction tasks (tool-on-target, e.g. shears on pumpkin) | `try_make_interact_task`            |
| 4    | Multi-target search sweep for `resource` candidates        | `make_fallback_search_sweep_task`   |

This ordering encodes "always cash in already-collected inputs before going
out to gather more". A task object looks like:

```js
{
  target_item: 'oak_planks',
  qty: 10,
  action_type: 'craft' | 'collect' | 'smelt' | 'kill' | 'interact' | 'search_sweep',
  parameters: { … },
}
```

`itemish_types` is `{'item', 'tool', 'workstation'}` — only these can be
crafted/smelted.

**Tier 4 behavior** has changed from the legacy single-target fallback:
`make_fallback_search_sweep_task` collects **every** eligible resource
candidate's fallback source into a single `'search_sweep'` task. The
sweep handler in `actions.js` tries each source in breadth-first order
across radii. Any one success exits and the SPL outer loop's next
iteration resolves the found target via tier 2. Only if every source
exhausts at every radius does the search_replanner get invoked (with the
full list, per the multi-target search_replanner contract). The legacy
`make_fallback_acquisition_task` is still exported and is used
internally by the sweep builder to derive each per-target source.

### `actions.js` — task execution + inner retry loop

`execute_task_action(task, agent, log, model, graph, model_search_replanner, breadcrumb_tracker)`
is the inner workhorse. It runs up to `max_inner_retries = 5` attempts on a
single task and returns `'success'` or `'fail'`.

**Sweep dispatch (at the top of the function):** if `task.action_type ===
'search_sweep'`, `execute_task_action` immediately delegates to
`handle_search_sweep` and returns. Sweep tasks bypass the per-attempt
mediation loop entirely — see `handle_search_sweep` below.

**Mediation** (`mediate_action(task, state)`) turns a task into a single bot
command via one of:

- `mediate_collect` — emits `!collectBlocks(...)`, `!useOn(...)` for
  environmental-use targets (e.g. lava bucket), or `!search(...)` if the
  source block isn't nearby.
- `mediate_kill` — `!attack(...)` if mob is in `nearby_entities.mobs`, else
  `!search(...)`.
- `mediate_craft` — `!craftRecipe(target, ceil(qty/batch_size))`.
- `mediate_smelt` — `!smelt_item(input, qty[, fuel])`. Fuel resolution
  expands abstract fuels (`any_plank` etc.) via `ABSTRACT_CLASS_MEMBERS`.
- `mediate_interact` — `!placeHere(target)` if target already in inventory
  (intentional behavior, see comment), else `!useOn(tool, target)` if nearby,
  else `!search(target)`.

**Per-attempt flow:**

1. `mediate_action` → command.
2. Snapshot a `trace_step` (state + action).
3. If command is a `!search`, route through `handle_search_action`
   (see `search.js`). On `search_exhausted`, first delegate to
   `recover_failed_search` (see `search_replanner.js`) — if it returns
   `'success'` the bot has been relocated and the inner loop `continue`s
   to retry mediation with the new state. Only if the search replanner
   also fails do we mark the target seen and break out to the
   `failure_replanner` path. On `search_success` or
   `search_found_not_reached`, continue (the bot may have moved and a
   follow-up attempt may now succeed).
4. Otherwise call
   `executeCommandWithModeRecovery(agent, action.command)` from
   `../command_utils.js`.
5. Success path:
   - For `interact` tasks: `handle_interact_success` checks whether the
     interaction satisfied the target; if not, but the target is now a
     collectable nearby block (e.g. interact spawned a block), it injects a
     follow-up `!collectBlocks` step before yielding.
   - For craft/smelt commands: sleep `craft_debounce_ms = 750` to let the
     inventory slot update event fire.
   - `finalize_task_trace(..., 'success', 'completed', …)` and return
     `'success'`.
6. Failure path:
   - Compute a stable `failure_signature` — for mode-interrupted failures
     this is `${command} || mode_interrupted:${sorted_mode_names}` so that
     per-attempt varying counts/positions don't defeat de-duplication.
   - Track `repeated_failure_count` for that signature.
   - `should_abort_repeated_failure` short-circuits if (a) a mode-interrupted
     failure occurs even once (1 mode interrupt already = 5 internal
     livelocked firings — fix B for BUG 15), or (b) a `!craftRecipe` fails
     twice with `Event updateSlot:0 did not fire within timeout`.
   - On abort or after exhausting `max_inner_retries`: `finalize_task_trace`
     with status `'fail'`. If `model` is provided and the failure is
     "recoverable" (`RECOVERABLE_FAILURE_KINDS`: `command_failure`,
     `mode_interrupted`, `unstructured_failure_result`, `runner_exception`,
     `unexpected_action_kind`), invoke `recover_failed_task` and return its
     result. Otherwise return `'fail'`.

**Baseline inventory:** `actions.js` snapshots inventory at task entry. All
`get_recovery_trace_state(agent, baseline)` calls render *deltas* relative to
that baseline so the failure replanner does not get confused by prior tasks
having already pushed an item's absolute count above `task.qty` (BUG 11
mitigation).

**Trace persistence (`persist_task_trace`):**

- Every finalized task trace appended to:
  - `<rollout_dir>/task_traces/full_task_trace.jsonl`
  - `<rollouts_root>/_datasets/{success|failure}_task_traces.jsonl`
- Failed traces additionally written as standalone pretty-printed JSON to
  `<rollout_dir>/task_traces/failed/<timestamp>__<action_type>__<target>__fail.json`.

**`handle_search_sweep(task, agent, log, model, graph, model_search_replanner, breadcrumb_tracker)`:**

Handles `action_type: 'search_sweep'` tasks (emitted by tier 4 in
`tasks.js`). The whole sweep is a single inner-loop attempt — it never
enters the `max_inner_retries` for-loop. Flow:

1. Maps `task.parameters.targets` → `sources` (string array of block /
   mob / abstract names).
2. Records a single summary step in the task_trace with action
   `search_sweep([...sources])`.
3. Calls `run_breadth_first_sweep(sources, agent, log, searched_targets, 0)`
   (see `search.js`).
4. **Success path**: `{found: true, source, item, ...}` returned →
   summary step result `'sweep_target_found'` → `terminal_reason:
   'sweep_target_found'` → returns `'success'`. The SPL outer loop's
   next iteration resolves the found target via tier 2.
5. **Exhaustion path**: `{found: false, sources_exhausted: [...]}` →
   step result `'sweep_exhausted'` → if `model_search_replanner` and
   `breadcrumb_tracker` are wired, invokes
   `recover_failed_search(sources_exhausted, ...)` with the **full**
   exhausted list. On replanner success → `terminal_reason:
   'sweep_replanner_relocated'` → returns `'success'`. On replanner
   fail (or null model) → finalizes as fail and optionally falls
   through to `failure_replanner` (mirrors the existing
   `exhausted_inner_retries` path for non-sweep tasks).

**Per-source outcomes:** the sweep step's result carries a
`per_source_outcomes` map (`source → 'found_reached' | 'found_not_reached'
| 'exhausted' | 'soft_skipped' | 'not_attempted'`). This is surfaced to
the failure_replanner LLM via `project_failed_steps` so it can distinguish
exhausted-at-max-radius sources from pathfinder-fail sources when planning
recovery.

**`searched_targets` interaction:** the sweep maintains its own per-call
`searched_targets` Set, distinct from the per-attempt set used by the
non-sweep `search_exhausted` branch. Inside the breadth-first helper,
sources are added to the set as they hit `found_not_reached`,
`soft_skipped`, or full-radius exhaustion — preventing redundant search
issuance within the same sweep.

### `breadcrumbs.js` — exploration map

`BreadcrumbTracker` maintains a spatial map of where the bot has been
during a rollout. Sampled at 1 Hz; a new breadcrumb is recorded only when
the bot is at least `BREADCRUMB_MIN_DIST = 24` blocks (horizontal) from
every breadcrumb currently held. Capacity is split across two pools:

- **Recent pool** (FIFO, size 16) — preserves the current trajectory.
- **Landmark pool** (score-ranked, size 48) — preserves diverse waypoints.

When a breadcrumb ages out of the recent pool it is *offered* to the
landmark pool: if its score
(`biome_rarity + block_novelty + spatial_isolation`) beats the weakest
current landmark, it swaps in. Otherwise it is discarded. Total cap is
64 breadcrumbs, so the prompt token budget is bounded.

Each breadcrumb stores `{x, y, z, biome, nearby_block_kinds,
nearby_mob_kinds}`. **No timestamp** — the collection is treated as a
spatial map, not a temporal trail. Pool membership is implicit; FIFO
behavior in the recent pool relies on array insertion order.

`get_breadcrumbs()` returns `RECENT ++ LANDMARKS` sorted by horizontal
distance from the bot's current position (closest first). The LLM and
the live dashboard never see the two-pool internal structure.

**Lifecycle (owned by `loop.js`):**

- Constructed and `start()`ed before the main `while`.
- `restore(list)` is called immediately after construction if the SPL
  checkpoint contains a matching-objective breadcrumb list (crash
  resume).
- `reset()` is called from `on_death` (post-respawn the bot is at a fresh
  spawn location; old breadcrumbs no longer correlate with the search
  space).
- `stop()` is called in the `finally` block.

**Persistence:**

- Each outer loop iteration:
  - `<rollout_dir>/breadcrumbs.json` is overwritten with the flat list
    via `log.breadcrumbs(...)`.
  - The SPL checkpoint is re-written with the current breadcrumbs as the
    third field so a process crash can resume the map.
- `rollout_live/current_breadcrumbs.md` is updated by the rollout logger
  with a sorted-by-distance markdown table.

### `search.js` — search command handling

- `parse_search_command(action)` — extracts the target from `!search("X")`.
- `run_search(target, state, agent, log, start_attempt)` —
  expands the target via `expand_search_item` (notably `any_log` → list of
  log block names), fast-paths if already in state, then sweeps radii
  `[32, 64, 128, 256, 511]` issuing `!searchForBlock(...)` for blocks or
  `!searchForEntity(...)` for mobs. Single-target.
- `run_breadth_first_sweep(sources, agent, log, searched_targets, start_attempt)`
  — multi-target sweep used by `handle_search_sweep`. Outer loop iterates
  radii; inner loop iterates sources at each radius (breadth-first). Returns
  `{found: true, source, item, message, outcomes}` on the first reached
  target, or `{found: false, sources_exhausted, outcomes}` after every
  source exhausts at radius 511. Unsupported abstracts (those that
  `expand_search_item` throws on) are soft-skipped with `spl.warn` — sweep
  continues with the remaining sources. `found_not_reached` for a source
  removes it from the active set (bigger radii won't help — pathfinder
  failure is the issue, not search radius).
- `check_search_complete(target, state)` — was the target found nearby after
  the search?
- `is_entity_target(target)` — uses `mob_search_targets` from `mc_sources.js`.

Failure replanner uses `run_search` (single-target) for its `!search`
actions. Search replanner uses `run_search` internally for one-shot
`!search(target)` actions in its plans. Only `handle_search_sweep` (in
`actions.js`) uses `run_breadth_first_sweep`.

### `trace.js` — trace shape helpers

Tiny formatters used by both `actions.js` and `failure_replanner.js`:

- `create_step_result(success, kind, message)` — canonical step result shape.
- `create_command_success_result(result)` — success wrapper.
- `create_action_result(command, success, kind, message)` — replanner-side.
- `project_failed_steps(steps)` — projects the failed steps of a trace into
  the slim form sent to the replanner LLM. Surfaces
  `mode_interrupt_counts`, `position_before`, `position_after` for
  mode-interrupted steps so the LLM can reason about which mode (typically
  `unstuck`) is blocking progress and pick a relocation (BUG 15).

### `log.js`

Single helper `make_spl(tag)` returning `{log, warn, error}` wrappers around
`console.*` with a fixed `[SPL]` tag prefix.

### `failure_replanner.js` — LLM-driven recovery

Invoked from `actions.js` once a task has failed *and* the failure kind is
recoverable. Up to `MAX_RECOVERY_ATTEMPTS = 3` LLM rounds, each producing up
to 8 actions; each action is retried up to `MAX_ACTION_RETRIES = 3`.

**Flow:**

1. Load `actions_reference.json` (from
   `achievement_hunter/docs/prompts/failure_replanner/`) — the menu of legal
   recovery actions (`!stop`, `!goToCoordinates`, `!search`, `!moveAway`,
   etc.) with constraints.
2. `ensure_safe_before_llm(agent)` — if the bot is in water/lava, escape
   first so the LLM call doesn't time out while the bot is dying. Races with
   `self_preservation` mode are caught and logged.
3. `fill_failure_replanner_prompt(failed_trace, previous_diagnoses,
   available_actions)` — builds the prompt (template in
   `achievement_hunter/docs/prompts/failure_replanner/failure_replanner.md`).
4. `model.send_prompt(prompt)` → JSON `{diagnosis, actions: [{name, args}]}`.
   Parsed by `extract_json` and validated by `validate_replanner_output`
   (exactly two top-level keys; `actions` is a non-empty array ≤ 8 of
   allowed-name objects with array `args` of primitives).
5. Execute the action sequence:
   - `format_action_as_command({name, args})` → `!name(arg, arg, …)`.
   - `!search` actions go through `run_search_action`, sharing
     `searched_targets` across attempts so the LLM can't loop on a search
     that already failed.
   - Other actions go through `executeCommandWithModeRecovery` + a 750 ms
     debounce.
   - After every action, `scsg_task_complete_check(task, graph, agent)`
     recomputes SCSG from the live inventory and returns `success` *as soon
     as* the task's `target_item` is no longer in the remaining SCSG
     vertices (or all sinks are satisfied). This lets recovery short-circuit
     mid-sequence if an unrelated side-effect satisfied the goal.
   - `HARD_FAILURE_KINDS` (`runner_exception`, `invalid_command`,
     `unavailable_action`, `search_exhausted`, `search_already_attempted`)
     terminate the action sequence (and the recovery loop) immediately.
6. If the sequence finishes without success, build a *new* failed trace from
   the executed actions and feed it back to the next attempt with the
   accumulated `previous_diagnoses` so the LLM doesn't propose the same fix
   twice.

**No rollout artifact in this repo currently contains a failure-replanner
trace** — every rollout in `rollouts/` exited via the deterministic happy
path. To understand the shape of replanner I/O, read
`achievement_hunter/docs/prompts/failure_replanner/failure_replanner.md`,
`actions_reference.json`, and the JSON envelope validated by
`validate_replanner_output` above.

### `search_replanner.js` — LLM-driven search recovery

Invoked from `actions.js` when an in-task `!search` exhausts its full
511-block radius. Tries to relocate the bot to a position where the
target is in nearby state. Up to `MAX_SEARCH_REPLANNER_ATTEMPTS = 3`
LLM rounds, each producing up to `MAX_ACTIONS_PER_PLAN = 10` actions;
each action is retried up to `MAX_ACTION_RETRIES = 2`.

Reaches into `failure_replanner.js` for two shared helpers
(`format_action_as_command`, `ensure_safe_before_llm`) so the two
replanners stay aligned on bot-command serialization and pre-LLM
safety escapes.

**Flow:**

1. Load `actions_reference.json` (from
   `achievement_hunter/docs/prompts/search_replanner/`) — exactly four
   navigation actions (`!goToCoordinates`, `!search`, `!digDown`,
   `!goToSurface`). No collection, crafting, smelting, or combat.
2. Build a search trace via `get_search_trace_state(agent, tracker)` —
   `world` / `self` / `inventory` / `nearby` / `craftable_items`
   (absolute inventory counts, no baseline delta) **plus** the
   breadcrumb map.
3. `ensure_safe_before_llm(agent)` then send the prompt
   (template in `achievement_hunter/docs/prompts/search_replanner/search_replanner.md`).
4. LLM returns `{summary, actions: [{name, args}, …]}` validated by
   `validate_search_replanner_output` (exactly two top-level keys; 1..10
   actions; allowed-name only; primitive args).
5. Execute the action sequence:
   - `!search` actions go through `run_search_action` with a per-plan
     `searched_targets` set — same target searched twice in one plan
     short-circuits to `search_already_attempted`.
   - Other actions go through `executeCommandWithModeRecovery` + a
     750 ms debounce.
   - **After every action, `target_now_in_nearby(target, agent)`** is
     the win condition. Returns `'success'` and exits as soon as the
     target appears in nearby state — catches both `search_success` and
     incidental encounters (e.g. a `!digDown` that breaks through to
     the target).
   - `PLAN_TERMINATING_KINDS` (`invalid_command`, `unavailable_action`,
     `search_already_attempted`) end the current plan but the outer
     attempt loop continues with the LLM summary appended to
     `previous_summaries`.
   - **`is_pathfinding_failure(result)`** (D11): `mode_interrupted`,
     `runner_exception`, or `command_failure` matching
     `/no path|PathStopped|Could not find a path/i` bails the entire
     recovery and returns `'fail'`. `actions.js` then routes the
     original task to `failure_replanner` via its existing
     fall-through.
6. If the sequence finishes without a `target_now_in_nearby` hit, push
   `{attempt, summary, actions}` to `previous_summaries` and loop.

**Rollout logger integration:** uses dedicated `log.search_recovery_*`
methods that maintain a parallel `live_state.search_recovery` field so
search-replanner activity is distinguishable from failure-replanner
activity in the rollout trace, the dashboard, and
`build_rollout_summary` (separate `search_recovery_attempts` counter).
The live dashboard's third row overrides candidates+am with
search-recovery panels when active; a dedicated standalone view is
written to `rollout_live/current_search_recovery.md`. All clears back
to placeholder on `search_recovery_end`.

**Persistence (`persist_search_trace`):**

- Every search-replanner invocation appended to:
  - `<rollout_dir>/search_traces/full_search_trace.jsonl`
- Failed invocations additionally written as standalone pretty-printed
  JSON to
  `<rollout_dir>/search_traces/failed/<timestamp>__<target>__fail.json`.

Trace shape: `{target, task, started_at, ended_at, terminal_status,
terminal_reason, attempts, initial_state, final_state}`. Each entry in
`attempts` is `{attempt, summary, plan_actions, results}`.

---

## 3. Data model summary

### PTD graph (input)

```jsonc
{
  "objective": "Smelt an iron ingot.",
  "sinks": ["iron_ingot"],
  "vertices": [{ "id": "iron_ingot", "qty": 1, "item_type": "item",
                 "acquisition_dependency": "none" }, …],
  "edges":    [{ "from": "raw_iron", "to": "iron_ingot",
                 "type": "smelting_input", "qty": 1, "consumed": true }, …]
}
```

`item_type` ∈ `{item, tool, workstation, resource}`.
`acquisition_dependency` ∈ `{none, mob, water_source, lava_source, …}`.
Edge `type` ∈ `{crafting_input, smelting_input, fuel_input,
workstation_dependency, tool_dependency, item_dependency}`.

### Candidate (loop ↔ task selector)

```jsonc
{
  "id": "stone_pickaxe", "qty": 1,
  "item_type": "tool", "acquisition_dependency": "none",
  "satisfied_inputs": [
    { "item": "stick", "qty": 2, "type": "crafting_input", "consumed": true },
    …
  ],
  "source_hint": "...", "source_kind": "...", "grounded_nearby_source": "..."
}
```

### Task (selector → mediator)

```jsonc
{
  "target_item": "oak_planks",
  "qty": 10,
  "action_type": "craft",
  "parameters": {
    "crafting_inputs": [{ "item": "any_log", "qty": 3 }],
    "workstation": null
  }
}
```

### Search-sweep task (selector → `handle_search_sweep`)

Emitted by tier 4 when no immediate craft / collect / interact is
available and one or more resource candidates need to be searched for.
Carries the **full** list of eligible targets so the sweep handler can
try them breadth-first across radii. The top-level `target_item` is set
to `targets[0].target_item` so existing trace/filename machinery
(`persist_task_trace`) keeps working unchanged.

```jsonc
{
  "target_item": "oak_log",         // first target — canonical id
  "action_type": "search_sweep",
  "parameters": {
    "targets": [
      { "target_item": "oak_log", "source": "any_log", "kind": "block", "qty": 3 },
      { "target_item": "stone",   "source": "stone",   "kind": "block", "qty": 11 },
      { "target_item": "iron_ore","source": "iron_ore","kind": "block", "qty": 3  }
    ]
  }
}
```

### Task trace (persisted)

```jsonc
{
  "objective": "Smelt an iron ingot.",
  "task": { … the task from above … },
  "terminal_status": "success" | "fail",
  "terminal_reason": "completed" | "exhausted_inner_retries"
                   | "repeated_identical_failure"
                   | "sweep_target_found"         // search_sweep: one source resolved
                   | "sweep_replanner_relocated"  // search_sweep: sweep failed, replanner succeeded
                   | "sweep_exhausted"            // search_sweep: everything failed
                   | …,
  "steps": [
    { "i": 1,
      "state": { /* recovery_trace_state at step start */ },
      "action": "!collectBlocks(\"oak_log\", 3)",
      "result": { "success": true, "kind": "command_success",
                  "message": "Collected 3 oak_log." } }
  ],
  "final_state": { … },
  "summary": { "step_count": 1, "last_action": "…",
               "last_result_kind": "command_success",
               "failed_steps": [ … only on fail … ] }
}
```

**For `search_sweep` tasks**, `steps[]` contains a single summary entry
with `action: "search_sweep([t1, t2, …])"` and a result that carries an
extra `per_source_outcomes` map:

```jsonc
{
  "i": 1,
  "action": "search_sweep([any_log, stone, iron_ore])",
  "result": {
    "success": false,
    "kind": "sweep_exhausted",
    "message": "All sources exhausted at radius 511: any_log, stone, iron_ore",
    "per_source_outcomes": {
      "any_log":  "exhausted",
      "stone":    "found_not_reached",
      "iron_ore": "soft_skipped"
    }
  }
}
```

The per-radius `!searchForBlock` / `!searchForEntity` calls are NOT in
the task_trace steps — they're logged separately into
`rollout_trace.json` via `log.am(...)` calls inside
`run_breadth_first_sweep`. `project_failed_steps` (in `trace.js`)
forwards `per_source_outcomes` to the failure_replanner LLM alongside
the other surfaced context fields.

A successful rollout (see e.g. `rollouts/smelt_an_iron_ingot_success/`)
consists of:

- `rollout_trace.json` — the full ordered stage log: alternating `SCSG`,
  `CANDIDATES`, `AM` stages, plus eventual completion.
- `task_traces/full_task_trace.jsonl` — one task trace per line, every task
  the loop executed in order.
- (If any failure occurred) `task_traces/failed/*.json` — pretty-printed
  individual failure traces.

---

## 4. Things to be careful about when editing

- **The hardcoded `load_graph = true` block in `loop.js` is intentional.**
  Do not switch it back to `generate_primary_task_dag_self_refined` unless
  the user asks. Changing `graph_file_path` is the supported way to switch
  objectives.
- **Death handling**: do not count `bot.on('death')` events as consecutive
  failures. The post-respawn `setTimeout(_, 500)` is load-bearing — it
  prevents reading inventory while the server is still settling.
- **Baseline inventory snapshot** in `execute_task_action` underpins the
  fix for BUG 11 (capped-collect tasks). Do not remove it or replace with
  a fresh `get_am_state` read inside steps.
- **`should_abort_repeated_failure` short-circuits on a single
  `mode_interrupted=true`.** This is intentional (BUG 15 fix B): one
  mode-interrupted result already represents 5 internal livelocked
  retries, so waiting for a second one is pure churn.
- **`failure_signature` strips timeout numbers and replaces
  mode-interrupted counts with sorted mode names.** Otherwise repeated
  failures look "new" each time and the abort path never fires.
- **Search exhaustion is sticky within a task**: once `searched_targets`
  has a target, the loop will not re-issue `!search` for it in that
  attempt sequence. The replanner has its own separate `searched_targets`
  set with the same semantics.
- **SCSG completion checks happen *after every replanner action*** —
  recovery can succeed mid-sequence by side effect; do not assume the LLM's
  final action is the one that completed the task.
- **Edits to files outside `achievement_hunter/`** must follow the
  project-wide marker-comment convention (see top-level `CLAUDE.md`).
  Everything inside this directory is AH-only and does *not* use markers.
- **`searched_targets` is NOT updated on search-replanner success.** When
  `recover_failed_search` returns `'success'`, the inner attempt loop
  `continue`s — the target was just relocated into nearby state, so
  blocking re-search would defeat the recovery. The `searched_targets`
  add happens only when the replanner returns `'fail'`.
- **Breadcrumb tracker uses horizontal distance only.** Vertical bot
  movement (e.g. `!digDown` for ores) does not create new breadcrumbs.
  This is intentional — `!search` radii (max 511) span every realistic
  y-level traversal, so the surface xz position is what determines
  reachability. Do not "fix" this to be 3D.
- **Breadcrumbs persist across crashes via the checkpoint.** The
  `BreadcrumbTracker` is in-memory, but each outer loop iteration calls
  `save_checkpoint(task_name, graph, breadcrumb_tracker.get_breadcrumbs())`.
  On resume, `loop.js` calls `breadcrumb_tracker.restore(...)` if the
  prior checkpoint's `objective` matches the current `task_name`.
  Mismatches are skipped silently — the breadcrumbs are objective-keyed,
  not world-keyed, so switching Minecraft worlds with the same
  objective name would (incorrectly) restore stale breadcrumbs.
- **Search-replanner success means target-in-nearby, NOT task-complete.**
  Unlike `failure_replanner.recover_failed_task`, which short-circuits
  on `scsg_task_complete_check`, the search replanner only guarantees
  the target is reachable. The SPL inner attempt loop has to actually
  perform `!collectBlocks`/`!attack` on the next iteration.
- **Pathfinding-class failures in the search-replanner plan bail to
  `failure_replanner`** (D11). If you add new failure kinds, decide
  whether they belong in `is_pathfinding_failure` (bail) or
  `PLAN_TERMINATING_KINDS` (end current plan only, continue to next
  attempt). The two have very different effects on recovery duration.
- **Sweep tasks bypass `mediate_action`.** `'search_sweep'` action_type
  is intentionally NOT in `mediate_action`'s switch — the dispatcher in
  `execute_task_action` short-circuits to `handle_search_sweep` before
  mediation runs. If you add the action_type to `mediate_action`'s
  switch, the dispatcher's branch will still win, but you've introduced
  dead code. The `default: throw` in `mediate_action` is a fail-safe
  against future regressions where the dispatcher is bypassed.
- **`search_replanner` takes a list of candidate targets**, not a single
  string. Single-target callers (the non-sweep `search_exhausted` branch
  in `actions.js`) wrap their argument as `[search_target]`. The sweep
  handler passes `sources_exhausted` directly. Internally,
  `any_target_now_in_nearby` expands abstracts via `expand_search_item`
  so an `any_log` candidate is satisfied by any concrete log appearing
  in nearby state.
- **Sweep is one inner-loop attempt** (D7). The whole breadth-first
  sweep counts as one slot in `max_inner_retries`, not N targets × 5
  retries. Without this the budget would vanish instantly on any
  multi-target sweep.
