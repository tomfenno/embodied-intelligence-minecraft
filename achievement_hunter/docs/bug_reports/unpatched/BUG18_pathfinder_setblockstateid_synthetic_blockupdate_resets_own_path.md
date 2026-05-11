# BUG 18 — Pathfinder's Own `setBlockStateId` Pre-Place Hack Synthesizes a `blockUpdate` That Resets the Pathfinder's Path Mid-Placement

**Severity:** High (every successful block placement during pathfinding triggers a
synthetic path-reset before the place has even started; doubles the path-reset rate on
any route that requires placing scaffolding; a candidate root cause of BUG 17's
`!goToSurface` tower-up livelock and the user-reported "bot blocks itself / fails to put
blocks under it" symptoms)
**Status:** Reverted — two patch revisions attempted, both caused worse regressions
than the original behaviour. Reverted to clean upstream-Mindcraft pathfinder patch
on `search-agent`. The static-analysis mechanism is verified (in-bot probe captured
the predicted synthetic→real emit pair during placement) but neither fix attempt
produced acceptable runtime behaviour. **Do not re-apply without empirical
pre/post measurement** — see "Attempted fixes and why they failed" below.
**Patch location:** none — currently unpatched.
**Branch:** `search-agent`
**Trace:** none specific; the mechanism fires on every placement during pathfinding.
BUG 17's trace
(`achievement_hunter/rollouts/2026-05-11T18-22-47-437Z_test/`) exercises it heavily
because the 1×1 tower-up climb is essentially "place, place, place" for 25 rungs.
**Related files:**
- `node_modules/mineflayer-pathfinder/index.js:563–593` (place-handler with the
  `setBlockStateId(pos, 1)` pre-place call at line 571)
- `node_modules/mineflayer-pathfinder/index.js:413–418` (the `bot.on('blockUpdate', …)`
  listener that fires `resetPath('block_updated', false)` whenever a path-adjacent
  block changes)
- `node_modules/mineflayer-pathfinder/index.js:128–145` (`resetPath`; note that
  `placing = false` is set at line 136)
- `node_modules/prismarine-world/src/world.js:104–109` (`_emitBlockUpdate`) and
  `:257–264` (`setBlockStateId` → calls `_emitBlockUpdate`)
- `node_modules/mineflayer/lib/plugins/blocks.js:581–584` (world → bot event
  forwarding for `blockUpdate`)
- `patches/mineflayer-pathfinder+2.4.5.patch` (the upstream-inherited patch that
  introduced the `setBlockStateId(pos, 1)` line)

**Related bugs:**
- **BUG 17** — `!goToSurface` tower-up livelock. This bug is a likely contributor
  (per BUG 17 §Root Cause "Hypothesis C — single-block head clearance prevents the
  place"). If this hypothesis is right, BUG 17's livelock partially resolves once
  the synthetic-blockUpdate path-reset is filtered.
- **BUG 12** — same family ("no cooperative cancellation; pathfinding cycles never
  terminate"). BUG 12's principled fix (Fix D) doesn't address the synthetic event
  source either; this report does.

---

## Symptom

User-facing description (verbatim, from the conversation that surfaced this report):

> Pathfinding has gotten worse from the original repo that we forked off of recently.
> Evidence for this is that the agent will accidentally block themselves with blocks
> when trying to path find or fail to put blocks under them.

The two field symptoms map cleanly onto the mechanism documented below:

1. **"fails to put blocks under them"** — the synthetic `resetPath` fires while
   `bot.placeBlock` is still in flight, so the path is cleared before the rung
   completes. On the next physics tick the pathfinder recomputes from a position
   that *includes a local-only "stone" block at the placement target*, which
   confuses `getMoveUp` for the very rung that hasn't actually finished placing.
2. **"blocks themselves with blocks"** — because the local-world model now has a
   `stone` block at the placement target (state id 1, see §Mechanism), `getMoveForward`
   / `getMoveUp` may plan a *dig* of that fake block on the next recompute. The
   bot ends up trying to dig blocks it just "placed."

These are *recently-surfaced* symptoms, not recently-introduced ones: the inherited
pathfinder patch has had this hack since upstream
`mindcraft-bots/mindcraft@a9b1d13f` (Oct 2024). The reason the bugs surfaced now is
that the `search-agent` work (commit `9db30dd Implimented search agent`) introduced
new placement-heavy navigation paths — most notably `!goToSurface` from underground —
that exercise the mechanism continuously over 25+ tower-up rungs per call.

---

## Mechanism

### The pre-place hack

The inherited pathfinder patch (`patches/mineflayer-pathfinder+2.4.5.patch`) adds one
line inside the place handler in `monitorMovement`. As applied,
`node_modules/mineflayer-pathfinder/index.js:563–593`:

```js
if (canPlace) {
    if (!lockEquipItem.tryAcquire()) return
    bot.equip(block, 'hand')
      .then(function () {
        lockEquipItem.release()
        const refBlock = bot.blockAt(new Vec3(placingBlock.x, placingBlock.y, placingBlock.z), false)
        if (!lockPlaceBlock.tryAcquire()) return
        bot.world.setBlockStateId(refBlock.position.offset(placingBlock.dx, placingBlock.dy, placingBlock.dz), 1)   // ← the patch line
        if (interactableBlocks.includes(refBlock.name)) {
          bot.setControlState('sneak', true)
        }
        bot.placeBlock(refBlock, new Vec3(placingBlock.dx, placingBlock.dy, placingBlock.dz))
          .then(function () {
            bot.setControlState('sneak', false)
            bot.setControlState('jump', false)
            if (bot.pathfinder.LOSWhenPlacingBlocks && placingBlock.returnPos) returningPos = placingBlock.returnPos.clone()
          })
          .catch(_ignoreError => { resetPath('place_error') })
          .then(() => {
            lockPlaceBlock.release()
            placing = false
            lastNodeTime = performance.now()
          })
      })
      .catch(_ignoreError => {})
}
```

The `setBlockStateId(…, 1)` call was added by upstream commit
`mindcraft-bots/mindcraft@a9b1d13f` (Oct 26 2024) with the message *"mostly fixed
infinite jump bug"*. The intent is to put a placeholder `stone` block (state id 1)
into the *bot's local world model* at the placement target *before* sending the real
`place_block` packet. On the next physics tick the bot's collision response treats
that local fake-stone as solid and pushes the bot up out of it — which (a) ends the
"jump and hope to clear `canPlace`" loop and (b) gives the place packet a moment to
finish round-tripping while the bot is already at the post-jump height.

### Why this is a self-trigger

`bot.world.setBlockStateId` is **not** silent. From
`node_modules/prismarine-world/src/world.js:257–264`:

```js
async setBlockStateId (pos, stateId) {
    const chunk = (await this.getColumnAt(pos))
    const pInChunk = posInChunk(pos)
    const oldBlock = chunk.getBlock(pInChunk)
    chunk.setBlockStateId(pInChunk, stateId)
    this.saveAt(pos)
    this._emitBlockUpdate(oldBlock, chunk.getBlock(pInChunk), pos)
}
```

`_emitBlockUpdate` (`prismarine-world/src/world.js:104–109`):

```js
_emitBlockUpdate (oldBlock, newBlock, position) {
    this.emit('blockUpdate', oldBlock, newBlock)
    this.emit(`blockUpdate:${position}`, oldBlock, newBlock)
}
```

`mineflayer/lib/plugins/blocks.js:581–584` forwards every `world` `blockUpdate` onto
the bot:

```js
const forwardedEvents = ['blockUpdate', 'chunkColumnLoad', 'chunkColumnUnload']
for (const event of forwardedEvents) {
    bot.world.on(event, (...args) => bot.emit(event, ...args))
}
```

And `mineflayer-pathfinder/index.js:413–418` subscribes its **own** path-invalidation
listener on exactly that event:

```js
bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!oldBlock || !newBlock) return
    if (isPositionNearPath(oldBlock.position, path) && oldBlock.type !== newBlock.type) {
        resetPath('block_updated', false)
    }
})
```

The placement target is **by construction** on the current path (it's the block the
current `Move` is about to place). `oldBlock.type` is air (or whatever was there),
`newBlock.type` is stone (state id 1 → `block.type=stone`). The two differ, so the
predicate is true and `resetPath('block_updated', false)` fires — caused entirely by
the pathfinder's own pre-place writeback.

### What `resetPath` does mid-place

`mineflayer-pathfinder/index.js:128–145`:

```js
function resetPath (reason, clearStates = true) {
    if (!stopPathing && path.length > 0) bot.emit('path_reset', reason)
    path = []
    if (digging) {
        bot.on('diggingAborted', detectDiggingStopped)
        bot.on('diggingCompleted', detectDiggingStopped)
        bot.stopDigging()
    }
    placing = false                        // ← !!
    pathUpdated = false
    astarContext = null
    lockEquipItem.release()
    lockPlaceBlock.release()                // ← !!
    stateMovements.clearCollisionIndex()
    if (clearStates) bot.clearControlStates()
    if (stopPathing) return stop()
}
```

The path is wiped, `placing` is set to false, and **both placement locks are
released** — all while `bot.placeBlock(refBlock, …)` is still pending in the
background. The 4th argument `clearStates = false` (from line 416) means control
states are *not* cleared, but the path/placing/lock state changes still happen.

So at the moment the synthetic `blockUpdate` fires:

| Component | State |
|---|---|
| `path` | `[]` |
| `placing` | `false` |
| `lockPlaceBlock` | released |
| `bot.placeBlock(refBlock, …)` | **still pending** — promise has not resolved |
| `bot.world` at placement target | local-only state-id-1 stone |
| `bot.world` at placement target (real) | air (server has not yet acknowledged) |

### What happens next

On the next physics tick, `monitorMovement` finds `path.length === 0` and
`pathUpdated === false`, so it recomputes:

```js
if (!pathUpdated) {
    const results = bot.pathfinder.getPathTo(stateMovements, stateGoal)
    bot.emit('path_update', results)
    path = results.path
    ...
}
```

A* runs against the bot's current cell and the local world. The local world says
there's a `stone` block at the position that, in reality, is air mid-place. Two
follow-on effects:

1. **`getMoveUp` for the original tower-up move recomputes with different `toBreak` /
   `toPlace`.** The original rung's `toBreak=[ceiling]`, `toPlace=[under feet]` may
   now look like a different move type (depending on geometry) — perhaps with a
   `toBreak` pointing at the fake-stone we just "placed."
2. **`getMoveForward` / horizontal moves around the column** now see a "stone" wall
   where the bot is mid-jumping. Pathfinder re-routes, possibly back through the
   fake-stone column, which it now plans to dig.

When `bot.placeBlock` finally resolves and the server's `block_change` arrives, the
*real* block type (cobblestone) replaces the fake-stone. That's a *second*
`blockUpdate` (stone → cobble) and a *second* `resetPath('block_updated', false)`.

### Two resets per placement, twice the chance of livelock

In a normal walking path each `Move` produces one server-driven `blockUpdate` per
break/place. With this hack:

| Step | `blockUpdate` count |
|---|---|
| Walk forward (no place) | 0 |
| Walk forward (with floor scaffolding place) | **2** (synthetic stone, then server cobble) |
| Tower-up (dig + place) | **3** (server-confirmed dig + synthetic stone + server cobble) |

For BUG 17's 25-rung `!goToSurface` climb, that's ~75 self-induced path resets in
~40 seconds of healthy execution — many of which arrive mid-rung and abort the rung
in flight.

### Why "infinite jump" was a real problem and why this hack "works"

The hack does what its commit message claims. `canPlace = placingBlock.y + 1 < bot.entity.position.y`
(line 562) requires the bot's feet to be *above* the placement Y before the place
fires. Without the hack, the bot jumps, briefly clears the threshold, lands back at
the original Y, jumps again — and on hosts where `placeBlock` latency exceeds the
jump apex window, the bot can cycle forever waiting for the place. The local-state
writeback lets the bot's collision response *plant* it at the higher Y immediately,
so when the place finally completes the bot is already on the new floor.

That fix is real and load-bearing. The problem is that it shares an event bus with
the pathfinder's path-invalidation listener and has no way to say "this update is
mine, not the server's."

---

## Why existing safeguards didn't catch this

| Safeguard | Why it didn't fire |
|---|---|
| `gotoUtil` rejects on `path_update` `noPath`/`timeout` | Each recompute returns a valid (different) path, not a terminal status. |
| `gotoUtil` rejects on `goal_updated` / `path_stop` | Goal isn't changed and nothing calls `pathfinder.stop()`. |
| Pathfinder's own `resetPath('place_error')` (in the place `.catch`) | Only fires when `bot.placeBlock` *rejects*. Most places succeed; the synthetic blockUpdate fires *before* the place even runs. |
| `unstuck` mode | See BUG 17 §3 — reference-equality on `bot.targetDigBlock` resets `stuck_time` every dig cycle. |
| `ActionManager.stop()` 10 s `cleanKill` | Requires a competing action to call `stop()`. None does during a single `!goToSurface`. |

The synthetic `blockUpdate` is indistinguishable from a server-driven one at the
listener level — both emit `(oldBlock, newBlock)` with the same shape. There is no
"source" field on the event.

---

## Attempted fixes and why they failed

Two patch revisions were applied and reverted on `search-agent` (uncommitted; visible
only in git reflog now). Both confirmed the mechanism via the in-bot probe but both
caused regressions worse than the original behaviour.

### Attempt 1 — bare `return` guard

Inserted a 4-condition guard around the existing listener: while `placing === true`,
`placingBlock` is set, the event position equals the synthetic write target, and
`newBlock.type === 1` (stone). On match: `return` without calling `resetPath`.

In-bot validation log (single `!collectBlocks("stone", 13)` run): 3 synthetic
suppressions, 11 real `resetPath` calls, zero false positives. Mechanism confirmed.

**Regression:** the user reported "trouble jumping when needed" and degraded
pathfinding in general. Hypothesised cause: the synthetic `resetPath`'s
`placing = false` side effect (`index.js:131` in clean upstream — line numbers
shift in patched form) had been load-bearing for stopping the place handler from
re-setting `bot.setControlState('jump', true)` every physics tick at `index.js:562`.
With the bare `return`, `placing` stayed `true` until `bot.placeBlock` resolved
~50–150 ms later; during that window the place handler re-fired `jump=true` each
tick, and the bot oscillated jump/land if it touched ground on its way through.

### Attempt 2 — `return` plus side-effect restoration

Same guard, plus `placing = false; lockPlaceBlock.release(); lockEquipItem.release()`
inside the guard before the `return`. The intent was to preserve the path (which is
the actual goal of BUG 18) while restoring the placement-state signal the synthetic
`resetPath` had implicitly provided.

**Regression: much worse than attempt 1.** The bot entered an infinite jumping loop
during a `!searchForBlock` after one successful placement. `mode:unstuck` fired,
couldn't yield (BUG 12 pattern), and `ActionManager.stop()`'s 10 s `cleanKill`
terminated the process. Crash log:

```
[BUG18] suppressed synthetic blockUpdate at (-233, 55, 52) (old=air new=stone)
[BUG18] real blockUpdate near path at (-233, 55, 52) (old=stone new=dirt) → resetPath
executing code...
action "mode:unstuck" trying to interrupt current action "action:searchForBlock"
waiting for code to finish executing...  (×33 → cleanKill → process exit 1)
```

The actual mechanism for the worse regression is **not yet diagnosed**. Hypothesis:
releasing `lockPlaceBlock` before `bot.placeBlock` resolves opens a window where a
second `Move` with its own `toPlace` can begin a concurrent placement chain — and
when that interacts with the now-jump-control-state-still-true bot, the bot is
unable to make ground-contact long enough for any handler to advance the path.
*Confidence in this hypothesis is low.* The thing we know for sure is that the
runtime symptom got worse, not the mechanism.

### What this tells us about the BUG 18 hypothesis

The static-analysis mechanism (synthetic emit → forwarded event → self-listener →
`resetPath`) is real and verified. But the synthetic `resetPath` is doing *more*
than just clearing the path — its side effects are tangled into the place handler's
tick loop in ways that aren't obvious from reading the code. Removing the
`resetPath` call (either bare or with selective side effects restored) is more
invasive than it looks.

**What a future fix would need to do differently:**

1. *Measure before patching.* Both attempts went straight from static analysis to
   patch to bot. Neither was preceded by an instrumented A/B run that quantified
   what the synthetic `resetPath` was actually contributing. A run with the probe
   alone (no `return`) for 10 minutes, capturing how many synthetic emits fire,
   how many path recomputes follow, and what the bot's position trajectory looks
   like during placements, would have caught at least one of the load-bearing
   side effects before patch attempt 1.
2. *Patch at the source, not the listener.* Both attempts modified the
   `blockUpdate` listener. The synthetic event is being *emitted* by
   `bot.world.setBlockStateId(target, 1)` at `index.js:571`. An alternative is to
   suppress the emit itself — e.g., bypass `world.setBlockStateId` and modify the
   chunk directly (without `_emitBlockUpdate`). That isolates the change to one
   call site and avoids touching the listener at all.
3. *Or patch differently entirely.* The "infinite jump" upstream fix could be
   re-implemented without the local-world-corruption side channel — e.g., a direct
   `bot.entity.position.y += 1` nudge, or a `bot.entity.onGround = true` hack
   bracketed by the place chain. These bypass the world model entirely.

## Proposed Fix (deferred — see "Attempted fixes" above)

Goal: keep the "infinite jump" fix (it's load-bearing for hosts with slow
`placeBlock` round-trips) while preventing it from re-entering the path-invalidation
listener.

### Fix A (recommended) — gate the path-reset listener on the currently-placing target

The cleanest patch is to **filter the path-invalidation listener** so it ignores
updates at the position currently being placed. The hack writes to
`refBlock.position.offset(placingBlock.dx, placingBlock.dy, placingBlock.dz)`; the
listener can compare against the same expression.

Patch target: `patches/mineflayer-pathfinder+2.4.5.patch` adds a hunk wrapping the
existing `bot.on('blockUpdate', …)` registration. The marker convention applies
(patch file edits to `node_modules/`).

Proposed hunk (delta against the current state of the listener):

```diff
   bot.on('blockUpdate', (oldBlock, newBlock) => {
     if (!oldBlock || !newBlock) return
+    // Start of AH code — BUG 18
+    // Ignore the synthetic blockUpdate the pathfinder itself emits via
+    // bot.world.setBlockStateId(pos, 1) immediately before bot.placeBlock.
+    // Without this guard, every placement during pathfinding self-triggers
+    // resetPath('block_updated', false), wiping `placing` and the path while
+    // bot.placeBlock is still pending — see BUG 17 livelock and the
+    // "blocks itself / fails to put blocks under" symptoms.
+    if (placing && placingBlock) {
+      const target = new Vec3(
+        placingBlock.x + placingBlock.dx,
+        placingBlock.y + placingBlock.dy,
+        placingBlock.z + placingBlock.dz,
+      )
+      if (oldBlock.position.equals(target) && newBlock.type === 1) {
+        return  // our own writeback; the real server block_change will follow
+      }
+    }
+    // End of AH code — BUG 18
     if (isPositionNearPath(oldBlock.position, path) && oldBlock.type !== newBlock.type) {
       resetPath('block_updated', false)
     }
   })
```

Three guards combined to avoid false negatives:

1. `placing && placingBlock` — only filter while a place is actively in flight.
2. `oldBlock.position.equals(target)` — only filter the exact position the hack
   writes to.
3. `newBlock.type === 1` — only filter when the new state is the specific
   placeholder (`state id 1` → `stone`) the hack writes; any other state change at
   that position (real server update arriving) still resets the path.

The third guard is the most important: when the real `block_change` arrives from
the server, `newBlock.type` will be `cobblestone` (or whatever was placed), not `1`,
so the listener still fires and the path is reset based on the real block change.
That preserves the original purpose of the listener — invalidate the path when the
world actually changes — while ignoring the self-induced spurious event.

**Soundness:** the filter is conservative; it only suppresses the exact event the
patch's own writeback creates. Other path-on-update behaviour is unaffected,
including when a player or piston changes a block on the path during pathfinding.

**Limitations:** if `placingBlock` is mutated to a new target before the synthetic
update fires (possible in chained `toPlace` sequences from `getMoveJumpUp`-style
moves with 2+ placements), the `target` check above will not match and the filter
will allow the reset through. The 3-guard combination protects against false
positives in that case; the cost is that the reset still fires, i.e. the bug is
"only mostly fixed" for multi-place moves. In practice the dominant placement move
on AH workloads is `getMoveUp` with one `toPlace`, so this edge case is rare.

### Fix B (more invasive, optional) — emit a typed marker on the synthetic update

Instead of (or in addition to) Fix A, change the writeback site to flag the synthetic
nature of the emit:

```diff
-            bot.world.setBlockStateId(refBlock.position.offset(placingBlock.dx, placingBlock.dy, placingBlock.dz), 1)
+            // Start of AH code — BUG 18
+            bot._pathfinder_synthetic_emit = true
+            try {
+              bot.world.setBlockStateId(refBlock.position.offset(placingBlock.dx, placingBlock.dy, placingBlock.dz), 1)
+            } finally {
+              bot._pathfinder_synthetic_emit = false
+            }
+            // End of AH code — BUG 18
```

The listener side would then short-circuit on `if (bot._pathfinder_synthetic_emit) return`.
This is more robust against the multi-place limitation in Fix A but is also more
invasive and harder to reason about because `setBlockStateId` is `async` and the
`finally` runs before the emit actually fires. **Don't use this version unless Fix A
proves insufficient in practice.**

### Fix C (don't do this) — remove the `setBlockStateId(pos, 1)` line

Removing the hack would close this bug but reintroduce the "infinite jump" bug it
was added to fix in Oct 2024. Don't do this without re-validating the original jump
fix on the current mineflayer/host combination.

---

## Evidence

In-bot validation log (post-patch, `search-agent` branch, during
`!collectBlocks("stone", 13)`):

```
[BUG18] suppressed synthetic blockUpdate at (-146, 58, 125) (old=water new=stone)
[BUG18] real blockUpdate near path at (-146, 58, 125) (old=stone new=dirt) → resetPath
[BUG18] suppressed synthetic blockUpdate at (-146, 57, 126) (old=air new=stone)
[BUG18] real blockUpdate near path at (-146, 57, 126) (old=stone new=air) → resetPath
[BUG18] suppressed synthetic blockUpdate at (-146, 58, 126) (old=air new=stone)
[BUG18] real blockUpdate near path at (-146, 57, 126) (old=air new=dirt) → resetPath
```

Every `suppressed synthetic` line shows `new=stone` (the state-id-1 writeback). Every
paired `real blockUpdate` line at the same position shows `new=<dirt|air|water>` —
never `stone` — confirming the `newBlock.type === 1` discriminator partitions the
event stream cleanly. Across the captured workflow the guard caught 3 synthetic
emits, 0 false positives, and the listener fell through to `resetPath` on all 11
real changes as designed.

Note: the `(-146, 57, 126) old=stone → new=air` line in the second pair is the
server *rejecting* the place — `placeBlock` failed and the local fake-stone was
reverted to air. Without BUG 18 this would have produced *three* path-resets at
that position (synthetic, revert, retry); with BUG 18 only the revert reset fires.
This is a useful side-effect: server-rejected placements now cost one reset
instead of two.

Mechanism evidence (static, fully verifiable from the source files):

1. The synthetic emit exists:
   `node_modules/mineflayer-pathfinder/index.js:571`:
   `bot.world.setBlockStateId(refBlock.position.offset(placingBlock.dx, placingBlock.dy, placingBlock.dz), 1)`
   (added by `mindcraft-bots/mindcraft@a9b1d13f`, inherited verbatim into
   `patches/mineflayer-pathfinder+2.4.5.patch`).
2. `setBlockStateId` calls `_emitBlockUpdate`:
   `node_modules/prismarine-world/src/world.js:263`.
3. `_emitBlockUpdate` emits the `blockUpdate` event on the world:
   `node_modules/prismarine-world/src/world.js:107`.
4. The bot forwards every world `blockUpdate` to itself:
   `node_modules/mineflayer/lib/plugins/blocks.js:581–584`.
5. The pathfinder subscribes to `bot.on('blockUpdate', …)` and resets on path-near
   updates:
   `node_modules/mineflayer-pathfinder/index.js:413–418`.
6. `resetPath` sets `placing = false` and releases `lockPlaceBlock`:
   `node_modules/mineflayer-pathfinder/index.js:136, 140`.

What is **not** yet in evidence:
- A reproduction that confirms the synthetic-blockUpdate path-reset is sufficient
  to fix BUG 17's `!goToSurface` hang (the post-patch in-bot run did not exercise
  an underground tower-up scenario). BUG 17 remains open pending that repro.
- A complete fix for the user-reported "bot blocks itself with blocks" symptom.
  The in-bot log post-patch shows BUG 18 catches ~25 % of the path-reset rate
  during `!collectBlocks`; the remaining 75 % comes from the bot's own dig/place
  events on its path. **Spun off as BUG 19** — see "Relation to Other Bugs".

---

## Relation to Other Bugs

- **BUG 17** (`!goToSurface` tower-up livelock) — this report names the specific
  mechanism that BUG 17 §2 Hypothesis C describes as "plausible but unverified."
  Applying Fix A here is the cheapest way to test whether BUG 17's livelock is
  primarily this mechanism vs. primarily BUG 17 §1 (the `range=0` goal). If
  applying Fix A doesn't fully resolve BUG 17, BUG 17's Fix A+B (relax `range`,
  add wallclock watchdog) should still be applied as defence-in-depth.
- **BUG 12** (cooperative cancellation refactor) — orthogonal. BUG 12 addresses
  the *outer* cancellation contract; this bug is a *self-trigger* inside the
  pathfinder. Either fix can land without the other.
- **BUG 14** (snow pathfinding `canHarvest` watchdog) — adjacent in `goToPosition`
  but unrelated mechanism. BUG 14's fix doesn't address the synthetic event source.
- **Upstream Mindcraft (`mindcraft-bots/mindcraft`)** — both the synthetic emit
  *and* the path-invalidation listener are inherited verbatim from upstream. This
  bug exists in stock Mindcraft as well; the fix proposed here is independent of
  AH and would be reasonable to upstream once verified locally.
- **BUG 19** — the broader path-reset cascade from the bot's own dig/place events
  on its own path. BUG 18 closes the synthetic emit (~25 % of resets in the
  observed workload); BUG 19 covers the remaining ~75 % (real server-confirmed
  changes the bot itself caused). BUG 18 is a strict subset; landing BUG 19 will
  not invalidate the BUG 18 patch but will subsume its effect.
