# BUG 13 — Iron Collection Wedges and Exits After Pickaxe Break (BUG 12 Pattern Triggered by BUG 10 Workflow)

**Severity:** Critical (process exit, infinite restart loop after checkpoint resume,
rollout never advances past iron stage)
**Status:** Reported — fix is "apply BUG 12's fixes"; not duplicated here
**Branch:** `hard-code-nts-am`
**Related bugs:**
- **BUG 10** — fixed the OOM that used to crash this exact workflow. The OOM is gone in
  this trace, confirming the `mineflayer-tool+1.2.0.patch` works.
- **BUG 12** — the *underlying* root cause this report demonstrates. Same `unstuck`
  interrupt deadlock + listener leak + `cleanKill` + deterministic checkpoint resume.
- **Prior fix:** `patches/mineflayer-tool+1.2.0.patch` and
  `src/agent/library/skills.js:531–549` (BUG 10).

---

## Symptom

Bot is collecting `iron_ore` with a `stone_pickaxe`. The first batch succeeds
(`Collected 16 iron_ore`). On the second batch:

```
[SPL] Action (attempt 1/5): !collectBlocks("iron_ore", 16)
parsed command: { commandName: '!collectBlocks', args: [ 'iron_ore', 16 ] }
executing code...

executing code...
action "mode:self_preservation" trying to interrupt current action "action:collectBlocks"
waiting for code to finish executing...
[SPL][cmd] Mode interrupted command (1/10), waiting for idle: !collectBlocks("iron_ore", 16)
Mode self_preservation finished executing, code_return: Action output:
Found non-destructive path.
Moved away from (-60, 46, -51) to (-61, 44, -50).

[SPL][cmd] Modes idle, retrying: !collectBlocks("iron_ore", 16)
parsed command: { commandName: '!collectBlocks', args: [ 'iron_ore', 16 ] }
executing code...

executing code...
action "mode:unstuck" trying to interrupt current action "action:collectBlocks"
waiting for code to finish executing...
waiting for code to finish executing...
... (~25 repetitions)
(node:33) MaxListenersExceededWarning: ... 11 error listeners added ...
... more repetitions ...
(node:33) MaxListenersExceededWarning: ... 11 collectBlock_finished listeners added ...
... more repetitions ...
Saved memory to: ./bots/AH_Bot/memory.json
Agent AH_Bot disconnected
Achievement agent process exited with code 1 and signal null
Restarting achievement agent...
```

After the restart, the SPL resumes from checkpoint, immediately re-issues
`!craftRecipe("stick", 1)` (success), then `!craftRecipe("stone_pickaxe", 1)` (i.e. the bot
*has* lost its pickaxe — confirming the break). The replacement stone pickaxe craft begins
but the bot is now spammed by `PartialReadError` packet errors (BUG 1) and the cycle is
poised to repeat the moment iron collection re-engages.

User-facing description: *"the stone pickaxe breaks while collecting iron and then it
exits the game."*

---

## Why This is a New Report Even Though BUG 12 Exists

BUG 12 documents this exact failure shape (mode interrupt → listener leak → `cleanKill` →
deterministic resume) using a different physical scenario (`!collectBlocks("iron_ore", 1)`
in a different cave, with `unstuck` firing first rather than after `self_preservation`).
Its proposed fixes are correct and unchanged.

This report exists because:

