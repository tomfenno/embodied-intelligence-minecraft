# BUG 20 — Raised `bot.pathfinder.thinkTimeout` (5000 → 15000 ms) Amplifies Pathfinder Wander and the `unstuck`-Interrupt Wedge During `!searchForBlock`

**Severity:** High (the bot wanders the same small cave for minutes during `!searchForBlock`
without surfacing a pathfinding failure; eventually `mode:unstuck` interrupts, the action
fails to yield, the achievement-agent process is killed by the harness, and the SPL is
forced into a checkpoint-resume loop — net effect is many wall-clock minutes lost per
search call and recurring crash/restart cycles)
**Status:** Fixed — applied on branch `search-agent` (Fix A only; Fix B and Fix C
remain deferred). The diagnostic confidence is still **Hypothesis**: the revert is the
cheap, reversible action that matches the user's instinct and removes the amplification,
but the dominant mechanism (pre-flight burn vs reactive-replan cascade) was not isolated
from a per-tick pathfinder log. If the wander symptom persists on the next rollout, see
§"What is not in evidence" — instrumented A/B is the next step, not a re-raise of
`thinkTimeout`.
**Branch:** `search-agent`
**Patch location:** `src/utils/mcdata.js:67–69` — the `bot.once('inject_allowed', …)`
block that assigned `bot.pathfinder.thinkTimeout = 15000` is removed; the pathfinder's
library-default `thinkTimeout = 5000` (`node_modules/mineflayer-pathfinder/index.js:40`)
is now in effect again. `goToGoal`'s two pre-flight `getPathTo` calls
(`src/agent/library/skills.js:1127, 1131`) still pass `pathfind_timeout=15000`
explicitly, so the long-distance pre-flight budget the original patch intended to give
to search/failure replanners is preserved.
**Trace:** none captured (the rollout that prompted this report was observed live in
stdout; the structured trace under `achievement_hunter/rollouts/` does not include
pathfinder per-tick state). User-supplied stdout excerpt is reproduced verbatim under
§Evidence.
**Related files:**
- `src/utils/mcdata.js:67–69` (post-revert: plain `loadPlugin(pathfinder)` + immediate
  `loadPlugin(pvp)`; no `inject_allowed` listener, no `thinkTimeout` override)
- `src/agent/library/skills.js:1098–1150` (`goToGoal` — two pre-flight `getPathTo` calls
  at `pathfind_timeout=15000`, then `bot.pathfinder.goto(goal)` which inherits
  `thinkTimeout`)
- `src/agent/library/skills.js:1218–1275` (`goToPosition`)
- `src/agent/library/skills.js:1277–1312` (`goToNearestBlock` — the entry point
  `!searchForBlock` calls)
- `src/agent/commands/actions.js:127–141` (`!searchForBlock` command wiring)
- `node_modules/mineflayer-pathfinder/index.js:38–107` (default `thinkTimeout=5000`,
  `getPathTo`, `getPathFromTo` — where `thinkTimeout` is consumed by A*)
- `node_modules/mineflayer-pathfinder/lib/astar.js` (A* `compute` loop — terminates when
  goal reached, frontier exhausted, or `timeout` elapsed)
- `achievement_hunter/src/pipeline/structured_loop/loop.js:48–80` (breadcrumb tracker
  start — the new periodic sampling that landed alongside the pathfinder regression
  window)

**Related bugs:**
- **BUG 12** — `unstuck`-interrupt deadlock + `cleanKill`-and-resume cycle. The stdout
  excerpt in §Evidence is the BUG 12 failure shape exactly (34× `waiting for code to
  finish executing...` after `mode:unstuck` tries to interrupt, then the agent exits with
  code 1 and the checkpoint resumes mid-task). This bug does **not** propose a fix to BUG
  12; instead it argues the raised `thinkTimeout` makes BUG 12 fire much more often by
  lengthening the window during which the search-skill is unyielding.
- **BUG 17** — `!goToSurface` tower-up livelock. BUG 17 already documents that `gotoUtil`
  has no wallclock budget independent of `thinkTimeout`, and that each `path_update` with
  `status: 'timeout'` is the only way A*-side timeouts can terminate a wedged
  `goto`. Tripling `thinkTimeout` triples the time-to-failure for that termination path.
