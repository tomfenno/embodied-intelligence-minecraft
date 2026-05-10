# Patched 
# BUG 2 — Stick Craft `updateSlot:0` Timeout

**Severity:** Critical (blocks all downstream craft tasks)
**Status:** Root cause identified
**Branch:** hard-code-nts-am
**Introduced by:** Uncommitted changes in `structured_loop.js` (deterministic AM)

---

## Symptom

```
crafting...
Code execution triggered catch: Error: Error: Event updateSlot:0 did not fire within timeout of 20000ms
    at EventEmitter.craft (.../mineflayer/lib/plugins/craft.js:32:13)
    at async Module.craftRecipe (.../src/agent/library/skills.js:103:5)
```

`!craftRecipe("stick", 1)` fails consistently after planks crafting succeeds.
Retried up to 5 times per attempt, always the same result.

---

## What Changed on This Branch

The old LLM-based AM generated `!craftRecipe("stick", 4)` (passing `task.qty` directly).
The new deterministic AM (`mediate_craft`) introduced `get_item_batch_size` to compute
the correct number of craft iterations:

```javascript
// achievement_hunter/src/pipeline/structured_loop.js
function mediate_craft(task) {
  const batchSize = get_item_batch_size(task.target_item);  // sticks → 4
  const crafts = Math.ceil(task.qty / batchSize);           // ceil(4/4) = 1
  return { kind: 'command', command: `!craftRecipe("${task.target_item}", ${crafts})` };
}
```

Result: `!craftRecipe("stick", 1)` instead of `!craftRecipe("stick", 4)`.

---

## Root Cause

The bug is in **`node_modules/mineflayer/lib/plugins/craft.js`** at the `grabResult`
function. It fires the `updateSlot:0` event BEFORE `putAway` registers its listener:

```javascript
// craft.js — grabResult()
window.updateSlot(0, item)   // ← fires updateSlot:0 with NO listener registered yet
await bot.putAway(0)         // ← registers once(window, 'updateSlot:0') here — too late
```

And `putAway` in `inventory.js:649`:

```javascript
async function putAway (slot) {
    const window = bot.currentWindow || bot.inventory
    const promisePutAway = once(window, `updateSlot:${slot}`)  // listener registered HERE
    await clickWindow(slot, 0, 0)
    ...
    await promisePutAway  // ← never resolves — the event already fired above
}
```

The event fires before the promise is registered. `putAway` sends the click to the
server, but the server's response either doesn't re-fire the event or the client/server
state has diverged from the pre-emptive manual `window.updateSlot` call.

### Why planks worked but sticks timed out

Planks may win the race because the server's own `setSlot` packet for slot 0 arrives
*after* `putAway` registers its listener (fewer ingredient-placement steps, faster
network round-trip). Sticks has two ingredient slots to fill (slots 1 and 3), each
triggering `waitForWindowUpdate(inventory, slot)` which calls
`once(bot.inventory, 'updateSlot:0')` — these intermediate listeners eat through any
buffered `updateSlot:0` events before `putAway` gets to register its own. The result is
a consistently lost race for sticks.

This race is timing-sensitive. `bot.craft(recipe, 4, null)` may have won it more
reliably (via some difference in state after the loop structure), which is why the
old behavior appeared to work.

---

## Proposed Fix

### Option A — Patch mineflayer (recommended)

Remove the pre-emptive `window.updateSlot(0, item)` from `grabResult` in `craft.js`.
This line has a code comment: `// Causes a double-emit on 1.12+ --nickelpro` and is
meant as a workaround. In MC 1.21.6 it breaks the event ordering.

Add to `patches/mineflayer+4.33.0.patch` (rename to match installed version first):

```diff
--- a/node_modules/mineflayer/lib/plugins/craft.js
+++ b/node_modules/mineflayer/lib/plugins/craft.js
@@ grabResult function
-        const item = new Item(recipe.result.id, recipe.result.count, recipe.result.metadata)
-        window.updateSlot(0, item)
-        await bot.putAway(0)
+        await bot.putAway(0)
```

This makes `putAway` rely entirely on the server's `setSlot` response for slot 0,
which is the correct event to trigger the promise.

After patching, rebuild without cache:

```bash
docker-compose build --no-cache
docker-compose up
```

### Option B — Timing workaround in skills.js (lower risk, less clean)

Add a small delay before `bot.craft` in `craftRecipe` to let inventory state settle
after any prior craft:

```javascript
// src/agent/library/skills.js, before line 103
await new Promise(resolve => setTimeout(resolve, 300));
await bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable);
```

This does not fix the root cause but may reduce the frequency of the race.

### Option C — Revert mediate_craft to pass task.qty directly

```javascript
function mediate_craft(task) {
  return {
    kind: 'command',
    command: `!craftRecipe("${task.target_item}", ${task.qty})`,
  };
}
```

This restores the pre-branch behavior (`!craftRecipe("stick", 4)`). It over-crafts
(16 sticks instead of 4) but avoids the race. `craftLimit.num` in `skills.craftRecipe`
clamps the actual craft count to available materials, so it won't error.

**Not recommended long-term** — defeats the purpose of `get_item_batch_size` —
but useful as a quick regression test to confirm the batch-size division is the
proximate cause.

---

## Verification

After applying Option A or B, confirm:

```
[SPL] Action (attempt 1/5): !craftRecipe("stick", 1)
crafting...
[SPL] Command result: Action output:
Successfully crafted stick, you now have 4 stick.
```

With no `Event updateSlot:0 did not fire` errors.
