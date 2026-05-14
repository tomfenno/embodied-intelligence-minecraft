# `!useOn("bucket", "lava")` Silent-Failure — Robust Fix Plan

**Scope:** `src/agent/library/skills.js` (`useToolOnBlock`) and
`achievement_hunter/src/pipeline/command_verifier.js`. Related, already-
patched issues: BUG7 (flowing-source confusion in `nearby_blocks`) and
BUG8 (`useToolOnBlock` wall obstruction). This plan does **not** modify
those patches — it builds on top of them.

**Status:**
- **Layer A — shipped.** `command_verifiers['!useOn']` registered;
  10 unit tests passing. See
  `achievement_hunter/src/pipeline/command_verifier.js` and
  `achievement_hunter/src/pipeline/__tests__/command_verifier_useOn.test.js`.
- **Layer B — revised, not yet implemented.** See §2 and the
  recommendations at the end.

---

## 1. Problem Statement

`!useOn("bucket", "lava")` (and by extension `"water"`) reports `success: true`
even when the bucket was never actually filled. The SPL then loops on the same
command 5×, hands off to the `failure_replanner`, which keeps issuing the
same command because the command keeps reporting success. The bot never
realizes the operation didn't change inventory.

### Observed log signature

```
[SPL] Command result: { success: true, message: 'Used bucket on lava.\n' }   // ×N
[SPL][recovery] Diagnosis: bucket likely targeted flowing lava ...           // wrong guess
```

The diagnosis is a guess — the source/flowing filter at `skills.js:2185`
already restricts to `metadata === 0`, so the cause is **not** flowing lava.

### What is actually happening

`useToolOnBlock` (`skills.js:2205-2261`) does:

```js
const distance = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
// viewBlocked / dig-through (BUG8 fix)
const equipped = await equip(bot, toolName);
if (toolName.includes('bucket')) {
    await bot.activateItem();    // ← fire-and-forget
}
log(bot, `Used ${toolName} on ${block.name}.`);
return true;                     // ← unconditional success
```

Three independent failure modes all collapse into `success: true`:

1. **`goToPosition(..., 2)` returns without reaching** (`Unable to reach …,
   you are 3 blocks away`). The skill ignores the goToPosition return value
   and continues. From ≥3 blocks the server-side raycast for `use_item` won't
   terminate on the source.
2. **Bot lands on top of the source block** (`You have reached at 124, 69,
   -37`). `lookAt` aims straight down at the source center, then
   `bot.activateItem()` fires before the server has necessarily processed the
   look update — server raycasts with stale pitch/yaw and misses, OR clips
   the player's own bounding box.
3. **`bot.activateItem()` succeeds packet-wise but the server rejects the
   fill** (raycast terminus is air/flowing-cell between bot and source). No
   error is returned to mineflayer; the skill has no way to know.

In all three cases the skill returns `true`, the SPL believes the command
worked, and the inventory state silently does not change.

---

## 2. Fix Strategy

Two layers, in order of importance.

### Layer A — Post-condition verifier for `!useOn` (must-have)

The fix for the silent-success problem belongs in
`achievement_hunter/src/pipeline/command_verifier.js`, **not** in
`skills.js`. The verifier layer already runs after every skill call,
snapshots inventory before/after, and reclassifies `success: true` →
`success: false` with `verifier_failed:<reason>` when the post-condition
is unmet. `executeCommandWithModeRecovery` (`command_utils.js:56-89`)
does the snapshot + dispatch; the verifier file is the only edit needed.

Why the verifier (not `useToolOnBlock`):

- Matches the established pattern. `!collectBlocks`, `!craftRecipe`,
  `!smelt_item`, `!placeHere`, `!consume`, and `!attack` all do
  inventory-delta verification purely from the verifier file. There is
  no precedent for putting this logic in the skill.
- Keeps the change inside `achievement_hunter/`. Per `CLAUDE.md`,
  edits to upstream `src/` files require AH marker comments and the
  patch system — a verifier entry avoids that entirely.
- Catches every code path that ends in `useToolOnBlock` (including
  future ones) without per-path shims in the skill.
- `inventory` is already a registered shard in `snapshot_state`; no
  plumbing changes.

Verifier entry shape (drop into `command_verifiers` next to `!attack`):

- **needs:** `new Set(['inventory'])` — same shard `!collectBlocks` uses.
- **verify({args, pre, post}):**
  - Destructure `[tool_name, target] = args ?? []`.
  - If `tool_name` is not bucket-like (`bucket`, `water_bucket`,
    `lava_bucket`, `milk_bucket`), return `{ok: true, reason:
    'non_bucket_tool'}` (pass-through; shears/dye/etc. don't have a
    contract yet).
  - Map `target` (lowercased) → expected filled-bucket item:
    - `lava` → `lava_bucket`
    - `water` → `water_bucket`
    - `cow` / `mooshroom` → `milk_bucket`
    - else → `{ok: true, reason: 'unknown_useOn_target:' + target}`.
  - `before = pre?.inventory?.[filled] ?? 0`
  - `after  = post?.inventory?.[filled] ?? 0`
  - Return `after > before ? {ok: true, reason: 'delta=' + (after-before)}
    : {ok: false, reason: 'bucket_unfilled'}`.

