# BUG 17 — `!goToSurface` Hangs Indefinitely in Pathfinder Tower-Up Livelock With No Recovery

**Severity:** High (single `!goToSurface` call hangs for ≥5 minutes with no progress, no
exception, no mode-eviction; bot stays animated — jumping and swinging — so the achievement
agent appears alive while the rollout is effectively dead air)
**Status:** Hypothesis — symptom and pre-call geometry are confirmed from the rollout
trace; the precise reason the dig/place cycle fails to terminate is not proven from the
trace alone (the trace is truncated mid-action; no per-tick pathfinder log is captured).
Multiple plausible mechanisms are documented below and ranked by confidence.
**Branch:** `search-agent`
**Trace:** `achievement_hunter/rollouts/2026-05-11T18-22-47-437Z_test/` (trace ends at
`2m 09s` with `SEARCH_RECOVERY` `attempt_start` queuing `!goToSurface`; the action never
emits an `action_result` in the trace because the rollout is still hanging at the time of
inspection — see Evidence)
**Related files:**
- `src/agent/library/skills.js:2003–2019` (`goToSurface`)
- `src/agent/library/skills.js:1209–1266` (`goToPosition`, including the BUG 14
  `checkDigProgress` watchdog at `1232–1245`)
- `src/agent/library/skills.js:1098–1141` (`goToGoal`)
- `src/agent/commands/actions.js:484–491` (`!goToSurface` command wiring)
- `achievement_hunter/src/pipeline/structured_loop/search_replanner.js:126–193`
  (`run_action` — no per-action wallclock timeout)
- `node_modules/mineflayer-pathfinder/index.js:497–594` (dig/place handler inside
  `monitorMovement`)
- `node_modules/mineflayer-pathfinder/lib/movements.js:553–585` (`getMoveUp`, the 1×1
  tower-up neighbour generator)
- `node_modules/mineflayer-pathfinder/lib/goals.js:51–73` (`GoalNear` with `range=0`)
- `node_modules/mineflayer-pathfinder/lib/goto.js:16–65` (`gotoUtil` — resolves only on
  `goal_reached` / `path_update`-with-status / `goal_updated` / `path_stop`; no wallclock
  timeout)
- `achievement_hunter/src/agent/ah_modes.js:152–214` (`unstuck`)

**Related bugs:**
- **BUG 12** — `unstuck`-interrupt deadlock + `cleanKill`-and-resume cycle. This bug is in
  the same family ("no overarching cancellation primitive; long-running skills can hang
  with the bot still animated"), but BUG 12 ends in a `cleanKill` after 10 s. BUG 17 does
  **not** terminate in `cleanKill` because the enclosing action is a `search_replanner`
  navigation action, not an SPL action — there is no `ActionManager.stop()` watchdog above
  it (see Why existing safeguards didn't catch this).
- **BUG 13** — same `unstuck` reference-equality bug surfaces here too (see Root Cause §3).
- **BUG 14** — patched `checkDigProgress` watchdog in `goToPosition`; one of the
  hypothesized livelock mechanisms (§Root Cause Hypothesis B) involves a transient
  false-positive of this watchdog, but its hardness gate makes that mechanism unlikely on
  stone (`hardness=1.5`, well above the `TRIVIAL_HARDNESS=0.5` floor) — see Root Cause for
  why it still warrants attention.
- **BUG 16** — fixed `block_dig`-missing-`sequence` server rejection. Patch is currently in
  place on this branch (verified — see Evidence). Server-side dig completion should work,
  so the "swings without breaking" symptom is **not** BUG 16 resurfacing.

---

## Symptom

User-facing description (verbatim):

> Agent called `!goToSurface` but the bot just jumped in place and smacked the cobblestone
> above it without ever breaking it. Additionally the bot kept switching between its
> pickaxe and some cobblestone in its equipped spot. This happened for 5 minutes and is
> still happening, i.e nothing ever broke it out of this buggy behavior.

Observable external behaviour:

| Signal | Observation |
|---|---|
| Animation | Continuous jump + arm swing toward the block above the head |
| Hotbar (held item) | Rapidly cycles between a pickaxe item and `cobblestone` |
| Block above head | Block visibly takes hits (swing animation lands) but never breaks |
| Rollout trace | Last entry is `SEARCH_RECOVERY` `attempt_start` queuing `!goToSurface`; no `action_result` ever written |
| Process state | Achievement-agent process still alive; no `exited with code` line; no `cleanKill`; no `unstuck` eviction; no mode interrupt |
| Duration | ≥5 minutes of wall-clock and counting at time of report |

This is a **silent hang**, distinct from:
- BUG 12's `cleanKill`-and-restart loop (BUG 12 exits the process after 10 s; this does
  not).
- BUG 16's "swings without breaking" symptom (that one resolves once `unstuck` fires or
  the SPL retry counter trips; this never fires either).