- **BUG 18 / BUG 19** — `setBlockStateId`-driven `blockUpdate` cascade triggers `resetPath`
  inside `monitorMovement`. Each reset starts a fresh A* round; a longer `thinkTimeout`
  proportionally lengthens each round. This is the most likely interaction surface but is
  not load-bearing on its own (BUG 18/19 fire only when the bot is placing or
  dig-cycling, which `!searchForBlock` does only opportunistically).

---

## Symptom

User-facing description (verbatim):

> The agent has been struggling with pathfinding recently. It gets stuck and will walk
> around the same area constantly. I believe this has to do with the recent patches to
> pathfinding since before the breadcrumbs was added pathfinding was alright. My main
> hypothesis is that it has to do with having to much time to try and find a
> non-destructable path.

Observable behaviour:

| Signal | Observation |
|---|---|
| Skill in flight | `!searchForBlock("coal_ore", 32)` (inside an SPL `search_sweep` task) |
| Bot motion | Walks in a small cave for "a couple minutes" in roughly the same area — not visibly making progress toward coal_ore; not stopped either |
| Pathfinder failure events | None surface in the stdout excerpt — no `NoPath`, no `Timeout`, no `Path not found` log line during the wander |
| Eventual termination | `mode:unstuck` tries to interrupt `action:searchForBlock`. The action does not yield; 34× `waiting for code to finish executing...` accumulate; achievement-agent exits with code 1; harness restarts; SPL resumes from checkpoint with `consecutive_failures` bumped |
| Frequency | Repeating on every iron→coal transition in the diamond-pickaxe run; observed multiple times in the 2026-05-12 test rollouts |

This is **not** BUG 17 (the bot is moving horizontally, not towering up under a stone
ceiling). It is **not** BUG 16 (no "swings without breaking"). It is the failure mode
described under §Root Cause of BUG 12 amplified by the `thinkTimeout` change.

---

## Pre-regression baseline

Before commit `51805c0`:

- `bot.pathfinder.thinkTimeout` was the library default of `5000` ms
  (`node_modules/mineflayer-pathfinder/index.js:40`).
- `goToGoal`'s pre-flight `getPathTo` calls already used `15000` ms each
  (`src/agent/library/skills.js:1117–1126`, in place since before the breadcrumb work).
- `bot.pathfinder.goto(goal)` consumed the library default — so per A* round inside
  `monitorMovement`'s reactive replans, the budget was 5 s.

After commit `51805c0` (Mon May 11 22:17:04 2026 -0600):

```js
// src/utils/mcdata.js:67–83
const bot = createBot(options);
bot.loadPlugin(pathfinder);
// Start of AH code
// Raise pathfinder's per-goto A* budget from the library default of 5000ms.
// …
bot.once('inject_allowed', () => {
    bot.pathfinder.thinkTimeout = 15000;
});
// End of AH code
```

- `thinkTimeout = 15000` is now read by **every** A* round, including the per-tick
  replans triggered by `path_reset` events inside `monitorMovement`.
- `goToGoal`'s pre-flight already-at-15000 calls are unchanged.

The patch's stated intent — "long-distance targets emitted by search_replanner /
failure_replanner regularly exceed 5s of planning and trigger 'Took to long to decide
path to goal!'" — is reasonable in isolation. The unintended consequence is that
**every** A* round, including the short reactive replans triggered by `blockUpdate` and
`path_reset`, now consumes up to 15 s before declaring `timeout`.

---

## Root Cause (hypothesis)

The user's hypothesis can be sharpened into three independently-amplifying mechanisms.
None of them is novel; all of them are existing failure paths whose magnitude scales
with `thinkTimeout`.

### §1. `goToGoal` already burns 30 s of pre-flight planning per call — `goto`'s own A* now adds up to 15 s on top of that

`src/agent/library/skills.js:1098–1149`:

```js
export async function goToGoal(bot, goal) {
    const nonDestructiveMovements = new pf.Movements(bot);
    /* … */
    nonDestructiveMovements.placeCost = 2;
    nonDestructiveMovements.digCost = 10;

    const destructiveMovements = new pf.Movements(bot);

    let final_movements = destructiveMovements;

    // Start of AH code
    const pathfind_timeout = 15000;
    // End of AH code
    if (await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout).status === 'success') {
        final_movements = nonDestructiveMovements;
        log(bot, `Found non-destructive path.`);
    }
    else if (await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout).status === 'success') {
        log(bot, `Found destructive path.`);
    }
    else {
        log(bot, `Path not found, but attempting to navigate anyway using destructive movements.`);
    }
    /* … */
    bot.pathfinder.setMovements(final_movements);
    try {
        await bot.pathfinder.goto(goal);
        /* … */
    }
```