That's the entire fix for the silent-success problem. The pasted log's
repeated `success: true / no inventory change` becomes
`verifier_failed:bucket_unfilled`; the SPL stops looping; the
`failure_replanner` gets honest input and a specific failure reason
(rather than guessing "flowing lava" or "wrong position").

Argument-parser note: `extract_command_args` (`command_verifier.js:787-800`)
already handles `!useOn("bucket", "lava")` — both args are JSON-quoted
strings, so `JSON.parse('["bucket", "lava"]')` returns `["bucket", "lava"]`.
No parser changes.

### Layer B — Skill-side improvements in `useToolOnBlock` (revised)

Layer A converts silent successes into honest failures. Layer B aims to
make the bucket *actually fill* more often, so the verifier has less work
to do. This **is** a `skills.js` change (upstream file — AH marker
comments required per `CLAUDE.md`).

After more careful evaluation, the original Layer B had three pieces; two
were oversold, and there's a fourth piece that's better than the weakest
original. Honest assessment below.

#### B1 — Synchronous `lookAt` + tick wait (recommended)

**Change:**

```js
await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
await bot.waitForTicks(1);
await bot.activateItem();
```

**Why it helps:** `bot.activateItem()` sends a `use_item` packet whose
server-side raycast uses the player's *currently transmitted* pitch/yaw.
`bot.lookAt(pos)` with `force=false` (the current default) can resolve
on the JS side before the look-update packet is flushed, so `use_item`
arrives at the server while the player is still facing wherever they
were before. `force=true` flushes immediately; `waitForTicks(1)` lets
the server apply it before the `use_item` packet arrives. This
plausibly explains the "sometimes works, sometimes doesn't" pattern in
the log — the failure is racy, not geometric.

**Risk:** Very low. Two-line change, no behavior change on the happy
path beyond one tick of latency.

#### B2 — Pre-flight `blockAtCursor` gate with nested lookAt + drift-conditional reposition retry (recommended)

**Change:** Before `activateItem`, check that `bot.blockAtCursor(5)`
returns the target source block. If it doesn't, retry — first with
cheap re-`lookAt` cycles, then (only if the bot has drifted out of
reach) with a single `goToPosition` reposition. If still wrong after
the budgets, `return false`.

```js
const LOOK_RETRIES = 3;
const REPOS_RETRIES = 1;
const REPOS_DRIFT_THRESHOLD = 2.5;  // blocks

let aimed = null;
for (let r = 0; r <= REPOS_RETRIES; r++) {
  for (let i = 0; i < LOOK_RETRIES; i++) {
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    await bot.waitForTicks(1);
    aimed = bot.blockAtCursor(5);
    if (aimed && aimed.position.equals(block.position)) break;
  }
  if (aimed && aimed.position.equals(block.position)) break;

  if (r < REPOS_RETRIES) {
    const drifted =
        bot.entity.position.distanceTo(block.position) > REPOS_DRIFT_THRESHOLD;
    if (drifted) {
      log(bot, `Bot drifted to ${bot.entity.position}; ` +
          `repositioning to ${block.position}.`);
      await goToPosition(
          bot, block.position.x, block.position.y, block.position.z, distance);
    } else {
      // Already in position — reposition would be a no-op. Bail out
      // and let Layer A's verifier + failure_replanner choose a smarter
      // recovery (different angle, dig-through, etc.).
      break;
    }
  }
}
if (!aimed || !aimed.position.equals(block.position)) {
  log(bot, `Raycast does not hit ${block.name} source at ${block.position} ` +
      `after ${LOOK_RETRIES} lookAt × ${REPOS_RETRIES + 1} reposition cycles ` +
      `(aimed at ${aimed?.position ?? 'nothing'}); not activating ${toolName}.`);
  return false;
}
```

**Why a pre-flight check at all:** `bot.blockAtCursor(reach)` uses
mineflayer's client-side raycast from the player's eye in the look
direction. That is the same primitive the server uses for `use_item`'s
targeting. If the client-side raycast doesn't see the source block,
the server's `use_item` raycast won't either, and the fill is
guaranteed to miss. Firing the packet anyway just wastes a tick and
burns a verifier attempt.

**Why nested retries (look inside, reposition outside):** the two
loops address different failure modes with very different costs.

