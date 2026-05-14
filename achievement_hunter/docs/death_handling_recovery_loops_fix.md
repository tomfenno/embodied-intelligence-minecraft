# Death Handling in Recovery Loops — Plan

**Status:** Diagnosis complete; fix proposed. Line numbers in Section 5 verified against the file state at 2026-05-14 — re-verify before editing if other patches land first.
**Affected files:** `achievement_hunter/src/pipeline/structured_loop/search_replanner.js`, `achievement_hunter/src/pipeline/structured_loop/failure_replanner.js`, `achievement_hunter/src/agent/pathfinding_wrappers.js` (companion defense-in-depth edit; see §6).
**Trigger:** Bug observed in rollout `evaluation_harness/experiments/achievement_hunter_eval_v2_full/our_agent/seed_24680/diamonds/runner_stdout.log` (lines 318–595).

---

## 1. The true problem

### Symptom (from the rollout log)

At `T+~210s` the bot drowned in a flooded cave during a search-recovery cycle. The bot-death flag (`agent.bot._ah_death_pending`) was set, and individual commands were correctly aborted by `command_utils.executeCommandWithModeRecovery` — each emitted `bot_died: aborted <command>`. But `recover_failed_search`'s outer attempt loop continued iterating for **9 more attempts** (attempts 2/10 through 10/10), each:

- Making an LLM call to generate a recovery plan (~5–10s each).
- Executing 1–N plan actions, every one of which aborted with `bot_died`.
- Burning per-action retries (`MAX_ACTION_RETRIES = 3` per action).

Only after attempt 10 fully exhausted did `actions.js`'s post-`recover_failed_search` check fire `[SPL] Bot death observed after sweep search_replanner — aborting task.` and route the system back to SCSG recomputation.

**Measured cost per dying-recovery cycle:** ~9 wasted LLM calls + ~150 seconds of wall-clock during which the bot is dead and the SCSG re-entry is delayed. In the rollout in question, the entire task subsequently timed out — without the loss of those ~150s, the agent might have completed the re-attempt before the wall-clock timeout.

### Why this happens — the architectural inconsistency

Bot death is signaled through a **side-channel global flag** on the bot object (`agent.bot._ah_death_pending`), not through the action-result schema. Layers handle this flag inconsistently:

| Layer | Observes `_ah_death_pending`? |
|---|---|
| `command_utils.executeCommandWithModeRecovery` | ✅ Aborts the command, returns `bot_died: aborted ...` |
| `actions.js` inner task loop | ✅ Multiple explicit checks; returns `'death'` to caller |
| `actions.js` sweep handler post-`recover_failed_search` | ✅ Explicit check; returns `'death'` |
| `search_replanner.recover_failed_search` outer attempt loop | ❌ **No check** |
| `search_replanner.recover_failed_search` inner action loop | ❌ **No check** |
| `failure_replanner.recover_failed_task` outer attempt loop | ❌ **No check** |
| `failure_replanner.recover_failed_task` inner action loop | ❌ **No check** |

The death signal IS being observed at the bottom of the stack (individual commands abort cleanly) and at the top of the stack (`actions.js` exits and re-enters SCSG after the replanner returns). But the **middle of the stack** — the replanner attempt loops — does not honor the signal.

The result is that each attempt's individual commands all return `command_failure`-shaped results (because the death message isn't a recognized kind), the outer loop treats this as normal failure, generates a new plan, and iterates. The flag is set throughout, but nothing inside the replanner reads it.

### Why this is a true bug, not an edge case

- Every kind of bot death (drowning, lava, mob damage, fall damage, etc.) sets `_ah_death_pending`. So this bug fires on **all** deaths during recovery, not just drowning.
- The two replanner loops collectively run on most recovery cycles (search_replanner for search exhaustion, failure_replanner for command failures). Deaths mid-recovery are common.
- The bug compounds with other improvements: even after fixing `goToNearestLand` to use moveAway as fallback (a separate concern), any future death during any recovery cycle will still trigger this dead-loop.

---

