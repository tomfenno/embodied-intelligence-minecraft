# BUG 9 — `GoalChanged` Propagates Through Recovery Boundary and Crashes the SPL

## Status

**Removed** on branch `search-agent` — owner determined the underlying patch (`ensure_safe_before_llm`) was ineffective at protecting the bot in practice. The function and both call sites (`failure_replanner.js`, `search_replanner.js`) were deleted entirely, which also eliminates the `GoalChanged` race this bug report describes (no more `moveAway` call inside the recovery boundary to race with).

Originally **Fixed** on branch `hard-code-nts-am` via the patch below; the patch was removed because it didn't deliver the safety it claimed.

**Patch (now removed):** was at `achievement_hunter/src/pipeline/structured_loop/failure_replanner.js` (`ensure_safe_before_llm` — positional water check on block-below / block-above + try-catch around the escape).

## Severity

High — crashes the SPL entirely, losing all checkpoint-resumable progress. Triggers on any
mode interrupt (self_preservation, unstuck, etc.) that fires while `ensure_safe_before_llm`
is navigating.

## Observed Symptom

SPL crashes with `GoalChanged` immediately at the start of a recovery attempt, even though the
mode action (self_preservation `moveAway`) then succeeds and moves the bot to safety. The task
log shows it as a fatal crash rather than a recoverable failure.

```
[SPL][recovery] Attempt 1/3
[SPL] Structured loop crashed: GoalChanged: The goal was changed before it could be completed!
    at error (/app/node_modules/mineflayer-pathfinder/lib/goto.js:2:15)
    at EventEmitter.goalChangedListener (/app/node_modules/mineflayer-pathfinder/lib/goto.js:34:17)
    at EventEmitter.emit (node:events:531:35)
    at bot.pathfinder.setGoal (/app/node_modules/mineflayer-pathfinder/index.js:150:9)
    at /app/node_modules/mineflayer-pathfinder/lib/goto.js:63:20
    at new Promise (<anonymous>)
    at goto (/app/node_modules/mineflayer-pathfinder/lib/goto.js:17:10)
    at bot.pathfinder.goto (/app/node_modules/mineflayer-pathfinder/index.js:164:12)
    at goToGoal (file:///app/src/agent/library/skills.js:1123:30)
    at async Module.moveAway (file:///app/src/agent/library/skills.js:1442:5)
Mode self_preservation finished executing, code_return: Action output:
Found non-destructive path.
Moved away from (-2053, 62, -3690) to (-2050, 63, -3685).
```

Note: self_preservation succeeds and moves the bot. The crash is from the race, not a real failure.

## Root Cause

**File:** `achievement_hunter/src/pipeline/structured_loop/failure_replanner.js:221`

`recover_failed_task` calls `ensure_safe_before_llm` before each LLM prompt. When the bot is
near water, `ensure_safe_before_llm` calls `skills.moveAway(bot, 10)`, which internally calls
`bot.pathfinder.goto(goalA)` and awaits it.

While `goto(goalA)` is pending, a mode (self_preservation, unstuck, etc.) fires and calls its
own `moveAway`. That call reaches `bot.pathfinder.goto(goalB)` → `bot.pathfinder.setGoal(goalB)`
→ fires the `goal_changed` event. The pending `goto(goalA)`'s `goalChangedListener` catches the
event and throws `GoalChanged`.

### Propagation chain

```
ensure_safe_before_llm:194  → moveAway → goto(goalA) awaiting...
  [mode fires]              → goto(goalB) → setGoal(goalB) → goal_changed event
  goto(goalA) throws GoalChanged
    ↓ (uncaught — no try-catch at failure_replanner.js:221)
recover_failed_task:221
    ↓ (uncaught — line 221 is outside any try-catch)
execute_task_action
    ↓ (uncaught)
structured_loop while(true)
    ↓ (try/finally only — no catch inside the loop)
_launch_spl .catch()       → "Structured loop crashed"
```

The crash is structurally identical to the one observed in the prior session where
`self_preservation` interrupted the recovery code path (see BUG 6 trace).

### Why the exception escapes

`ensure_safe_before_llm` has no try-catch. Line 221 in `recover_failed_task`:

```js
await ensure_safe_before_llm(agent);   // line 221 — throws GoalChanged, no catch
const raw = await model.send_prompt(prompt);  // never reached
```

The SPL's while loop has `try/finally` for cleanup but no `catch` for per-iteration errors:

```js
try {
  while (true) {
    // ...
    if (await execute_task_action(...) === 'success') { ... }  // throws GoalChanged
  }
} finally {
  bot.off('death', on_death);  // cleanup only
}
```