| Cause | Look retry fixes? | Reposition fixes? |
|---|---|---|
| Look-update packet raced; one `waitForTicks` wasn't enough | Yes (~50 ms) | Yes, but expensively |
| Bot's pitch/yaw nudged by physics or a mode tick between calls | Yes (~50 ms) | Yes, but expensively |
| Bot fell off edge / got pushed by mob between `goToPosition` and `lookAt` | No | **Yes** |
| Bot landed in partial-block state (mid-fall, jostled, half in lava) | No | **Yes** |
| Intervening flowing-lava cell at current angle | No | No — same geometry |
| Bot too far / wrong horizontal spot to begin with | No | No — pathfinder lands in same wrong spot |

Cheap lookAt retries (~50 ms each) handle the look-race and nudge
cases. A single drift-conditional `goToPosition` (~200 ms when bot is
already there, seconds when it actually has to re-path) handles the
"bot drifted" cases. Anything else bails to the verifier and the
failure_replanner.

**Why reposition is gated on drift:** `goToPosition` to the same spot
when the bot is already within range is essentially a no-op — same
position in, same position out, same raycast result. Looping it
provides no new information. The drift check
(`distanceTo(block.position) > 2.5`) is the cheap signal that
reposition would actually move the bot. Without that check, the loop
either wastes seconds in a no-op or makes the failure mode invisible
to the replanner by hiding it inside the skill.

**Bounding the retries — slippery slope:** the failure_replanner
already retries `!useOn` after a `bucket_unfilled` verifier hit, with
context the skill doesn't have (the broader plan, prior recovery
attempts, etc.). The in-skill retry is justified only for *transient*
failures the replanner would also recover from but more slowly
(LLM round-trips take seconds; in-skill retries take milliseconds).
`REPOS_RETRIES = 1` keeps the in-skill escalation tight; deeper
recovery is the replanner's job.

**Risk:** Low–medium. Edge cases:
- `blockAtCursor` may handle fluid boundingBoxes differently in this
  mineflayer version. **Smoke-test first** (see Step 3b) — confirm it
  returns the source block when the bot looks at it from above and
  from the side. If the from-above raycast returns null, the gate must
  use `bot.world.raycast` with a fluid-aware matcher, or skip the
  from-above arm.
- Position equality (`aimed.position.equals(block.position)`) is the
  primary signal, not name — accounts for fluid block returning a
  different name than expected.
- Retry counts are guesses; tune from rollout data.
- Drift threshold of 2.5 blocks is approximate; the goal is "would
  `goToPosition` do anything?" — bot already within reach → no
  benefit; bot out of reach → reposition is the fix.

This replaces the speculative "side-adjacent slot" piece from the
original plan with two grounded checks: a raycast gate that uses the
same primitive the server uses, and a drift-conditional reposition
that addresses a real failure mode (physics/mob displacement) without
duplicating the failure_replanner.

#### B3 — Fail-fast on `goToPosition` unreachable (optional polish)

**Change:** After `goToPosition`, if
`bot.entity.position.distanceTo(block.position) > 2.5`, log and
`return false` before `activateItem`.

**Why it (barely) helps:** With Layer A already in place, this case is
caught by the verifier as `bucket_unfilled`. The only win is:
- One fewer `activateItem` call per failed attempt.
- A more specific failure message (`out_of_reach` vs `bucket_unfilled`)
  for the failure_replanner.

**Risk:** Very low.

**Verdict:** Optional. Ship only if profiling shows meaningful tick
savings on real rollouts, or if the failure_replanner is choosing the
wrong recovery based on the generic `bucket_unfilled` message.

#### B4 — Side-adjacent slot at source Y (NOT recommended)

The original plan justified this with "lookAt straight down is flaky in
mineflayer because the player's bounding box clips the top face." On
re-examination that claim doesn't hold up:

- In vanilla Minecraft, standing on top of a lava source and looking
  straight down is a standard technique for safe lava collection.
- The bot's bounding box (~1.8 m tall, ~0.6 m wide) sits *above* the
  lava's top face (y=70) when feet are at y=70. It touches the face but
  doesn't penetrate it. The server-side raycast from eye (y≈71.6) going
  toward the targeted point (y=69.5) cleanly hits the top face at y=70
  before anything else.
- There's no documented mineflayer-specific quirk that breaks this case.

The *real* benefit of a side-adjacent slot, if any, is incidental: a
side-adjacent position is ~1 block from the source center vs ~1.6
blocks diagonally from above, so the raycast is shorter and less
likely to be intercepted by intervening flowing-lava cells. But the
log shows the bot already getting within 2 blocks, so distance isn't
the limiting factor at the "reached" case.

Risks of implementing it:

- **Side-slot selection complexity.** Candidate slot may itself be
  lava/water, may be unreachable, may be on the wrong side of the
  source pool entirely.
- **Lava damage.** Adjacent walkable slot at source Y is exactly the
  position where the bot stands in flowing lava and takes damage.
- **BUG8 interaction.** Changes which approach `viewBlocked` evaluates;
  cave-geometry dig-through path may stop triggering correctly.