1. **BUG 10 was filed against the same user-visible symptom** ("pickaxe breaks during iron
   collection → process exits"). The patch it shipped (`mineflayer-tool+1.2.0.patch`) was
   correct for the OOM root cause, but it cannot prevent this *different* root cause from
   producing the same user-visible symptom on the same workflow. Without a separate report
   linking them, the user reasonably believes BUG 10 "isn't fully fixed" when in fact the
   OOM is gone and a second, distinct bug is hitting the same scene.
2. **The interaction is what matters.** When the pickaxe breaks mid-collection, BUG 10's
   patch routes the failure cleanly back through `skills.js:collectBlock`'s catch — but
   the bot is left at the same physical position, often in a tight underground geometry
   (this trace: y=46, recently-mined cave wall). The next action issued by the SPL on that
   position triggers `self_preservation` and then `unstuck`, which is BUG 12's exact
   precondition. **BUG 10's fix routes around the OOM and lands the bot in BUG 12's trap.**
3. **Trace evidence is concrete.** This rollout independently confirms BUG 12's symptom
   pattern (11/11 listener warnings, deterministic resume, identical task on restart) and
   provides a reproducible workflow for testing BUG 12's fixes.

---

## Root Cause

Identical to BUG 12, restated briefly with the new evidence:

1. **`ActionManager.stop()` polls `requestInterrupt` every 300 ms** while waiting for the
   running action to yield (`src/agent/action_manager.js:26–37`).

2. **`requestInterrupt` calls `bot.collectBlock.cancelTask()` without awaiting it**
   (`src/agent/agent.js:233–239`). Each unawaited `cancelTask()` invocation in
   `mineflayer-collectblock@1.6.0`'s `cancelTask`
   (`node_modules/mineflayer-collectblock/lib/CollectBlock.js:268–280`) does:
   ```js
   this.bot.pathfinder.stop();
   yield events.once(this.bot, 'collectBlock_finished');
   ```
   `events.once` subscribes one `collectBlock_finished` listener and one `error` listener,
   removing only the one that fires first. Because the wedged action never finishes, neither
   listener fires — both leak. After ~6 polls (each adding 2 listeners), Node's default
   `MaxListeners=10` is breached on both events. The trace shows exactly `11 / 11`,
   matching the predicted leak rate.

3. **After 10 s the watchdog calls `cleanKill('Code execution refused stop after 10 seconds.')`**,
   which calls `process.exit(1)`. The Docker supervisor restarts the container.

4. **Checkpoint resume is deterministic** (`achievement_hunter/src/pipeline/checkpoint.js`,
   `loop.js:46`). `checkpoint.json` records only `{objective, graph, saved_at}` — not which
   task was attempted last, not how many `cleanKill`s have occurred, not whether the previous
   exit was clean. The next process selects the same task from the same physical position
   and re-enters the same trap.

The new wrinkle this trace adds: in this rollout, `self_preservation` fires *first* and
*succeeds* (moves bot ~2 blocks). The retry then triggers `unstuck`, which wedges. So the
deadlock is NOT specific to `unstuck` triggering first — *any* mode interrupt that lands the
bot in a position where the next attempt's mode also fires can produce this. The previous
`Mode interrupted command (X/10)` counter even ran cleanly through one cycle before the
wedge.

---

## Why BUG 10's Patch Doesn't Cover This

BUG 10's fix is upstream of `bot.collectBlock.collect()` returning — it converts a
silent infinite recursion into a thrown `NoChest`, which `skills.js:collectBlock` catches
and converts into a clean `{success: false}`. That's the right fix for that bug.

It doesn't cover this trace because:

- The pickaxe break here happens cleanly: `bot.collectBlock.collect()` returns a failure
  result, the SPL marks the action failed, and the next iteration would have caught it via
  the outer `equipForBlock({requireHarvest:true})` check returning `false`.
- **But the SPL never gets to that next iteration.** Between the failed `collect()` and the
  next `equipForBlock`, modes fire (the bot is still in the same dangerous geometry). The
  mode interrupt path is the BUG 12 trap. The clean-failure path BUG 10 enables is
  irrelevant once the action is wedged — the wedge is in `ActionManager.stop()`, one layer
  up.

In other words: BUG 10 made *one* failure recoverable; BUG 12 makes *every* recovery
attempt potentially fatal at the process level. They're orthogonal.

---

## Fix

Apply BUG 12's three fixes verbatim. Summarized for cross-reference (full rationale lives
in `BUG12_*.md`):

