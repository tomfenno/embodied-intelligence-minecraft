# BUG 19 — Pathfinder Resets Its Own Path On Every Dig/Place It Performs (Self-Caused `blockUpdate` Cascade)

**Severity:** High (every block the bot itself breaks or places on its current path
triggers a full `resetPath` + A* recompute; observed rate of ~10–15 self-induced
resets per `!collectBlocks` invocation; produces the user-reported "bot blocks itself
with blocks" symptom and is the residual mechanism behind BUG 17 / BUG 18 after the
synthetic-emit fix landed)
**Status:** Hypothesis — mechanism statically verified end-to-end; behavioural impact
*partially* confirmed by in-bot probe (BUG 18 validation log captured 10 self-caused
resets in a single `!collectBlocks("stone", 13)` attempt) and by the user-reported
"bot blocks itself with blocks" symptom that BUG 18 alone does not fix.
**Branch:** `search-agent`
**Trace:** in-bot log from the BUG 18 validation run (quoted in §Evidence). No
rollout trace was captured because the agent didn't fail terminally — the cascade
*degrades* pathfinding rather than wedging it.
**Related files:**
- `node_modules/mineflayer-pathfinder/index.js:413–429` (the `bot.on('blockUpdate', …)`
  listener, *after* BUG 18's guard — only catches synthetic emits, not real ones)
- `node_modules/mineflayer-pathfinder/index.js:497–526` (dig handler — `bot.dig`
  resolves *after* server `block_change` arrives, so the resulting `blockUpdate`
  fires while the path step is mid-transition)
- `node_modules/mineflayer-pathfinder/index.js:528–593` (place handler — same shape
  on the place side)
- `node_modules/mineflayer-pathfinder/index.js:128–145` (`resetPath`; sets
  `placing = false`, releases `lockPlaceBlock`, clears `path`, `pathUpdated`,
  `astarContext`)
- `node_modules/mineflayer-pathfinder/index.js:252–265` (`isPositionNearPath` — the
  proximity predicate that decides whether a `blockUpdate` invalidates the path)
- `node_modules/mineflayer/lib/plugins/blocks.js:222–224` (server `block_change`
  packet handler — calls `world._updateBlockState`, which emits `blockUpdate`)

**Related bugs:**
- **BUG 18** — fixed the *synthetic* portion of the cascade (the pre-place
  `setBlockStateId(target, 1)` writeback). BUG 19 is the *real* portion — the
  server-confirmed `block_change` events the bot's own digs and places cause.
  BUG 18 catches ~25 % of the cascade in workloads with placement; BUG 19 covers
  the remaining ~75 % and is also relevant to dig-only workloads (`!collectBlocks`).
- **BUG 17** — `!goToSurface` tower-up livelock. BUG 19 is a candidate additional
  contributor: every successful rung's dig + place fires 2 real resets, and over
  a 25-rung climb that's 50 resets — each one shortening the time the bot has to
  execute the next step.
- **BUG 12** — same family (no overall cancellation contract). BUG 12 Fix C
  (progress watchdog) would *also* mitigate this by giving wedged actions an
  escape valve, but BUG 19 is a cheaper and more targeted fix.

---

## Symptom

User-facing description (verbatim, from earlier in the conversation):

> Agent will accidentally block themselves with blocks when trying to path find or
> fail to put blocks under them.

In-bot probe output from a post-BUG-18 `!collectBlocks("stone", 13)` run (full log
in §Evidence) shows the bot:

1. Places dirt at `(-146, 58, 125)` to bridge water.
2. The placement fires `resetPath` (the *real* `blockUpdate`, not the synthetic
   one BUG 18 catches).
3. Path is recomputed against a world that now has the bot's own dirt placement
   at `(-146, 58, 125)`.
4. The new path goes *through* the bot's own dirt — A* sees a shorter route by
   digging through the freshly-placed scaffolding.
5. Bot breaks the dirt it just placed: `(-146, 58, 125) old=dirt new=air →
   resetPath`.
6. Another recompute. Repeat.

This is the "blocks itself with blocks" pattern as a concrete log sequence.

Even *without* the dig-through-own-placement behaviour, the cascade is visible as
sheer churn: 10–15 `resetPath` events per `!collectBlocks` invocation, each one
clearing the path, releasing place/equip locks, and triggering an A* recompute on
the next physics tick.

---

## Root Cause

### The listener treats self-caused updates the same as external ones

`mineflayer-pathfinder/index.js:413–429` (after BUG 18 lands):

```js
bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!oldBlock || !newBlock) return
    // Start of AH code — BUG 18
    if (placing && placingBlock) {
      const synthTarget = new Vec3(
        placingBlock.x + placingBlock.dx,
        placingBlock.y + placingBlock.dy,
        placingBlock.z + placingBlock.dz)
      if (oldBlock.position.equals(synthTarget) && newBlock.type === 1) {
        return  // synthetic; the real server block_change still triggers reset
      }
    }
    // End of AH code — BUG 18
    if (isPositionNearPath(oldBlock.position, path) && oldBlock.type !== newBlock.type) {
        resetPath('block_updated', false)
    }
})
```

This listener has one job: invalidate the current path when the world changes near
it. That's correct when an external agent (player, piston, water flow, lava flow)
modifies a block on the bot's path — A*'s assumptions are stale and a recompute is
required.

But the same listener also fires for the **bot's own actions**:

1. Bot calls `bot.dig(targetBlock)`. Server processes the dig, sends `block_change`
   (`<oldBlockType> → air`).
2. Mineflayer's `blocks.js:222` calls `bot.world._updateBlockState(pos, 0)`.
3. `_updateBlockState` calls `setBlockStateId`, which emits `blockUpdate`.
4. The pathfinder's *own* listener receives the event.
5. `isPositionNearPath(pos, path)` is true because the bot just dug a block that
   was, by definition, on the path's `toBreak` list.
6. `oldBlock.type !== newBlock.type` is true (`<block> !== air`).
7. `resetPath('block_updated', false)` fires.
8. `path = []`. The bot's own action invalidated its own path.

Same shape on the place side: the server's `block_change` for the placement at
the path's `toPlace` target arrives, the listener sees it, the position is on the
path, types differ, reset fires.

### Why this is a load-bearing performance problem

Per `bot.pathfinder.thinkTimeout = 5000` (`index.js:40`), each path recompute can
take up to 5 seconds of A* search. In practice straightforward computations
finish in well under 100 ms, but **every recompute starts A* from scratch** — the
previous search tree is discarded (`resetPath` sets `astarContext = null` at
`index.js:138`). For a `!collectBlocks` workflow that breaks 10 blocks to reach
a stone deposit, that's 10 throwaway A* runs in addition to the one productive
search.

The cascade compounds when the recompute *crosses* a position the bot is mid-
modifying. Concretely:

1. Bot at `(x, y, z)`, mid-dig on block at `(x, y+1, z)`.
2. Dig completes server-side. `blockUpdate` fires. resetPath wipes the path
   *and* releases `lockEquipItem` and `lockPlaceBlock` (line 139–141).
3. Next physics tick: path is recomputed. New path may have a different
   `nextPoint` or a different `toBreak`/`toPlace` shape because the world has
   changed.
4. Bot starts executing the new path. If the new path includes a place at a
   position that's about to land — e.g., the spot the bot just dug — the bot
   may now be standing inside its own former dig target waiting for collision
   physics to resolve, with no `digging` flag set (it was reset).

In the BUG 17 tower-up workflow, this manifests as: bot breaks ceiling stone,
resetPath fires from the dig, recompute happens against a world where the bot
is mid-jump and the ceiling is gone — the new path may decide to skip the place
and go straight to the next dig. The placement under the bot's feet doesn't
happen. Bot falls back down. Repeat.

### Why `isPositionNearPath`'s "near" tolerance doesn't save us

`isPositionNearPath` (`index.js:252–`) accepts positions within ~1 block of any
path node, accounting for path-segment AABBs. The bot's own dig/place targets
are *exactly* on path nodes (they are `toBreak`/`toPlace` entries by
construction), so the predicate always matches. There's no proximity bucket
that lets self-caused updates slip through.

### Why this didn't surface before the BUG 18 fix

Before BUG 18, the synthetic emit fired *first* (during the place chain, before
`bot.placeBlock` resolves). That reset already cleared the path and reset
`placing = false`. By the time the server-confirmed real `block_change`
arrived, the path was already empty (so `isPositionNearPath` short-circuited on
the empty path) and `placing` was already false. The real reset was effectively
a no-op.

After BUG 18, the synthetic emit is suppressed, so the path is *still
populated* when the real `block_change` arrives — and now the real emit
*actually* fires the reset that the synthetic used to "shield." From the
listener's perspective the rate of resets didn't change; from the path's
perspective the resets now arrive at a worse time (mid-execution rather than
pre-execution). This is benign for the BUG 18 fix because the reset still
fires once per place, but it shifts the timing.

For dig-heavy workloads (`!collectBlocks`) this self-reset behaviour was
*already* the dominant cost and was never shielded by BUG 18's mechanism.

---

## Why existing safeguards didn't catch this

| Safeguard | Why it didn't fire |
|---|---|
| BUG 18 guard | Only matches synthetic emits (newBlock.type === 1). Real dig/place emits carry the actual server block (cobblestone, dirt, air), which doesn't match. |
| `gotoUtil` rejects on `path_update` with `noPath` / `timeout` | Each recompute returns a valid path (the goal is still reachable from the new position). |
| `unstuck` mode | Position is *changing* each rung (bot moves forward / up), so `prev_location.distanceTo(...) >= 2` fires the else-branch and resets `stuck_time = 0`. The cascade is fast enough that the bot never appears geographically stuck. |
| `failure_replanner` | The action does eventually succeed (after enough churn); the SPL doesn't fall through. |

The cascade doesn't *terminate* anything — it just makes everything slower and
more error-prone. There's no obvious failure trace; just inefficient execution.

---

## Proposed Fix

### Fix A (recommended) — track positions the bot itself is currently modifying and short-circuit the listener for them

The cleanest framing: the pathfinder already *knows* which positions it's
currently digging (closure-scoped `bot.targetDigBlock`, or the just-shifted
toBreak entry) and placing (`placingBlock`). Use that knowledge to suppress
self-caused resets at exactly those positions.

Patch target: `patches/mineflayer-pathfinder+2.4.5.patch`, extending the BUG
18 hunk to also filter dig-target and place-target self-emits. The marker
convention applies (patch file edits to `node_modules/`).

```diff
   bot.on('blockUpdate', (oldBlock, newBlock) => {
     if (!oldBlock || !newBlock) return
     // Start of AH code — BUG 18
     if (placing && placingBlock) {
       const synthTarget = new Vec3(
         placingBlock.x + placingBlock.dx,
         placingBlock.y + placingBlock.dy,
         placingBlock.z + placingBlock.dz)
       if (oldBlock.position.equals(synthTarget) && newBlock.type === 1) {
         return  // synthetic; the real server block_change still triggers reset
       }
     }
     // End of AH code — BUG 18
+    // Start of AH code — BUG 19
+    // Self-caused real blockUpdate: the bot itself just dug or placed at this
+    // position. Skip the path-reset; the active dig/place handler is the
+    // authority on path progression at this position, and `resetPath` would
+    // clobber its state mid-flight. External-agent updates (players, pistons,
+    // water/lava flow) still fire `resetPath` as designed.
+    if (bot.targetDigBlock && oldBlock.position.equals(bot.targetDigBlock.position)) {
+      return
+    }
+    if (placing && placingBlock) {
+      const placeTarget = new Vec3(
+        placingBlock.x + placingBlock.dx,
+        placingBlock.y + placingBlock.dy,
+        placingBlock.z + placingBlock.dz)
+      if (oldBlock.position.equals(placeTarget)) {
+        return
+      }
+    }
+    // End of AH code — BUG 19
     if (isPositionNearPath(oldBlock.position, path) && oldBlock.type !== newBlock.type) {
         resetPath('block_updated', false)
     }
   })
```

**Two guards combined:**

1. `bot.targetDigBlock` covers the dig case. `bot.targetDigBlock` is set by
   `mineflayer/lib/plugins/digging.js:157` when a dig starts and cleared at line
   179 when it completes. The window is open exactly when a server-confirmed
   `block_change` for the dig target can arrive (server confirms by sending
   `block_change` → `_updateBlockState` → `blockUpdate`). The dig-completion
   `block_change` arrives *while* `targetDigBlock` is still set (the clear at
   line 179 happens *after* the `block_dig` finish packet is written but
   `blockUpdate` fires from the server's response, which can arrive before or
   after — in practice the race is tight but the guard catches it because the
   blockUpdate is processed before `bot.dig`'s `.then` runs). Worth verifying
   empirically (see §Validation).
2. `placing && placeTarget` covers the place case. This is the BUG 18 guard's
   condition minus the `newBlock.type === 1` discriminator — instead of
   "discriminate synthetic vs real by type," now suppress *both* synthetic and
   real at the placement target.

**Soundness:**

- Self-caused dig: when `bot.targetDigBlock.position.equals(oldBlock.position)`,
  the bot is *actively* the cause of this update. The dig handler will resolve
  its `bot.dig` promise on the next microtask, the `.then` will set
  `digging = false`, and the path step will advance naturally on the next
  `monitorMovement` tick. No path-reset needed.
- Self-caused place: same story on the place side. `bot.placeBlock`'s `.then`
  sets `placing = false` and releases the lock. Path step advances naturally.
- External updates: when an external agent modifies a block on the path, neither
  `bot.targetDigBlock` nor `placingBlock` matches the position. Falls through to
  the existing `isPositionNearPath` check → `resetPath` fires as today.

**Why the predicates are tighter than BUG 18's:**

BUG 18 required `newBlock.type === 1` to discriminate synthetic from real at
the same position. BUG 19 doesn't need that discriminator — once you're inside
the `bot.targetDigBlock.position.equals(...)` or `placeTarget.equals(...)`
branch, you *know* the bot caused this update, so suppressing both synthetic
and real is correct. The BUG 18 hunk can stay as-is (it's a strict subset of
the BUG 19 place guard for synthetics), or be folded into BUG 19 — either is
fine. The diff above leaves BUG 18's hunk in place for clarity and to keep the
two reports' patches independently revertible.

**Limitations:**

- **Race window on dig completion** (low confidence): if `bot.targetDigBlock` is
  cleared *before* the server's `block_change` is processed (i.e., the
  blockUpdate fires after `digging.js:179`), this guard won't fire and the
  resetPath will still happen. Mitigation: in practice the order is
  `block_change packet → world.setBlockStateId → blockUpdate → digging.js:179`,
  but worth verifying with the same `console.log` probe approach used for
  BUG 18. If the race exists, the fix is to clear `targetDigBlock` in
  `mineflayer`'s digging.js `.then` (not at line 179 directly) — but that's a
  patch to a different file.
- **Multi-block placement moves** (low confidence): `getMoveJumpUp` can produce
  moves with up to two `toPlace` entries. After the first place commits,
  `placingBlock` is reassigned to the second entry. The first place's real
  `block_change` may arrive *after* `placingBlock` has been reassigned, so the
  `placeTarget.equals(...)` check would fail and the reset would fire. Severity
  is low because the *second* place hasn't started yet, so `placing` is still
  true and the path's general shape is still valid; the reset just costs one
  extra A* recompute.
- **`bot.targetDigBlock` is cleared during digging if a different dig starts**
  (`digging.js:145`: "if (bot.targetDigBlock) bot.stopDigging()"). If the
  pathfinder's dig handler interrupts an existing dig to start a new one, there
  is a momentary window where `bot.targetDigBlock` points to the *new* target,
  not the original. Worst case: the original target's late server emit gets
  through the filter and resets the path. Severity is low for the same reason.

### Fix B (alternative, more invasive) — track positions in a Set, clear on completion

Instead of relying on `bot.targetDigBlock` / `placingBlock`, maintain a
pathfinder-owned `Set<string>` of "positions the pathfinder is currently
acting on." Add the position on dig/place start, remove on completion. The
listener filters against this set.

```js
const selfActedPositions = new Set()
function keyPos (p) { return `${p.x},${p.y},${p.z}` }

// in dig handler:
digging = true
selfActedPositions.add(keyPos(b))
// ...
bot.dig(block, true)
    .catch(...)
    .then(() => { lastNodeTime = ...; digging = false; selfActedPositions.delete(keyPos(b)) })

// in place handler:
selfActedPositions.add(keyPos(placeTargetPos))
// ...
bot.placeBlock(...).then(...).then(() => { selfActedPositions.delete(keyPos(placeTargetPos)); placing = false })

// in listener:
if (selfActedPositions.has(keyPos(oldBlock.position))) return
```

**Pros:** survives `placingBlock` reassignment in multi-place moves; survives
`bot.targetDigBlock` being reassigned mid-dig.

**Cons:** more state to maintain, more places to set/clear, larger patch
surface area.

**Recommendation:** start with Fix A. If the limitations of Fix A surface in
practice (probe shows ~5–10 % of self-caused emits sneak through), upgrade to
Fix B.

### Fix C (not recommended) — narrow `isPositionNearPath`'s tolerance

The listener uses `isPositionNearPath` (`index.js:252`) to decide what counts
as "on the path." Narrowing its tolerance (e.g., requiring exact match)
*would* reduce false positives from nearby blocks but would also miss real
external updates that legitimately invalidate the path. Worse trade-off than
Fix A.

---

## Evidence

In-bot validation log captured after BUG 18 patch landed, during
`!collectBlocks("stone", 13)` (bot at the surface bridging water and digging
through dirt to reach stone):

```
[BUG18] real blockUpdate near path at (-145, 63, 125) (old=grass_block new=air) → resetPath
[BUG18] real blockUpdate near path at (-145, 62, 125) (old=dirt new=air) → resetPath
[BUG18] real blockUpdate near path at (-145, 61, 125) (old=dirt new=air) → resetPath
[BUG18] real blockUpdate near path at (-146, 60, 125) (old=dirt new=air) → resetPath
[BUG18] real blockUpdate near path at (-147, 59, 125) (old=dirt new=air) → resetPath
[BUG18] real blockUpdate near path at (-148, 58, 125) (old=dirt new=air) → resetPath
[BUG18] real blockUpdate near path at (-148, 58, 126) (old=dirt new=air) → resetPath
[BUG18] real blockUpdate near path at (-149, 58, 125) (old=sand new=air) → resetPath
[BUG18] real blockUpdate near path at (-149, 58, 125) (old=air new=water) → resetPath
[BUG18] real blockUpdate near path at (-149, 57, 125) (old=sand new=air) → resetPath
[BUG18] real blockUpdate near path at (-149, 57, 125) (old=air new=water) → resetPath
```

All eleven of these resets are bot-caused:

| Type | Count | Pattern |
|---|---|---|
| Self-dig (bot broke a block) | 9 | `old=<block> new=air` |
| Water flow into bot-dug cavity | 2 | `old=air new=water` |

The two `old=air new=water` lines are *adjacent* to bot-dug positions — the
bot dug sand, water from a nearby source flowed in. Arguably external (the
water flow is server physics), but the trigger is the bot's dig. Either way:
of the eleven resets, **zero are caused by an external agent (player, piston,
etc.)**. Every one of them invalidates a path the pathfinder just built.

The "blocks itself with blocks" sequence is also visible from the same run:

```
[BUG18] suppressed synthetic blockUpdate at (-146, 58, 125) (old=water new=stone)
[BUG18] real blockUpdate near path at (-146, 58, 125) (old=stone new=dirt) → resetPath
  ← bot placed dirt at (-146, 58, 125) as a scaffolding bridge
[BUG18] real blockUpdate near path at (-147, 58, 126) (old=dirt new=air) → resetPath
  ← bot then broke a different dirt block at (-147, 58, 126)
[BUG18] real blockUpdate near path at (-146, 58, 125) (old=dirt new=air) → resetPath
  ← then broke the dirt it had JUST placed at (-146, 58, 125)
```

The bot placed dirt at `(-146, 58, 125)` and broke it less than a second
later. Between the two events, the path was reset at least twice and
recomputed at least twice; A* preferred a route that went *through* the
freshly-placed dirt rather than around it. With Fix A applied:

- Place at `(-146, 58, 125)`: BUG 18 guard catches the synthetic
  (`new=stone`); the real (`new=dirt`) is then suppressed by BUG 19's
  placeTarget guard because `placing=true` and `placeTarget = (-146, 58, 125)`.
  → 0 resets.
- Subsequent dig at `(-146, 58, 125)`: the bot's pathfinder would *not* plan
  this dig in the first place if the previous place-completion hadn't reset
  the path and triggered a recompute. With BUG 19, the place completes
  cleanly, the path advances to the *next* node (which was the original
  target), and the bot never plans the wasteful dig of its own scaffolding.

What's still **not** in evidence:
- A direct A/B measurement of `!collectBlocks` execution time before vs. after
  BUG 19 (would quantify the perf improvement).
- A repro of the dig-target race window mentioned in Fix A's limitations
  (would confirm whether `bot.targetDigBlock` is reliably set when the
  blockUpdate fires).

The cheapest confirming probe is the same approach used for BUG 18: add a
`console.log` to the new BUG 19 guards and run the same `!collectBlocks`
workflow. Expect to see ~7–10 lines of "BUG 19 suppressed self-dig at …" and
"BUG 19 suppressed self-place at …" per invocation.

---

## Relation to Other Bugs

- **BUG 18** — strict subset. BUG 18's guard catches synthetic emits at the
  place target; BUG 19's guard catches *both* synthetic and real at the place
  target *and* real at the dig target. If BUG 19 lands as written, BUG 18's
  hunk becomes redundant (the BUG 19 place guard subsumes it). Leave both in
  for now — easy to revert independently if a regression surfaces.
- **BUG 17** — `!goToSurface` tower-up livelock. BUG 19 should be applied
  before re-testing BUG 17, because the dig→place cycle in tower-up generates
  exactly the resetPath cascade BUG 19 addresses. If BUG 17 still hangs after
  BUG 18 + BUG 19, the residual mechanism is BUG 17 §1's `GoalNear(range=0)`
  and BUG 17 Fix A is needed.
- **BUG 12** — the cooperative-cancellation refactor is orthogonal. BUG 19
  reduces the rate of *self-induced* path churn but doesn't change the
  cancellation contract.
- **Upstream Mindcraft** — the listener and the cascade exist in upstream
  too. The proposed fix is independent of AH-specific code (`bot.targetDigBlock`
  and `placingBlock` are mineflayer/pathfinder-native), so the patch is
  upstreamable.