Any unhandled exception inside the loop escapes through the `finally` and crashes `structured_loop`.

## Fix

**File:** `achievement_hunter/src/pipeline/structured_loop/failure_replanner.js:246–273`

Two changes to `ensure_safe_before_llm`:

1. **Use a positional water check: block below or block above.** `oxygenLevel < 15` (matching
   `self_preservation`) was tried first but turned out not to be a reliable indicator of whether
   the bot is in water — oxygen only depletes when the head is fully submerged, so a bot
   standing on a water block with its head at an air gap reads a normal oxygen level and the
   pre-LLM check skips. The current check is positional:
   `block_below?.name === 'water' || block_above?.name === 'water'`. This catches both the
   standing-on-water case (likely to be pulled under during the LLM wait) and the head-submerged
   case, which is what the safety check needs to cover.

2. **Wrap the escape in try-catch.** When both `ensure_safe` and `self_preservation` fire at
   the same time, the mode wins the pathfinder race and moves the bot to safety. The
   `GoalChanged` from the cancelled `moveAway` is caught and logged. The LLM call proceeds —
   the mode's escape was sufficient.

```js
// failure_replanner.js — ensure_safe_before_llm (applied)
async function ensure_safe_before_llm(agent) {
  const bot = agent.bot;
  const block = bot.blockAt(bot.entity.position);
  const block_above = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  const block_below = bot.blockAt(bot.entity.position.offset(0, -1, 0));

  const in_water =
      block_below?.name === 'water' || block_above?.name === 'water';
  const in_lava = block?.name === 'lava' || block_above?.name === 'lava';

  try {
    if (in_water) {
      await skills.moveAway(bot, 10);
    } else if (in_lava) {
      await bot.lookAt(bot.entity.position.offset(5, 1, 0), true);
      bot.setControlState('jump', true);
      bot.setControlState('sprint', true);
      await new Promise(r => setTimeout(r, 3000));
      bot.clearControlStates();
    }
  } catch (e) {
    // A mode (self_preservation) raced with this escape and won — it moved the
    // bot to safety already. Log and proceed; the mode's escape is sufficient.
    spl.warn(`ensure_safe_before_llm: escape interrupted (${e.message}) — mode moved bot to safety.`);
  }
}
```

### Why not `oxygenLevel`?

Tried first; rejected. Oxygen only drops when the head is fully submerged, so a bot standing
on water (feet block water, head at air gap) reads a normal `oxygenLevel` and the pre-LLM
check skips — exactly the case where the bot is most likely to be pulled under during the
30–120 s LLM wait. The block-below / block-above check catches both the surface case and the
fully-submerged case directly.

### Why not replace `moveAway` with direct controls (jump + sprint)?

`jump=true` + `sprint=true` causes the bot to float upward toward the water surface but does
NOT navigate to dry land. After the timeout the bot stops wherever it is — potentially still in
shallow water. `moveAway` uses the pathfinder to navigate to solid ground, which is the correct
behaviour for a pre-LLM safety check. The race is fixed by the try-catch, not by removing
`moveAway`.

### Why not catch at the SPL loop level (Fix B)?

A broad catch on `GoalChanged`/`PathStopped` at the `execute_task_action` level treats all
navigation interruptions as task failures. This:
- Uses a fragile error-message string match (`startsWith('GoalChanged')`) — library format can change
- Masks real pathfinder failures that the outer retry logic should see
- Is the wrong level of abstraction — the race is inside `ensure_safe_before_llm`, fix it there

### Fix complexity

Low — 8 lines changed in a single function. No new imports. No behavior change on the happy
path (bot not in water/lava before LLM call).

## Evidence

From the trace above:
- `!collectBlocks("oak_log", 3)` failed 5 times with `{ success: false, message: '' }` —
  likely due to mode interruptions (same root as previous self_preservation ping-pong issues)
- Recovery attempt 1 started → `ensure_safe_before_llm` ran → `moveAway` was interrupted by
  `self_preservation` → GoalChanged thrown and uncaught → SPL crash
- After the crash, self_preservation successfully moved the bot and `item_collecting` mode
  picked up 3 items — confirming the crash was from the race, not a real navigation failure

## Relation to Other Bugs

- **BUG 6:** Same propagation pattern — mode interrupt during recovery causes exception to
  escape through `failure_replanner` and crash SPL. BUG 6 patches fixed the drowning
  trigger condition but not the propagation vulnerability.
- **BUG 5:** First identified that mode interrupts can crash the SPL. Fix B here is the
  general solution that makes the SPL resilient to this class of failure regardless of which
  mode fires.