1. **Persist a `unclean_exit_count` in the checkpoint and abort resume above a threshold.**
   Hooks into `agent.cleanKill`. After 3 consecutive `cleanKill(_, 1)` exits on the same
   checkpoint, clear the checkpoint and emit a meaningful `log.complete('aborted: repeated
   unclean exits during resume')`. *This is the safety net that converts "infinite Docker
   restart loop" into "rollout terminates with a diagnosable failure trace."*

2. **Make `requestInterrupt` own `cancelTask`'s lifecycle.** Either fire `cancelTask()`
   only on the first poll tick of a `stop()` cycle (Option A in BUG 12), or guard it with
   an in-flight promise (Option B). Eliminates the `MaxListenersExceededWarning` and stops
   the listener leak from compounding the wedge.

3. **Add a progress watchdog inside `skills.collectBlock` (and ideally `runAsAction`)** —
   if the bot has not moved >0.5 blocks AND has not broken a block in the last 8 s, throw
   `Error('progress_timeout')`. This converts the wedge from a process-level kill into a
   task-level failure that flows through `executeCommandWithModeRecovery` →
   `execute_task_action`'s retry counter → `failure_replanner`. The replanner's diagnosis
   (with the BUG 11 inventory delta now showing "0 iron_ore added this task" plus a
   `progress_timeout` failure kind) would correctly identify the bot as physically stuck
   and recommend relocation rather than another collect attempt.

Order of priority: **(1) immediately** — without it, this trace's restart loop continues
indefinitely and burns LLM/server cost while making zero progress. **(3) next** — it's the
principled fix for this whole class of "action runs but makes no progress" wedge. **(2)
last** — hygiene; reduces noise and makes future debugging cleaner but doesn't change the
crash behavior.

---

## Evidence

From the supplied log, single rollout, two consecutive process lifecycles:

| Process | Action attempted | Mode timeline | Listener warnings | Outcome |
|---|---|---|---|---|
| node:33 (initial) | `!collectBlocks("iron_ore", 16)` (2nd batch) | `self_preservation` → success → retry → `unstuck` → wedge | 11 error / 11 `collectBlock_finished` | exit 1 |
| node:45 (resume) | `!craftRecipe("stick", 1)` → success → `!craftRecipe("stone_pickaxe", 1)` | `PartialReadError` storm during craft (BUG 1) | none yet | (log truncates; trajectory: craft pickaxe → re-collect iron → re-enter trap) |

Three observations confirm the BUG 12 diagnosis applies here:

1. **`self_preservation` ran cleanly first.** `Mode interrupted command (1/10)` printed,
   the mode completed, the SPL retried. So the wedge is *not* about the first interrupt
   being malformed — it's about what happens when the *next* mode fires on the still-stuck
   bot. The retry counter exists and is being respected; the deadlock is below it.

2. **Listener warnings cap at 11/11**, identical to BUG 12's three-process series. Two
   listeners per `stop()` poll tick × ~6 ticks = 12 listeners ≈ Node's MaxListeners
   threshold. Reproducible under the same pollrate/timeout assumptions.

3. **Resume after restart re-attempts the same workflow.** Bot lost its pickaxe (confirmed
   by SPL emitting `!craftRecipe("stone_pickaxe", 1)` after restart — the SCSG would not
   have queued that if the pickaxe still existed in inventory). After re-crafting, the
   bot will return to mining iron at the same general position. Without BUG 12 fix #1,
   the loop is permanent.

---

## What This Means for the User

If you run with the current branch state:
- **OOMs no longer happen on pickaxe break.** BUG 10 patch is doing its job.
- **Process exits no longer happen during the `collect()` call itself.** That bug is gone.
- **Process exits *do* still happen** when modes fire on the geometry the bot ends up in
  after the failed collect. The supervisor restarts, the checkpoint resumes, the cycle
  repeats — until something external intervenes.

The actionable next step is BUG 12's three fixes, in the priority order above. Of these,
only fix (1) needs to ship before this rollout pattern can complete unattended; fixes (2)
and (3) are quality improvements.
