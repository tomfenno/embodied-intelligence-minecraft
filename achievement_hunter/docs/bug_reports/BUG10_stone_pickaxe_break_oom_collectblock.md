# BUG 10 — Stone Pickaxe Break During Iron Collection Causes OOM Crash

**Severity:** Critical (process crash, full restart required)
**Status:** Fixed — patch and catch update applied on branch `hard-code-nts-am`
**Patch:** `patches/mineflayer-tool+1.2.0.patch`
**Caller updates:** `src/agent/library/skills.js:494–503` (comment) and
`src/agent/library/skills.js:531–549` (catch handler)

---

## Symptom

The bot is collecting iron_ore with a stone pickaxe. The pickaxe breaks (exhausts its last
durability) during a `!collectBlocks("iron_ore", 16)` call. Instead of the command returning
`{ success: false }` cleanly, the Node.js process crashes:

```
[SPL] Action (attempt 1/5): !collectBlocks("iron_ore", 16)
parsed command: { commandName: '!collectBlocks', args: [ 'iron_ore', 16 ] }
executing code...

<--- Last few GCs --->

[33:0xffff8d310000]   493717 ms: Mark-Compact 1974.8 (2082.1) -> 1962.1 (2085.6) MB ...
[33:0xffff8d310000]   495068 ms: Mark-Compact 1980.5 (2088.1) -> 1967.8 (2091.4) MB ...

FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

No `[SPL] Command result:` line appears — the command never returns.

---

## History

A prior fix in `skills.js:collectBlock` added `{requireHarvest: true}` to the outer
`equipForBlock` call so that a missing tool is detected before `collect()` is called. That
fix correctly handles the **static** case (tool gone before collection starts). The OOM
persists because the pickaxe break can arrive **after** the outer check but **during**
internal navigation inside `collect()`.

---

## Root Cause

### The race window

The crash is a **race** between the server's `set_slot` packet (notifying the client that
the pickaxe was destroyed) and the collectblock plugin's inner tool-equip check.

**Detailed sequence:**

1. Outer iteration N: `bot.tool.equipForBlock(block, {requireHarvest: true})` is called.
   Reads `bot.inventory.items()` synchronously. The pickaxe is still present (the previous
   dig's `set_slot` packet has not yet been processed; it's queued as a macrotask).
   Returns without throwing.

2. `await bot.collectBlock.collect(block)` starts. The work between iteration N-1's last
   real I/O await and this point — `success=true; collected++; await autoLight(bot);` —
   runs entirely as microtasks (`autoLight` returns `Promise.resolve(false)` when no torch
   is needed). **No macrotask runs in this window**, so the queued `set_slot` is still
   unprocessed.

3. Inside `collectAll`, the first real I/O await is
   `await bot.pathfinder.goto(GoalLookAtBlock)`. **Now** the macrotask queue drains and the
   `set_slot` packet is processed. `bot.inventory.slots[hand]` is set to null.

4. Bot reaches the block. `mineBlock(bot, block, options)` is called.

5. `mineBlock` calls `bot.tool.equipForBlock(block, equipToolOptions)` where:
   ```js
   const equipToolOptions = {
       requireHarvest: true,
       getFromChest: true,
       maxTools: 2
   };
   ```

6. `itemList = inventory.items().filter(canHarvest)` — empty (pickaxe gone).

7. `getFromChest: true` branch fires:
   ```js
   yield retrieveTools(this.bot, {
       chestLocations: this.chestLocations,  // [] — never populated in this codebase
       ...
   });
   yield this.equipForBlock(block, options);  // recursive — assumes retrieveTools added a tool
   ```

8. **The actual bug, in `mineflayer-tool`'s `retrieveTools`:**
   ```js
   const chestLocations = [...options.chestLocations];
   while (chestLocations.length > 0) {       // empty list — loop never runs
       // ...go to chest, pull tools, throw NoChest if no chest matches...
   }
   // falls through with no return value, no throw
   ```
   When `chestLocations` is empty, the `while` never executes and the function returns
   `undefined` silently. The recursive `equipForBlock` call then re-enters the same path
   (still empty inventory, still empty chest list) — **infinite async recursion**.

9. Each recursive call allocates a Promise frame plus the closures inside the `__awaiter`.
   The heap grows by several MB/sec. Combined with the ~1.97 GB already in use from normal
   pathfinder A* state at 8 minutes runtime, the process crosses the heap limit within a
   few seconds and Node aborts with the OOM seen above.

### Why the outer `requireHarvest:true` check doesn't catch this

The outer fix reads inventory at the **top of each outer loop iteration**. The break event
arrives **after** that read, while the next `collect()` call's `goto()` is awaited. By the
time `mineBlock`'s `equipForBlock` runs, the inventory has changed — but the outer check
already passed.

### Why the silent fallthrough exists

`retrieveTools` was written to throw `NoChest` when chests *exist* but contain no usable
tools. The author missed the case where `chestLocations` is empty to begin with — the
`while` simply never runs. The caller (`equipForBlock`) assumes `retrieveTools` either adds
a tool to inventory or throws, and recurses on the assumption that something changed. With
silent fallthrough, that assumption is violated and recursion never terminates.

---

## Fix

Two coordinated changes:

### 1. Patch `mineflayer-tool` to throw on empty `chestLocations`

**File:** `node_modules/mineflayer-tool/lib/Inventory.js` (via
`patches/mineflayer-tool+1.2.0.patch`)

```diff
 function retrieveTools(bot, options, cb) {
     return __awaiter(this, void 0, void 0, function* () {
         const chestLocations = [...options.chestLocations];
+        if (chestLocations.length === 0) {
+            const err = (0, Tool_1.error)('NoChest', 'No chest locations registered to retrieve tools from!');
+            if ((cb != null) && typeof cb === 'function')
+                cb(err);
+            throw err;
+        }
         while (chestLocations.length > 0) {
```

Closes the recursion at its source: the function now either succeeds (tool retrieved) or
throws (no chests / no tools), matching the contract its caller already assumes.

This fix is preferred over patching `mineflayer-collectblock` to set `getFromChest:false`
because it preserves chest-fetch behaviour for any future code that registers chest
locations, while still preventing the OOM when none are registered (the current state of
this codebase).

### 2. Handle `NoChest`/`NoItem` in `skills.js:collectBlock`

**File:** `src/agent/library/skills.js:531–549`

```diff
 catch (err) {
     if (err.name === 'NoChests') {
         log(bot, `Failed to collect ${blockType}: Inventory full, no place to deposit.`);
         break;
     }
+    else if (err.name === 'NoChest' || err.name === 'NoItem') {
+        // Tool gone mid-collection: mineBlock's equipForBlock ran with no
+        // harvestable tool, then either (a) requireHarvest threw NoItem, or
+        // (b) getFromChest entered retrieveTools which now throws NoChest
+        // when chestLocations is empty (see BUG 10).
+        log(bot, `Don't have right tools to harvest ${blockType}.`);
+        return false;
+    }
     else {
         log(bot, `Failed to collect ${blockType}: ${err}.`);
         continue;
     }
 }
```

Without this, the `NoChest` thrown from inside `collect()` would fall to the generic `else`
branch, log `Failed to collect iron_ore: Error...`, and `continue`. The next iteration's
outer `equipForBlock({requireHarvest:true})` would *then* throw `NoItem` and return false.
Functionally fine, but noisy and wasteful. Catching `NoChest` directly returns false in
one step with the right user-facing message.

`NoChests` (plural — emptied-inventory case from `emptyInventoryIfFull`) is intentionally
left in its own branch since the failure semantics differ.

### Propagation chain (with fixes)

```
mineBlock equipForBlock({getFromChest:true}) called with empty inventory
  → retrieveTools (chestLocations=[]) throws NoChest    ← patch
  → equipForBlock catch re-throws NoChest
  → mineBlock no catch → propagates
  → collectAll no catch → propagates
  → collect() catch: targets.clear(); err.name !== 'PathStopped' → re-throws
  → skills.js:collectBlock catch: err.name === 'NoChest' → return false  ← caller update
  → command returns { success: false } cleanly
  → SPL replans with the failure result
```

### Note on chest-fetch capability

`bot.tool.chestLocations` is never populated anywhere in this codebase, so the
`getFromChest:true` branch is effectively unused today. If future code does register
chests, the `mineflayer-tool` patch preserves the original behaviour (navigate to chest,
pull tool, recurse to equip it) — only the empty-list edge case changes from "silent
infinite recursion" to "throw `NoChest`."

---

## Evidence

- Process runs ~8 minutes, heap accumulates to ~1.97 GB from normal pathfinder A* state.
- `!collectBlocks("iron_ore", 16)` attempt 1 starts.
- Outer `equipForBlock` passes (pickaxe present at read time).
- `set_slot` (pickaxe destroyed) is processed during `goto()` inside `collectAll`.
- `mineBlock` equipForBlock sees empty inventory → `getFromChest:true` + empty
  `chestLocations` → infinite recursion → ~5–10 MB/sec heap growth → OOM within seconds.

## Relation to Other Bugs

- **Prior fix attempt:** `skills.js:collectBlock` line 502–509 — added `requireHarvest:true`
  to the outer `equipForBlock` call. Closes the static case (tool gone at loop start) but
  not the race opened by the `goto()` await inside `collectAll`.
- **BUG 9:** Same class of race — an external event fires during a pathfinder `goto()`
  await and causes an exception that the surrounding code must handle correctly.
