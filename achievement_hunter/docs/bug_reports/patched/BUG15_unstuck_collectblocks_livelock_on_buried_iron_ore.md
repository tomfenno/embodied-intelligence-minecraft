# BUG 15 — Unstuck-vs-CollectBlocks Livelock When Mining a Buried Iron Ore (No CleanKill Variant of BUG 12)

**Severity:** High (task never progresses; rollout stalls on `raw_iron` collect; no
process exit, no `failure_replanner` recovery path that breaks the loop)
**Status:** Fixed (Fix B only) — applied on branch `main`. Fix A intentionally not
applied; see "Why Fix A isn't safe yet."
**Branch:** `main`
**Trace:** `achievement_hunter/rollouts/2026-05-11T01-42-44-300Z_test/`
**Patch location:**
- `achievement_hunter/src/pipeline/command_utils.js:71–101` — `build_mode_interrupted_result` returns `{mode_interrupted: true, mode_interrupt_counts, position_before, position_after, message}` on interrupt-cap exhaustion or idle timeout.
- `achievement_hunter/src/agent/ah_modes.js:478–480` — new `getActiveModeNames()` introspection so `command_utils` can attribute interrupts to specific modes.
- `achievement_hunter/src/pipeline/structured_loop/actions.js:28–34` — added `'mode_interrupted'` to `RECOVERABLE_FAILURE_KINDS`.
- `achievement_hunter/src/pipeline/structured_loop/actions.js:146–159` — step result built with `kind: 'mode_interrupted'` and the per-mode tallies + displacement attached.
- `achievement_hunter/src/pipeline/structured_loop/actions.js:369–378` — stable signature for `mode_interrupted` results so retry-counting doesn't reset on the floating numbers in `message`.
- `achievement_hunter/src/pipeline/structured_loop/actions.js:391–398` — Fix B (tightened): `should_abort_repeated_failure` returns true on the *first* `mode_interrupted` failure on a command (`repeated_count >= 1`). Rationale: a single such failure already represents `MAX_MODE_INTERRUPTS=5` consecutive in-attempt mode firings — enough evidence to abort to the replanner without waiting for a second outer attempt.
- `achievement_hunter/src/pipeline/command_utils.js:3` — `MAX_MODE_INTERRUPTS` lowered from 10 to 5. With the tightened Fix B, total mode firings before replanner takes over drop from 10×5 = 50 worst-case to 5×1 = 5 (single-attempt budget, then abort).
- `achievement_hunter/src/pipeline/structured_loop/trace.js:18–40` — `project_failed_steps` now surfaces `mode_interrupt_counts` / `position_before` / `position_after` into the slim failed-step summary the replanner reads.
- `achievement_hunter/docs/prompts/failure_replanner/failure_replanner.md` (Reasoning Guidance) — explicit instruction to relocate or change source on `kind: "mode_interrupted"` rather than re-issuing the same command.

**Related files:**
- `achievement_hunter/src/pipeline/command_utils.js` (`executeCommandWithModeRecovery`, `MAX_MODE_INTERRUPTS = 5` — lowered from upstream's 10 by Fix B's accompanying patch)
- `achievement_hunter/src/pipeline/structured_loop/actions.js` (`execute_task_action`, `max_inner_retries = 5`, `mediate_collect`)
- `src/agent/modes.js:90–139` (`unstuck` mode definition)
- `src/agent/library/skills.js:417–557` (`collectBlock`)

**Related bugs:**
- **BUG 12** — same root cause family (unstuck fires on `!collectBlocks`). Different
  failure shape: BUG 12's `collectBlocks` *wedges*, `ActionManager.stop()` cannot evict
  it, and `cleanKill` exits the process after 10 s. BUG 15's `collectBlocks` yields to
  the interrupt *cleanly*, no listener leak warnings appear, no process exit occurs —
  the action layer is healthy. The damage is at the SPL retry layer: unstuck and
  `collectBlocks` form a livelock that bounces the bot between the dig site and a
  surface position with no net progress.
- **BUG 13** — same physical scenario as BUG 12 (iron collection wedge) but post-
  pickaxe-break. Not applicable here: the bot has a fresh `stone_pickaxe` (just crafted
  at stage 46, never used to dig before iron) and never reports a tool break.

---

## Symptom

