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
4. **Mediates the task into a single bot command** (`!collectBlocks`,
   `!craftRecipe`, `!smelt_item`, `!attack`, `!useOn`, `!placeHere`, or
   `!search…`) and executes it.
5. If the command fails after inner retries, the **failure replanner** (an
   LLM) is invoked to propose a short corrective action sequence.
6. Loops until SCSG is empty (all sinks satisfied), or until
   `max_outer_retries` (10) consecutive failures are accumulated, or until
   `recover_failed_task` returns `fail` after a hard error.

The loop is otherwise fully deterministic: there is **no LLM in the happy
path**. The LLM is only consulted when a task has exhausted its retries and
the failure is classified as recoverable.

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
| 4    | Fallback acquisition (search-based) for `resource` candidates | `make_fallback_acquisition_task`  |

This ordering encodes "always cash in already-collected inputs before going
out to gather more". A task object looks like:

```js
{
  target_item: 'oak_planks',
  qty: 10,
  action_type: 'craft' | 'collect' | 'smelt' | 'kill' | 'interact',
  parameters: { … },
}
```

`itemish_types` is `{'item', 'tool', 'workstation'}` — only these can be
crafted/smelted.

### `actions.js` — task execution + inner retry loop

`execute_task_action(task, agent, log, model, graph)` is the inner workhorse.
It runs up to `max_inner_retries = 5` attempts on a single task and returns
`'success'` or `'fail'`.

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
   (see `search.js`). On `search_exhausted`, mark target seen so we don't
   re-search; on `search_success` or `search_found_not_reached`, continue
   (the bot may have moved and a follow-up attempt may now succeed).
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

### `search.js` — search command handling

- `parse_search_command(action)` — extracts the target from `!search("X")`.
- `run_search(target, state, agent, log, start_attempt)` —
  expands the target via `expand_search_item` (notably `any_log` → list of
  log block names), fast-paths if already in state, then sweeps radii
  `[32, 64, 128, 256, 511]` issuing `!searchForBlock(...)` for blocks or
  `!searchForEntity(...)` for mobs.
- `check_search_complete(target, state)` — was the target found nearby after
  the search?
- `is_entity_target(target)` — uses `mob_search_targets` from `mc_sources.js`.

Failure replanner uses the same `run_search` helper for `!search` actions.

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

### Task trace (persisted)

```jsonc
{
  "objective": "Smelt an iron ingot.",
  "task": { … the task from above … },
  "terminal_status": "success" | "fail",
  "terminal_reason": "completed" | "exhausted_inner_retries"
                   | "repeated_identical_failure" | …,
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