The pre-flight sequence is:

1. Try `nonDestructiveMovements` (which is **not** strictly non-destructive — it sets
   `digCost=10`, so paths through breakable blocks are 10× the base cost rather than
   forbidden). A* runs for up to 15 s. On a coal_ore target inside a partially-explored
   cave, the search frontier expands until either a `digCost≤low` path is found or the
   budget is exhausted.
2. If `noPath` / `timeout`, fall through to `destructiveMovements` with the same 15 s
   budget.
3. Then `bot.pathfinder.goto(goal)` is called, which internally calls `getPathTo`
   **again** under the same movement profile, with **`thinkTimeout`** as its budget — now
   15 s where it used to be 5 s.

User's instinct ("too much time to try and find a non-destructable path") maps directly
to step 1: with `digCost=10` and a 15 s budget, A* exhausts a much larger frontier
searching for a low-cost detour than it did under the historical 5 s budget. For a
coal_ore target across a wall of stone, the non-destructive frontier is the *entire*
explorable air-and-already-broken volume — potentially hundreds of nodes — before A*
gives up and falls back to step 2.

This is a static property of the call: it does not depend on the cave geometry to
explain why each `!searchForBlock` invocation now spends much longer in planning.

### §2. `monitorMovement`'s reactive replans now run on a 15 s budget per round

Inside `node_modules/mineflayer-pathfinder/index.js` the executor calls `resetPath`
whenever a `blockUpdate` event near the path fires, or whenever a dig/place handler's
`catch` runs. Each `resetPath` clears `astarContext`, and the next tick's `monitorTick`
recomputes the path by allocating a new A* with `thinkTimeout` (now 15000).

In a cave where the bot is **wandering past blocks the breadcrumb sampler is also
touching** (see §3 for the suspected interaction), each `blockUpdate` triggers
`resetPath('block_updated', false)`. The new A* round can take up to 15 s instead of 5 s
to either succeed or return `timeout`. During that 15 s the bot keeps moving along the
*previous* partial path until exhaustion, then waits for the new path. From the outside
this manifests as the bot walking ten blocks one way, pausing, then walking back —
exactly the "walk around the same area constantly" symptom.

The same reset-cascade is BUG 19's primary mechanism; BUG 19 documents the static
analysis end-to-end. The novel observation here is that the *magnitude* of the cascade —
how long each round of "compute → reset → compute" takes — has tripled.

### §3. Suspected interaction with the breadcrumb sampler — unverified

`achievement_hunter/src/pipeline/structured_loop/breadcrumbs.js:62–67`:

```js
start() {
    if (this._interval_handle != null) return;
    this._interval_handle =
        setInterval(() => this._sample(), this._period_ms);
    /* … */
}
```

`_sample` reads `getNearestBlocks(bot)` and `getNearbyEntities(bot)` on every tick of
`BREADCRUMB_PERIOD_MS`. By itself, sampling does not place or break blocks — so it
should not emit `blockUpdate`s and should not trigger `resetPath`. However, the
breadcrumb work and the `thinkTimeout` raise landed in the same window (commits
`bd28342` and `7592a6e` for breadcrumbs, `51805c0` for `thinkTimeout`), and the user
explicitly tags the regression to "since before the breadcrumbs was added pathfinding
was alright". Three plausible explanations:

1. **Coincidence** — the breadcrumb work is innocent; only `thinkTimeout` matters. §1
   and §2 fully explain the symptom on their own.
2. **Indirect contention** — breadcrumb sampling holds CPU during `_sample` long enough
   to delay `monitorTick`. With a 15 s A* budget, a tick lost to GC or to a synchronous
   `getNearestBlocks` doesn't matter; with a 5 s budget the bot would have already
   timed out and recovered.
3. **Unrelated regression** — some other change in the breadcrumb window (e.g. the
   checkpoint-resume cycle inflating `consecutive_failures`, or the search_replanner
   feeding broader coordinates) shifts which targets `!searchForBlock` is being aimed at.