## 2. The fix — robust, minimal, consistent

### Principle

**Make `_ah_death_pending` a first-class loop terminator at the same level as `MAX_*_ATTEMPTS`.** The check pattern is already established in `actions.js`; we're not inventing a new mechanism — we're closing a known gap in two specific places to make the codebase internally consistent.

### Specifically

1. **At the top of each attempt iteration** in both replanners, check `_ah_death_pending` before doing any work (no LLM call, no command execution). If set: log clearly, persist the trace if applicable, and return a fail signal that the caller already handles (`'fail'` with `terminal_reason: 'bot_died'`).

2. **After each `run_action` call** in both replanners' inner action loops, check `_ah_death_pending`. If set: stop running plan actions for this attempt. The outer-loop check on the next iteration will then bail the recovery cleanly.

3. **Mirror the existing pattern in `actions.js`.** Same wording in logs (`Bot death observed ...`), same control flow (early `return`), same terminal-reason value (`'bot_died'`). The caller's existing handling will treat the early return the same as the eventual 10-attempt exhaustion — but now it fires immediately on death.

### Why this is a true fix and not a bandaid

- **Closes a documented inconsistency.** `actions.js` already has these checks at every critical point. Adding them to the replanners brings the codebase to internally consistent behavior; nothing about the architecture changes.
- **Doesn't introduce new schema or concepts.** No new result kinds, no new return values, no new globals. Uses the existing `_ah_death_pending` flag exactly as `actions.js` already does.
- **Minimal blast radius.** Two replanner files, ~5–10 lines each. No callers need to change because both replanners already returned `'fail'` for unsuccessful exits; the caller in `actions.js` already handles that and the existing post-replanner death check still fires correctly as a backstop.
- **Doesn't paper over the side-channel-flag design.** A more-principled "true fix" would be to add `bot_died` as a first-class action-result `kind` and have the death signal flow through the result schema. That would be a deeper refactor touching the result schema, action manager, command_utils, and every callsite that reads `result.kind`. The current fix doesn't preclude that future refactor — it just doesn't require it. The flag-based approach is already the established convention; making it work consistently is the right immediate move.

### What we explicitly do NOT do

- **No new helper module** for death-handling. The pattern is `if (agent.bot._ah_death_pending) { spl.log(...); return ...; }` — two lines. Wrapping that in a helper would add an abstraction without saving complexity.
- **No changes to the action-result schema.** Death already flows through the message field (e.g. `'bot_died: aborted !goToSurface() after bot death — SPL will re-enter SCSG on respawn'`); we're not duplicating that into a structured kind.
- **No changes to `actions.js`'s outer-level checks.** They are correct; they currently fire as a backstop and will continue to do so after this fix as a redundancy.

---

## 3. Step-by-step implementation plan

### Step 1 — Pre-flight (no edits)

Confirm at code-read time:

- `agent.bot._ah_death_pending` is the canonical death flag (grep `_ah_death_pending` across the repo; should match the actions.js usage we already see).
- `recover_failed_search` already has a `finalize(terminal_status, terminal_reason)` helper for clean termination (it does — `search_replanner.js` defines it at the top of the function).
- `recover_failed_task` (in `failure_replanner.js`) has a comparable termination path — likely a `return 'fail'` or similar.
- Tests under `achievement_hunter/src/pipeline/__tests__/` don't mock `_ah_death_pending` in a way that would break with the new checks. If they do, expose the seam for testing.

### Step 2 — `recover_failed_search` (`search_replanner.js`)

Add an outer-loop death check at the top of each attempt iteration:

```js
for (let attempt = resume_attempt; attempt <= MAX_SEARCH_REPLANNER_ATTEMPTS; attempt++) {
  if (agent.bot._ah_death_pending) {
    spl.log(`Bot died — aborting recovery at attempt ${attempt}/${MAX_SEARCH_REPLANNER_ATTEMPTS}.`);
    return finalize('fail', 'bot_died');
  }
  // ... existing body (save_runtime_state, LLM call, action loop, ...)
}
```