- **Risk/reward.** Speculative benefit, real implementation cost,
  multiple regression surfaces.

**Verdict:** Drop unless profiling on real rollouts proves the "from
above" case is the dominant failure mode after B1+B2 ship.

---

## 3. Confidence Report

| Claim | Confidence | Basis |
|---|---|---|
| `useToolOnBlock` returns `true` unconditionally after `bot.activateItem()` | **High** | Direct read of `skills.js:2253-2260`. No branching. |
| The flowing-vs-source filter is already correct | **High** | `skills.js:2185` `metadata === 0`. Confirmed by BUG7 patch context. |
| `goToPosition(..., 2)` can return without reaching | **High** | Log line `Unable to reach 124, 69, -37, you are 3 blocks away.` Multiple occurrences. |
| A verifier entry in `command_verifier.js` correctly reclassifies the silent-success case | **High** | Same mechanism as the `!digDown` verifier, which is *already* reclassifying `!digDown(2)` as `verifier_failed:no_descent` in the pasted log. Existing `inventory` shard + `executeCommandWithModeRecovery` plumbing — no new infrastructure. |
| `target` / `tool_name` parse cleanly via `extract_command_args` | **High** | Both are JSON-quoted strings; `extract_command_args` (`command_verifier.js:787-800`) handles them today for `!collectBlocks("oak_log", 3)`. |
| Look-sync race (`use_item` packet arrives before look update) is a real failure mode | **Medium** | Consistent with "sometimes works, sometimes doesn't" log pattern. Not directly proven from log alone — would need packet trace to confirm. |
| `await bot.lookAt(target, true)` + `waitForTicks(1)` (B1) reduces look-sync races | **Medium–High** | Standard mineflayer mitigation; `force=true` flushes the look packet synchronously. Cheap to verify on a rollout. |
| `bot.blockAtCursor(5)` post-`lookAt` (B2) reliably predicts whether `use_item` will hit the source | **Medium** | Both use the same client-side raycast primitive — but mineflayer's raycast may handle fluid bounding-boxes differently from the server. Need to verify the position-equality check (not name) catches the lava case correctly. |
| Bounded inner-`lookAt` retry (B2) catches transient look-state perturbations cheaply | **Medium–High** | Each retry costs ~50 ms; budget of 3 is plenty for the look-race and physics-nudge cases without meaningful happy-path latency cost. |
| Drift-conditional reposition (B2) catches the "bot got pushed / fell" failure mode | **Medium** | Plausible but unproven in this log — the log doesn't show position deltas between `goToPosition` and the failed `useOn`. The drift gate makes the addition cheap on the happy path: triggers only when `distanceTo > 2.5`. |
| Same-spot reposition with no drift would be a no-op | **High** | `goToPosition` short-circuits when already within range. The drift gate exists specifically to avoid this no-op loop. |
| Bounding-box "clipping top face" claim from original Layer B | **Refuted** | Vanilla MC fills buckets from above routinely. Bot's bounding box sits above y=70, doesn't penetrate the lava's top face. Re-examination of geometry showed no mineflayer-specific quirk supporting this. |
| Side-adjacent slot (B4) raises success rate vs from-above | **Low** | Speculative. The plausible benefit is "shorter raycast → fewer intercepts" but unproven, and the side-slot has its own failure modes (lava damage, unreachable). |
| Verifier won't regress milk-bucket / water-bucket flows | **Medium** | The `unknown_useOn_target` and `non_bucket_tool` pass-throughs default to "trust the skill" so any unmapped target is a no-op. Cow/mooshroom mapping should be confirmed against a milking rollout before relying on it. |
| Layer A is contained to one file | **High** | Verified — `command_verifiers['!useOn']` entry only. 10 unit tests pass; full pipeline suite (192 tests) still green. |

**Overall:**
- **Layer A:** High confidence; shipped.
- **Layer B1 (sync lookAt):** Medium–high confidence it helps. Cheap. Recommend ship.
- **Layer B2 (pre-flight `blockAtCursor`):** Medium confidence. Cheap-ish, addresses a real signal. Recommend ship.
- **Layer B3 (fail-fast on distance):** Low confidence it adds value beyond Layer A. Optional polish.
- **Layer B4 (side-adjacent slot):** Low confidence. Recommend skip.

Recommend landing B1+B2 together after Layer A has soaked on a rollout
or two. If they don't visibly reduce verifier firings, the failure
mode is something other than I've hypothesized and further skill-side
work should pause until a packet-level trace is available.

---

## 4. Step-by-Step Plan

### Step 0 — Reproduce locally

- [ ] Pick a rollout that consistently hits the silent-success loop. The
      pasted log is one; the
      `fill_a_bucket_with_lava_have_a_lava_bucket_in_the_inventory` PTD
      is the canonical reproducer. `acquire_diamonds` exercises water
      buckets through the same code path.