The first explanation is the simplest and is consistent with the stdout. The third
deserves its own investigation but is out of scope for this report — it would not be
reverted by reverting the `thinkTimeout` raise.

### §4. The wedge that ends each wander is BUG 12, not a new bug

The stdout excerpt (Evidence §1) shows the canonical BUG 12 failure shape:

```
mindcraft-1  | action "mode:unstuck" trying to interrupt current action "action:searchForBlock"
mindcraft-1  | waiting for code to finish executing...
mindcraft-1  | waiting for code to finish executing...
…  (34 repetitions)
mindcraft-1  | Achievement agent process exited with code 1 and signal null
mindcraft-1  | Restarting achievement agent...
```

`ActionManager.stop()` polls `executing` every 300 ms (per BUG 12 §Root Cause) and after
`10 s` of `executing === true` calls `cleanKill` which exits the process. Each
"waiting for code to finish executing..." line corresponds to a poll; 34 lines × 300 ms
≈ 10.2 s — consistent with the 10 s `cleanKill` budget exactly.

This bug does **not** propose a new fix to BUG 12. It documents the link: by tripling
the time each `getPathTo` / `goto` round takes, the raised `thinkTimeout` keeps
`searchForBlock` in its unyielding `await` for proportionally longer, which makes BUG
12's wedge fire much more often. Before the raise, a typical `!searchForBlock` call
would complete (or fail-fast) inside a single 30–60 s window; after the raise, it can
sit in pre-flight + reactive-replans for several minutes. `mode:unstuck` then has many
more opportunities to fire mid-call.

### §Proximate vs root cause

- **Proximate cause:** the wandering is the natural externally-visible shape of a
  long-running `goto` with frequent `resetPath`s — bot walks the partial path while
  the next A* round computes, then reverses when the new path differs, then reverses
  again.
- **Root cause:** raising `thinkTimeout` from 5000 to 15000 enlarged the time window of
  every A* round (pre-flight in `goToGoal` was already 15 s and unchanged, but
  `goto`-internal rounds tripled). Combined with `monitorMovement`'s aggressive
  `resetPath` policy (BUG 18 / BUG 19) and `executeCommandWithModeRecovery`'s lack of
  cooperative cancellation (BUG 12), the search-skill becomes both visibly slower and
  much more likely to be killed by `cleanKill` mid-call.

The change in `src/utils/mcdata.js:67–83` was correct in spirit (the 5 s default is too
tight for the long-distance targets the search-replanner emits at radius 256+); the
problem is that the same constant governs short-distance reactive replans where 5 s was
already plenty. A single global value is the wrong knob for two very different
workloads.

---

## Why existing safeguards didn't catch this

| Safeguard | Why it didn't fire / prevent |
|---|---|
| `monitorMovement` `timeout` branch in A* | It *does* fire — but only after the full `thinkTimeout` elapses. Tripling that constant tripled the time-to-fire. |
| `goToGoal` pre-flight `getPathTo` fallback (`nonDestructive` → `destructive` → "try anyway") | Already gated on 15 s × 2 = 30 s of pre-flight; the recent `thinkTimeout` change did not affect this layer (still 15 s each). The pre-flight latency has been there all along, but it was masked by the much tighter `goto`-internal budget. |
| `ActionManager.stop()` 10 s `cleanKill` (BUG 12) | Fires correctly — it is what produces the visible 34× `waiting for code to finish executing...` and the process exit. But it is a process-kill, not a recovery; the SPL has to resume from checkpoint. |
| `mode:unstuck` 20 s + 10 s `cleanKill` | Fires, but it is the source of the interrupt that BUG 12 traps. By the time `unstuck` decides to interrupt, the bot has already been wedged for ≥20 s — half of that is `thinkTimeout`-driven wait. |
| `search_replanner` `MAX_SEARCH_REPLANNER_ATTEMPTS` (recently raised from 3 to 10) | Counts replanner invocations, not individual skill calls. The same `!searchForBlock` can wedge for minutes before a single replanner attempt completes. |
| `failure_replanner` D11 pathfinding-fall-through | Triggers only on a *returned* failure classified as pathfinding. The wander does not return; the wedge does, but via `cleanKill` (which is interpreted as a crash, not a recovery hand-off). |

No existing safeguard separates "A* budget for long pre-flight planning" from "A* budget
for short reactive replans inside an already-active `goto`". The patch in commit
`51805c0` set both to 15 s with a single line.