Add an inner-action-loop death check after each `run_action`:

```js
for (let i = 0; i < replanner_output.actions.length; i++) {
  // ... existing retry loop running run_action ...
  if (agent.bot._ah_death_pending) {
    spl.log(`Bot died mid-plan — stopping action sequence in attempt ${attempt}.`);
    break;  // exit the inner action loop; outer-loop check next iteration handles termination
  }
}
```

### Step 3 — `recover_failed_task` (`failure_replanner.js`)

Identical pattern. Add outer-loop check at top of each attempt iteration, and inner-action-loop check after each `run_action`. Termination uses whatever the function's existing fail-exit path is (likely `return 'fail';` or equivalent — verify at edit time and match the existing convention).

### Step 4 — Trace persistence

For `recover_failed_search`, the existing `finalize('fail', 'bot_died')` already writes the search_trace with `terminal_reason: 'bot_died'` — no additional work needed.

For `recover_failed_task` — if it persists a task trace, ensure the bot-died exit path writes a comparable `terminal_reason`. If it doesn't currently persist on early exits, leave that as-is (the rollout log will still capture the death event via stdout).

### Step 5 — Verification (no in-game required)

```bash
node --check achievement_hunter/src/pipeline/structured_loop/search_replanner.js
node --check achievement_hunter/src/pipeline/structured_loop/failure_replanner.js
npx vitest run
```

All 235 tests should still pass. The checks are additive and don't change any existing control flow on the non-death path.

### Step 6 — Verification (in-game)

Run a benchmark episode where the bot is likely to die mid-recovery (e.g. a `diamonds` task that goes through flooded caves). Look for the new log lines in stdout:

- `[SPL][search] Bot died — aborting recovery at attempt N/10.` — fires immediately after death is observed; no further LLM calls follow.
- `[SPL][recovery] Bot died — aborting recovery at attempt N/10.` — same shape for failure_replanner.