- [ ] Confirm the pre-fix behavior by reading the log: repeated
      `Used bucket on lava` with `success: true` and no `lava_bucket`
      appearing in subsequent `nearby_blocks`/inventory state.

### Step 1 — Layer A: `!useOn` verifier in `command_verifier.js`

**File:** `achievement_hunter/src/pipeline/command_verifier.js`
(Inside `achievement_hunter/` — no AH markers needed.)

- [ ] Add a constant near the top of the file (alongside `BLOCK_DROPS`,
      `MOB_DROPS`, `SMELT_OUTPUT`):
      ```js
      const USEON_FILLED_BUCKET = {
        lava: 'lava_bucket',
        water: 'water_bucket',
        cow: 'milk_bucket',
        mooshroom: 'milk_bucket',
      };
      const BUCKET_TOOLS = new Set([
        'bucket', 'water_bucket', 'lava_bucket', 'milk_bucket',
      ]);
      ```
- [ ] Add a `'!useOn'` entry to `command_verifiers` (place it after
      `'!attack'` so all inventory-delta verifiers cluster together):
      ```js
      '!useOn': {
        needs: new Set(['inventory']),
        verify: ({args, pre, post}) => {
          const tool = args?.[0];
          const target = args?.[1];
          if (typeof tool !== 'string' || typeof target !== 'string') {
            return {ok: true, reason: 'unparseable_args'};
          }
          if (!BUCKET_TOOLS.has(tool)) {
            return {ok: true, reason: 'non_bucket_tool'};
          }
          const filled = USEON_FILLED_BUCKET[target.toLowerCase()];
          if (!filled) {
            return {ok: true, reason: `unknown_useOn_target:${target}`};
          }
          const before = pre?.inventory?.[filled] ?? 0;
          const after = post?.inventory?.[filled] ?? 0;
          return after > before ?
              {ok: true, reason: `delta=${after - before}`} :
              {ok: false, reason: 'bucket_unfilled'};
        },
      },
      ```
- [ ] Sanity-check that `extract_command_args` correctly parses
      `!useOn("bucket", "lava")` → `["bucket", "lava"]` (it already
      does for `!collectBlocks("oak_log", 3)` — same shape).
- [ ] Trace one invocation in your head:
      `executeCommandWithModeRecovery` → `required_pre_state('!useOn(...)')`
      returns `{'inventory'}` → `snapshot_state` captures inventory →
      skill runs → post-state snapshot → `verify_command_outcome` calls
      the new verifier → if no `lava_bucket` delta, result is rewritten
      to `success: false, message: 'verifier_failed:bucket_unfilled | …'`.

### Step 2 — Tests for Layer A

- [ ] Add a unit case in
      `achievement_hunter/src/pipeline/__tests__/` (mirror an existing
      verifier test if one exists; otherwise file alongside
      `cook_a_porkchop_test.js`):
      - Pre-state: `{inventory: {bucket: 1}}`.
      - Post-state: same (no `lava_bucket`).
      - Command: `!useOn("bucket", "lava")`.
      - Expect `verify_command_outcome` → `{verified: true, ok: false,
        reason: 'bucket_unfilled'}`.
- [ ] Add the success case:
      - Pre-state: `{inventory: {bucket: 1}}`.
      - Post-state: `{inventory: {lava_bucket: 1}}`.
      - Expect `{verified: true, ok: true, reason: 'delta=1'}`.
- [ ] Add the pass-through cases:
      - `!useOn("shears", "sheep")` → `{ok: true, reason: 'non_bucket_tool'}`.
      - `!useOn("bucket", "nothing")` → `{ok: true, reason:
        'unknown_useOn_target:nothing'}`.

### Step 3 — Layer B: skill-side improvements (independent follow-up)

**File:** `src/agent/library/skills.js`
**Markers:** wrap edits in `// Start of AH code` / `// End of AH code`
(see `CLAUDE.md` — file is outside `achievement_hunter/`).

Recommend shipping B1 and B2 together; B3 optional; skip B4. Defer
until Layer A has soaked on a rollout — if Layer A's verifier rarely
fires in practice, Layer B is unneeded.

#### Step 3a — B1: synchronous `lookAt`

- [ ] In `useToolOnBlock` (around `skills.js:2216`), replace:
      ```js
      await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
      ```
      with:
      ```js
      // Start of AH code
      await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
      await bot.waitForTicks(1);
      // End of AH code
      ```
- [ ] Verify the BUG8 `viewBlocked` check (which runs after the
      `lookAt`) still operates on the updated look direction — it should,
      since the look update is now flushed synchronously.

#### Step 3b — B2: pre-flight `blockAtCursor` gate with nested lookAt + drift-conditional reposition retry