The agent finishes crafting `stone_pickaxe` (full_task_trace task 11, terminal_status
`success`) and the SPL determines the next task is:

```json
{"target_item":"raw_iron","qty":1,"action_type":"collect",
 "parameters":{"source_block":"iron_ore","item_dependency":null,"tool":"stone_pickaxe"}}
```

(`rollout_trace.json` stage 49, elapsed `2m 53s`.) From the state in stage 50
(`achievement_hunter/rollouts/2026-05-11T01-42-44-300Z_test/rollout_trace.json`), the
bot is at position `(212.34, 144, -61.37)` standing on stone, with `iron_ore` in
`nearby_blocks` and `stone_pickaxe` equipped. `mediate_collect`
(`actions.js:210–226`) emits `!collectBlocks("iron_ore", 1)`.

The action enters an indefinite oscillation. From the supplied log (one task attempt,
all 10 mode-recovery retries):

```
[SPL] Next task: {"target_item":"raw_iron","qty":1,"action_type":"collect", ... }
[SPL] Action (attempt 1/5): !collectBlocks("iron_ore", 1)
parsed command: { commandName: '!collectBlocks', args: [ 'iron_ore', 1 ] }
executing code...

executing code...

action "mode:unstuck" trying to interrupt current action "action:collectBlocks"
waiting for code to finish executing...
[SPL][cmd] Mode interrupted command (1/10), waiting for idle: !collectBlocks("iron_ore", 1)
Mode unstuck finished executing, code_return: Action output:
Found non-destructive path.
Moved away from (220, 150, -55) to (215, 153, -54).

[SPL][cmd] Modes idle, retrying: !collectBlocks("iron_ore", 1)
parsed command: { commandName: '!collectBlocks', args: [ 'iron_ore', 1 ] }
executing code...

executing code...

action "mode:unstuck" trying to interrupt current action "action:collectBlocks"
waiting for code to finish executing...
[SPL][cmd] Mode interrupted command (2/10), waiting for idle: !collectBlocks("iron_ore", 1)
Mode unstuck finished executing, code_return: Action output:
Found non-destructive path.
Moved away from (220, 150, -54) to (219, 154, -51).

... (interrupts 3–9, all with the same "from (220, 150, -54) to (219, 154, -51)"
   move-away coordinates except the final two, which drift to (224, 152, -57) and
   (225, 155, -50)) ...

[SPL][cmd] Mode interrupted command (10/10), waiting for idle: !collectBlocks("iron_ore", 1)
Mode unstuck finished executing, code_return: Action output:
Found non-destructive path.
Moved away from (229, 152, -53) to (225, 155, -50).

[SPL][cmd] Modes idle, retrying: !collectBlocks("iron_ore", 1)
parsed command: { commandName: '!collectBlocks', args: [ 'iron_ore', 1 ] }
executing code...
```

Three things to note:

