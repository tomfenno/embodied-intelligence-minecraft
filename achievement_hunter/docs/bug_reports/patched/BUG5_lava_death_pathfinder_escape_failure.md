# BUG 5 — Lava Escape Fails: `moveAway` Uses Pathfinder, Which Treats Lava as Impassable

**Severity:** Critical (total item loss, full rebuild required — 10+ minutes of runtime)
**Status:** Fixed — both patches applied on branch `hard-code-nts-am`
**Trace:** `2026-04-27T22-40-04-985Z_Test_Lava_Bucket`
**Patches:**
- Fix A — `achievement_hunter/src/agent/ah_modes.js:69–119` (`self_preservation` else-branch)
- Fix B — `achievement_hunter/src/pipeline/structured_loop/actions.js:92–102` (`execute_task_action`)
- Fix B (replanner) — `achievement_hunter/src/pipeline/structured_loop/failure_replanner.js:48–68` (`run_action`)

---

## Symptom

When the bot falls into a lava pool (observed during `!useOn("bucket", "lava")` execution), it
dies and loses all inventory. The `self_preservation` mode fires and reaches the escape branch,
but the bot never moves — it burns to death in place.

From the rollout trace:
- **5m 27s** — attempt 4: `!useOn("bucket", "lava")`. Inventory shows `bucket:1`, `lava` in
  `nearby_blocks`. Bot approaches the lava to fill the bucket.
- **5m 32s** — attempt 5: `!search("lava")`. Inventory is completely empty. The bot respawned
  at the beach having lost every item.
- **7m 05s** — failure replanner diagnosis: *"You died in lava and lost the bucket, then
  respawned at the beach with an empty inventory."*

---

## Root Cause

### Escape branch (the bug)

```js
// ah_modes.js:56-90 — self_preservation lava handler
} else if (
    block.name === 'lava' || block.name === 'fire' ||
    blockAbove.name === 'lava' || blockAbove.name === 'fire') {
  say(agent, 'I\'m on fire!');
  const water_bucket =
      bot.inventory.items().find(item => item.name === 'water_bucket');
  if (water_bucket) {
    execute(this, agent, async () => {
      // Places water_bucket — correct, this works fine
    });
  } else {
    execute(this, agent, async () => {
      // Re-checks for water_bucket (race-condition guard — fine)
      const nearest_water = world.getNearestBlock(bot, 'water', 20);
      if (nearest_water) {
        await skills.goToPosition(bot, pos.x, pos.y, pos.z, 0.2); // OK
        return;
      }
      await skills.moveAway(bot, 5);  // ← THE BUG
    });
  }
}
```

`skills.moveAway(bot, 5)` is the pathfinder's "move to a random point 5 blocks away." The
pathfinder computes movement costs by block type. Lava blocks have an effectively infinite
movement cost — the pathfinder treats them as impassable. When the bot is **inside** a lava
pool (surrounded by lava blocks on all sides), the pathfinder finds no valid 5-block path and
returns without moving. The escape action completes immediately and silently, doing nothing.
The bot continues burning.

### How the bot fell in (why prevention failed)

The `!useOn("bucket", "lava")` Mindcraft command navigates the bot to a block adjacent to
the lava source, then uses the item. In cave geometry, the adjacent block can be a single
1-block-wide ledge at the edge of a lava pool. Pathfinding onto such a ledge is valid, but
executing the `useOn` interaction (which involves looking, moving, and using the item) can
knock the bot off the ledge and into the pool.

There is no SPL-level guard that checks terrain safety before issuing `!useOn` on lava. The
pathfinder finds any adjacent block without considering cliff/ledge risk.

---

## Fix Recommendations

### Fix A — Active Direct-Control Escape ✅ Applied

**When in lava, bypass the pathfinder entirely and use raw bot controls.**