---

## Proposed Fix

Two complementary fixes. The first reverts the global change and replaces it with the
finer-grained one the patch's comment block actually wanted. The second adds a wallclock
budget to `!searchForBlock` so it cannot wedge indefinitely regardless of `thinkTimeout`.

### Fix A — Restore the library-default `thinkTimeout` and instead pass `timeout` only on the long-distance pre-flights

Revert `src/utils/mcdata.js:67–83` to the upstream-clean form (drop the `inject_allowed`
listener). Per `node_modules/mineflayer-pathfinder/index.js:64–73`:

```js
bot.pathfinder.getPathTo = (movements, goal, timeout) => {
    /* … */
    const generator = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout })
    /* … */
}
```

`getPathTo` already accepts a per-call `timeout`. `goToGoal`'s two pre-flight calls
already pass `15000` explicitly (`skills.js:1127, 1131`), so reverting `thinkTimeout` to
`5000` does **not** affect them. What changes is only the budget for A* rounds inside
`bot.pathfinder.goto(goal)` and inside `monitorMovement`'s reactive replans, which
return to the upstream default.

```js
// src/utils/mcdata.js  (proposed revert)
const bot = createBot(options);
bot.loadPlugin(pathfinder);
// (delete the bot.once('inject_allowed', …) block)
bot.loadPlugin(pvp);
/* … */
```

**Soundness:** the comment on the original patch claims the raise is needed to avoid
"Took to long to decide path to goal!" for radius-256+ targets. That message is emitted
by A* inside `getPathTo`. The two `getPathTo` calls in `goToGoal` already use a 15 s
budget — so the long-distance complaint does **not** depend on `thinkTimeout`. The only
caller that would regress is `bot.pathfinder.goto(goal)`'s internal A*, which runs
*after* a successful pre-flight, on a path the pre-flight already verified — so a 5 s
budget should be ample.

**Limitations:** if some skill call site bypasses `goToGoal` and reaches
`bot.pathfinder.goto` directly, that call site will inherit the 5 s default again. Audit
required:

```
grep -nR "bot.pathfinder.goto\|pathfinder.goto" src/agent
```

The audit's results should drive whether any specific call site needs an explicit
`pathfind_timeout` parameter raised at that site.

### Fix B — Wallclock budget on `goToNearestBlock` (and therefore `!searchForBlock`)

Independent of Fix A — bounds the symptom at the skill level so a runaway pre-flight or
a reset cascade cannot keep `searchForBlock` in flight for minutes.

`src/agent/library/skills.js:1277–1312` (annotation marker required since the file is
outside `achievement_hunter/`):

```js
// Start of AH code
const GO_TO_NEAREST_BLOCK_TIMEOUT_MS = 60_000;  // 60s — comfortable for radius-32 paths
// End of AH code

export async function goToNearestBlock(bot, blockType, min_distance=2, range=64) {
    /* … existing argument validation, range clamp, getNearestBlock … */
    if (!block) {
        log(bot, `Could not find any ${blockType} in ${range} blocks.`);
        return false;
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    // Start of AH code
    const ok = await Promise.race([
        goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance),
        new Promise(resolve => setTimeout(() => {
            log(bot, `goToNearestBlock watchdog: ${GO_TO_NEAREST_BLOCK_TIMEOUT_MS}ms elapsed, aborting.`);
            bot.pathfinder.stop();
            resolve(false);
        }, GO_TO_NEAREST_BLOCK_TIMEOUT_MS)),
    ]);
    return ok;
    // End of AH code
}
```

**Soundness:** `bot.pathfinder.stop()` from the watchdog fires `path_stop` → `gotoUtil`
rejects with `PathStopped` → `goToPosition`'s `catch` clears its `checkDigProgress`
interval and re-throws / returns `false`. The outer `Promise.race` resolves to `false`.
`searchForBlock`'s callers (search-replanner / search.js) see the falsy result and
proceed to the next candidate.

**Choice of 60 s:** at `radius=32` (the smallest legal value per
`actions.js:135–137`) a healthy walk to coal_ore takes <30 s in the worst observed
case. 60 s gives 2× headroom. For larger ranges (the action accepts up to 512), the
constant may need to scale: `timeout = max(60_000, range * 1000)`.