---

## Pre-call context (from trace)

The bot reached the `!goToSurface` call after a successful iron-collection task. Final
state from
`achievement_hunter/rollouts/2026-05-11T18-22-47-437Z_test/task_traces/full_task_trace.jsonl`
(end of the `raw_iron` task):

```json
"final_state": {
  "world": {
    "position": { "x": -1052.36, "y": 45, "z": 1663.5 },
    "dimension": "overworld",
    "biome": "mangrove_swamp"
  },
  "surroundings": {
    "below": "iron_ore",
    "legs": "air",
    "head": "air",
    "firstBlockAboveHead": "stone (0 blocks up)"
  },
  "inventory": {
    "counts": { "raw_iron": 10, "cobblestone": 54, "mud": 3 },
    "equipment": { "mainHand": "stone_pickaxe" }
  }
}
```

Key facts:

- **Bot is underground in a 1×2 mining cavity at `y=45`.** `below=iron_ore` (floor at
  `y=44`), `legs=air` (`y=45`), `head=air` (`y=46`), `firstBlockAboveHead=stone (0 blocks
  up)` — i.e. the next non-air block above the head is stone at `y=47`. So the **ceiling
  is at `y=47`**; the bot has exactly **one block of head clearance** before that ceiling.
- **Held item is `stone_pickaxe`.** Inventory carries `54 × cobblestone` (the pathfinder's
  default scaffolding block — see `Movements.scafoldingBlocks` in
  `node_modules/mineflayer-pathfinder/lib/movements.js:86–88`).
- The subsequent task switches to `wheat`. `!searchForBlock("wheat", 32 … 511)` exhausts
  without finding wheat (the bot is underground). At `1m 23s` the SPL escalates to
  `search_replanner` (see `rollout_trace.json` lines 615–663). The plan emitted at
  `2m 09s` is:

  ```json
  "planned_actions": [
    {"name": "!goToSurface", "args": []},
    {"name": "!goToCoordinates", "args": [-1400, 80, 2010, 3]},
    {"name": "!search", "args": ["wheat"]}
  ]
  ```

- The rollout trace ends mid-`!goToSurface`. Per the user, the agent is still in this
  state at the time of bug filing.

The target the bot is towering toward: `goToSurface` scans `y=360 → y=-64` at the bot's
`(floor(x), floor(z)) = (-1053, 1663)` column, picks the highest non-air block, and calls
`goToPosition(bot, block.x, block.y+1, block.z, 0)`
(`src/agent/library/skills.js:2009–2017`). For this biome and column the surface is around
`y=70`, so the bot must rise ≈25 blocks through stone.

---

## Root Cause

The bot is in a 1×2 cavity with stone overhead. The only pathfinder move that climbs
straight up through a stone ceiling without sideways relocation is `getMoveUp`
(`mineflayer-pathfinder/lib/movements.js:553–585`):

```js
getMoveUp (node, neighbors) {
    const block1 = this.getBlock(node, 0, 0, 0)   // bot's feet space
    if (block1.liquid) return
    if (this.getNumEntitiesAt(node, 0, 0, 0) > 0) return
    const block2 = this.getBlock(node, 0, 2, 0)   // block above bot's head
    let cost = 1
    const toBreak = []
    const toPlace = []
    cost += this.safeOrBreak(block2, toBreak)
    if (cost > 100) return
    if (!block1.climbable) {
      if (!this.allow1by1towers || node.remainingBlocks === 0) return
      // …
      toPlace.push({ x: node.x, y: node.y - 1, z: node.z, dx: 0, dy: 1, dz: 0, jump: true })
      cost += this.placeCost
    }
    // …
    neighbors.push(new Move(node.x, node.y + 1, node.z,
        node.remainingBlocks - toPlace.length, cost, toBreak, toPlace))
}
```

So each rung of the climb has **`toBreak = [ceiling block]`** and
**`toPlace = [{below-feet, jump=true}]`**. The execution side
(`mineflayer-pathfinder/index.js:497–594`) processes the move as: dig handler first
(equip best pickaxe → `bot.dig` the ceiling), then place handler (equip scaffolding →
jump → `bot.placeBlock` under feet). The held-item alternation the user observes —
pickaxe ↔ `cobblestone` — is exactly the externally-visible signature of this loop.

### Why the call hangs indefinitely instead of failing

`gotoUtil` (`mineflayer-pathfinder/lib/goto.js:16–65`) resolves only on:

