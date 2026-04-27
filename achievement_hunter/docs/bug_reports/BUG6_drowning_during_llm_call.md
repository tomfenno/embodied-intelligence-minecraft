# BUG 6 — Bot Drowns During LLM Call: Water Check Misses Submerged Case and Does Not Actively Escape

**Severity:** High (causes death and item loss; recoverable but adds 5–15 minutes of rebuild)
**Status:** Fixed — both patches applied on branch `hard-code-nts-am`
**Trace:** `2026-04-27T22-40-04-985Z_Test_Lava_Bucket`
**Patches:**
- Fix A — `achievement_hunter/src/agent/ah_modes.js:46–49` (`self_preservation` water branch)
- Fix B — `achievement_hunter/src/pipeline/structured_loop/failure_replanner.js:180–196` (function), `:216` (call site)

---

## Symptom

After the bot respawned from a lava death (BUG 5), the inner retry loop continued with
empty inventory, running `!searchForBlock("lava", 128)` for ~91 seconds. At the end of
that search the failure replanner was called, which awaited an LLM response. During the
LLM call the bot (navigating through cave terrain near water) entered a water body and
drowned, causing a second death and a second full item-loss event.

From the rollout trace:
- **5m 32s–5m 34s** — `!search("lava")` → `!searchForBlock("lava", 32/64/128)` launched
  from the beach after respawn. Bot is actively pathfinding underground toward lava.
- **5m 34s–7m 05s** — 91-second gap: `!searchForBlock("lava", 128)` running. During this
  time the bot is navigating through cave terrain which commonly includes water bodies.
- **7m 05s** — failure replanner fires. LLM call (`model.send_prompt(prompt)`) begins.
  Bot is idle at whatever position the search left it.
- Recovery attempt 1 diagnosis: *"You died in lava and lost the bucket, then respawned at
  the beach with an empty inventory."* — this describes the BUG 5 death. The second death
  (drowning) is consistent with the bot being in or near water when the LLM call started,
  and then losing health while awaiting the response.

---

## Root Cause

### Issue 1 — Water check misses the fully-submerged case

```js
// ah_modes.js:46-49
if (blockAbove.name === 'water') {
    if (!bot.pathfinder.goal) {
        bot.setControlState('jump', true);
    }
}
```

`blockAbove` is the block at the bot's **head position** (Y + 1). The check only fires when
the head block is water — that is, when the bot is at the surface with water up to its chin.

If the bot is **fully submerged** in a cave water pocket (feet block is `water`, head block
is `stone` ceiling), `blockAbove.name` is `'stone'`, not `'water'`. This branch does not
fire. The bot receives no assistance. It slowly drowns.

The code falls through to the final `else if (agent.isIdle())` branch which simply calls
`bot.clearControlStates()` — actively removing any jump the bot had set. No help.

### Issue 2 — Jump-only is insufficient even when the check fires

Even in the shallower case where the check does fire (`blockAbove === 'water'`), the response
is only `bot.setControlState('jump', true)`. This is:
- **Blocked when pathfinding:** the `!bot.pathfinder.goal` gate means no jump fires during the
  91-second search navigation. The pathfinder handles swimming in theory, but if it routes the
  bot through a tight water section it cannot exit, the pathfinder stalls and the bot drowns
  without any self_preservation intervention.
- **Passive when idle:** once the search ends and the bot is idle (LLM call in progress),
  `jump=true` is set but nothing actively navigates the bot upward or to solid ground. In a
  cave water pocket with a 1-block air gap at the surface, the bot may not surface reliably
  from jumping alone depending on its exact position.

### Issue 3 — No hazard check before the LLM call

```js
// failure_replanner.js:198
const raw = await model.send_prompt(prompt);
```

There is no check of the bot's position or block state before the LLM call. The call can
take 30–120 seconds. If the bot is in water, lava, or taking damage at the time the call
is issued, it will remain in that state for the entire LLM wait with only the (broken) mode
logic as protection.

---

## Fix Recommendations

### Fix A — Correct the Water Condition in `self_preservation` (Top Recommendation)

**Change the water check to cover both the surface case and the fully-submerged case, and
replace passive `jump=true` with an active escape via `execute()`.**

```js
// ah_modes.js — replacement water block in self_preservation.update

const in_water = block.name === 'water' || blockAbove.name === 'water';

if (in_water) {
  execute(this, agent, async () => {
    await skills.moveAway(bot, 5);
    // moveAway via pathfinder works here: the pathfinder CAN navigate through
    // water (it treats water as high-cost but passable), and it will route the
    // bot toward solid ground. This is the correct tool for water escape.
  });
}
```

