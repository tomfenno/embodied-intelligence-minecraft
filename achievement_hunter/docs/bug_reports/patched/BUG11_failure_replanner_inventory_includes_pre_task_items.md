# BUG 11 — `failure_replanner` Inventory Counts Include Items Collected Before This Task

**Severity:** Medium (degrades replanner LLM diagnosis quality; can cause wrong recovery
plans on capped collect tasks)
**Status:** Fixed — applied on branch `hard-code-nts-am`
**Trace:** `achievement_hunter/rollouts/2026-04-28T02-52-20-957Z_test/task_traces/failed/2026-04-28T02-53-56-411Z__collect__raw_iron__fail.json`
**Files changed:**
- `achievement_hunter/src/pipeline/agent_state.js` — `get_recovery_trace_state` accepts an optional `baseline_inventory`; new `_inventory_delta` helper.
- `achievement_hunter/src/pipeline/structured_loop/actions.js` — `execute_task_action` snapshots inventory once at task start and threads it through `create_trace_step`, `handle_interact_success`'s inline collect step, `finalize_task_trace`, and `recover_failed_task`.
- `achievement_hunter/src/pipeline/structured_loop/failure_replanner.js` — `recover_failed_task` accepts and forwards `baseline_inventory` to its own `get_recovery_trace_state` calls.

---

## Symptom

A `collect` NTS task with `qty: 19` (raw_iron) fails its inner retries and is handed to
`failure_replanner`. The trace state surfaced to the LLM contains the **full** inventory
count, including items the bot had **before this task ever started**:

```jsonc
"task": { "target_item": "raw_iron", "qty": 19, ... },
"steps": [
  { "i": 1, "state": { "inventory": { "counts": { "raw_iron": 19, ... } } }, "action": "!collectBlocks(\"iron_ore\", 16)" },
  { "i": 2, "state": { "inventory": { "counts": { "raw_iron": 29, ... } } }, "action": "!collectBlocks(\"iron_ore\", 16)" },
  ...
]
```

By step 2 the bot already has **more raw_iron (29) than the task asked for (19)**. From the
LLM's perspective the trace is incoherent — the task says "collect 19", the bot has 29, and
yet every step is marked failed. Diagnoses produced from this state tend to be wrong (e.g.
"task is already satisfied, no recovery needed") because the inventory contradicts the
failure signal.

---

## Root Cause

### Two interacting design choices

1. **Action quantity is capped.** `mediate_collect` clamps the per-action quantity to
   `max_collect_qty = 16` (`achievement_hunter/src/pipeline/structured_loop/actions.js:24,
   216–217`):
   ```js
   return create_command_action(`!collectBlocks("${concrete_block}", ${
       Math.min(task.qty, max_collect_qty)})`);
   ```
   So an NTS task with `qty: 19` always emits `!collectBlocks(..., 16)`. This is intentional
   — it prevents one task from monopolizing collection — and the SPL relies on the next
   outer iteration's SCSG re-evaluation to issue a follow-up task for the remaining 3.

2. **Trace inventory is the raw global inventory.** Every step in the failed trace stores
   `state.inventory.counts` straight from `bot.inventory` via `get_recovery_trace_state`
   (`achievement_hunter/src/pipeline/agent_state.js:91, 159–160`):
   ```js
   const inv = {};
   if (raw_state?.inventory != null) inv.counts = raw_state.inventory;
   ```
   Nothing scopes the inventory to "what changed during this task." The count includes
   raw_iron the bot collected during *prior* `collect raw_iron` tasks (which were also
   capped at 16, so several tasks in a row may run before SCSG considers the requirement
   met).

### Why the LLM gets confused

The replanner prompt receives the trace as-is. The LLM's job is to read the task, look at
what the bot actually did, and diagnose why it failed. With the global inventory count it
sees a contradiction between "you needed 19, you have 29" and "every step failed." There is
no way for the LLM to know that of those 29 raw_iron, 19 were already in inventory when this
task started — that history is invisible.