| Event | Resolves as | Fired when |
|---|---|---|
| `goal_reached` | success | `monitorMovement` sees `path.length === 0 && stateGoal.isEnd(bot.entity.position.floored())` |
| `path_update` with `path.length === 0` | success | A* returned `noPath` *or* `timeout` but the cleanup branch matched length 0 |
| `path_update` with `status: 'noPath'` | rejected `NoPath` | A* concluded no path exists |
| `path_update` with `status: 'timeout'` | rejected `Timeout` | A* exceeded `thinkTimeout` (5000 ms) |
| `goal_updated` | rejected `GoalChanged` | something called `setGoal` with a different goal |
| `path_stop` | rejected `PathStopped` | something called `bot.pathfinder.stop()` |

**There is no wallclock timeout on the overall `goto` call.** If A* keeps returning
non-trivial paths and the bot keeps making *some* state change every few seconds (path
mutations, blockUpdate events, dig restarts), none of those termination events fire and
`gotoUtil` waits indefinitely. The achievement agent's `await skills.goToSurface(bot)`
(via `actions.js:485–490`) inherits that wait.

### §1. `goToPosition` uses `GoalNear(x, y+1, z, 0)` — `range=0` is too strict

`goToSurface` (`skills.js:2003–2019`):

```js
export async function goToSurface(bot) {
    const pos = bot.entity.position;
    for (let y = 360; y > -64; y--) {
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') continue;
        await goToPosition(bot, block.position.x, block.position.y + 1, block.position.z, 0);
        log(bot, `Going to the surface at y=${y+1}.`);``
        return true;
    }
    return false;
}
```

The fourth argument is `min_distance = 0`. That flows through to
`new pf.goals.GoalNear(x, y, z, 0)` at `skills.js:1250`, whose `isEnd` is
(`mineflayer-pathfinder/lib/goals.js:67–72`):

```js
isEnd (node) {
  const dx = this.x - node.x
  const dy = this.y - node.y
  const dz = this.z - node.z
  return (dx * dx + dy * dy + dz * dz) <= this.rangeSq    // rangeSq = 0
}
```

With `rangeSq=0`, isEnd is true only when the bot's `position.floored()` *exactly* equals
the target voxel. In normal flat terrain this resolves the moment the bot stands on the
correct column; A* can find a path to that exact cell and the bot follows it. But for a
**straight vertical tower-up through 25 blocks of stone**, any horizontal drift of even one
cell during the climb means `isEnd` never matches. Pathfinder will keep re-pathing toward
the exact target, and since `goToSurface` chose the column to be the bot's own current
column, the only valid moves from any laterally-offset cell are *back* over to the column
plus another tower-up — which the dig/place loop may or may not be able to execute
depending on local geometry.

A non-zero `min_distance` (e.g. `2` like the default of `goToPosition`) would let the path
terminate as soon as the bot is *near* the surface block, even if it ended up one cell
laterally off — which is a routine outcome of stacking 25 1×1 jump-placements.

This is the **highest-confidence contributor** because it is a static property of the
call: the trace doesn't have to prove a race, just a geometric mismatch.

### §2. The dig/place rung has multiple ways to fail forward without ever completing

The handler order in `monitorMovement` is dig-first, then place
(`mineflayer-pathfinder/index.js:497–594`):

```js
if (digging || nextPoint.toBreak.length > 0) {
  if (!digging && bot.entity.onGround) {
    digging = true
    const b = nextPoint.toBreak.shift()
    const block = bot.blockAt(new Vec3(b.x, b.y, b.z), false)
    const tool = bot.pathfinder.bestHarvestTool(block)
    fullStop()
    const digBlock = () => {
      bot.dig(block, true)
        .catch(_ignoreError => { resetPath('dig_error') })
        .then(() => { lastNodeTime = performance.now(); digging = false })
    }
    if (!tool) digBlock()
    else bot.equip(tool, 'hand').catch(()=>{}).then(() => digBlock())
  }
  return
}
if (placing || nextPoint.toPlace.length > 0) {
  if (!placing) {
    placing = true
    placingBlock = nextPoint.toPlace.shift()
    fullStop()
  }
  // …
  let canPlace = true
  if (placingBlock.jump) {
    bot.setControlState('jump', true)
    canPlace = placingBlock.y + 1 < bot.entity.position.y
  }
  if (canPlace) {
    if (!lockEquipItem.tryAcquire()) return
    bot.equip(block, 'hand').then(function () {
      // …
      bot.placeBlock(refBlock, new Vec3(placingBlock.dx, placingBlock.dy, placingBlock.dz))
        .then(() => { bot.setControlState('sneak', false); bot.setControlState('jump', false); /* … */ })
        .catch(_ignoreError => { resetPath('place_error') })
        .then(() => { lockPlaceBlock.release(); placing = false; lastNodeTime = performance.now() })
    }).catch(()=>{})
  }
  return
}
```