**Limitations:** bounds the damage but does not eliminate the underlying wander. The
bot will still walk back and forth for up to 60 s per call. Fix A is the actual
remediation; Fix B is the safety net.

### Fix C — (Deferred) Audit `digCost=10` in `goToGoal` against the breadcrumb work

The `goToGoal` non-destructive movement profile sets `digCost=10` (`skills.js:1111`).
This is a *cost weight* and **not** a forbidden-block list. With a 15 s budget A* will
explore a huge frontier for a 10-cost detour before falling back. If §1 turns out to
dominate empirically, an alternative is to reduce `digCost` (to e.g. `4`) so A* gives
up the search for a clean detour sooner. **Do not apply this without measuring** — it
trades pre-flight latency for more aggressive block-breaking, which has its own failure
modes (BUG 5 lineage).

---

## Evidence

### §1. User-supplied stdout excerpt (verbatim)

The wander into the BUG-12-shape wedge into the checkpoint resume, exactly as captured
in the docker logs (`mindcraft-1` container):

```
mindcraft-1  | [SPL] Command result: { success: true, message: 'Action output:\nCollected 3 iron_ore.\n' }
mindcraft-1  | [SPL] Next task: {"target_item":"coal","action_type":"search_sweep","parameters":{"targets":[{"target_item":"coal","source":"coal_ore","kind":"block","qty":1}]}}
mindcraft-1  | [SPL] Search sweep starting: targets=[coal_ore]
mindcraft-1  | [SPL] Sweep starting: sources=[coal_ore]
mindcraft-1  | [SPL] Search (coal_ore r=32): !searchForBlock("coal_ore", 32)
mindcraft-1  | parsed command: { commandName: '!searchForBlock', args: [ 'coal_ore', 32 ] }
mindcraft-1  | executing code...
mindcraft-1  |
mindcraft-1  | executing code...
mindcraft-1  |
mindcraft-1  | action "mode:unstuck" trying to interrupt current action "action:searchForBlock"
mindcraft-1  | waiting for code to finish executing...
mindcraft-1  | waiting for code to finish executing...
…  (32 more "waiting for code to finish executing..." lines)
mindcraft-1  | Saved memory to: ./bots/AH_Bot/memory.json
mindcraft-1  | Agent AH_Bot disconnected
mindcraft-1  | Achievement agent process exited with code 1 and signal null
mindcraft-1  | Restarting achievement agent...
…
mindcraft-1  | [SPL] Checkpoint found - resuming: Test (saved at 2026-05-12T16:13:29.462Z)
mindcraft-1  | [SPL] Restored 3 breadcrumbs from checkpoint.
mindcraft-1  | [SPL][breadcrumbs] Started (min_dist=24, recent=16, landmark=48).
mindcraft-1  | [SPL] Detected mid-task crash (active_task=search_sweep::coal). consecutive_failures bumped to 1.
mindcraft-1  | [SPL] Next task: {"target_item":"coal","qty":1,"action_type":"collect","parameters":{"source_block":"coal_ore","item_dependency":null,"tool":"wooden_pickaxe"}}
mindcraft-1  | [SPL] Action (attempt 1/5): !collectBlocks("coal_ore", 1)
```

Two load-bearing observations:

1. **Between `executing code...` and `mode:unstuck trying to interrupt`, no pathfinder
   log line is emitted** — no `Found non-destructive path.`, no `Found destructive
   path.`, no `Path not found, but attempting to navigate anyway.`. The
   `!searchForBlock` is still inside `goToGoal`'s pre-flight `getPathTo` or inside the
   first reactive `goto` round when `unstuck` interrupts. With the historical 5 s
   `thinkTimeout`, the first reactive round would have already returned (success or
   timeout) by the time `unstuck`'s 20 s threshold fires. With 15 s, the first
   reactive round is still mid-A* at the 20 s mark.
2. **The 34× `waiting for code to finish executing...` is the BUG 12 fingerprint.**
   The achievement-agent process is killed by the harness after `10 s` of unyielding
   poll (300 ms × 34 ≈ 10.2 s), matching `cleanKill`'s budget exactly.

### §2. Static code evidence

- `src/utils/mcdata.js:67–83` — the `thinkTimeout = 15000` assignment, gated on
  `inject_allowed` so it runs after the pathfinder plugin attaches.
- `node_modules/mineflayer-pathfinder/index.js:40` — library default
  `bot.pathfinder.thinkTimeout = 5000`.