- [ ] In `useToolOnBlock`, replace the single `lookAt` from B1 with a
      nested retry structure: cheap `lookAt` retries inside,
      drift-conditional `goToPosition` reposition outside. For
      bucket-on-fluid only — keep the non-bucket / non-fluid paths
      using B1's single `lookAt`:
      ```js
      // Start of AH code
      const target_pos = block.position.offset(0.5, 0.5, 0.5);
      const verify_aim =
          toolName.includes('bucket') &&
          (block.name === 'lava' || block.name === 'water');
      const LOOK_RETRIES = 3;
      const REPOS_RETRIES = 1;
      const REPOS_DRIFT_THRESHOLD = 2.5;

      if (verify_aim) {
        let aimed = null;
        outer: for (let r = 0; r <= REPOS_RETRIES; r++) {
          for (let i = 0; i < LOOK_RETRIES; i++) {
            await bot.lookAt(target_pos, true);
            await bot.waitForTicks(1);
            aimed = bot.blockAtCursor(5);
            if (aimed && aimed.position.equals(block.position)) break outer;
          }
          if (r < REPOS_RETRIES) {
            const drifted =
                bot.entity.position.distanceTo(block.position) >
                REPOS_DRIFT_THRESHOLD;
            if (!drifted) break;  // reposition would be a no-op
            log(bot, `Bot drifted to ${bot.entity.position}; ` +
                `repositioning to ${block.position}.`);
            await goToPosition(
                bot, block.position.x, block.position.y, block.position.z,
                distance);
          }
        }
        if (!aimed || !aimed.position.equals(block.position)) {
          log(bot, `Raycast does not hit ${block.name} source at ` +
              `${block.position} after ${LOOK_RETRIES} lookAt × ` +
              `${REPOS_RETRIES + 1} reposition cycles ` +
              `(aimed at ${aimed?.position ?? 'nothing'}); ` +
              `not activating ${toolName}.`);
          return false;
        }
      } else {
        await bot.lookAt(target_pos, true);
        await bot.waitForTicks(1);
      }
      // End of AH code
      ```
- [ ] Note: this subsumes B1's `lookAt` change on the fluid path. B1's
      single-`lookAt` snippet in Step 3a remains only for the non-fluid
      branch.
- [ ] **Smoke-test fluid raycasting first.** Before shipping, verify
      `bot.blockAtCursor(5)` returns the source block when the bot
      looks at it:
      - From above (feet on top of source, looking straight down).
      - From the side (feet at source Y, adjacent x/z, looking
        horizontally).
      If `blockAtCursor` returns null in either case (mineflayer skips
      fluid bounding-boxes), the gate must use a different primitive —
      switch to `bot.world.raycast` with a fluid-aware matcher, or
      drop the from-above arm and fall back to current behavior there.
      Verify before merging.
- [ ] Tune retry counts based on smoke test and one rollout:
      - If a single `lookAt` succeeds almost always → `LOOK_RETRIES = 1`.
      - If `LOOK_RETRIES = 3` is sometimes insufficient even after a
        reposition → look-state is being reset by something else;
        pause and diagnose before raising the budget.
      - If `goToPosition` reposition almost never triggers in the log
        (`drifted` ~always false) → drift is rare; `REPOS_RETRIES = 0`
        and rely on look retries + replanner.
      - If reposition triggers and frequently succeeds →
        `REPOS_RETRIES = 1` is correct; don't raise further.
- [ ] Confirm the reposition path doesn't loop pathologically: if
      `goToPosition` itself fails (no path), the next `lookAt` cycle
      will produce the same `aimed != source` result and the loop will
      exit on `REPOS_RETRIES` exhaustion. Verify in a hand-test that
      this terminates within ~1 s.

#### Step 3c — B3 (optional): fail-fast on distance

- [ ] After `goToPosition`, check
      `bot.entity.position.distanceTo(block.position) > 2.5`. If so,
      log `Could not get within 2 blocks of <block>; not using <tool>`
      and `return false`.
- [ ] Only ship this if Layer A's `bucket_unfilled` message is too
      generic for the failure_replanner — otherwise the verifier
      handles this case already.

#### Step 3d — B4: DROPPED

The "prefer side-adjacent slot at source Y" piece from the original
plan is dropped. Geometric justification didn't hold up on
re-examination (vanilla MC fills from above routinely), risk/reward
ratio is poor (lava-damage edge cases, BUG8 interaction,
implementation complexity). Re-add only if rollout data after B1+B2
shows from-above fills still failing at a meaningful rate.

### Step 4 — Tests for Layer B

