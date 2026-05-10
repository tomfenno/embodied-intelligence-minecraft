# BUG 7 — Flowing Water/Lava in `nearby_blocks` Triggers Premature `!useOn`

**Severity:** Medium (command failure or unintended navigation; no item loss on its own)
**Status:** Fixed — patch applied on branch `hard-code-nts-am`
**Patch:** `achievement_hunter/src/pipeline/agent_state.js:34` and `:60` (`get_am_state`, `get_nts_state`)

---

## Symptom

The bot issues `!useOn("bucket", "lava")` (or `"water"`) when only **flowing** lava/water is
within 8 blocks — not a still source block. Two failure modes follow:

1. **Unintended navigation:** `useToolOn()` searches up to 64 blocks for a source block. If one
   exists 20–50 blocks away, the bot navigates there unexpectedly, leaving its current position
   to reach a distant source the AM did not know about.
2. **Command failure:** If no source block exists within 64 blocks, `useToolOn()` fails and the
   inner retry loop burns an attempt. Repeated failures exhaust retries and trigger the failure
   replanner unnecessarily.

---

## Root Cause

### `nearby_blocks` does not distinguish source from flowing blocks

```js
// agent_state.js:28–32 (get_am_state) and :53–57 (get_nts_state) — before fix
const block_set = new Set();
for (const block of getNearestBlocks(bot)) {
  block_set.add(block.name);  // ← no metadata check
}
const nearby_blocks = Array.from(block_set);
```

`getNearestBlocks(bot)` scans within 8 blocks and returns all blocks. In Minecraft/mineflayer,
both still and flowing water share the block name `"water"`; same for `"lava"`. The distinction
is `block.metadata`:
- **`metadata === 0`** — source block (still; collectable with a bucket)
- **`metadata === 1–7`** — flowing block (not collectable)

Because `block.name` is the same for both, flowing blocks entered `nearby_blocks` as `"lava"` or
`"water"`. The Action Mediator's check `nearby_blocks.includes('lava')` then returned `true`
and emitted `!useOn("bucket", "lava")` — even though no collectible source was nearby.

### Why `useToolOn` didn't save it

`useToolOn()` in `skills.js:2042` already correctly filters for source blocks:
```js
let blocks = world.getNearestBlocksWhere(bot,
    block => block.name === targetName && block.metadata === 0, 64, 1);
```
But its search radius is 64 blocks — much larger than the AM's 8-block awareness window. So
`useToolOn` could navigate the bot far from where the AM intended.

---

## Fix

Filter flowing blocks from `nearby_blocks` at construction time. The same `metadata === 0`
pattern already used in `skills.js` is applied here.

```js
// agent_state.js — module-level constant (line 5)
const COLLECTIBLE_LIQUIDS = new Set(['water', 'lava']);

// Inside both get_am_state and get_nts_state (lines 34 and 60):
const block_set = new Set();
for (const block of getNearestBlocks(bot)) {
  if (COLLECTIBLE_LIQUIDS.has(block.name) && block.metadata !== 0) continue;
  block_set.add(block.name);
}
const nearby_blocks = Array.from(block_set);
```

**Patch location:** `achievement_hunter/src/pipeline/agent_state.js:3–5` (constant), `:34` and `:60` (guard line)

**Effect:** When only flowing lava is within 8 blocks, `nearby_blocks` will not contain `"lava"`.
`mediate_interact` falls through to `!search("lava")`, which correctly navigates the bot to find
an actual source block before attempting collection.

---

## No Other Changes Required

- `useToolOn()` (`skills.js:2042`) — already correct; not the bug location
- `mediate_interact` / `mc_sources.js` — fixed indirectly by correcting the data they read
- `self_preservation` — reads `bot.blockAt()` directly; unaffected
- `!search("lava")` / `searchForBlock` — does not use `nearby_blocks`; unaffected

---

## Existing Pattern Reused

The `block.metadata === 0` check to identify source blocks is already used in three places in
`skills.js`: `collectBlock()` (line 472), `goToNearestBlock()` (line 1273), and `useToolOn()`
(line 2042). This fix makes `agent_state.js` consistent with that established pattern.