- `node_modules/mineflayer-pathfinder/index.js:64–107` — A* receives the timeout via
  `getPathTo` / `getPathFromTo` and passes it to `new AStar(start, movements, goal,
  timeout, …)`. Inside `astar.js` the timeout is the wall-clock bound on `compute`.
- `src/agent/library/skills.js:1117–1126` — `goToGoal`'s `pathfind_timeout = 15000`,
  which is independent of `thinkTimeout` because both `getPathTo` calls pass it
  explicitly.
- `src/agent/library/skills.js:1141–1149` — `bot.pathfinder.goto(goal)`, which does
  not accept a timeout argument and therefore reads `bot.pathfinder.thinkTimeout`
  through `getPathFromTo`'s default.

### §3. Git evidence the regression is timing-correlated with the breadcrumb era

```
51805c0 Incerased time for pathfinding.            ← the thinkTimeout raise
cea76fd Updated checkpoint system to keep loop integridty through crashes.
3e1a3f7 Capped search radius to 256 to avoid crashing
a393254 Added a command verifier to bypass parsing success messages.
553f5fd Fixed false negative search result issue with BFS
ee89267 Improved searching functions to use BFS on multiple targets.
9db30dd Implimented search agent
7592a6e Implemented logger to breadcrumbs and added breadcrumbs to checkpoint
bd28342 Started on search agent. Made breadcrumb functions for location map
```

The breadcrumb work begins at `bd28342`; the `thinkTimeout` raise lands at `51805c0`,
**after** the breadcrumb work. The user's mental model ("since before the breadcrumbs
was added pathfinding was alright") points at the whole era, but the only
pathfinder-policy change in the era is `51805c0`. §3 of Root Cause notes that the
breadcrumb sampler itself is not believed to be load-bearing.

### What is **not** in evidence (would need to confirm this report)

- A per-tick pathfinder log capturing actual `path_update` events with `status` and
  `path.length` during the wander. Adding `bot.on('path_update', e => spl.log(...))`
  and `bot.on('path_reset', r => spl.log(...))` instrumentation in `loop.js` for one
  rollout would resolve §1 vs §2 dominance.
- A measurement of the bot's `entity.position` over the wander interval — is it
  oscillating within 5 blocks (consistent with §2 reset cascade) or making slow
  forward progress (consistent with §1 pre-flight burn while the bot follows a stale
  partial path)?
- A side-by-side A/B with `thinkTimeout=5000` (reverted) vs `15000` (current) on the
  same checkpoint. If reverting eliminates the wander while preserving radius-256+
  search behaviour, Fix A is sufficient. If the wander persists at 5000, the
  breadcrumb interaction (§3) deserves a real investigation.

---

## Relation to Other Bugs

- **BUG 12** (`unstuck`-interrupt deadlock + `cleanKill` crashloop): the wedge that
  ends each wander **is** BUG 12. This report does not re-propose BUG 12's fixes; it
  documents that the raised `thinkTimeout` makes BUG 12's symptoms much more frequent
  by extending the unyielding window. Apply BUG 12's `AbortSignal` plumbing (Fix C+D)
  to eliminate the wedge regardless of `thinkTimeout`. Apply Fix A here to eliminate
  the *amplification* of the wedge specifically during search.
- **BUG 17** (`!goToSurface` tower-up livelock): same family — no wallclock budget on
  the skill call. BUG 17's Fix B (a `Promise.race`-based watchdog at the skill level)
  is structurally identical to Fix B here, applied to `goToNearestBlock` instead of
  `goToSurface`. Both should be applied; both would be made redundant by BUG 12's
  Fix D.
- **BUG 18 / BUG 19** (`setBlockStateId` / `resetPath` cascade): §2 here observes that
  each reset round now runs A* for up to 15 s instead of 5 s. **Do not pre-emptively
  re-attempt the BUG 18 patches in response to this report** — the priority order in
  `unpatched/README.md` is clear: BUG 18 needs instrumented A/B measurement before
  any further attempt. The `thinkTimeout` revert (Fix A) is independent of that
  measurement and is the recommended near-term action.
- **BUG 5** (lava-death pathfinder escape failure): Fix C above (lowering `digCost`)
  would interact with BUG 5's lineage — more aggressive block-breaking in pathfinder
  has known cost. This is why Fix C is deferred and gated on measurement.
