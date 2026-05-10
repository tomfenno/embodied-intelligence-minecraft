# BUG 14 — Pathfinder Aborts on `snow_block` Because `canHarvest` Conflates "Will Drop Items" with "Can Be Broken"

## Status

**Severity:** Medium — pathfinding silently fails any time the route requires breaking a `snow_block` (or any other shovel-preferred / pickaxe-preferred block) without the matching tool, even when the block is fully breakable bare-handed. Snow biomes and the surface near snow-capped terrain become effectively impassable until the bot crafts a shovel.

**Status:** Fixed — applied on branch `snow-pathfinding-bug-patch`

**Branch:** `snow-pathfinding-bug-patch`

**Patch location:** `src/agent/library/skills.js:1232–1245` (`// Start of AH code` / `// End of AH code`) — Fix B applied.

**Trace:** _not supplied with this report_

**Related files:**
- `src/agent/library/skills.js:1232–1245` (`checkDigProgress` inside `goToPosition`)
- `node_modules/prismarine-block/index.js:298–301` (`canHarvest` definition)
- `node_modules/minecraft-data/minecraft-data/data/pc/1.21.6/blocks.json` (`snow_block` entry, `harvestTools`)

## Symptom

User-reported behaviour:

> When having to break a `snow_block` during path finding the agent fails and reports
> `"Cannot break snow_block with current tools."` This does not happen when the agent has any
> tier of shovel. This is wrong since the agent can break snow blocks with nothing, it just
> cannot collect snowballs without a shovel.

The log line is emitted verbatim from `skills.js:1237`:

```
Pathfinding stopped: Cannot break snow_block with current tools.
```

After this line, `bot.pathfinder.stop()` and `bot.stopDigging()` are called, the pending
`goToGoal` rejects, and `goToPosition` falls through its `catch` block:

```
Pathfinding stopped: <err.message>.
```

…returning `false`. Any caller that relies on `goToPosition` (and by extension
`goToCoordinates`, `goToNearestBlock`, `searchForBlock` follow-on navigation, `collectBlocks`
movement legs, etc.) sees a navigation failure with no recovery hint, even though the bot was
physically capable of clearing the obstruction.

The user observes that giving the bot **any tier of shovel** makes the symptom disappear. This
is consistent with the diagnosis below: the abort is gated on `targetBlock.canHarvest(itemId)`,
which returns `true` as soon as the held item is a wooden+ shovel and `false` otherwise.

## Root Cause

### The check, in full

`src/agent/library/skills.js:1232–1244`:

```js
const checkDigProgress = () => {
    if (bot.targetDigBlock) {
        const targetBlock = bot.targetDigBlock;
        const itemId = bot.heldItem ? bot.heldItem.type : null;
        if (!targetBlock.canHarvest(itemId)) {
            log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.`);
            bot.pathfinder.stop();
            bot.stopDigging();
        }
    }
};