Expected wall-clock between death and SCSG re-entry: **~1–3 seconds** (one in-progress attempt's remaining commands aborting + finalize), versus the current **~150 seconds** (9 LLM calls + 30+ aborted command executions).

---

## 4. Confidence report

### Diagnosis (~95% confidence)

- The rollout log is unambiguous on the symptom: death observed at line 318, recovery continues for attempts 2–10 (lines 320–593), final death-bail at line 595.
- The post-replanner check in `actions.js` (`Bot death observed after sweep search_replanner`) firing confirms `_ah_death_pending` was set the whole time.
- The pattern of `bot_died: aborted ...` messages on every command across all 9 wasted attempts confirms the flag was being observed at the command-level but not at the replanner-level.

What I'm slightly less sure about (~5%): whether there's a separate code path (not in the partial views I've read) that's also affected. The fix is local to the two replanners; if a third recovery loop exists somewhere, this fix wouldn't cover it. Mitigation: a grep for "MAX_RECOVERY_ATTEMPTS" / "MAX_SEARCH_REPLANNER_ATTEMPTS" should surface any others before edit-time.

### Fix correctness (~90% confidence)

- Pattern is established in `actions.js`; we're matching it exactly. No new mechanism.
- Small surface (~5–10 lines per file). Easy to review.
- Tests should pass without changes — the new check is additive and only fires when `_ah_death_pending === true`, which existing tests don't simulate.

What could go wrong (~10%):
- The exact shape of `failure_replanner`'s termination might require slightly different handling than `search_replanner`'s `finalize` helper. Need to read its code at edit time and match the convention.
- The inner-action-loop check needs to break out cleanly — if either replanner does state mutation after the action loop that we'd want to skip on bot-death, we need to handle that explicitly.

### Fix scope (~85% confidence)

- We're fixing the two replanner loops. We are NOT addressing the broader question of whether `_ah_death_pending` should be replaced with a result-schema-based signal. That would be a larger refactor; this fix doesn't preclude it but doesn't require it.
- We are NOT addressing the `goToNearestLand` → `moveAway` fallback (a separate concern; tracked as a follow-up).

### Operational impact (~70% confidence)

- **Cost savings per dying-recovery cycle:** 8–9 LLM calls saved, ~120–145 seconds of wall-clock saved.
- **Frequency:** Deaths during recovery happen at non-negligible rate in cave/lava/water tasks. Hard to give an exact percentage without rollout data, but the fix pays for itself the first time it fires.
- **Risk of false bails:** Zero. The check is `if (_ah_death_pending) return`. If the flag is set, the bot is genuinely dead — there's no useful work to do until respawn.
- **Risk of missing real deaths:** Zero. The check is at every iteration boundary; any death that sets the flag will be observed at the next boundary, which is at most one attempt away.

### What would push confidence higher before merging

- 5 minutes reading `failure_replanner.recover_failed_task` to confirm the termination shape exactly matches what I propose.
- 5 minutes greping for other places that loop over `MAX_*_ATTEMPTS` constants to make sure no third replanner exists.
- One synthetic rollout that intentionally drowns the bot mid-recovery to confirm the new behavior end-to-end.

Without those, I'd ship this fix at ~85% confidence and verify in production rollouts.

---

## 5. Appendix — Concrete code pointers for context-cleared resumption

This appendix exists so a future agent (with no in-memory context from the discovery session) can apply the fix without re-reading the rollout log or re-discovering line numbers. Verify the line numbers before editing — they may have drifted by ±a few lines if other patches landed first.

### 5.1 `_ah_death_pending` flag definition

- **Initialized to `false`:** `achievement_hunter/src/pipeline/structured_loop/loop.js:111`
- **Set to `true` on death:** `achievement_hunter/src/pipeline/structured_loop/loop.js:116`
- **Cleared to `false` on respawn:** `achievement_hunter/src/pipeline/structured_loop/loop.js:138`

Verify with: `grep -n "_ah_death_pending" achievement_hunter/src/pipeline/structured_loop/loop.js`

### 5.2 Existing pattern in `actions.js` (reference — do NOT edit, only mirror)

The check pattern is established at 8+ sites in `achievement_hunter/src/pipeline/structured_loop/actions.js` at approximate lines `166, 189, 234, 329, 345, 419, 459, 479`. The canonical shape:

```js
if (agent.bot._ah_death_pending) {
  spl.log('<context-specific message>');
  return 'death';   // or break, depending on enclosing scope
}
```

The post-`recover_failed_search` backstop (the one that currently fires *after* 10 wasted attempts) is around `actions.js:419` and emits `Bot death observed after sweep search_replanner — aborting task.` — after this fix it should rarely fire, because the inner replanner check will catch death earlier.

### 5.3 Edit target 1 — `achievement_hunter/src/pipeline/structured_loop/search_replanner.js`

Function: `recover_failed_search` (declared at line **317**). File is 613 lines total.

**Key landmarks inside the function** (verified 2026-05-14):

| Line | Code | Role |
|---|---|---|
| 317–319 | `export async function recover_failed_search(targets, agent, model, breadcrumb_tracker, log, task = null, seed_failure_message = null, seed_sweep_outcomes = null) {` | Entry (8th arg `seed_sweep_outcomes` was added — older versions of the plan listed 7 args) |
| 320–323 | `if (!Array.isArray(targets) || targets.length === 0) { spl.warn(...); return 'fail'; }` | Pre-`finalize` early exit (cannot use `finalize` here — it isn't in scope yet) |
| 406–421 | `const finalize = (terminal_status, terminal_reason) => { … persist_search_trace(...); log?.search_recovery_end?.(terminal_status); return terminal_status; };` | **Termination helper — USE THIS for all bot-died exits.** Signature is `finalize(terminal_status, terminal_reason)` returning `terminal_status` (e.g. `'fail'`). |
| 439 | `try {` | Try-finally around the loop |
| 443–444 | `for (let attempt = resume_attempt; attempt <= MAX_SEARCH_REPLANNER_ATTEMPTS; attempt++) {` | **OUTER LOOP HEADER — insert outer death check immediately inside this `{`, BEFORE the `save_runtime_state` call at 445.** |
| 445–454 | `save_runtime_state({ active_replanner: { kind: 'search', task_key: current_task_key, outer_attempt: attempt, action_index: 0, action_retry: 0, plan: null, }, });` | Per-attempt state save |
| 455 | `spl.log(\`Attempt ${attempt}/${MAX_SEARCH_REPLANNER_ATTEMPTS}\`);` | First in-attempt log — outer death check fires before this |
| 467 / 472 / 479 | `return finalize('fail', 'llm_failed' \| 'invalid_llm_output' \| 'validation_failed');` | Existing termination examples — match this shape |
| 497 | `for (let i = 0; i < replanner_output.actions.length; i++) {` | Inner per-action-index loop header |
| 511 | `for (let retry = 0; retry <= MAX_ACTION_RETRIES; retry++) {` | Innermost per-retry loop header |
| 528–529 | `result = await run_action(action, agent, log, searched_targets, searched_targets_outcomes);` | **Inner action call — insert inner death check IMMEDIATELY AFTER this (after the `spl.log('Result:', result);` line at 530 is also fine), before the loop continues.** |
| 577 | `return finalize('success', 'target_reached');` | Success exit |
| 603–604 | `spl.warn(\`Recovery exhausted after ${MAX_SEARCH_REPLANNER_ATTEMPTS} attempts.\`); return finalize('fail', 'search_replanner_exhausted');` | Natural exhaustion fallthrough |
| 606–608 | `} finally { clear_active_replanner(); }` | Cleanup — runs on every exit path including bot-died |

**Outer death check (insert at top of for-body, between line 444 `{` and line 445 `save_runtime_state(...)`):**

```js
if (agent.bot._ah_death_pending) {
  spl.log(`Bot died — aborting recovery at attempt ${attempt}/${MAX_SEARCH_REPLANNER_ATTEMPTS}.`);
  return finalize('fail', 'bot_died');
}
```

**Inner death check (insert after the `run_action` call at lines 528–529, immediately after line 530 `spl.log('Result:', result);`):**

```js
if (agent.bot._ah_death_pending) {
  spl.log(`Bot died mid-plan — stopping action sequence in attempt ${attempt}.`);
  break;  // exit innermost retry loop; the per-action-index loop's next-iteration check at top of outer attempt loop finalizes
}
```

Note: there are TWO nested inner loops (per-action-index at 497, per-retry at 511). The `break` above exits the innermost retry loop. The per-action-index loop's continuation will see `result` from the dead bot's failed action; the cleanest behavior is to also break out of the per-action-index loop. To do that, set a flag and check it after the retry-loop closes — OR (simpler) rely on the outer-loop death check firing on the NEXT attempt iteration. The latter is fine because: the dead bot's next action call will also abort immediately (`command_utils` aborts on `_ah_death_pending`), so the worst case is one extra fast-returning iteration through the remaining actions in the plan — not an LLM call. Pick the simpler form unless rollout testing shows the extra iteration matters.

The `finally { clear_active_replanner(); }` at 606–608 will still run, which is correct.

The file is in `achievement_hunter/src/` (AH-owned) so per CLAUDE.md the `// Start of AH code` / `// End of AH code` markers are NOT required. Match the surrounding code style.

### 5.4 Edit target 2 — `achievement_hunter/src/pipeline/structured_loop/failure_replanner.js`

Function: `recover_failed_task` (declared at line **240**). File is 468 lines total.

**Key landmarks (verified 2026-05-14):**

| Line | Code | Role |
|---|---|---|
| 12 | `import { … MAX_RECOVERY_ATTEMPTS, FAILURE_REPLANNER_MAX_ACTION_RETRIES as MAX_ACTION_RETRIES, … }` | Constants |
| 23–29 | `HARD_FAILURE_KINDS = new Set([...])` | Hard failure set |
| 31 | `const spl = make_spl('[SPL][recovery]');` | Logger handle |
| 240 | `export async function recover_failed_task(failed_trace, agent, model, graph, log = null, baseline_inventory = null) {` | Entry |
| 266–268 | `let exit_status = null; let exit_attempt = resume_attempt - 1; let exit_detail = null;` | Exit-tracking — **the bot-died exit must set these** |
| 270 | `try {` | Try-finally |
| 271–272 | `for (let attempt = resume_attempt; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {` | **OUTER LOOP HEADER — insert outer death check inside, right after the `exit_attempt = attempt;` on line 273.** |
| 273 | `exit_attempt = attempt;` | Already tracks current attempt — set THIS before bot-died check so exit log is accurate |
| 274–283 | `save_runtime_state({ active_replanner: { kind: 'failure', … } });` | Per-attempt state save |
| 284 | `spl.log(\`Attempt ${attempt}/${MAX_RECOVERY_ATTEMPTS}\`);` | First in-attempt log |
| 297 / 311 | `exit_status = 'llm_error'; … break;` / `exit_status = 'validation_failed'; … break;` | **Exit-status pattern — match this for `'bot_died'`.** |
| 370 | `result = await run_action(action, agent, log, searched_targets);` | **Inner action call — insert inner death check IMMEDIATELY AFTER this.** |
| 387–392 | `if (result_indicates_hard_failure(result)) { spl.warn(...); hard_failed = true; exit_detail = result.kind; break; }` | Hard-failure exit pattern from action loop |
| 407–410 | `if (hard_failed) { exit_status = 'hard_failure'; break; }` | Outer-loop reaction to inner hard-fail |
| 416–423 | Post-loop exit log: distinguishes `exit_status === null` (natural exhaustion) vs early-bail. **Already supports a new `exit_status` value — bot-died will print as `Recovery aborted at attempt N/M (bot_died).`** |
| 425 | `return 'fail';` | Sole fail return (success returns at line 379) |
| 427–429 | `} finally { clear_active_replanner(); }` | Cleanup |

**Outer death check (insert just after `exit_attempt = attempt;` at line 273):**

```js
if (agent.bot._ah_death_pending) {
  spl.log(`Bot died — aborting recovery at attempt ${attempt}/${MAX_RECOVERY_ATTEMPTS}.`);
  exit_status = 'bot_died';
  break;
}
```

The existing post-loop block at 416–423 will then emit `Recovery aborted at attempt N/MAX_RECOVERY_ATTEMPTS (bot_died).` and the function returns `'fail'` at 425 — caller already handles `'fail'`.

**Inner death check (insert just after `run_action` call at line 370):**

```js
if (agent.bot._ah_death_pending) {
  spl.log(`Bot died mid-plan — stopping action sequence in attempt ${attempt}.`);
  hard_failed = true;
  exit_detail = 'bot_died';
  break;
}
```

This breaks the inner per-retry loop. The enclosing per-action-index loop's next iteration's `if (result_indicates_hard_failure(result)) break;` at 387 won't trigger (the bot-died message isn't a HARD_FAILURE_KIND), so we set `hard_failed = true` explicitly so the outer loop's `if (hard_failed) { exit_status = 'hard_failure'; break; }` at 407–410 fires immediately.

(Alternative: use the outer-loop check approach exclusively — let the inner action loop finish whatever's left this attempt and let the OUTER death check on the next iteration handle termination. This is simpler but burns one more attempt's worth of action retries before bailing. The inner check above is preferred for fastest abort.)

### 5.5 Verification commands

```bash
# Syntax check
node --check achievement_hunter/src/pipeline/structured_loop/search_replanner.js
node --check achievement_hunter/src/pipeline/structured_loop/failure_replanner.js

# Test suite — should remain at 235/235 (the checks fire only when _ah_death_pending=true,
# which no existing test simulates)
npx vitest run

# Confirm flag canonical form
grep -rn "_ah_death_pending" achievement_hunter/src/ src/agent/

# Look for any other replanner-style attempt loops we might have missed
grep -rn "MAX_\(SEARCH_REPLANNER\|RECOVERY\)_ATTEMPTS" achievement_hunter/src/
```

### 5.6 Deployment note

Both edit targets are under `achievement_hunter/src/`, which IS bind-mounted in `docker-compose.yml` (along with `achievement_hunter/docs`, `achievement_hunter/logs`, `achievement_hunter/rollouts`, `achievement_hunter/rollout_live`). A `docker compose restart mindcraft` suffices — no `--build` needed.

Files under upstream `src/agent/` would need a full rebuild, but this fix does not touch them.

### 5.7 In-rollout log signature to look for

After the fix, the dying-mid-recovery rollout signature should change from:

```
[SPL] Agent died: AH_Bot drowned
[SPL][search] Attempt 2/10
[SPL][search] ... bot_died: aborted ! ...
[SPL][search] Attempt 3/10
... (repeats through attempt 10) ...
[SPL] Bot death observed after sweep search_replanner — aborting task.
```

to:

```
[SPL] Agent died: AH_Bot drowned
[SPL][search] Bot died mid-plan — stopping action sequence in attempt N.
[SPL][search] Bot died — aborting recovery at attempt N/10.
[SPL] Bot death observed after sweep search_replanner — aborting task.   # (backstop, may or may not fire)
```

with N typically 1 or 2 (the attempt during which death occurred), and SCSG re-entry happening within ~1–3 seconds of the death event.

### 5.8 Out of scope for this fix (track separately)

- `goToNearestLand` should fall back to `!moveAway` when its midpoint give-up triggers, giving a drowning bot a real recovery path. This is the user's "Issue 2", to be addressed after Issue 1 is verified working in a rollout.
- Replacing `_ah_death_pending` side-channel flag with a first-class `bot_died` result kind. Larger refactor; this fix doesn't block it.

---

## 6. Companion edit — `achievement_hunter/src/agent/pathfinding_wrappers.js`

### 6.1 Why include it

Audit of all `_ah_death_pending`-aware sites (see grep output below) found:

- ✅ `command_utils.js` (3 sites — command layer)
- ✅ `actions.js` (8 sites — top-level task driver and sweep handler)
- ✅ `search.js` (2 sites — search/sweep)
- ✅ `loop.js` (lifecycle: init/set/clear)
- ❌ `search_replanner.js` (this fix — §5.3)
- ❌ `failure_replanner.js` (this fix — §5.4)
- ⚠️ `pathfinding_wrappers.js` — has a `while (true)` retry loop at line 139 with no direct flag check.

Verify with: `grep -rn "_ah_death_pending" achievement_hunter/src/ src/`

### 6.2 Severity: LOW (defense-in-depth, not a known live bug)

The wrapper's `while (true)` loop at `pathfinding_wrappers.js:139` calls `agent.actions.runAction(...)` at lines 158 and 218. The loop checks `finalReturn.interrupted && !finalReturn.timedout` at line 167 and exits with `{ success: false, message: '' }`. So if `runAction` correctly reports interruption on death, the wrapper bails cleanly — this is the common case.

The hypothetical risk: if `runFinal` ever returns a normal failure shape during death (e.g. pathfinder returns "No path to the goal" because the entity was removed mid-search rather than raising an interrupt), the wrapper would classify the message as `retryable` (lines 41–47), try a midpoint hop on the corpse (line 218), increment `depth` (line 244), and loop. Two compounding safeguards bound the damage:

1. **`PATHFINDING_WRAPPER_MAX_DEPTH = 4`** (`config.js:80`) — at most 4 iterations of final + midpoint before the `depth >= maxDepth` exit at line 177 fires.
2. **No-forward-progress check** at lines 254–272 — fires when iter-end XZ-distance to target hasn't dropped by ≥`MIN_FORWARD_PROGRESS_BLOCKS` (1.0). A dead bot does not move, so this almost certainly bails on iteration 1.

Combined with `command_utils`'s immediate-abort behavior on `_ah_death_pending` (commands return in milliseconds), the realistic worst-case waste is ~1–2 fast-aborted cycles before the no-progress check exits — i.e. seconds, not minutes. The explicit flag check is therefore strict insurance, not a measurable performance fix.

Still worth adding because: (a) it makes the wrapper's death behavior explicit rather than emergent, (b) it produces a clean `reason=bot_died` log line in the per-day pathfinding log for post-mortem clarity, and (c) it costs one line of code.

### 6.3 The edit

Insert a single check at the top of the `while (true)` loop body, immediately after line 139:

```js
while (true) {
    if (agent.bot._ah_death_pending) {
        logAttempt({ label, phase: 'give_up', depth, reason: 'bot_died' });
        return { success: false, message: '' };
    }
    // --- Progress snapshot --- (existing line 140 comment)
    ...
}
```

Match the existing `logAttempt` shape — the wrapper has its own structured log format (line 105) that other give_up paths use (e.g. line 178 `reason: 'maxDepth=...'` and line 209 `reason: 'midpoint_too_close_to_target...'`). Using `logAttempt` keeps the death event in the same per-day log file at `PATHFINDING_WRAPPER_LOG_DIR/<date>.log` so post-mortem analysis stays uniform.

Return shape `{ success: false, message: '' }` mirrors the existing interrupted-bail return at line 169 — the caller (`agent.actions.runAction`) already handles empty-message false results.

### 6.4 Verification (companion)

```bash
node --check achievement_hunter/src/agent/pathfinding_wrappers.js
npx vitest run  # should remain at 235/235
grep -n "_ah_death_pending" achievement_hunter/src/agent/pathfinding_wrappers.js  # should show 1 hit at the top of withPathRetry's while loop
```

### 6.5 Deployment

`achievement_hunter/src/agent/` is bind-mounted in `docker-compose.yml` (same as `pipeline/`). `docker compose restart mindcraft` suffices — no rebuild.

---

## 7. Final summary — files touched by this fix

| File | Edits | Severity | Risk |
|---|---|---|---|
| `achievement_hunter/src/pipeline/structured_loop/search_replanner.js` | 2 inserts (~7 lines) | HIGH — known live bug | Low |
| `achievement_hunter/src/pipeline/structured_loop/failure_replanner.js` | 2 inserts (~10 lines) | HIGH — suspected same shape | Low |
| `achievement_hunter/src/agent/pathfinding_wrappers.js` | 1 insert (~4 lines) | LOW — defense-in-depth (bounded by maxDepth=4 + no-forward-progress check) | Very low |

**Out of scope** (do not touch as part of this fix): `command_utils.js`, `actions.js`, `search.js`, `loop.js` (already correct); `scsg.js`, `self_refine.js`, `tasks.js`, `io_queue.js` (audit confirmed no async-bot loops); upstream `src/agent/action_manager.js` (gated by `this.executing`).

### 7.1 Combined verification

```bash
# Syntax
node --check achievement_hunter/src/pipeline/structured_loop/search_replanner.js
node --check achievement_hunter/src/pipeline/structured_loop/failure_replanner.js
node --check achievement_hunter/src/agent/pathfinding_wrappers.js

# Tests — should remain at 235/235
npx vitest run

# Confirm new checks exist
grep -c "_ah_death_pending" \
    achievement_hunter/src/pipeline/structured_loop/search_replanner.js \
    achievement_hunter/src/pipeline/structured_loop/failure_replanner.js \
    achievement_hunter/src/agent/pathfinding_wrappers.js
# Expected: 2, 2, 1
```

### 7.2 Confidence after review

- **Fix completeness:** ~95% — three loops in two layers + one defense-in-depth site. Audit found no other middle-of-stack loops that await bot/action calls without flag awareness.
- **Line-number accuracy:** ~95% as of 2026-05-14. If any other patches land before this one, re-grep for the landmark strings (`for (let attempt = resume_attempt`, `const finalize =`, `result = await run_action`, `while (true)` in pathfinding_wrappers) to find the new lines.
- **No tests need to change:** none of the existing 235 tests simulate `_ah_death_pending = true`, so adding checks that fire only when the flag is set is purely additive.