1. **No `cleanKill`, no `MaxListenersExceededWarning`.** `collectBlocks` is yielding to
   the interrupt cleanly — `bot.collectBlock.cancelTask()` is *resolving* (the second
   `executing code...` print pair is unstuck's `moveAway`, and `Mode unstuck finished
   executing` appears every cycle). The deadlock from BUG 12 is absent.
2. **Move-away coordinates are nearly identical across retries.** The unstuck mode
   reports `from (220, 150, ...)` six times in a row. After unstuck moves the bot up
   ~3 blocks, `collectBlocks` re-pathfinds back down to (or near) the same `(220,
   150)` neighborhood — the same iron ore is the nearest match for
   `getNearestBlocksWhere(... 'iron_ore' ..., 64, 1)` (`skills.js:459–476`) every time
   — and gets stuck again at the same site within unstuck's 20-second window.
3. **Rollout never terminates.** `rollout_trace.json` has `status: "running"` and
   `task_traces/full_task_trace.jsonl` ends at task 11 (`stone_pickaxe`). Task 12
   (`raw_iron` collect) never produces a `terminal_status` line; the rollout was
   saved mid-livelock.

User-facing description: *"the agent just kept attempting to mine iron underneath them
but never succeeded."*

---

## Root Cause

### The interaction loop

```
mediate_collect("iron_ore")
   → !collectBlocks("iron_ore", 1)
       → skills.collectBlock → bot.collectBlock.collect(target)
           → bot.pathfinder.goto(... near target ...)
               → bot stands at dig site, begins digging stone to reach iron_ore
                   (xz position changes slowly; many sub-block digs)
                   ⏱ 20s elapses with distance(prev_location, current) < 2
                       → unstuck.update fires (modes.js:90–133)
                       → unstuck calls skills.moveAway(bot, 5)
                           → ActionManager.stop() preempts collectBlocks
                           → bot.collectBlock.cancelTask() resolves cleanly
                           → moveAway pathfinds the bot UP/AWAY ~3 blocks
                       → "Mode unstuck finished executing"
   → executeCommandWithModeRecovery sees result.success !== true
   → bot.modes.isAnyModeActive() is now false → wait for idle (✓)
   → retry !collectBlocks("iron_ore", 1)  ← SAME command, SAME mediation
   → ... same cycle ...
```

This is a **livelock**, not a deadlock: every component is making forward progress
against its own contract (unstuck moves the bot, recovery wrapper retries the failed
command, mediate_collect re-issues since iron_ore is still in `nearby_blocks`), yet
the macro state — bot at the buried iron ore, with no iron in inventory — never
changes.

### Where the loop is unbounded

Three retry layers compose, and none of them detects the livelock:

1. **`executeCommandWithModeRecovery`** (`command_utils.js:18–52`) caps individual
   mode interrupts at `MAX_MODE_INTERRUPTS = 10`. Quoting:
   ```js
   if (agent.bot.modes.isAnyModeActive()) {
     if (interrupt_count >= maxModeInterrupts) {
       warn(`Command interrupted by mode ${interrupt_count} time(s), treating as failure:`, command);
       return {success: false, message: 'mode_interrupted'};
     }
     interrupt_count++;
     log(`Mode interrupted command (${interrupt_count}/${maxModeInterrupts}), waiting for idle:`, command);
     ...
     continue;
   }
   ```
   The comment is explicit (`command_utils.js:9–17`): *"Mode interruptions are not
   counted as failures — the bot is moved to safety and the same command is retried."*
   This is intentional for one-off interrupts (e.g. `self_preservation` evicting a
   bot from lava once). It is wrong for an unstuck mode that fires deterministically
   on every retry: each retry resets the unstuck state (`unstuck.unpause` clears
   `prev_location` and `stuck_time` — `modes.js:134–138`), so the 20-second timer
   restarts. The next 20 s of digging is again "movement <2 blocks → stuck", and
   unstuck fires again. The cap caps a *single* SPL attempt, not the livelock.

2. **`execute_task_action`** (`actions.js:55–182`) caps inner attempts at
   `max_inner_retries = 5`. When `executeCommandWithModeRecovery` returns
   `{success:false, message:'mode_interrupted'}`, `is_successful_command_result`
   returns false (`actions.js:339–349`), `get_command_failure_signature` produces
   `!collectBlocks("iron_ore", 1) || mode_interrupted` (`actions.js:351–362`), and the
   loop counts it as a repeated identical failure. **But the early-abort guard only
   fires for craft-recipe timeouts** (`actions.js:364–370`):
   ```js
   export function should_abort_repeated_failure(command, result, repeated_count) {
     const message = result?.message ?? '';
     return command.startsWith('!craftRecipe(') &&
         message.includes('Event updateSlot:0 did not fire within timeout') &&
         repeated_count >= 2;
   }
   ```
   For a `mode_interrupted` failure on `!collectBlocks` the guard does nothing, so all
   five attempts run. That is **5 × 10 = 50 unstuck firings per task** before
   `execute_task_action` finally exits with `exhausted_inner_retries` and hands off
   to `failure_replanner`.

3. **`failure_replanner`** then runs `MAX_RECOVERY_ATTEMPTS = 3` recovery cycles
   (`failure_replanner.js:21`). Each cycle that proposes `!collectBlocks(iron_ore, …)`
   or `!search("iron_ore")` plus follow-on collect will re-enter the same livelock.
   Eventually replanner exhausts and the task fails — but the SPL's outer loop will
   re-select `raw_iron` collect on the next iteration (since the resource graph
   `vertices: [iron_ingot, raw_iron]` from stage 47 still has the same unmet
   `raw_iron` vertex), and the cycle restarts.

### Why unstuck fires *every* retry on the same scene

`modes.js:90–133` (annotated):

```js
{
  name: 'unstuck',
  interrupts: ['all'],
  prev_location: null,
  distance: 2,
  stuck_time: 0,
  max_stuck_time: 20,
  prev_dig_block: null,
  update: async function (agent) {
    if (agent.isIdle()) { ... return; }
    const bot = agent.bot;
    const cur_dig_block = bot.targetDigBlock;
    if (cur_dig_block && !this.prev_dig_block) {
      this.prev_dig_block = cur_dig_block;
    }
    if (this.prev_location
        && this.prev_location.distanceTo(bot.entity.position) < this.distance
        && cur_dig_block == this.prev_dig_block) {
      this.stuck_time += (Date.now() - this.last_time) / 1000;
    } else {
      this.prev_location = bot.entity.position.clone();
      this.stuck_time = 0;
      this.prev_dig_block = null;
    }
    ...
    if (this.stuck_time > max_stuck_time) {
      ...
      execute(this, agent, async () => {
        ...
        await skills.moveAway(bot, 5);
        ...
      });
    }
  },
  unpause: function () {
    this.prev_location = null;
    this.stuck_time = 0;
    this.prev_dig_block = null;
  }
}
```

When the agent is digging through stone to reach a buried `iron_ore`:

- xz position drifts by sub-block amounts per dig (bot stays standing on the same
  pillar while breaking adjacent blocks). 3D `distanceTo` reads <2 most ticks.
- `cur_dig_block` changes between *different* stone blocks frequently. The check
  `cur_dig_block == this.prev_dig_block` compares object identity, not block type.
  Each new dig-target is a different `Block` instance, so the condition
  `cur_dig_block == this.prev_dig_block` is false → the *else* branch fires →
  `prev_location` and `prev_dig_block` reset, `stuck_time` resets to 0.

  **Hypothesis (likely cause, not directly proven from log):** the reset on
  *different* dig blocks is what *should* make the unstuck mode forgiving while
  legitimate dig-chains are running. But the user observes unstuck firing anyway,
  which suggests one of:
  - the bot is not actively `targetDigBlock`-ing during the bulk of the 20 s
    (pathfinder is *thinking* between digs), so `cur_dig_block` is `null` and the
    condition `cur_dig_block == this.prev_dig_block` is `null == null` = true →
    stuck_time accumulates;
  - or `mineflayer-collectblock` waits on `pathfinder.goto` for an unreachable goal
    (iron_ore boxed in by stone with no walkable approach), the bot stands still in
    a corridor with `targetDigBlock=null` for >20 s, and unstuck fires.

  The log's `Moved away from (220, 150, -55) to (215, 153, -54)` (vertical Δy=+3)
  is consistent with the bot being on a roof/ledge at y=150 above the ore — i.e.,
  pathfinder is *not actively digging downward* at unstuck-fire time, it is
  parked while computing.

- Once unstuck fires, the bot is teleported up ~3 blocks (`moveAway(bot, 5)`).
  `unstuck.unpause` clears state. `executeCommandWithModeRecovery` retries
  `!collectBlocks("iron_ore", 1)`. The plugin runs `getNearestBlocksWhere(...,
  'iron_ore', 64, 1)` from the new position; the same iron_ore is again the nearest
  match; pathfinder routes back toward it. Within 20 s the bot is again parked
  somewhere near (220, 150, ...) and unstuck fires again. The "from" coordinates
  repeating across attempts 2–7 (`(220, 150, -54)`) are the empirical proof that the
  bot returns to the same stuck position each retry.

### Proximate vs root cause

- **Proximate:** `unstuck` fires deterministically on the bot's idle-while-pathfinding
  state at the dig site; `executeCommandWithModeRecovery` treats every interrupt as
  "transient" and retries; `mediate_collect` re-issues the same command because
  `iron_ore` is still in `nearby_blocks`.
- **Root:** there is no feedback signal from the *retry layer* back to the *mode
  layer* that says "your interrupt was the cause of the prior failure." The SPL
  cannot distinguish "unstuck fired once, command then succeeded" from "unstuck
  fired ten times, command never started making real progress." Both look like
  "interrupts: N, success: false" to the wrapper.

---

## Why existing safeguards didn't catch this

- **`MAX_MODE_INTERRUPTS = 10`** bounds *one* SPL attempt's worth of interrupts, not
  the whole task. The wrapper's comment explicitly excludes mode interrupts from
  failure accounting (`command_utils.js:9–17`).
- **`should_abort_repeated_failure`** only fast-aborts repeated `!craftRecipe`
  `updateSlot:0` timeouts (`actions.js:364–370`). A `!collectBlocks ... ||
  mode_interrupted` repeat falls through the normal 5-attempt budget.
- **`bot.modes.pause('unstuck')`** is used in other skills that have similar
  exposure (`skills.js:180` and `:1412/:1516/:1598/:1753` — see e.g. the
  furnace/place flows), but `skills.collectBlock` does *not* pause unstuck around
  the `bot.collectBlock.collect(block)` call (`skills.js:526`) or around the
  manual-dig branch (`skills.js:520–523`). So `collectBlocks` is uniquely exposed.
- **BUG 12's progress watchdog (proposed Fix C in that report)** would not catch
  this because the watchdog measures "moved <0.5 blocks AND no block broken in 8 s."
  Here the bot *does* move (unstuck moves it ~3 blocks every ~20 s) and *may* be
  breaking blocks during the digging phase. The watchdog's "no progress" definition
  is satisfied by the unstuck movement itself.
- **BUG 12 / BUG 13's other fixes (cooperative cancellation, `unclean_exit_count`)**
  are orthogonal: BUG 12's cancellation fix makes `stop()` return faster, BUG 13's
  checkpoint counter catches infinite restart loops. Neither addresses a livelock
  that never crashes the process.

---

## Proposed Fix

**Observational caveat (added after first review).** The user reports that during the
livelock the bot's animation shows it *swinging at the block but never landing a hit*
— i.e., the dig is started but no `diggingCompleted` event ever fires. The log
excerpt does not include dig-event traces, so this is currently a behavioral
observation, not a logged fact, but it materially changes the fix story below: if
the underlying mining call cannot break the block at all, then suppressing the
`unstuck` interrupt converts a *bounded livelock that eventually exits to
`failure_replanner`* into an *unbounded hang with no exit*. The action layer has no
internal time/progress watchdog inside `skills.collectBlock`, and
`bot.interrupt_code` (`skills.js:458, 552`) only flips on an external `stop()` call
— which the surrounding `ActionManager` will never issue once `unstuck` is paused.

This caveat means **Fix A below is *not* recommended as-is**; it is documented to
explain why the "obvious" pause-unstuck approach is wrong here.

### Fix B (primary) — Count `mode_interrupted` failures toward early abort

Extend `should_abort_repeated_failure` (`actions.js:364–370`) so that two
consecutive `mode_interrupted` failures on the same command short-circuit the
five-attempt budget and hand off to `failure_replanner`:

```js
export function should_abort_repeated_failure(command, result, repeated_count) {
  const message = result?.message ?? '';

  // Start of AH code
  if (message === 'mode_interrupted' && repeated_count >= 2) {
    return true;
  }
  // End of AH code

  return command.startsWith('!craftRecipe(') &&
      message.includes('Event updateSlot:0 did not fire within timeout') &&
      repeated_count >= 2;
}
```

**Robustness:** changes 5 × 10 = 50 unstuck firings into 2 × 10 = 20 before the
task is flagged failed and replanner runs. Crucially, this does *not* require us
to suppress `unstuck` — the mode keeps firing as a watchdog signal whenever the
bot is making no real progress, and the SPL just *believes* the signal sooner.
That preserves coverage for the underlying "swings but doesn't hit" failure: it
shows up as a `mode_interrupted` failure exactly as before, and now exits the
task quickly enough for the replanner to try a different action (e.g.
`!moveAway`, `!search("iron_ore")` with `exclude=[current position]`, or
re-selecting a different `iron_ore` from `nearby_blocks`).

**Soundness:** two consecutive `mode_interrupted` failures on the same command is
strong evidence the mode-and-command pair is stable. This is the same pattern as
the existing craft-timeout abort (`actions.js:367–369`) and lands in the same
function.

**Limitations:**
- Does not address the underlying "swings but doesn't hit" bug. That is a
  separate (deeper) issue likely living in `mineflayer-collectblock` /
  `bot.dig`'s pathfinder-reach computation, and should be filed as its own
  report once reproduced with dig-event-level logging.
- Does not prevent the *replanner* from also choosing `!collectBlocks(iron_ore,
  …)` again and re-entering the livelock. `MAX_RECOVERY_ATTEMPTS = 3`
  (`failure_replanner.js:21`) caps the recovery cycles but each cycle could
  burn another 2 × 10 interrupts. Total worst case after Fix B: 20 (initial
  attempt) + 3 × 20 (replanner cycles) = 80 interrupts ≈ 30 min, still much
  better than the current unbounded behavior, but not great. The principled fix
  for that is an in-skill progress watchdog (see "Why Fix A isn't safe yet"
  below).

### Why Fix A (pause `unstuck` inside `skills.collectBlock`) isn't safe yet

The pattern already exists in this codebase: `skills.js:180, :1412, :1516, :1598,
:1753` wrap stationary work in `bot.modes.pause('unstuck')` / `unpause('unstuck')`.
It is tempting to do the same for `collectBlock`'s for-loop body
(`skills.js:454–554`). **Don't, until a progress watchdog lands first.**

Failure mode without a watchdog:

1. `bot.modes.pause('unstuck')` at iteration top.
2. `bot.collectBlock.collect(block)` is called. Internally it loops on
   `pathfinder.goto + bot.dig`. If the dig animation runs but the block never
   actually breaks (the symptom user observed), the internal loop never resolves.
3. No mode fires — `unstuck` is paused, `self_preservation`/`cowardice`/`self_defense`
   only fire on damage/enemy presence which don't apply here.
4. `executeCommandWithModeRecovery` is blocked on `executeCommand` awaiting the
   action.
5. `ActionManager.stop()`'s 10 s watchdog never runs because nothing is calling
   `stop()`.
6. The agent process is alive but idle forever.

This is strictly worse than the current livelock, which at least exits to
`failure_replanner` after the inner-retry budget is spent.

**Prerequisite for safely applying Fix A:** add BUG 12's "Fix C — progress
watchdog" inside `skills.collectBlock` first — reject with `progress_timeout` when
xz-position has moved <0.5 blocks **and** `bot.diggingCompleted` has not fired in
the last ~10 s. With that landed, pausing `unstuck` becomes safe and Fix A
eliminates the cosmetic-but-wasteful unstuck loop. Without it, Fix A turns the
livelock into a hard hang.

If/when the prerequisite lands, the body would look like:

```js
// src/agent/library/skills.js — around the for-loop body of collectBlock
// PREREQUISITE: progress watchdog must be in place inside this loop body
// before applying this pause. See BUG 12 Fix C.
for (let i = 0; i < num; i++) {
    if (bot.interrupt_code) break;
    // ... existing block search ...

    // Start of AH code
    bot.modes.pause('unstuck');
    try {
        // existing equip + dig/collect logic (lines ~493–550)
        // with an inner ProgressTimeout rejection (BUG 12 Fix C)
    } finally {
        bot.modes.unpause('unstuck');
    }
    // End of AH code

    if (bot.interrupt_code) break;
}
```

### Fix priority

1. **Fix B immediately.** One-line guard inside `should_abort_repeated_failure`.
   No risk of converting a livelock into a hang. Reduces the worst-case wasted
   time on the supplied trace from "unbounded" to ~3 min before
   `failure_replanner` takes over.
2. **BUG 12 Fix C (progress watchdog inside `skills.collectBlock`)** next. This
   is the principled fix for the entire family of "action runs but makes no
   progress" wedges — including the "swings but doesn't hit" symptom this trace
   exhibits.
3. **Fix A (pause `unstuck` inside `collectBlock`)** *only after* (2) lands.
   Eliminates the cosmetic up-and-down motion during legitimate mining; not load-
   bearing for correctness once the watchdog is in place.

Fix B alone is sufficient to prevent the unbounded-rollout behavior in the
supplied trace.

---

## Evidence

From the supplied log (single task attempt, recovery wrapper interrupts 1–10):

| Interrupt # | Mode | Move-away `from` | Move-away `to` |
|---|---|---|---|
| 1 | unstuck | (220, 150, -55) | (215, 153, -54) |
| 2 | unstuck | (220, 150, -54) | (219, 154, -51) |
| 3 | unstuck | (220, 150, -54) | (219, 154, -51) |
| 4 | unstuck | (220, 150, -54) | (219, 154, -51) |
| 5 | unstuck | (220, 150, -54) | (219, 154, -51) |
| 6 | unstuck | (220, 150, -54) | (219, 154, -51) |
| 7 | unstuck | (220, 150, -54) | (219, 154, -51) |
| 8 | unstuck | (220, 150, -54) | (219, 154, -51) |
| 9 | unstuck | (220, 150, -54) | (224, 152, -57) |
| 10 | unstuck | (229, 152, -53) | (225, 155, -50) |

Observations:

1. **`from` column is `(220, 150, -54)` for eight consecutive retries.** Bot
   returns to the same parked position every time `collectBlocks` resumes. Direct
   proof that `getNearestBlocksWhere(... 'iron_ore' ..., 64, 1)`
   (`skills.js:459–476`) re-selects the same target each iteration.
2. **No `cleanKill`, no `MaxListenersExceededWarning`, no `Achievement agent
   process exited` line.** Distinguishes BUG 15 from BUG 12 — the action layer
   is healthy; the bug is at the retry layer.
3. **Every cycle logs `Mode unstuck finished executing, code_return: Action
   output:\nFound non-destructive path.\nMoved away from … to …`** — unstuck is
   completing, not wedging.
4. **`rollout_trace.json` `status: "running"`** and `full_task_trace.jsonl` has
   no record of task 12 — the rollout was saved while still in the livelock,
   confirming the task never reached a terminal state inside the trace window.
5. **Pre-iron context is clean.** Tasks 6–9 in `full_task_trace.jsonl` show the
   bot mining `stone` with `wooden_pickaxe` successfully (e.g. task 6: `Collected
   11 stone.` in a single attempt). The bot is not generally bad at digging — it
   is specifically the iron_ore acquisition step that wedges, consistent with the
   buried-in-stone geometry the user described.

---

## Relation to Other Bugs

- **BUG 12** (`unpatched/BUG12_unstuck_interrupt_deadlock_crashloop_with_checkpoint_resume.md`)
  — same family: `unstuck` interrupts `!collectBlocks(iron_ore, …)` and the SPL
  retry layer is the root of the problem. **Why this is a separate report:** BUG 12
  documents the *wedged-action* variant where `collectBlock`'s underlying
  `bot.collectBlock.collect()` cannot be cancelled, `ActionManager.stop()` polls
  fruitlessly, the listener leak grows, and `cleanKill` exits the process — leading
  to BUG 12's checkpoint-resume infinite restart loop. BUG 15 is the *clean-cancel*
  variant: cancellation works, the process never dies, and instead the SPL retries
  itself into a livelock. BUG 12's proposed fixes (`AbortController`, progress
  watchdog, `unclean_exit_count`) would all leave BUG 15 unaddressed: cooperative
  cancellation doesn't change anything about a flow where cancellation already
  works, and the progress watchdog measures "moved <0.5 blocks" which is satisfied
  by the unstuck-driven movement itself.
- **BUG 13** (`unpatched/BUG13_iron_collection_wedges_after_pickaxe_break_via_unstuck_deadlock.md`)
  — same root cause as BUG 12, post-pickaxe-break iron workflow. Not applicable
  here: trace shows fresh `stone_pickaxe` crafted at stage 46 and present in the
  state at stage 50 (`"inventory":{"stone_pickaxe":1,...}`). No pickaxe-break event
  occurs before the livelock starts.
- **BUG 4** (`patched/BUG4_outer_retry_loop_deterministic_failure.md`) —
  conceptually adjacent. BUG 4 was about the outer retry loop counting deterministic
  failures and re-issuing them; BUG 15 is the inner counterpart at the mode-recovery
  layer. The same general lesson applies: retries are cheap; *deterministic* retries
  on a known-bad command are not.
- **Interaction with BUG 11** (`patched/BUG11_failure_replanner_inventory_includes_pre_task_items.md`):
  if/when `failure_replanner` runs on this task, the baseline_inventory snapshot
  (`actions.js:49`) correctly shows 0 `raw_iron` collected during the task, so the
  replanner's diagnosis input is clean. The bug here is upstream of the replanner;
  BUG 11's fix is unaffected.