And a global listener at line 413–418:

```js
bot.on('blockUpdate', (oldBlock, newBlock) => {
  if (!oldBlock || !newBlock) return
  if (isPositionNearPath(oldBlock.position, path) && oldBlock.type !== newBlock.type) {
    resetPath('block_updated', false)
  }
})
```

Every successful dig or place fires a `blockUpdate` for a position on the current path,
which immediately `resetPath`s. Recomputation finds a fresh tower-up at the bot's new
position and the cycle continues. None of `resetPath`, the dig-`.catch` or the
place-`.catch` ever emits a terminating `path_update` status that `gotoUtil` would treat
as failure — they all simply clear the path and wait for the next compute round.

So the loop terminates only when one of these holds:

1. `getMoveUp` produces no neighbours (e.g., `node.remainingBlocks === 0`, i.e. no more
   scaffolding; or `block2` becomes unbreakable). With 54 cobblestone, exhaustion is
   unlikely within the 25 blocks needed.
2. The composite `getPathTo` returns `noPath` (every move out of the current node was
   pruned). Vertical-only A* through stone with the bot's tool set has few prunes.
3. The composite `getPathTo` exhausts `thinkTimeout=5000 ms` returning `timeout`. For a
   25-cell straight tower with branching factor ~1 (only `getMoveUp` applies in 1×2
   cavities) A* finishes in milliseconds — `timeout` should not fire.
4. The bot reaches the goal cell. Blocked by §1 if the bot drifts laterally.

**No path terminates the loop in the configuration captured by the trace.** That is the
load-bearing part of the diagnosis. The "why doesn't a single rung complete" question
below is then a secondary concern — even if every rung *did* complete cleanly, §1 alone
can still hang the call once the bot reaches the surface column without exactly matching
the floored target.

### §2a. Hypothesis B (lower confidence) — AH `checkDigProgress` watchdog false-positive

`goToPosition` installs a 1000-ms-period watchdog (`skills.js:1232–1245`, BUG 14 patch):

```js
const TRIVIAL_HARDNESS = 0.5;
const checkDigProgress = () => {
    if (bot.targetDigBlock) {
        const targetBlock = bot.targetDigBlock;
        const itemId = bot.heldItem ? bot.heldItem.type : null;
        if (!targetBlock.canHarvest(itemId) && targetBlock.hardness > TRIVIAL_HARDNESS) {
            log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.`);
            bot.pathfinder.stop();
            bot.stopDigging();
        }
    }
};
const progressInterval = setInterval(checkDigProgress, 1000);
```

In the dig phase the pathfinder does `bot.equip(tool, 'hand').then(() => digBlock())`. The
equip is async and only completes once the server's `set_slot` is processed by the
client, so there is a short window (50–200 ms typical) where `bot.targetDigBlock` is being
set up by `bot.dig` while `bot.heldItem` may still reflect the *previous* held item — the
`cobblestone` last used to place. If the 1000-ms tick of `checkDigProgress` falls inside
that window, the predicate is

```
!stone.canHarvest(cobblestone_id) && stone.hardness > 0.5
  → !false && 1.5 > 0.5
  → true → bot.pathfinder.stop()
