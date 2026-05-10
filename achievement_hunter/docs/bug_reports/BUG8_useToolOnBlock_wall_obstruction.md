# BUG 8 — `useToolOnBlock` Wall Obstruction: Random Recovery Unreachable in Cave Geometry

## Status

**Fixed** — `src/agent/library/skills.js:2084–2102` (`// Start of AH code` / `// End of AH code`)

## Severity

Medium — task blocks without crashing; triggers `failure_replanner` with repeated `!useOn` failures.

## Observed Symptom

Bot navigates to lava, finds it nearby, but every `!useOn("bucket", "lava")` call returns failure
with an empty message. The `failure_replanner` then repeatedly retries `!searchForBlock` +
`!useOn` with the same result.

From rollout trace `2026-04-28T01-15-17-544Z_test`:

```
AM attempt 2: !useOn("bucket", "lava")   → failure (empty message)
AM attempt 3: !useOn("bucket", "lava")   → failure
AM attempt 4: !useOn("bucket", "lava")   → failure
AM attempt 5: !useOn("bucket", "lava")   → failure

RECOVERY attempt 1: !searchForBlock("lava", 64) → success, navigated to (-479, -38, -1764)
                    !equip("bucket")             → success
                    !useOn("bucket", "lava")     → failure (×3)

RECOVERY attempt 2: !goToCoordinates(-479, -38, -1764, 1) → failure (×3)
```

## Root Cause

**File:** `src/agent/library/skills.js:2062–2111` — `useToolOnBlock`

The function first navigates to within 2 blocks of the target (`distance = 2` for bucket+lava),
then ray-casts to check if view is blocked (`viewBlocked()`). When view is blocked, the original
code ran a single random-position recovery attempt:

```js
// Original lines 2084–2094 (replaced):
const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
if (viewBlocked()) {
    const blockInView = bot.blockAtCursor(5);
    log(bot, `Block ${blockInView.name} is in the way, not using ${toolName}.`);
    return false;
}
```

`nearbyPos` is offset ±1 block (random) from the lava block in X and Z, placing it 0–1.4 blocks
from lava. `goToPosition(..., 1)` then tries to reach within 1 block of `nearbyPos`. This
requires the bot to be essentially **at the lava block itself**, which the pathfinder treats as
impassable (infinite cost). Navigation fails, `viewBlocked()` remains true, the function returns
`false`.

The deeper issue is that the random recovery is a bandaid — it tries to find a luckier angle
rather than actually removing the obstruction.

**This is proven directly in the trace:** `!goToCoordinates(-479, -38, -1764, 1)` (tolerance=1,
at the lava block's exact coordinates) failed three consecutive times — pathfinder cannot reach
within 1 block of the lava because lava is impassable.

This is a pre-existing limitation in `useToolOnBlock`, **not** introduced by any patch on this
branch. It manifests consistently in deep cave geometry where lava is only accessible from a
2-block standoff through a single opening.

## Fix

Replace the random angle-hunting recovery with a dig-through approach. `useOn` is only attempted
when one of two conditions holds:

- **A — view is clear:** no block obstructs the ray from the bot's eyes to the target
- **B — bot is above the lava:** feet Y ≥ lava block top (Y+1); looking straight down into a
  lava pool is always valid for bucket fill

If neither condition holds (view is blocked and bot is not above), the bot digs the blocking block
to clear the path, then re-checks. `bot.canDigBlock()` guards against indestructible blocks
(bedrock, etc.) before attempting `bot.dig()`.

**File:** `src/agent/library/skills.js` — annotated block `// Start of AH code` / `// End of AH code`

```js
// Start of AH code
const isAbove = () => bot.entity.position.y >= block.position.y + 1;

if (viewBlocked() && !isAbove()) {
    const blockingBlock = bot.blockAtCursor(5);
    if (!blockingBlock || !bot.canDigBlock(blockingBlock)) {
        log(bot, `Block ${blockingBlock?.name ?? 'unknown'} is in the way and cannot be broken, not using ${toolName}.`);
        return false;
    }
    log(bot, `Breaking ${blockingBlock.name} to reach ${block.name}...`);
    await bot.dig(blockingBlock);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
    if (viewBlocked() && !isAbove()) {
        const stillBlocking = bot.blockAtCursor(5);
        log(bot, `Block ${stillBlocking?.name ?? 'unknown'} is still in the way, not using ${toolName}.`);
        return false;
    }
}
// End of AH code
```

### Annotation convention

AH patches to files **outside** `achievement_hunter/` are wrapped in `// Start of AH code` /
`// End of AH code` comments. Files inside `achievement_hunter/` are entirely AH code and do not
use this marker. The annotation exists so patches to upstream Mindcraft files can be located and
re-applied after an upstream merge.

### Why this is better than the cardinal-sweep alternative

The cardinal sweep (4 directions at distance 2, stop at first clear sightline) was the initial
proposed fix but is still a bandaid — it finds a better angle rather than resolving the
obstruction. Digging is the correct fix: if a wall blocks the path to lava, remove the wall.

| | Original | Cardinal sweep | Dig-through (applied) |
|---|---|---|---|
| Recovery strategy | Random angle | Systematic angles | Remove the obstacle |
| Requires navigating into lava | Yes | No | No |
| Resolves root obstruction | No | No | Yes |
| Handles indestructible blocks | N/A | N/A | `canDigBlock()` guard |
| After mining releases lava flow | N/A | N/A | `viewBlocked()` re-check catches it |

### Risk

Upstream change to Mindcraft base code. Any merge from upstream may conflict. The annotation
markers (`// Start of AH code` / `// End of AH code`) make the AH-specific block easy to
identify and re-apply after an upstream merge.

## Evidence

From rollout `2026-04-28T01-15-17-544Z_test` (full trace in
`achievement_hunter/rollouts/2026-04-28T01-15-17-544Z_test/rollout_trace.json`):

- AM attempt 2–5: lava visible in `nearby_blocks`, `!useOn` returns empty failure → `viewBlocked()` triggered
- Recovery attempt 1, action 2: `!searchForBlock("lava", 64)` navigated to (-479, -38, -1764) but pathfinding used destructive mode — bot did not reach a clear standoff position
- Recovery attempt 2, action 0: `!goToCoordinates(-479, -38, -1764, 1)` failed ×3 — direct confirmation that GoalNear=1 at the lava block is unreachable

## Not a Regression

This bug exists in Mindcraft upstream. It is not related to:
- BUG 5 Fix B (sneak guard) — sneak is irrelevant when `useToolOnBlock` returns false before `activateItem`
- BUG 7 (flowing liquid filter) — in this trace the lava was a source block (metadata=0), confirmed reachable by `!searchForBlock`
