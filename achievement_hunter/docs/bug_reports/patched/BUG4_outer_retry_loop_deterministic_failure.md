# Patched 
# BUG 4 — Outer Retry Loop Re-Queues Deterministically Failing Task

**Severity:** Medium (wastes retries, extends failure duration)
**Status:** Confirmed from logs
**Location:** `achievement_hunter/src/pipeline/structured_loop.js:98-104`

---

## Symptom

After the inner retry loop aborts early (repeated identical failures), the outer loop
immediately re-evaluates SCSG and selects the same task, restarting from attempt 1/5:

```
[SPL] Aborting early after repeated identical failures (2) for: !craftRecipe("stick", 1)
[SPL] Task failed after max retries, re-evaluating state...
[SPL] Next task: {"target_item":"stick","qty":4,"action_type":"craft",...}
[SPL] Action (attempt 1/5): !craftRecipe("stick", 1)
```

This cycles until `MAX_OUTER_RETRIES` (currently 10) is exhausted — burning all outer
retries on a deterministically failing command with no intervening state change.

---

## Root Cause

```javascript
// structured_loop.js
const am_status = await run_am_deterministic(task, agent, log);
if (am_status === 'success') {
  consecutive_failures = 0;
} else {
  spl.log('Task failed after max retries, re-evaluating state...');
  if (++consecutive_failures >= MAX_OUTER_RETRIES) break;
  // ← loops back to run_scsg, which returns the SAME task (inventory unchanged)
}
```

When `run_am_deterministic` aborts early after repeated identical failures, it returns
`'fail'`. The outer loop increments `consecutive_failures` and continues. SCSG
re-evaluates the inventory — which hasn't changed because the craft failed — and
returns the same task. The inner loop then runs again from attempt 1.

The inner early-abort exists to avoid wasting the 5 inner retries on a command that
has already proven to be deterministically failing. But the outer loop immediately
undoes this by re-queueing the same command.

---

## Proposed Fix

Track the last-failed task signature at the outer loop level. If SCSG returns the
same task that just caused an inner abort, skip re-attempting it and count it as
an outer failure directly:

```javascript
// structured_loop.js
let consecutive_failures = 0;
let last_failed_task_sig = null;

while (true) {
  const scsg = run_scsg(G, agent, log);
  if (scsg.status === 'complete') { ... }

  const task = run_nts_deterministic(scsg.candidates, agent, log);
  if (!task) {
    if (++consecutive_failures >= MAX_OUTER_RETRIES) break;
    continue;
  }

  const task_sig = `${task.action_type}:${task.target_item}:${task.qty}`;

  if (task_sig === last_failed_task_sig) {
    spl.warn('Same task selected after prior abort, skipping re-attempt.');
    if (++consecutive_failures >= MAX_OUTER_RETRIES) break;
    continue;
  }

  const am_status = await run_am_deterministic(task, agent, log);
  if (am_status === 'success') {
    consecutive_failures = 0;
    last_failed_task_sig = null;
  } else {
    last_failed_task_sig = task_sig;
    spl.log('Task failed after max retries, re-evaluating state...');
    if (++consecutive_failures >= MAX_OUTER_RETRIES) break;
  }
}
```

This ensures each unique outer failure increments `consecutive_failures` exactly once,
rather than looping indefinitely on the same failing task.

---

## Note

This bug amplifies BUG 2 but does not cause it. Fixing BUG 2 will make BUG 4
irrelevant for the stick-craft case. BUG 4 should still be fixed independently
for robustness against future deterministic failures.