```

`bot.pathfinder.stop()` fires `path_stop` → `gotoUtil` rejects with `PathStopped` →
`goToPosition`'s `catch` logs and returns `false` → `goToSurface` proceeds to its
`return true` (it ignores the inner return). So if this race fired, `!goToSurface` would
**resolve quickly**, not hang. The user's 5-minute hang means this is **not** the
load-bearing mechanism in this trace. It is documented because it would produce the same
held-item oscillation pattern, and a future race tightening could turn it into a real
crash class.

(There's also a stricter version: `bot.targetDigBlock` is assigned inside `bot.dig` at
`mineflayer/lib/plugins/digging.js:157`, *after* `bot.lookAt` and the start
`block_dig` packet write. So in practice the window where `targetDigBlock` is set but
`heldItem` is still cobblestone is much smaller than the equip duration — the equip's
`.then` callback runs after `set_slot` is processed, and only *then* does `bot.dig` start
executing. This narrows Hypothesis B further but doesn't fully exclude it across slow
network conditions.)

### §2b. Hypothesis C (medium confidence) — single-block head clearance prevents the place

For the first rung from `y=45`, the ceiling at `y=47` is one block above the bot's head
(`y=46`). For the place to fire,
`canPlace = placingBlock.y + 1 < bot.entity.position.y` must be true; the placement is at
`(node.x, node.y-1, node.z) = (x, 44, z)`, so `canPlace = 45 < bot.y`, requiring the bot's
feet to be above `y=45`.

The pathfinder orders dig before place. The expected sequence is:

1. Dig stone at `(x, 47, z)`. Block becomes air.
2. Place handler fires. Bot sets `jump=true`. Bot ascends through the now-cleared `y=47`.
3. `canPlace` becomes true, equip cobblestone, `bot.placeBlock` succeeds.

But the `blockUpdate` listener fires *during* the dig: the server's block-state change
from stone to air at `(x, 47, z)` is on the path, so `resetPath('block_updated', false)`
fires before the dig handler's `.then` even runs. That clears the path *and sets
`placing = false`* — innocent on its own, but it means the bot's still-pending dig
completion races with a path recompute that may or may not put the place back on the very
next rung. If the recompute lands a slightly different geometry (e.g. the bot is now at
`y=45` with the ceiling at `y=48`), the new rung again has `toBreak=[stone at +2]` and a
fresh place, and the cycle continues without the place ever firing.

This is **plausible but unverified** — the trace doesn't capture per-tick pathfinder
state. A clean reproduction would log each `path_update`'s `path` and `status`, but the
truncated rollout trace doesn't include that.

### §3. `unstuck` mode's `cur_dig_block === prev_dig_block` is reference equality, so the
stuck timer never accumulates across rungs

`achievement_hunter/src/agent/ah_modes.js:167–207`:

```js
const cur_dig_block = bot.targetDigBlock;
if (cur_dig_block && !this.prev_dig_block) {
  this.prev_dig_block = cur_dig_block;
}
if (this.prev_location &&
    this.prev_location.distanceTo(bot.entity.position) < this.distance &&
    cur_dig_block == this.prev_dig_block) {
  this.stuck_time += (Date.now() - this.last_time) / 1000;
} else {
  this.prev_location = bot.entity.position.clone();
  this.stuck_time = 0;
  this.prev_dig_block = null;
}
```

`cur_dig_block == prev_dig_block` is an object-identity comparison. `bot.targetDigBlock`
is reassigned each time `bot.dig` runs — even on the *same* world position — because
`mineflayer-pathfinder/index.js:502` constructs the block via `bot.blockAt(...)`, which
returns a fresh `Block` object every call. And `bot.targetDigBlock` is set to `null` every
time `bot.dig` resolves (`mineflayer/lib/plugins/digging.js:179`), so even *within* a
single rung the comparison flips to `null === <prev block>` the moment the dig
finishes — triggering the `else` branch and resetting `stuck_time` to 0.

Across the dig→place→dig cycle, the comparison alternates between `null === null` (just
after dig completes, just before next dig starts), `null === <prev>` (place phase), and
`<new block instance> === <prev block instance>` (different references) — none of which
make `stuck_time` accumulate to the `max_stuck_time = 20` s threshold.

**Result:** the only mode that could fire `cleanKill` after 10 s never fires; the bot
remains "unstuck-stuck" forever.

This is the same reference-equality bug-shape as BUG 13's discussion of unstuck not
firing during the post-pickaxe-break iron-collection wedge, although the contexts differ.
A behaviourally-correct fix is to compare by `block.position.equals(prev_dig_block.position)`
rather than by reference — that would let `stuck_time` accumulate any time the bot is
repeatedly trying to dig the same world position, even across dig restarts.

### §4. `search_replanner` has no per-action wallclock budget

`achievement_hunter/src/pipeline/structured_loop/search_replanner.js:126–193`:

```js
async function run_action(action, agent, log, searched_targets) {
  // …
  const command = format_action_as_command(action);
  try {
    const env_result = await executeCommandWithModeRecovery(agent, command);
    // …
  } catch (e) {
    return create_action_result(command, false, 'runner_exception', String(e));
  }
}
```

`executeCommandWithModeRecovery` waits on the inner command (here `!goToSurface`) and only
returns when the command resolves. There is no `Promise.race` with a timeout. So if
`!goToSurface` never returns, this `await` never returns; the outer recovery loop in
`recover_failed_search` waits forever on this one action; the entire SPL is blocked. No
restart, no failover, no replanner hand-off.

In short: every layer above `bot.pathfinder.goto` trusts the layer below to return
eventually. The only layer with a wallclock budget at all is `ActionManager.stop()`'s
10-second `cleanKill` (`action_manager.js:26–37` per BUG 12), but that only fires when
`stop()` is called by a *new* action superseding the current one — there is no new action
queued during a search-replanner step, so `stop()` is never invoked and `cleanKill` never
fires.

### §Proximate vs root cause

- **Proximate cause:** `bot.pathfinder.goto` never resolves because the dig/place loop
  for tower-up either fails to make incremental progress against an exact-cell goal
  (§1 + §2), or makes progress that gets undone by `blockUpdate`-triggered `resetPath`
  before any individual rung completes (§2b).
- **Root cause:** layered absence of bounded-time guarantees:
  - `goToSurface` uses `range=0` and ignores `goToPosition`'s return value (§1).
  - `gotoUtil` has no overall timeout (§ "Why the call hangs indefinitely").
  - `unstuck`'s identity check never accumulates `stuck_time` across the cycle (§3).
  - `search_replanner.run_action` has no per-action timeout (§4).

Each layer is, in isolation, doing exactly what it is documented to do. Combined, they
turn a single hard-to-reach pathfinder edge case into a silent rollout-killer with no
recovery path.

---

## Why existing safeguards didn't catch this

| Safeguard | Why it didn't fire |
|---|---|
| `ActionManager.stop()` 10 s `cleanKill` (BUG 12) | Only fires when a *new* action tries to interrupt the current one. `search_replanner` does not queue a new action mid-`!goToSurface`. |
| `unstuck` mode 20 s + 10 s `cleanKill` | `cur_dig_block === prev_dig_block` is reference-equality, so `stuck_time` resets on every dig start (§3). |
| `goToPosition` `checkDigProgress` (BUG 14) | The hardness gate (`> 0.5`) admits stone; the predicate is well-formed for stone-with-pickaxe. The false-positive race in §2a would *terminate* the hang, not prolong it, so its absence doesn't help either. |
| `executeCommandWithModeRecovery` `MAX_MODE_INTERRUPTS=10` | Counts mode interrupts. No mode interrupts during this hang (`unstuck` doesn't fire). |
| `search_replanner` `MAX_ACTION_RETRIES=2` | Counts retries of *returned* failures. The action never returns, so the retry counter never advances. |
| `failure_replanner` D11 fall-through | Triggered by `is_pathfinding_failure(result)`. No result is ever produced. |
| BUG 16 `block_dig` sequence patch | In place and verified — server-side dig completion works. (`block_dig` writes at `node_modules/mineflayer/lib/plugins/digging.js:148–155, 170–177, 202–208` all include `sequence`.) |

The cleanKill watchdogs are all *interrupt-driven*. None of them is a **wallclock budget**
on a single skill call. BUG 12 explicitly identifies this gap (§Framing: "actions don't
yield to cancellation") and proposes `AbortSignal` + a progress watchdog as the
principled fix. BUG 17 is another concrete data point for that same diagnosis.

---

## Proposed Fix

Layered. Each layer is independently useful; together they close the gap.

### Fix A — `goToSurface`: don't insist on the exact cell and surface the inner failure

`src/agent/library/skills.js:2003–2019` (annotation marker required since this file is
outside `achievement_hunter/`):

```js
// Start of AH code
export async function goToSurface(bot) {
    /**
     * Navigate to the surface (highest non-air block at current x,z).
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     */
    const pos = bot.entity.position;
    for (let y = 360; y > -64; y--) {
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') continue;
        // Relax from range=0 (must land in exactly this voxel — pathologically strict
        // for a 1×1 tower-up that may drift one cell laterally during placement) to
        // range=2 (within the 2-block neighborhood, which is the goToPosition default).
        const ok = await goToPosition(
            bot, block.position.x, block.position.y + 1, block.position.z, 2);
        if (ok) log(bot, `Going to the surface at y=${y+1}.`);
        else    log(bot, `goToSurface gave up at y=${y+1}.`);
        return ok;
    }
    return false;
}
// End of AH code
```

**Two changes:**

1. `min_distance` 0 → 2. Closes §1 directly: the pathfinder can terminate as soon as the
   bot is at the surface column ± 2, which it naturally is once the climb is complete
   and head-blocks above are broken.
2. Forward `goToPosition`'s boolean result, and log a distinct line for failure. Today
   the function returns `true` on the first non-air block found regardless of whether
   the climb succeeded — search_replanner sees "success" even on a hard failure and
   moves on to `!goToCoordinates` from a position that didn't actually surface.

**Soundness:** purely additive — it can't make the existing behaviour stricter, and the
log lines remain greppable. The original code's promise was "true if the surface was
reached" but it didn't honour that promise; this version does.

**Limitations:** does not bound `goToPosition`'s own runtime; if the climb itself wedges
for §2/§2b reasons, this fix doesn't shorten the wait. Pair with Fix B.

### Fix B — `goToSurface` wallclock watchdog

A direct upper bound on the call. Conservative threshold so a healthy climb of 25 blocks
× ~1.5 s/rung ≈ 40 s never trips it:

```js
// Start of AH code
const GOTO_SURFACE_TIMEOUT_MS = 90_000;  // 90 s; healthy climbs finish in ~40 s

