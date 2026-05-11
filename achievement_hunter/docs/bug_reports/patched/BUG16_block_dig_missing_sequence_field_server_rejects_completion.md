# BUG 16 — `block_dig` Packet Sent Without `sequence` Field; Server Rejects Dig Completion in 1.21

**Severity:** High (resource collection via `bot.dig` fails silently for hardness>0
blocks; chains into BUG 15's SPL livelock and BUG 12-family unstuck cascades)
**Status:** Fixed (Fix 1 applied; Fix 2 deferred) — applied on branch `main`
**Branch:** `main`
**Patch location:** `patches/mineflayer+4.37.1.patch`
- `digging.js` inject head — adds bot-level `bot._inputSequence` + `bot._nextInputSequence()` (idempotent across plugins).
- `digging.js` three `block_dig` write sites (start at status 0, finish at status 2, cancel at status 1) — each now includes `sequence: bot._nextInputSequence()`.
- `inventory.js` — replaces the old plugin-local `let sequence = 0` / `sequence++` with the shared bot-level counter so `use_item` and `block_dig` (release) draw from the same monotonic stream.
- `inventory.js` `deactivateItem` — `body.sequence = bot._nextInputSequence()` (was `0`).
- `digging.js` `digTime` — `incorrect_for_wooden_tool` → `mineable/pickaxe` material rewrite (migrated from the now-deleted `mineflayer+4.33.0.patch`; still needed in 4.37.1, complements Fix 1 by also aligning the bot's locally computed dig duration with the server's).
- `place_block.js` — `timeout: 5000` → `timeout: 500` (also migrated from the old patch).
- Stale `patches/mineflayer+4.33.0.patch` deleted; its still-relevant hunks migrated into `mineflayer+4.37.1.patch`; the `isInWater = false` workaround and `use_item` rotation fix were intentionally NOT migrated because upstream 4.37.1 already does the correct thing (block-at-eye-level for water; `toNotchianYaw/Pitch` for rotation).
**Trace:** `achievement_hunter/rollouts/2026-05-11T01-42-44-300Z_test/` (the livelock
that motivated BUG 15) and live observation of an iron-ore dig from a follow-up
reproduction.
**Related files:**
- `node_modules/mineflayer/lib/plugins/digging.js:130–159` — `bot.dig` writes
  `block_dig` packets with `{status, location, face}` only; the schema-required
  `sequence` field is omitted.
- `node_modules/minecraft-data/minecraft-data/data/pc/1.21.1/protocol.json:8191–8210`
  — 1.21 `packet_block_dig` schema requires `status, location, face, sequence`.
- `node_modules/minecraft-data/minecraft-data/data/pc/1.21.1/protocol.json:3861–3870`
  — `packet_acknowledge_player_digging` (S→C) carries the `sequenceId` echo;
  mineflayer does not subscribe to it.
- `patches/mineflayer+4.33.0.patch` — already patches `use_item` to include
  `sequence` (see `inventory.js`), confirming that sequence-aware packets are
  load-bearing on 1.21. Same fix has not been applied to `block_dig`.

**Related bugs:**
- **BUG 15** — SPL-level livelock observed in the rollout trace. The livelock is a
  *consequence* of this bug: when `bot.dig` resolves locally but the server
  silently rejects the completion, the bot's local world is briefly out-of-sync
  with the server, the iron_ore is restored server-side, and the SPL retries the
  same `!collectBlocks(iron_ore, …)` until `unstuck` fires (BUG 15 livelock) or
  the action wedges hard (BUG 12 deadlock). Fix B for BUG 15 mitigates the
  *symptom* (task fails fast to the replanner); this report addresses the
  *cause*.
- **BUG 10** — also touches `bot.collectBlock.collect` / `bot.dig` paths but
  fixes a different mechanism (tool-equip recursion). Independent.

---

## Symptom

User-facing description: *"the bot stands on the iron block trying to mine it; the
block visually cracks, but right before it breaks the block goes back to full and
the agent keeps swinging at the now-full block until `unstuck` triggers."*

That sequence of visible events — partial crack → block snaps back to undamaged →
arm continues swinging without further crack progress — is the classic shape of a
**server-side dig-completion rejection**. The crack animation is server-broadcast
to the player's own client, so the cracks appearing at all confirms the server
*accepted* the `block_dig {status: 0}` start packet. The block reverting at the
expected completion time confirms the server *rejected* the `block_dig {status: 2}`
finish packet (or never matched it to the open dig) and replied with a block-state
correction.

This pairs with the BUG 15 trace evidence:

- `rollout_trace.json` stage 50 emits `!collectBlocks("iron_ore", 1)` from
  `(212.34, 144, -61.37)`.
- The log shows 10 consecutive `Mode interrupted command (X/10), waiting for idle`
  cycles with the bot returning to roughly the same position (`from (220, 150,
  -54)` six times) after every unstuck eviction.
- No `Collected 1 iron_ore` message is ever logged for this task; the rollout
  ends with status `"running"` and `task_traces/full_task_trace.jsonl` has no
  terminal record for the `raw_iron` task.

If `bot.dig` were completing server-side, even a single iteration would log
`Collected 1 iron_ore` and the SPL would advance. The fact that no progress is
ever made — across roughly 20 seconds per attempt × multiple attempts — is
consistent with every dig being rejected.

---

## Root Cause

`bot.dig` (`node_modules/mineflayer/lib/plugins/digging.js:130–159`) writes two
`block_dig` packets per dig (start and finish):

```js
bot._client.write('block_dig', {
  status: 0, // start digging
  location: block.position,
  face: bot.targetDigFace // default face is 1 (top)
})
waitTimeout = setTimeout(finishDigging, waitTime)
...
function finishDigging () {
  ...
  bot._client.write('block_dig', {
    status: 2, // finish digging
    location: bot.targetDigBlock.position,
    face: bot.targetDigFace
  })
  ...
  bot._updateBlockState(block.position, 0)
}
```

The 1.21 protocol schema for `block_dig`
(`minecraft-data/.../1.21.1/protocol.json:8191–8210`) is:

```json
"packet_block_dig": [
  "container",
  [
    {"name": "status",   "type": "varint"},
    {"name": "location", "type": "position"},
    {"name": "face",     "type": "i8"},
    {"name": "sequence", "type": "varint"}
  ]
]
```

The `sequence` field is **required** by the schema but the call sites above
never set it. `protodef` serializes a missing field as the type's default (`0`
for `varint`), so every `block_dig` packet leaves the bot with `sequence=0`.