const progressInterval = setInterval(checkDigProgress, 1000);
```

This runs once per second while `goToPosition` is awaiting `goToGoal`. Whenever the
pathfinder picks up a `targetDigBlock` (i.e. it has decided to dig through), the predicate
`!targetBlock.canHarvest(itemId)` aborts the entire navigation if the held item isn't in the
block's `harvestTools` table.

### What `canHarvest` actually returns

`node_modules/prismarine-block/index.js:298–301`:

```js
canHarvest (heldItemType) {
  if (!this.harvestTools) { return true }; // for blocks harvestable by hand
  return heldItemType && this.harvestTools && this.harvestTools[heldItemType]
}
```

Three regimes:

| `harvestTools` field | Held item in table | `canHarvest` returns |
|---|---|---|
| absent | n/a | `true` (any item, including bare hand) |
| present | yes | `true` |
| present | no / hand | `false` |

Critically, the second regime — `harvestTools` present — is set in `minecraft-data` for **any
block with a preferred tool**, regardless of whether vanilla Minecraft actually requires that
tool to break the block. The field encodes "tools that yield drops," not "tools required to
break."

### Snow block specifically

`node_modules/minecraft-data/minecraft-data/data/pc/1.21.6/blocks.json` (snow_block entry):

```json
{
  "name": "snow_block",
  "displayName": "Snow Block",
  "hardness": 0.2,
  "material": "mineable/shovel",
  "diggable": true,
  "harvestTools": {
    "876": true,  // wooden_shovel
    "881": true,  // stone_shovel
    "886": true,  // iron_shovel
    "891": true,  // diamond_shovel
    "896": true,  // golden_shovel
    "901": true   // netherite_shovel
  },
  "drops": [ 971 ]   // snowball
}
```

Vanilla Minecraft semantics for `snow_block`:

- `requires_correct_tool_for_drops` is **false** in the block tag set — a bare-hand player
  breaks it just fine, only the **drop** (snowballs, item id 971) is gated on a shovel.
- `hardness` is `0.2` → bare-hand dig time is well under one second; the pathfinder's dig
  attempt would succeed within a single `checkDigProgress` tick if the abort weren't fired.

`prismarine-block`'s `canHarvest` does not model `requires_correct_tool_for_drops`. It only
sees the `harvestTools` table, which is populated for snow_block, so it returns `false` for
any non-shovel held item. The abort fires, pathfinding stops, and the symptom surfaces.

### Proximate vs. root cause

- **Proximate cause:** `skills.js:1237` logs and aborts because `canHarvest(itemId)` returned
  `false`.
- **Root cause:** the `checkDigProgress` watchdog uses `canHarvest` as a proxy for "is this
  block breakable with the current tools," but `canHarvest` only answers "will this tool yield
  drops." For every block where Minecraft's "preferred tool" and "required tool" differ
  (snow_block being the canonical example), the proxy is wrong and the watchdog cancels
  navigation that would otherwise complete.

The same false abort fires for any other block whose `harvestTools` lists tools but whose
real-world `requires_correct_tool_for_drops` is `false`. Other plausible offenders include
`snow` (the layered version, also `mineable/shovel`, `hardness 0.1`), and historically other
"preferred tool" blocks where minecraft-data's harvestTools table is set even though the
vanilla block can break bare-handed.

## Why existing safeguards didn't catch this

- The check is a single guard inside `goToPosition`; there is no second-chance retry or
  alternative dig attempt. Once `bot.pathfinder.stop()` is invoked, the goal is cancelled
  cleanly and the surrounding `try` returns through the success path of `goToGoal`'s
  rejection — no failure-replanner-visible signal beyond the log line.
- `failure_replanner` sees the navigation failure as a generic `goToPosition` returning
  `false`. Without parsing the specific log substring `"Cannot break ... with current tools"`
  there's no way to distinguish "physically blocked by an indestructible block" (legitimate
  abort) from "the watchdog fired a false positive on snow."
- Mineflayer's pathfinder, left to its own devices, would have completed the dig — `digTime`
  for snow_block bare-handed is still short (hardness 0.2 × non-matching multiplier 5 ≈ 1
  second). The 1000ms `checkDigProgress` interval guarantees the abort fires before the dig
  even has a chance to finish.
- No upstream Mindcraft or AH layer catches the canHarvest miscategorisation; the
  watchdog itself is AH-local code (no `// Start of AH code` markers in this region but the
  block is not present in stock Mindcraft `goToPosition`).

## Proposed Fix

The watchdog's intent is to abort navigation when the bot is digging an actually
unbreakable block (e.g. obsidian bare-handed, bedrock at any time). `canHarvest` is the wrong
predicate. Two complementary fixes are appropriate:

### Fix A — Replace `canHarvest` with `bot.canDigBlock`

`bot.canDigBlock(block)` is the mineflayer-native check that answers exactly the watchdog's
question: "given the currently held item, can this block be dug at all?" It returns `false`
for `bedrock`, in-progress liquids the bot can't touch, and similar truly-undiggable cases —
and it returns `true` for `snow_block` bare-handed.

`src/agent/library/skills.js:1232–1244` becomes:

```js
// Start of AH code
const checkDigProgress = () => {
    if (bot.targetDigBlock) {
        const targetBlock = bot.targetDigBlock;
        if (!bot.canDigBlock(targetBlock)) {
            log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.`);
            bot.pathfinder.stop();
            bot.stopDigging();
        }
    }
};
// End of AH code
```

**Soundness:** `bot.canDigBlock` defers to the same dig-time machinery the pathfinder uses
internally to decide whether to dig at all. Aligning the watchdog with the pathfinder
prevents the watchdog from cancelling work the pathfinder considers feasible.

**Limitations:** `canDigBlock` does not bound dig duration. A bot bare-hand-digging stone or
obsidian (hardness 1.5 / 50) will not be aborted even though the dig will take many seconds
or minutes. If "no excessively slow digs" is also a desired property, it must be enforced
separately (see Fix B). For the reported bug — snow_block — this fix alone is sufficient.

### Fix B (recommended) — Gate the existing `canHarvest` abort on a `hardness` floor

Keep the existing `canHarvest` primitive (it correctly answers "would this drop without a
proper tool"), but only abort when the bare-hand dig is *also* expensive enough to be worth
aborting. Hardness is the right secondary signal because, when `canHarvest` is false, the
bare-hand dig multiplier is fixed (×5 vs the 1.5s base), so dig duration is purely a function
of hardness.

```js
// Start of AH code
const TRIVIAL_HARDNESS = 0.5;   // bare-hand dig completes in ≤ ~2.5 s
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
// End of AH code
```

#### Threshold rationale (`TRIVIAL_HARDNESS = 0.5`)

Empirical hardness distribution of 1.21.6 blocks where `harvestTools` is set (i.e. blocks
where `canHarvest` would return false bare-handed):

| Hardness | Blocks | Bare-hand dig |
|---|---|---|
| 0 | 15 dead coral variants | instant |
| 0.1 | `snow` | ~0.5 s |
| 0.2 | `snow_block` ← reported bug | ~1 s |
| 0.4 | `netherrack`, `crimson_nylium`, `warped_nylium` | ~2 s |
| 0.5 | `magma_block` | ~2.5 s |
| 0.75 | `calcite` | ~3.75 s |
| 0.8 | sandstone / quartz family (16 variants) | ~4 s |
| 1.5 | stone / deepslate family (~125 blocks) | ~7.5 s |
| 3.0 | iron_ore, etc. | ~15 s |

A threshold of **0.5** sits inside the wide gap between `magma_block` (0.5) and `calcite`
(0.75), and well below `stone` (1.5). It admits:

- The reported false-positive (`snow_block`) and its sibling (`snow`).
- Zero-cost dead corals (the watchdog firing on these is pure noise).
- Nether-floor blocks (`netherrack`, nylium, `magma_block`) which are 2–2.5 s bare-handed and
  are bare-hand-acceptable in vanilla.

…and continues to abort:

- Sandstone / quartz (0.8) — 4 s bare-handed.
- All stone-tier blocks (1.5) — 7.5 s.
- All ore-tier blocks (3.0+) — 15 s+.
- Obsidian (50.0) — minutes.

If sandstone-on-route ever surfaces as a residual false-positive, bumping the threshold to
`0.8` (above sandstone) or `1.0` is a one-character change. Going below `0.5` (e.g. `0.3`)
keeps the behaviour change strictly limited to snow + dead corals.

**Soundness:** does not weaken the existing protection against bare-hand stone/ore grinding
— those blocks have hardness ≥ 1.5 and continue to abort exactly as today. The change is
purely additive: a small set of low-hardness blocks no longer fire a false abort.

**Limitations:** hardness alone does not model held-tool tier (e.g. `cobblestone` with a
wooden pickaxe is fast even though wooden_pickaxe isn't in cobblestone's `harvestTools`). But
the `canHarvest` clause already gates on tool match, so this fix only changes behaviour in
the no-matching-tool branch — the cobblestone-with-wood-pick path was already (correctly) not
hitting the abort.

### Annotation

Both fixes patch a file outside `achievement_hunter/` (`src/agent/library/skills.js`), so
both must be wrapped in `// Start of AH code` / `// End of AH code` markers per the project
convention noted in BUG 8 §"Annotation convention."

### Recommended

Apply **Fix B**. It is the smallest-diff change that both resolves the reported bug *and*
preserves the existing safeguard against bare-hand grinding through stone/ore tier blocks
that the user explicitly wanted to keep. Fix A is included for reference as the more
principled but less surgical alternative; choose it if a future change to mineflayer's
`canDigBlock` or to minecraft-data's `harvestTools` table makes the predicate-swap more
attractive than the threshold-gated form.

## Evidence

Direct from the source files cited above — no rollout trace was attached to this report, but
the failure mechanism is fully determined by static analysis:

1. `skills.js:1236` — predicate is `!targetBlock.canHarvest(itemId)`.
2. `prismarine-block/index.js:298–301` — `canHarvest` returns `false` whenever
   `harvestTools` is set and `heldItemType` is absent from the table.
3. `minecraft-data/.../1.21.6/blocks.json` snow_block entry — `harvestTools` table contains
   only the six shovel item IDs (876, 881, 886, 891, 896, 901). Therefore any `heldItemType`
   that is not one of those six (including `null` for bare hands) yields `false` from
   `canHarvest`, which makes the predicate at `skills.js:1236` true, which logs and aborts.
4. The user-confirmed inverse — handing the bot a shovel of any tier resolves the abort —
   matches: a shovel's item ID lands in the `harvestTools` table, `canHarvest` returns
   `true`, the predicate is false, the watchdog does nothing, the dig completes.

If a trace is later attached, the line to grep for is the verbatim string
`"Cannot break snow_block with current tools."` immediately followed by a `goToPosition`
returning `false`.

## Relation to Other Bugs

- **BUG 8 (`useToolOnBlock` wall obstruction)** patches the *separate* `useOn` flow with a
  dig-through recovery and uses `bot.canDigBlock()` as its guard. That fix is independent
  evidence that `canDigBlock` is the right primitive for "can this block actually be broken"
  in this codebase. The fix proposed here applies the same primitive to the pathfinding
  watchdog.
- **BUG 5 (lava death pathfinder escape)** also touches pathfinder behaviour but on the
  escape side; the snow_block abort fires before any death/escape concern arises.
- No shared root cause with BUG 12 / BUG 13 — those are AbortController / unstuck deadlocks,
  not predicate misuse.