Result: the LLM either declares the task already complete (and the recovery plan is a no-op,
which then re-fails) or invents an unrelated explanation (looking for a tool problem,
location problem, etc.) instead of diagnosing the real failure (e.g. pickaxe broke,
collectBlock command produced an empty result, etc. — see BUG 10 for one such cause).

### Why this only bites on capped tasks

For a small task (`qty <= 16`), one action satisfies the SCSG requirement and the loop
moves on. For a large task (`qty > 16`), the SCSG fragments the requirement into multiple
sequential tasks. Each new task starts with the inventory carrying forward the previous
tasks' work, so by tasks 2..N the global count is much larger than `task.qty`. The mismatch
between `task.qty` (a *delta* the SCSG wants this task to add) and `inventory.counts[item]`
(an *absolute* count) is the source of confusion.

---

## Fix

Snapshot the inventory at the start of each `execute_task_action` call and subtract those
baseline counts when serializing trace steps and the `final_state` for the failure replanner.
The trace should report inventory **as the delta produced during this task**, not the global
state. The rest of the SPL (SCSG, NTS) should keep using the raw global inventory — this
adjustment is only for the replanner's view.

### Sketch

In `actions.js:execute_task_action`, capture a baseline before the retry loop:

```js
const baseline_inventory = { ...get_am_state(agent).inventory };
```

Pass it into `create_trace_step` and `finalize_task_trace` (or the helper that builds
`final_state`) so they can subtract:

```js
function task_scoped_inventory(current, baseline) {
  const out = {};
  for (const [name, count] of Object.entries(current ?? {})) {
    const delta = count - (baseline[name] ?? 0);
    if (delta > 0) out[name] = delta;
  }
  return out;
}
```

Then in `get_recovery_trace_state` (or at the call site in `actions.js`), substitute:
```js
inv.counts = task_scoped_inventory(raw_state.inventory, baseline_inventory);
```

Only positive deltas are kept (the task collected/crafted them). Items consumed during the
task aren't relevant to the replanner for collect/craft failures; if needed, they can be
exposed under a separate `consumed` field. The baseline itself does **not** need to be
serialized — the LLM should reason about what *this task* did, not what the bot had before.

### Behavioral expectation after fix

For the same trace above:

```jsonc
"task": { "target_item": "raw_iron", "qty": 19, ... },
"steps": [
  { "i": 1, "state": { "inventory": { "counts": {} } }, ... },           // collected nothing yet
  { "i": 2, "state": { "inventory": { "counts": { "raw_iron": 10, "cobblestone": 32 } } }, ... },  // 10/19 done
  ...
]
```

The replanner now sees: "task wanted 19, this run has produced 10, every action returned an
unstructured failure" — which correctly points at the action-execution layer (the real bug),
not at imaginary completed-task confusion.

### Scope notes

- **Don't change SCSG / NTS state.** Those need the absolute inventory to evaluate goal
  satisfaction. Only `get_recovery_trace_state` (and only when called from
  `execute_task_action`'s trace path) should be adjusted.
- **Equipment is unaffected.** `inv.equipment.mainHand` is a label, not a count, so
  baseline subtraction doesn't apply.
- **Search/recovery sub-actions** that run inside the task should subtract from the same
  baseline (so a recovery step's reported inventory still reflects "this task's progress").

---

## Evidence

From the linked trace:

| Step | task.qty | reported `raw_iron` | what actually happened this task |
|---|---|---|---|
| 1 | 19 | 19 | 0 collected (bot had 19 going in) |
| 2 | 19 | 29 | 10 collected so far |
| 3 | 19 | 29 | 10 collected (action failed) |
| 4 | 19 | 29 | 10 collected (action failed) |
| 5 | 19 | 29 | 10 collected (action failed) |

A replanner reading rows 2–5 sees `raw_iron: 29 ≥ task.qty: 19`, which superficially
contradicts the failure status. After the fix it would see `raw_iron: 10 < task.qty: 19`,
correctly framing the diagnosis as "this task under-delivered, why?"

## Relation to Other Bugs

- **BUG 10:** A common upstream cause of these capped-collect failures (pickaxe break OOM /
  clean failure path). The replanner's confusion described here makes BUG 10's failures
  harder to recover from cleanly because the LLM mis-diagnoses the situation.
