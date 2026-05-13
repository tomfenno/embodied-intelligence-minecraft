# BUG 6 — Bot Drowns During LLM Call: Water Check Misses Submerged Case and Does Not Actively Escape

**Severity:** High (causes death and item loss; recoverable but adds 5–15 minutes of rebuild)
**Status:** Partially fixed — Fix A applied on branch `hard-code-nts-am`; Fix B removed on branch `search-agent` after owner determined the pre-LLM escape was ineffective in practice (`ensure_safe_before_llm` was deleted entirely, including its 3 s lava sprint sleep).
**Trace:** `2026-04-27T22-40-04-985Z_Test_Lava_Bucket`
**Patches:**
- Fix A — `achievement_hunter/src/agent/ah_modes.js:46–49` (`self_preservation` water branch) — still in place
- Fix B — `achievement_hunter/src/pipeline/structured_loop/failure_replanner.js` (`ensure_safe_before_llm` function + call sites in failure/search replanners) — **removed**, see BUG 9 for the related removal rationale

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

### Fix A — Use `bot.oxygenLevel` as the Drowning Signal ✅ Applied

**Replace all water block checks with a direct oxygen level check. Escape only when the bot
is genuinely running out of air.**

```js
// ah_modes.js:45–49 — self_preservation.update, first branch
if (bot.oxygenLevel != null && bot.oxygenLevel < 15) {
  execute(this, agent, async () => {
    await skills.moveAway(bot, 5);
  });
}
```

**Patch location:** `achievement_hunter/src/agent/ah_modes.js:45–49`

**Source:** `bot.oxygenLevel` is provided by mineflayer's `breath.js` / `entities.js` plugins
(`air_supply / 15`, range 0–20). 20 = full air. Depletes only when the bot's head is fully
submerged. Recharges immediately when the head surfaces.

**Why this is better than all previous approaches:**

| Approach | Problem |
|---|---|
| `blockAbove === 'water'` (original) | Missed fully-submerged cave case (ceiling above head) |
| `block \|\| blockAbove === 'water'` | Fired on wading; caused ping-pong PathStopped loop |
| `block && blockAbove === 'water'` | Still fired during pathfinder navigation through 2+-block-deep lakes |
| `!bot.pathfinder.goal && water` | `bot.pathfinder.goal` unreliable during `setMovements` transitions |
| **`bot.oxygenLevel < 15`** | Fires only when bot has been genuinely submerged for ~3.75 s — not on wading, not on brief head dips during swimming, not during active pathfinder navigation through water |

**Threshold:** 15 out of 20 = lost 5 air units = ~3.75 seconds of continuous head submersion.
- Short enough to escape before dangerous levels (10 units = ~7.5 s remaining before total air loss, then drowning damage)
- Long enough to ignore brief head dips during normal pathfinder water traversal
- `!= null` guard handles the pre-spawn window before any `breath` packet arrives

**Wading (feet in water, head above):** oxygenLevel stays at 20 → no trigger ✓  
**Active swimming through a river:** bot surfaces within ~2–3 s → oxygenLevel stays ≥ 15 → no trigger ✓  
**Stuck submerged (LLM call, pathfinder stalled):** oxygenLevel steadily drops below 15 → trigger ✓

---

### Fix B — Pre-LLM Safety Check in `failure_replanner` ✅ Applied

**Ensure the bot is not in a hazardous state before making an LLM call. Check once and
escape immediately — no polling loop.**

```js
// failure_replanner.js:246–273 — standalone function (try-catch added by BUG 9)
async function ensure_safe_before_llm(agent) {
  const bot = agent.bot;
  const block = bot.blockAt(bot.entity.position);
  const block_above = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  const block_below = bot.blockAt(bot.entity.position.offset(0, -1, 0));

  const in_water =
      block_below?.name === 'water' || block_above?.name === 'water';
  const in_lava = block?.name === 'lava' || block_above?.name === 'lava';

  try {
    if (in_water) {
      await skills.moveAway(bot, 10);
    } else if (in_lava) {
      await bot.lookAt(bot.entity.position.offset(5, 1, 0), true);
      bot.setControlState('jump', true);
      bot.setControlState('sprint', true);
      await new Promise(r => setTimeout(r, 3000));
      bot.clearControlStates();
    }
  } catch (e) {
    // BUG 9: a mode raced with this escape and won — proceed.
    spl.warn(`ensure_safe_before_llm: escape interrupted (${e.message}) — mode moved bot to safety.`);
  }
}

// call site in recover_failed_task, before each LLM call
await ensure_safe_before_llm(agent);
const raw = await model.send_prompt(prompt);
```

**Patch location:** `achievement_hunter/src/pipeline/structured_loop/failure_replanner.js:246–273` (function) and the `recover_failed_task` call site (just before each `model.send_prompt`).

**`in_water` check — block-below / block-above:** the bot is at risk of drowning during the LLM wait if (a) it is standing on a water block (likely to be pulled under by physics/momentum during the 30–120 s wait) or (b) its head is already submerged. An earlier iteration used `bot.oxygenLevel < 15` to match `self_preservation`, but oxygen only depletes when the head is fully submerged — a bot standing on water with its head at an air gap reads a normal `oxygenLevel` and the check skipped exactly the case it needed to catch. See BUG 9 for the full rationale.

**Design rationale:** An earlier proposal polled every 500ms and waited for `self_preservation`
to handle the hazard, which is passive and adds unnecessary latency. The implemented version
checks once and acts immediately: water → `moveAway(10)` (pathfinder navigates to solid ground),
lava → sprint-jump for 3 seconds (pathfinder can't navigate lava, so direct controls are used,
same approach as the BUG 5 Fix A escape). If the bot is safe, the check returns instantly with
no overhead.

**Called per recovery attempt, not once:** Correct — the bot's position changes between
attempts as recovery actions execute. Each LLM call can start in a different state.

**Robustness:** High for the specific LLM call window. Belt-and-suspenders on top of Fix A —
Fix A handles hazards during all navigation, Fix B is the hard guarantee at each LLM
call boundary.

**Limitation:** Fix B only protects LLM calls in `failure_replanner`. If the bot drowns during
a long navigation (like the 91-second `!searchForBlock("lava", 128)` that preceded the LLM
call in this trace), Fix B does not help. Only Fix A covers that window.

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