export async function goToSurface(bot) {
    const pos = bot.entity.position;
    for (let y = 360; y > -64; y--) {
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') continue;
        const target = { x: block.position.x, y: block.position.y + 1, z: block.position.z };
        const ok = await Promise.race([
            goToPosition(bot, target.x, target.y, target.z, 2),
            new Promise(resolve => setTimeout(() => {
                log(bot, `goToSurface watchdog: ${GOTO_SURFACE_TIMEOUT_MS}ms elapsed, aborting.`);
                bot.pathfinder.stop();
                resolve(false);
            }, GOTO_SURFACE_TIMEOUT_MS)),
        ]);
        return ok;
    }
    return false;
}
// End of AH code
```

`bot.pathfinder.stop()` from the timeout branch fires `path_stop` →
`gotoUtil` rejects → `goToPosition`'s `catch` returns `false`. The outer `Promise.race`
also resolves to `false`. `goToPosition`'s `finally`-via-`catch` clears the
`checkDigProgress` interval. `search_replanner` then sees a falsy result and falls
through to `!goToCoordinates` (or whatever its `is_pathfinding_failure` classification
routes to).

**Soundness:** the timeout value should be picked so that 99-th-percentile healthy
climbs finish below it. 90 s is comfortable for a 25-block climb; for very deep tunnels
(say, `y=-50` mining for diamonds, climbing 120 blocks) the timeout would need to be
proportional. A reasonable alternative is to compute it dynamically:
`timeout = max(30_000, 1500 * (target.y - bot.entity.position.y))`.

**Limitations:** this is the smoke-alarm fix at the skill level. It does not address
why the pathfinder hung — just bounds the damage. BUG 12's principled fix is required
to address the root cause across the whole skill surface.

### Fix C — `unstuck`: compare dig block by position, not identity

`achievement_hunter/src/agent/ah_modes.js:174–186`:

```js
// Start of AH code (annotation kept; file is already AH-local but the change is documented for clarity)
const cur_dig_block = bot.targetDigBlock;
if (cur_dig_block && !this.prev_dig_block) {
  this.prev_dig_block = cur_dig_block;
}
const same_dig_block = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.position && b.position && a.position.equals(b.position);
};
if (this.prev_location &&
    this.prev_location.distanceTo(bot.entity.position) < this.distance &&
    same_dig_block(cur_dig_block, this.prev_dig_block)) {
  this.stuck_time += (Date.now() - this.last_time) / 1000;
} else {
  this.prev_location = bot.entity.position.clone();
  this.stuck_time = 0;
  this.prev_dig_block = null;
}
// End of AH code
```

Two semantic changes from the existing code:

1. Compare `prev_dig_block` and `cur_dig_block` by world position rather than JS object
   identity. Closes §3.
2. (Worth considering, not shown) Treat `cur_dig_block === null` as "same position" for
   a short tolerance window (say, 500 ms) so the stuck timer doesn't reset between rung
   transitions when the bot is mid-cycle. Conservative; not strictly required for this
   bug.

**Soundness:** the original intent of the `prev_dig_block` clause was "if the bot is
digging the *same* block, accumulate stuck time." Identity comparison breaks that intent
the moment `bot.dig` is called twice on the same position. Position equality matches
the intent.

**Limitations:** still only catches stuck-while-digging-the-same-block. A bot wedged in a
dig→place loop that *does* progress 1 block per rung but at 0.1 rung/s — pathologically
slow — would not trip this. That's BUG 12 §c (progress watchdog) territory.

### Fix D — Defer to BUG 12

The principled fix — cooperative cancellation (`AbortSignal` threaded through skills) and
a progress watchdog at the action layer — is BUG 12's primary fix. If BUG 12 lands, Fix B
above becomes redundant (the watchdog covers the surface-climb case) and the broader
class of "skill wedges silently" bugs is addressed in one place.

**Sequencing recommendation:**
1. **Fix A** now — trivial, closes the most likely single-call livelock contributor (§1).
2. **Fix B** now — three-line wallclock budget; eliminates the dead-air symptom even if
   future variants of the underlying livelock emerge.
3. **Fix C** at convenience — independently useful; reduces the BUG 13 / BUG 17 unstuck
   blind spot for unrelated future bugs.
4. **Defer to BUG 12 (Fix D)** as the principled long-term cure. Once landed, revisit B.

---

## Evidence

Direct from the trace at `achievement_hunter/rollouts/2026-05-11T18-22-47-437Z_test/`:

1. **Pre-call geometry** — `task_traces/full_task_trace.jsonl` final-state record (quoted
   in §Pre-call context). Bot at `(-1052.36, 45, 1663.5)` in a 1×2 cavity with ceiling
   at `y=47`, holding `stone_pickaxe`, carrying 54 cobblestone.

2. **The action that hung** — `rollout_trace.json:638–663`:

   ```json
   {
     "timestamp": "2026-05-11T18:24:57.381Z",
     "elapsed": "2m 09s",
     "stage": "SEARCH_RECOVERY",
     "type": "attempt_start",
     "attempt": 1,
     "target": "wheat",
     "summary": "Wheat crops are found in villages (plains, desert, savanna)...",
     "planned_actions": [
       {"name": "!goToSurface", "args": []},
       {"name": "!goToCoordinates", "args": [-1400, 80, 2010, 3]},
       {"name": "!search", "args": ["wheat"]}
     ]
   }
   ```

   The trace ends at this `attempt_start`. There is no subsequent `action_result` for
   `!goToSurface`, no `attempt_end`, no `terminal_status`. The process is still alive at
   the time of bug filing (no `process exited` log line).

3. **No `cleanKill`** — the trace contains no listener-leak warnings, no `Code execution
   refused stop after 10 seconds` line, no checkpoint resume. Distinguishes this from
   BUG 12's failure shape.

4. **BUG 16 patch is in place** — verified by inspecting
   `node_modules/mineflayer/lib/plugins/digging.js:27–34` (the `_nextInputSequence`
   counter is present) and lines 148–155, 170–177, 202–208 (all three `block_dig` writes
   include `sequence: bot._nextInputSequence()`). Excludes BUG 16 as the cause of the
   "swings without breaking" symptom.

5. **Search-replanner pipeline** — `search_replanner.js:126–154` confirms `run_action`
   awaits `executeCommandWithModeRecovery` without a wallclock race. No per-action
   timeout exists on this path.

What is **not** in evidence and would be needed to lift this report from `Hypothesis` to
`Confirmed`:
- A per-tick pathfinder log showing repeated `resetPath('block_updated', false)` /
  `path_update` cycles without termination.
- The bot's live `entity.position.y` while hung — if it stays at `y=45` over time, §2b
  is the dominant mechanism (the bot is climbing but the place never lands); if it
  oscillates around a higher `y` (say `y=70`), §1 is dominant (the bot reached the
  surface column but `isEnd` never matches).
- A console log line, if any. The trace persists structured action results but the SPL
  logs (`spl.log`, `spl.warn`) flow to stdout and were not captured in the rollout
  directory.

A confirming reproduction would simply unblock the agent (e.g. `bot.pathfinder.stop()`
via REPL), record what `bot.entity.position.y` is at that moment, and re-run with verbose
pathfinder logging enabled.

---

## Relation to Other Bugs

- **BUG 12** (`unstuck` interrupt deadlock + cleanKill crashloop): same family — a
  long-running skill wedges with no cooperative cancellation. BUG 12 is harder
  (concurrent action stops collide with the wedge and yield `cleanKill`); BUG 17 is
  softer (no second action arrives, so the wedge merely persists indefinitely). The
  principled fix is shared (Fix D above). Apply Fix B in the meantime to cover this
  call site specifically.
- **BUG 13** (iron collection wedges after pickaxe break): noted because §3 here is the
  same `unstuck` identity-vs-position bug-shape as BUG 13's surrounding analysis,
  reached from a different workflow. Fix C closes the §3 gap shared between the two.
- **BUG 14** (pathfinder `canHarvest` aborts on snow): the BUG 14 fix's watchdog
  (`checkDigProgress`) is referenced in Hypothesis B (§2a). The hardness gate at
  `TRIVIAL_HARDNESS=0.5` correctly leaves stone in scope, but a transient
  heldItem/targetDigBlock race could in principle fire the abort during the equip
  window. Confidence is low because the abort would *resolve* the hang, not perpetuate
  it; included for completeness.
- **BUG 15** (unstuck/collectblocks livelock): different workflow (`!collectBlocks` not
  `!goToSurface`), but Fix B of BUG 15 (early-abort on `mode_interrupted` from inside
  the action) is structurally the same idea as Fix B here: bound the wait at the skill
  level rather than relying on outer layers.
- **BUG 16** (`block_dig` missing `sequence`): explicitly excluded as the cause. The
  patch is in place and the symptom ("swings without breaking") in BUG 17 has a
  different mechanism — pathfinder reset, not server rejection.