- [ ] Replay the rollout from §1 with B1+B2 enabled. Expect:
      - Reduced `verifier_failed:bucket_unfilled` count.
      - Some `!useOn` calls return `Raycast does not hit lava source`
        (B2's new failure path) instead of `success: true` followed by
        `bucket_unfilled` (faster + more specific signal).
- [ ] BUG8 regression: hand-construct a cave scenario where the only
      approach is from above. Confirm B2's pre-flight check still
      passes when the bot is correctly positioned above the source,
      and that BUG8's dig-through path is unaffected.
- [ ] B2 fluid-raycast smoke test:
      - Spawn near a lava source, `lookAt` its top face, call
        `bot.blockAtCursor(5)`. Confirm `.position` equals the source's
        block coords. If not, B2's gate logic needs adjustment before
        shipping (see Step 3b's last sub-item).

### Step 5 — Documentation

- [ ] Create a bug report in
      `achievement_hunter/docs/bug_reports/unpatched/` named
      `BUG21_useOn_bucket_silent_success_no_inventory_check.md`
      following BUG7/BUG8 structure (Symptom / Root Cause / Fix / Patch
      location).
- [ ] After Layer A lands:
      - Update its `Status` to `Fixed — applied on branch <branch>`.
      - Add `**Patch location:**` with `file:line` range for the
        `'!useOn'` entry in `command_verifier.js`.
      - Move the file to `patched/`.
      - Remove the row from `unpatched/README.md`; add a row to
        `patched/README.md`.
      (Per `CLAUDE.md` bug-report flow.)
- [ ] If/when Layer B lands, file a separate report (BUG22 or similar)
      for the positioning issue, since it has independent root cause
      and patch location.

### Step 6 — Verification on real rollouts

- [ ] Re-run the rollout that produced the original log. Expected new
      behavior with Layer A only:
      - First `!useOn` returns `success: false` with message
        `verifier_failed:bucket_unfilled | Action output: … Used bucket
        on lava.`.
      - `failure_replanner` no longer guesses "flowing lava"; it sees
        `bucket_unfilled` and proposes a positioning fix
        (`!goToCoordinates` to an adjacent slot, then `!useOn`).
      - Within a few replanner attempts, `lava_bucket` appears in
        inventory and the SPL completes.
- [ ] Scan for regressions on adjacent skills:
      - `acquire_diamonds` (uses `!useOn` for water buckets) —
        verifier should pass on successful water pickups and reclassify
        silent failures the same way.
      - `cook_a_pork_chop` (no bucket use) — sanity check no regression
        in the verifier path.
      - Any PTD that calls `!useOn` on entities with non-bucket tools
        (shears on sheep, dye on sheep, etc.) — verifier's
        `non_bucket_tool` pass-through should leave them untouched.

---

## 5. Risks & Open Questions

- **Cow / mooshroom mapping in the verifier.** The skill's entity path
  (`skills.js:2164-2179`) uses `bot.useOn(entity)`, not `activateItem`,
  and milking is generally reliable. Including `cow` / `mooshroom` in
  `USEON_FILLED_BUCKET` reclassifies any failed milking too. If a
  milking rollout shows false negatives, drop those entries — the
  silent-success problem is specifically the block-target path.
- **`extract_command_args` strictness.** If the LLM ever emits
  `!useOn(bucket, lava)` without quotes, `JSON.parse` fails and the
  verifier pass-throughs with `unparseable_args`. That's the same
  behavior every other verifier has and is the right default — surfaces
  the malformed command via the SPL rather than via a verifier-level
  reclassification.
- **Inventory shard staleness.** `post.inventory` is captured by
  `snapshot_state` immediately after the skill returns. The skill
  itself awaits `bot.activateItem()` synchronously, but the inventory
  *update packet* may arrive asynchronously. If verifier false-
  negatives appear on rollouts where the bucket clearly filled (visible
  in subsequent state), add a brief inventory-settle wait inside
  `executeCommandWithModeRecovery` before `snapshot_state(agent,
  verifier_needs)` for the post snapshot — but only if observed; don't
  pre-emptively slow down every command.
- **B2 fluid-raycast behavior (Layer B only).** `bot.blockAtCursor`
  uses mineflayer's client raycast. Depending on the version, it may
  skip blocks whose boundingBox is `empty` — flowing lava has empty
  bbox; source lava may or may not. If the raycast skips the source
  block, B2's gate would false-fail every fill from above. Mitigation:
  smoke-test before shipping; if needed, use `bot.world.raycast` with a
  fluid-aware matcher, or relax the gate when looking near-vertical at
  a fluid pool.
- **Look-sync race is hypothesis, not proof (Layer B only).** B1
  assumes the `use_item` packet sometimes arrives before the look
  update is processed server-side. This is consistent with the log but
  not directly proven. If B1 ships and the verifier still fires at the
  same rate, the failure mode is elsewhere and further skill-side work
  should pause until a packet trace is available.

---

## 6. Done Criteria

**Layer A (required):**

- `command_verifiers['!useOn']` is registered and gated on `BUCKET_TOOLS`
  + `USEON_FILLED_BUCKET`.
- `executeCommandWithModeRecovery` reclassifies silent-success
  `!useOn("bucket", "lava")` calls as `success: false` with
  `verifier_failed:bucket_unfilled`.
- The original rollout no longer burns 5 AM attempts + 3 recovery
  attempts on silent-success `!useOn` loops; recovery now sees an
  honest failure signal on the first attempt.
- Unit tests cover: silent-success → `bucket_unfilled`, real success →
  `delta=1`, `non_bucket_tool` pass-through, `unknown_useOn_target`
  pass-through.
- BUG21 is filed and moved to `patched/` with `file:line` patch
  location pinned to the `command_verifier.js` entry.

**Layer B1+B2 (recommended follow-up, only if A's verifier fires often):**

- Non-fluid path: `bot.lookAt(target, true)` + `bot.waitForTicks(1)`
  precedes `bot.activateItem()`.
- Bucket-on-fluid path: nested retry — up to 3 `lookAt` retries inner,
  up to 1 drift-conditional `goToPosition` reposition outer, with a
  final `blockAtCursor(5)` gate. If raycast still doesn't hit the
  source after the budget, `useToolOnBlock` returns false before
  `activateItem`.
- Reposition only triggers when
  `distanceTo(block.position) > 2.5` (drift detected); same-spot
  reposition is gated out as a no-op.
- BUG8 cave scenario still passes (dig-through fallback intact, B2
  gate confirmed to pass on legitimate from-above approaches).
- Verifier firing rate measurably drops on the canonical lava-bucket
  rollout.

---

## 7. Recommendations

**Implement:**

1. **Layer A** (already shipped). Inventory-delta verifier for `!useOn`
   in `command_verifier.js`. Load-bearing fix; done.
2. **Layer B1** — synchronous `lookAt(target, true)` +
   `waitForTicks(1)` in `useToolOnBlock`, applied to the non-fluid
   branch. (Subsumed by B2 on the fluid branch.) Two-line change, low
   risk, addresses a plausible look-update race. Ship after Layer A
   has soaked on one rollout.
3. **Layer B2** — pre-flight `blockAtCursor(5)` gate for bucket-on-
   fluid in `useToolOnBlock`, with **nested retries**:
   - **Inner loop** — up to 3 cheap `lookAt` retries (~50 ms each) to
     self-heal look-update races and physics/mode nudges to pitch-yaw.
   - **Outer loop** — at most 1 drift-conditional `goToPosition`
     reposition, triggered only when
     `distanceTo(block.position) > 2.5` (i.e. the bot has actually
     moved off the intended spot). Same-spot reposition is gated out
     so it doesn't loop pathologically as a no-op.
   - Ships alongside B1 (B2 subsumes B1's `lookAt` change on the fluid
     path). **Requires a smoke test first** to confirm mineflayer's
     raycast returns the source block when looked at — if it doesn't,
     switch to `bot.world.raycast` with a fluid-aware matcher or drop
     the from-above arm.

**Do not implement (yet):**

4. **Layer B3** — fail-fast on initial `goToPosition` distance. B2's
   drift check covers the "bot drifted" case; Layer A catches the
   "skill fired anyway" case. B3 would only add a slightly more
   specific failure message; rely on B2's logging instead.
5. **Layer B4** — side-adjacent slot at source Y. Original
   justification didn't hold up on re-examination. The risk surface
   (lava damage, slot-selection complexity, BUG8 interaction)
   outweighs the speculative benefit. Re-consider only if rollout
   data after B1+B2 ship shows from-above fills failing at a
   meaningful rate.

**Slippery-slope discipline:** B2's retry escalation is intentionally
tight (3 looks × 1 reposition × ~1 s total worst case). The
failure_replanner already retries `!useOn` after a `bucket_unfilled`
verifier hit with broader plan context the skill doesn't have. We add
in-skill retries only for the *transient* failures the replanner
would also recover from but slowly (LLM round-trips take seconds).
Anything deeper is the replanner's job — don't grow this loop further.

**Stop point:** if Layer A + B1 + B2 ship and the verifier still fires
on most lava-bucket attempts, do not add more skill-side mitigations.
The failure mode is something other than what's hypothesized, and
diagnosis should switch to packet-level inspection (logging the
`use_item` packet's look state, comparing client and server raycast
outcomes) before more code lands.

**Order of operations:**

1. ✅ Layer A — done.
2. File BUG21 documenting the silent-success bug and the verifier fix
   (per §4 Step 5).
3. Soak Layer A on one or two real rollouts. Read the verifier firing
   rate from the SPL logs to confirm Layer B is worth doing.
4. If firings are frequent:
   - Run B2's smoke test (`blockAtCursor` on a lava source from above
     and from the side) before writing the skill change.
   - Implement B1 (non-fluid path) and B2 (fluid path) together.
   - Tune `LOOK_RETRIES` and `REPOS_RETRIES` from the smoke test +
     one rollout.
5. Soak again. Compare verifier firing rate before/after. If it drops
   meaningfully → done. If not → pause and diagnose with packet-level
   tracing rather than adding more skill-side code.