The key changes:
1. `block.name === 'water' || blockAbove.name === 'water'` — catches both the fully-submerged
   (ceiling above) and the at-surface (water above head) cases.
2. `execute()` wraps the action in `agent.actions.runAction`, which interrupts any ongoing
   pathfinder action (including the lava search) and runs the escape. This replaces the
   purely passive `setControlState('jump', true)`.
3. The `!bot.pathfinder.goal` gate is removed — escape should fire regardless of whether
   the bot is pathfinding. The cost (interrupting the search) is justified by preventing death.

**Why `moveAway` is the right tool for water (unlike lava):** The pathfinder treats water as
passable (high cost, not infinite). `moveAway(bot, 5)` WILL find a valid path from inside
water to solid ground. This is the opposite of the lava case where the pathfinder fails.

**Robustness:** High. Covers the fully-submerged cave case, works during pathfinding, and
actively navigates the bot to safety rather than passively setting control states.

**Soundness:** The fix correctly uses `execute()` (which goes through `runAction` and can
interrupt other actions) rather than direct control states. `moveAway` is the appropriate
pathfinder call for water because lava-passability is the issue for BUG 5, not water.
Removing the `!bot.pathfinder.goal` gate is a deliberate trade-off: the search is interrupted,
but that is preferable to death.

**One concern:** calling `execute()` every tick while in water would spam the action manager.
This should be guarded either with a cooldown (same as the torch_placing mode uses `cooldown`)
or by checking `!mode.active` before calling (which `ModeController.update()` already does —
`mode.active` is true during the execute, so it won't re-enter until the escape completes).

---

### Fix B — Pre-LLM Safety Check in `failure_replanner` (Secondary Recommendation)

**The user's suggestion: ensure the bot is not in a hazardous state before making an LLM call.**

```js
// failure_replanner.js — add before model.send_prompt(prompt)

async function wait_for_safe_position(agent, timeout_ms = 15000) {
  const bot = agent.bot;
  const deadline = Date.now() + timeout_ms;

  while (Date.now() < deadline) {
    const block = bot.blockAt(bot.entity.position);
    const block_above = bot.blockAt(bot.entity.position.offset(0, 1, 0));
    const in_hazard = block?.name === 'water' || block_above?.name === 'water'
                   || block?.name === 'lava'  || block_above?.name === 'lava';
    if (!in_hazard) return;
    await sleep(500);
  }
  // Timeout: actively navigate away regardless
  await skills.moveAway(bot, 10);
}

// In recover_failed_task, before the LLM call:
await wait_for_safe_position(agent);
const raw = await model.send_prompt(prompt);
```

**Robustness:** Medium. Covers the specific reported failure mode (bot in water when LLM call
begins). However it is a band-aid: it does not fix the underlying `self_preservation` failure
that allowed the bot to be in a dangerous position in the first place. If Fix A (self_preservation)
is applied correctly, Fix B becomes largely redundant.

**Soundness:** The suggestion is architecturally correct. A long-blocking call like an LLM
request should not be made while the bot is in a hazardous state. The 15-second poll window
gives the mode system time to handle the hazard autonomously; the fallback `moveAway` handles
the case where the mode system failed (which is exactly the scenario in this bug).

**Assessment:** Fix B is sound and worth adding as a **defensive belt-and-suspenders measure**,
but it should not be the primary fix. Fix A addresses the root cause; Fix B adds a guaranteed
safety net for this specific code path.

**Limitation:** Fix B only protects LLM calls in `failure_replanner`. If the bot drowns during
a long `executeCommand` navigation (like the 91-second `!searchForBlock("lava", 128)` that
preceded the LLM call), Fix B does not help. Only Fix A covers that window.

---

## Summary: Recommended Fix Priority

| # | Fix | Where | Covers |
|---|-----|--------|--------|
| A | Fix `self_preservation` water condition + use `execute()` | `ah_modes.js` | All drowning scenarios — during navigation, during LLM call, during idle |
| B | Pre-LLM safety check | `failure_replanner.js` | Drowning specifically at LLM call start; belt-and-suspenders |

Apply Fix A first. Apply Fix B if you want an explicit hard guarantee that LLM calls never
start in a hazardous state, regardless of how the mode system behaves.

---

## Interaction with BUG 5

BUG 5 (lava death) is what put the bot into the scenario that triggered this bug. With
empty inventory after respawn, the inner loop's `!searchForBlock("lava", 128)` sent the
bot back underground, where it encountered water on the way. Fixing BUG 5 alone does not
prevent BUG 6, because the bot can enter water in other scenarios (cave navigation to find
any block, not just lava). Both bugs require independent fixes.