The pathfinder's inability to navigate through lava is the core failure. The fix is to:
1. Find the nearest adjacent block that is not lava (checking all 4 cardinal directions and
   diagonals at the bot's current Y level).
2. Look toward it and sprint-jump using `bot.setControlState`.
3. If no such block exists (fully enclosed lava pool), sprint-jump toward an arbitrary
   direction — best possible effort.

```js
// ah_modes.js:69–119 — self_preservation else-branch (no water_bucket)
execute(this, agent, async () => {
  const wb = bot.inventory.items().find(item => item.name === 'water_bucket');
  if (wb) { /* race-condition guard: place if acquired since outer check */ return; }

  // Phase 1: direct-control escape — bypasses pathfinder (lava = impassable).
  const bot_pos = bot.entity.position;
  const hazard = new Set(['lava', 'fire']);
  const directions = [
    {x: 1, z: 0}, {x: -1, z: 0}, {x: 0, z: 1},  {x: 0, z: -1},
    {x: 1, z: 1}, {x: -1, z: 1}, {x: 1, z: -1}, {x: -1, z: -1},
  ];
  const escape_dir = directions.find(d => {
    const b = bot.blockAt(bot_pos.offset(d.x, 0, d.z));
    return b != null && !hazard.has(b.name);
  });
  const look_target = escape_dir
      ? bot_pos.offset(escape_dir.x * 5, 1, escape_dir.z * 5)
      : bot_pos.offset(5, 1, 0);
  await bot.lookAt(look_target, true);
  bot.setControlState('jump', true);
  bot.setControlState('sprint', true);
  await new Promise(r => setTimeout(r, 3000));
  bot.clearControlStates();

  // Phase 2: if now on solid ground, pathfind to water to extinguish fire.
  const cur_block = bot.blockAt(bot.entity.position);
  if (cur_block && !hazard.has(cur_block.name)) {
    const nearest_water = world.getNearestBlock(bot, 'water', 20);
    if (nearest_water) {
      const wp = nearest_water.position;
      await skills.goToPosition(bot, wp.x, wp.y, wp.z, 0.2);
    }
  }
});
```

**Patch location:** `achievement_hunter/src/agent/ah_modes.js:69–119`

**Robustness:** High. Does not depend on the pathfinder. Works even when all adjacent blocks
are lava (bot is not guaranteed to escape, but this is the best possible effort). The two-phase
approach (sprint-jump first, then pathfind to water once on solid ground) is more effective
than the original single-phase pathfinder attempt.

**Soundness:** The raw control approach matches how a skilled Minecraft player escapes lava —
look toward the edge and sprint-jump. It correctly sequences the escape (get out first, then
douse the fire). The fallback to pathfind-to-water correctly handles the residual fire damage.

**Limitation:** Cannot escape a fully enclosed lava lake. This is acceptable — the game
provides no way out of a fully enclosed lava lake. The bot's overall behavior is still more
reliable because it will escape whenever solid ground is adjacent (the common case in caves).

---

### Fix B — Prevention: Sneak/Crouch Before Approaching Lava ✅ Applied

**Enable sneak state during `!useOn("bucket", "lava")` so server-side edge physics prevent
the bot from walking off the ledge into the pool.**

Expert Minecraft players crouch when collecting lava or water at the edge of a pool. The
server enforces this: a sneaking player cannot walk off a block edge regardless of momentum
or animation jitter during the item-use interaction.

```js
// actions.js:92–102 — execute_task_action, inside the per-attempt loop
const is_lava_useOn = task.action_type === 'interact' &&
    task.parameters?.target === 'lava' &&
    action.command.startsWith('!useOn(');

if (is_lava_useOn) agent.bot.setControlState('sneak', true);
let command_result;
try {
  command_result = await executeCommand(agent, action.command);
} finally {
  if (is_lava_useOn) agent.bot.setControlState('sneak', false);
}
```

**Patch location:** `achievement_hunter/src/pipeline/structured_loop/actions.js:92–102`

**Why only `!useOn(`:** `mediate_interact` can emit three commands depending on state —
`!search("lava")` (search branch, exits before this code), `!placeHere("lava")` (if lava
already in inventory), and `!useOn("bucket", "lava")` (bucket fill). Sneak is only needed
for the `!useOn` case where the bot is standing adjacent to the lava pool.

**Robustness:** High. Server-side physics enforce the edge constraint — this is not a
client-side heuristic. The `try/finally` guarantees sneak is always cleared even on
exception or interruption.

**Coverage gap — replanner:** `run_action` in `failure_replanner.js` also calls
`executeCommand` directly and had no sneak guard. Recovery sequences can include
`!useOn("bucket", "lava")` (e.g., when re-collecting lava after a death). The same
try/finally pattern was applied there at `failure_replanner.js:48–68`.

**Limitation:** Prevents falling off during the interaction animation. Does not protect
against the pathfinder routing the bot onto a 1-block ledge with no solid ground behind it
before the sneak state is set. Fix A (escape) remains necessary as the fallback.

---

## Note on Interaction with Recovery System

The failure replanner does correctly handle lava deaths (demonstrated in this trace: recovery
attempt 2 rebuilt all prerequisites and successfully obtained the lava bucket). Fix A reduces
how often recovery is needed; it does not replace recovery. Both should be present.