In 1.21 the server uses `sequence` as the per-player monotonic counter used by
the predictive-action acknowledgement system (see
`packet_acknowledge_player_digging` at `protocol.json:3861–3870`):

```json
"packet_acknowledge_player_digging": [
  "container",
  [ {"name": "sequenceId", "type": "varint"} ]
]
```

When the bot calls `bot.dig` repeatedly:

1. First start packet at `sequence=0` → server accepts (initial state).
2. Server begins simulating the dig and broadcasts the crack-progress (visible to
   the user as "block cracks").
3. Bot's local `setTimeout(finishDigging, waitTime)` fires after the locally
   computed dig time elapses; bot writes the finish packet, still at
   `sequence=0`.
4. Server has already advanced its expected sequence past `0` (because every
   other input — `use_item`, `block_place`, etc. — was incrementing sequence
   per `inventory.js`'s counter). It receives a `block_dig` finish at a stale
   `sequence`, treats the action as non-authoritative, **rejects the finish**,
   and emits `acknowledge_player_digging` plus a `block_update` restoring the
   iron_ore. The user sees this as "block reverts to full right before it
   breaks."
5. Mineflayer's `digging.js` plugin does not subscribe to
   `acknowledge_player_digging`, so the rejection is invisible to the bot
   layer.
6. `finishDigging` *also* calls `bot._updateBlockState(block.position, 0)` —
   this writes "air" to the bot's *local* world (line 158) regardless of
   server response. The local `blockUpdate` event fires, `onBlockUpdate`
   resolves `diggingTask`, and `bot.dig()` resolves successfully from the
   bot's perspective.
7. The next chunk/block update from the server overwrites the local air with
   the restored iron_ore. The bot's outer loop in `skills.collectBlock` calls
   `getNearestBlocksWhere(... 'iron_ore' ...)` again, finds the same block, and
   re-enters `bot.collectBlock.collect()`.
8. Each cycle takes ~1.15 s (iron_ore + stone_pickaxe + on_ground per
   `prismarine-block/index.js:digTime`) plus pathfinder overhead. After ~20 s
   of "no real progress" the `unstuck` mode threshold trips
   (`src/agent/modes.js:122`, `max_stuck_time = 20`), evicting the bot —
   which is exactly the BUG 15 livelock.

### Why the `use_item` patch is the precedent

`patches/mineflayer+4.33.0.patch` shows the same class of fix already applied
to `inventory.js`:

```diff
       bot._client.write('use_item', {
         hand: offHand ? 1 : 0,
         sequence,
-        rotation: { x: 0, y: 0 }
+        rotation: { x: yawDeg, y: pitchDeg }
       })
```

The patch threads the existing `let sequence = 0; sequence++` counter
(`inventory.js:30, 117`) into the packet. That counter is closure-scoped to
the `inventory.js` `inject` function and is *not* accessible from
`digging.js` — each plugin has its own sequence variable in scope. Worse, in
1.21 the server expects a single coordinated counter per player session
across all input packets, not per-plugin counters. The correct fix is to
move sequence ownership up to a bot-level shared counter.

### Proximate vs root cause

- **Proximate (what the user sees):** the iron_ore re-appears right before
  it breaks.
- **Root (what's actually wrong):** `block_dig` is missing the `sequence`
  field required by the 1.21 protocol, and `acknowledge_player_digging` is
  unhandled, so the bot can't even *detect* that the server rejected the
  dig.

---

## Why existing safeguards didn't catch this

- **BUG 14's `goToPosition` watchdog** (`skills.js:1232–1245`) only guards
  the path-to-block phase, not the dig itself. Dig progress (or
  not-progress) is invisible to it.
- **BUG 10's `requireHarvest: true` check** confirms a tool is in inventory
  before entering `collect()`. It cannot detect a *server-side* rejection of
  the dig that follows.
- **BUG 15's Fix B** terminates the SPL retry loop after two consecutive
  `mode_interrupted` failures, but it operates *after* the dig has already
  failed silently and `unstuck` has already fired — it's a recovery, not a
  prevention.
- **`bot._updateBlockState(0)` in `finishDigging`** masks the rejection
  locally: from `mineflayer-collectblock`'s perspective the dig completed,
  the target is removed (`CollectBlock.js:57`), and the call returns
  success. The bug only manifests downstream when the world re-syncs with
  the server.
- **No subscription to `acknowledge_player_digging`** means even if the
  caller wanted to verify the dig succeeded, there's no signal to observe.

---

## Proposed Fix

This is a `node_modules/mineflayer/...` change and so goes through
`patches/mineflayer+4.33.0.patch` per the `CLAUDE.md` patch workflow. The diff
inside the patch should be wrapped with `// Start of AH code` / `// End of AH
code` markers so it's locatable on upstream merges.

### Fix 1 — Thread a bot-level sequence counter into `block_dig`

Owner: a single counter on `bot` (e.g., `bot._inputSequence`), incremented
once per outgoing input packet that the schema requires `sequence` for.
`inventory.js`'s closure-local `sequence` should migrate to the same shared
counter. Sketch (final form lives in the patch):

```js
// Start of AH code — at the top of inject(bot), digging.js
function nextSequence () {
  bot._inputSequence = (bot._inputSequence ?? 0) + 1
  return bot._inputSequence
}
// End of AH code
```

Then at the two write sites in `dig`:

```js
// Start of AH code
bot._client.write('block_dig', {
  status: 0,
  location: block.position,
  face: bot.targetDigFace,
  sequence: nextSequence()
})
// End of AH code

...

function finishDigging () {
  ...
  if (bot.targetDigBlock) {
    // Start of AH code
    bot._client.write('block_dig', {
      status: 2,
      location: bot.targetDigBlock.position,
      face: bot.targetDigFace,
      sequence: nextSequence()
    })
    // End of AH code
  }
  ...
}
```

`stopDigging` (`digging.js:165–190`) also writes `block_dig {status: 1}` and
must take a `sequence` too. Any other call site of `bot._client.write('block_dig',
...)` in `node_modules/mineflayer/lib/...` needs the same treatment.

The `inventory.js` `sequence` counter and the new bot-level counter must
become the same counter, otherwise digs and item-uses interleave with two
independent sequence streams and the server still rejects one of them. The
cleanest version of the patch deletes `inventory.js`'s `let sequence = 0`
and rewrites the existing `sequence++ → body.sequence = sequence` site to
use `bot._inputSequence`.

### Fix 2 — Subscribe to `acknowledge_player_digging` and reject `bot.dig` on stale acks

Without this, even with Fix 1, a future protocol drift would silently
revert to the same failure mode. Add a listener in `digging.js`:

```js
// Start of AH code
bot._client.on('acknowledge_player_digging', ({sequenceId}) => {
  if (bot.targetDigBlock && bot._lastDigSequence != null
      && sequenceId < bot._lastDigSequence) {
    diggingTask.cancel(new Error('block_dig sequence rejected by server'))
  }
})
// End of AH code
```

(Exact comparison semantics depend on whether the server echoes the most
recently-accepted sequence or the most recent rejected sequence; pin down
empirically. The point is: when the server's ack stalls or lags, surface
that to the caller rather than relying on `_updateBlockState(0)` to mask
it.)

### Robustness, soundness, limitations

- **Robustness:** Fix 1 is mechanical — every `block_dig` write site gets
  the missing field. Fix 2 is the watchdog; together they convert silent
  rejections into either successful digs or explicit `bot.dig`
  rejections, both of which `skills.collectBlock`'s catch handler and the
  SPL already know how to route.
- **Soundness:** sequence numbers are already in use for `use_item` in this
  codebase and on this server version. The fix extends an established
  pattern; nothing new is being invented.
- **Limitations:**
  - The patch must be applied to *every* `block_dig` write site in
    `node_modules/mineflayer/lib/...`, not just `digging.js`. A grep for
    `'block_dig'` in `node_modules/mineflayer` is required before
    landing.
  - The "bot-level counter" change touches code outside `digging.js`. If
    we keep `inventory.js`'s counter independent for short-term
    simplicity, the bug may persist intermittently (server expects
    coordinated counter). The full patch must consolidate.
  - The `acknowledge_player_digging` listener (Fix 2) may need to handle
    sequence wraparound for long-running sessions; varint sequences in
    practice won't wrap during a normal rollout but the watchdog
    comparison should be `<` with a sane epsilon, not `!=`.

### Sequencing

1. **Fix 1 immediately.** Land in `patches/mineflayer+4.33.0.patch` under
   AH markers. This is the load-bearing fix; iron-ore collection (and any
   other resource that takes >0 dig time) starts working again.
2. **Fix 2 next.** Land as a follow-up so future protocol changes can't
   silently regress to the same failure shape.
3. **Re-run the BUG 15 trace.** Expect: bot completes
   `!collectBlocks("iron_ore", 1)` cleanly, SPL advances to `raw_iron`
   smelt, no `mode_interrupted` failures. BUG 15's Fix B remains in place
   as defense-in-depth.

---

## Evidence

1. **1.21 `block_dig` schema requires `sequence`**
   (`minecraft-data/.../1.21.1/protocol.json:8191–8210`). Field is
   `varint`, no `default`/`optional` flag — protodef serializes missing as
   `0` but the server treats `0` after the first action as stale.

2. **mineflayer `digging.js` never sets `sequence`**. Three
   `block_dig` write sites (`digging.js:130–134`, `:149–153`, `:178–182`)
   all use a three-field object. `grep -n sequence
   node_modules/mineflayer/lib/plugins/digging.js` returns no matches.

3. **`inventory.js` does send `sequence` and is already patched by AH** to
   include real rotation. The `let sequence = 0; sequence++` counter
   (`inventory.js:30, 117`) demonstrates that mineflayer recognises the
   need for a per-input counter — but the implementation is plugin-local
   and not shared with digging.

4. **Visible "crack then revert" matches server rejection.** Crack
   animation is server-driven (the server broadcasts
   `block_break_animation` per tick of dig progress). If the start packet
   were rejected outright, no cracks would appear. Cracks appearing then
   the block reverting before completion is the textbook pattern of "start
   accepted, finish rejected."

5. **`finishDigging` masks the rejection locally** (`digging.js:158`,
   `bot._updateBlockState(block.position, 0)`). This is why
   `bot.dig().then(...)` resolves successfully and
   `skills.collectBlock.collected++` fires, even when no real raw_iron
   drops. Downstream SPL state checks (inventory[raw_iron] < qty) cause
   the SPL to re-issue the task — the user-visible "kept attempting to
   mine."

6. **Pattern is iron-stage specific in this trace, but generic.** Any
   block with `digTime > 0` (i.e., any non-instamine block) is exposed.
   Tasks 6–9 in `task_traces/full_task_trace.jsonl` collected stone
   successfully because… *(plausible but unverified)* the first few digs
   per session use `sequence=0` and the server may be lenient at the
   start of a session before sequence drift sets in. After many input
   packets have flowed through `use_item`/place_block, the server's
   expected `block_dig` sequence has advanced past `0` and digs start
   rejecting. Confirming this requires landing Fix 1 and observing
   whether all dig-required tasks reliably succeed.

---

## Relation to Other Bugs

- **BUG 15** documents the SPL livelock that this dig-rejection induces. BUG 15
  Fix B (early-abort on repeated `mode_interrupted`) is still useful as a
  failure-handling improvement and remains in place; with BUG 16 Fix 1
  applied, the `mode_interrupted` path should be rare-to-never on the iron
  stage.
- **BUG 12 / BUG 13** describe the harder failure mode where the dig
  *also* wedges the action and triggers `cleanKill`. BUG 16's fix reduces
  the rate at which the bot ends up in the "unstuck-friendly" position in
  the first place by making actual dig completion the normal case.
- **BUG 10** (pickaxe break OOM) and BUG 14 (snow_block canHarvest abort)
  also live in `skills.collectBlock` / pathfinder dig paths. Both fix
  different mechanisms; BUG 16 is orthogonal — none of those patches
  touches packet construction.
- **BUG 1** (entity metadata partial-read) and BUG 16 are both 1.21
  protocol-drift bugs. They reinforce the broader point that
  `patches/mineflayer+4.33.0.patch` should be audited for any other
  `*+sequence`-required packets that aren't currently threading the
  field.
