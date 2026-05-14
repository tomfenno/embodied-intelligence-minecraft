# `Collected N <block>` Messages Misrepresent the Actual Inventory Delta

## Summary

The `message` text printed for successful `!collectBlocks(...)` commands says
`Collected N <block>`, where `<block>` is the **mined block name** and `N` is
an internal counter from the collect skill. In several runs the rollout's
post-action inventory state shows that:

1. The item that actually landed in the inventory differs from `<block>` —
   the block name is reported even when the block drops something else
   (`diamond_ore` → `diamond`, `iron_ore` → `raw_iron`, `stone` → `cobblestone`).
2. The count `N` differs from the actual inventory delta — sometimes fewer
   items than the rollout shows added, sometimes many more (because the
   bot incidentally mined extra blocks while pathing).

Either way, the message is unsupported as a statement about what the bot
ended up holding, which is what downstream planning/verifier steps consume.

## Confidence

**High** for both sub-patterns. In every example below the rollout's
pre-action and post-action `state.inventory` are quoted verbatim and the
delta is arithmetic on those numbers.

## Why This Is a Message Inaccuracy

The `[SPL] Command result` message is printed by `actions.js:235` from the
raw `command_result` returned by `executeCommandWithModeRecovery`. Its
`message` field is whatever the upstream `collectBlock` skill assembled —
the skill counts how many of the named block it broke and reports that,
without reconciling against `bot.inventory` deltas. The rollout, in
contrast, snapshots actual `bot.inventory` after the action lands, so it
is the authoritative ground truth for what the bot got.

Consequence: an LLM (or human) reading `runner_stdout.log` sees a claim
about a named item and a count that does not match the inventory the
next step is going to plan against.

## Examples

### Example 1 — `diamond_ore` reported, `diamond` actually received

- Run directory: `achievement_hunter/message-audit-runs/diamonds/`
- Message source: `achievement_hunter/message-audit-runs/diamonds/runner_stdout.log`
- Rollout/source evidence: `achievement_hunter/message-audit-runs/diamonds/rollout_trace.json`
- Message excerpt (`runner_stdout.log:245-248`):

```text
[SPL] Command result: {
  success: true,
  message: 'Action output:\nCollected 1 diamond_ore.\n'
}
```

- Contradicting evidence — pre-action `state.inventory`
  (`rollout_trace.json:3434-3447`) has no `diamond` or `diamond_ore`
  entries, while the next SCSG state immediately after the action
  (`rollout_trace.json:3511-3525`) shows:

```text
"inventory": {
  "granite": 10,
  "diorite": 4,
  "spruce_log": 2,
  "cobblestone": 92,
  "diamond": 1,
  ...
}
```

- Explanation: The bot was holding an `iron_pickaxe` (no Silk Touch), so
  breaking `diamond_ore` drops `diamond`. The rollout confirms `+1 diamond`,
  but the message names the mined block (`diamond_ore`). A reader of the
  message would expect `diamond_ore` to be in inventory; the rollout shows
  `diamond` is.

### Example 2 — `iron_ore` reported, `raw_iron` actually received

- Run directory: `achievement_hunter/message-audit-runs/acquire_hardware/`
- Message source: `achievement_hunter/message-audit-runs/acquire_hardware/runner_stdout.log`
- Rollout/source evidence: `achievement_hunter/message-audit-runs/acquire_hardware/rollout_trace.json`
- Message excerpt (`runner_stdout.log:161`):

```text
[SPL] Command result: { success: true, message: 'Action output:\nCollected 1 iron_ore.\n' }
```

- Contradicting evidence — the AM step's pre-state
  (`rollout_trace.json:2188-2198`) has no `raw_iron` and no `iron_ore`;
  the post-action SCSG state (`rollout_trace.json:2256-2268`) shows:

```text
"inventory": {
  "furnace": 1,
  "spruce_log": 2,
  "dirt": 9,
  "wooden_pickaxe": 1,
  "cobblestone": 13,
  "spruce_planks": 3,
  "crafting_table": 1,
  "stone_pickaxe": 1,
  "raw_iron": 1
}
```

- Explanation: Breaking `iron_ore` with a `stone_pickaxe` drops `raw_iron`,
  not `iron_ore`. The rollout shows `+1 raw_iron`, the message reports
  `Collected 1 iron_ore`. Downstream smelting logic depends on `raw_iron`
  being in inventory; the message text would suggest the wrong item.

### Example 3 — `stone` count under-reports, drop name mismatches

- Run directory: `achievement_hunter/message-audit-runs/acquire_hardware/`
- Message source: `achievement_hunter/message-audit-runs/acquire_hardware/runner_stdout.log`
- Rollout/source evidence: `achievement_hunter/message-audit-runs/acquire_hardware/rollout_trace.json`
- Message excerpt (`runner_stdout.log:112`):

```text
[SPL] Command result: { success: true, message: 'Action output:\nCollected 11 stone.\n' }
```

- Contradicting evidence — pre-action inventory
  (`rollout_trace.json:1591-1598`) has no `cobblestone` and no `dirt`;
  the immediately-following SCSG inventory
  (`rollout_trace.json:1700-1709`) shows:

```text
"inventory": {
  "spruce_log": 2,
  "crafting_table": 1,
  "wooden_pickaxe": 1,
  "stick": 2,
  "spruce_planks": 3,
  "dirt": 9,
  "cobblestone": 13
}
```

- Explanation: Two distinct inaccuracies stack here. (a) Breaking `stone`
  with a `wooden_pickaxe` drops `cobblestone`, but the message names
  `stone`. (b) The message claims `11` but the inventory delta is
  `+13 cobblestone` and `+9 dirt` (22 blocks of material total). The
  collect skill's headline reports the requested-block counter, ignoring
  the extras it picked up while moving through dirt and stone on the way
  to/from the target — the rollout sees all of it.

### Example 4 — `spruce_log` count under-reports actual delta

- Run directory: `achievement_hunter/message-audit-runs/acquire_hardware/`
- Message source: `achievement_hunter/message-audit-runs/acquire_hardware/runner_stdout.log`
- Rollout/source evidence: `achievement_hunter/message-audit-runs/acquire_hardware/rollout_trace.json`
- Message excerpt (`runner_stdout.log:52-57`):

```text
[SPL] Command result: {
  success: true,
  message: 'Action output:\n' +
    'Failed to collect spruce_log: Timeout: Took to long to decide path to goal!.\n' +
    'Collected 4 spruce_log.\n'
}
```

- Contradicting evidence — pre-action inventory (`rollout_trace.json:482`)
  is `{}` (empty). The next inventory snapshot
  (`rollout_trace.json:688`) shows:

```text
"spruce_log": 5
```

- Explanation: The skill log reports `Collected 4 spruce_log` and a
  trailing `Failed to collect spruce_log: Timeout`, suggesting an
  incomplete collect. The rollout shows the inventory actually gained
  `+5 spruce_log`. The message under-counts the real outcome by one;
  whatever final pickup happened after the headline was assembled is
  silently absent from the message text. (Item name matches here —
  `spruce_log` drops `spruce_log` — so only the count is off.)

## Important Files

- `achievement_hunter/src/pipeline/structured_loop/actions.js:233-235` —
  prints the raw `command_result` as `[SPL] Command result`; the
  `message` field comes verbatim from the upstream `collectBlock` skill.
- `achievement_hunter/src/pipeline/structured_loop/trace.js:18-26` —
  `create_command_success_result` later routes the same blob through
  `build_command_success_message`, which strips known plumbing but does
  not reconcile the headline count or name against inventory.
- `achievement_hunter/src/pipeline/structured_loop/result_messages.js`
  (`build_command_success_message`, lines 245-295) — the success-message
  formatter; preserves the upstream `Collected N <block>` line verbatim
  after stripping crafting plumbing.
- `src/agent/library/skills.js` — upstream `collectBlock` log source for
  the `Collected N <block>` and `Failed to collect …` strings; counts
  block-break events, not item-pickup events.

## Notes

- Both sub-patterns trace back to the same upstream skill: the
  `collectBlock` log reports block-name + block-break count, while the
  rollout state machine snapshots `bot.inventory` deltas. They share a
  single shared cause — the message channel and the state channel are
  computed from different sources — so they are grouped here.
- The count direction is not consistent (Example 4 under-reports by 1;
  Example 3 under-reports by ~11). This is consistent with the skill
  counting only the named block while extra mined blocks during
  pathfinding also enter inventory.
- Not all collects in the audit show this drift; e.g. the `coal_ore`
  collect in `diamonds/runner_stdout.log:147-150` reports
  `Collected 1 coal_ore` and the rollout records `coal_ore: 1` (no
  smelting yet). The pattern fires reliably for ore→drop mismatches
  and whenever the bot makes the pathing-collect detours visible to
  the inventory snapshot.

---

## Potential Fixes

The fix surface has three viable shapes; they're not mutually exclusive,
but only one needs to land to make the message accurate. All three rely
on the same observation: there is already a reliable post-action
inventory snapshot in scope — either inside the skill itself
(`bot.inventory`), or one tick-settled layer up
(`executeCommandWithModeRecovery`'s `verifier_post_state`). The current
headline ignores both and uses an internal counter.

### Option A — Patch the upstream skill to emit a delta-based headline

**Where:** `src/agent/library/skills.js`, inside `collectBlock`
(currently lines 463-602; AH-marker edits are already present at
501-504 and 540-558, so a third marker block is consistent with the
file's existing patching pattern).

**Shape:**

1. Before the `for` loop at line 500, snapshot inventory:
   ```js
   const inv_before = getInventoryCounts(bot);
   ```
2. After the loop (after `if (bot.interrupt_code) break;` exits all
   iterations) and before line 601, snapshot again and diff:
   ```js
   const inv_after = getInventoryCounts(bot);
   const delta = {};
   for (const [k, v] of Object.entries(inv_after)) {
     const d = v - (inv_before[k] ?? 0);
     if (d > 0) delta[k] = d;
   }
   ```
3. Replace `log(bot, \`Collected ${collected} ${blockType}.\`)` with a
   delta-driven log that names the **drop item(s) that actually arrived**:
   ```js
   const entries = Object.entries(delta).sort((a, b) => b[1] - a[1]);
   if (entries.length === 0) {
     log(bot, `Collected 0 ${blockType} (no inventory delta).`);
   } else {
     const head = `Collected ${entries[0][1]} ${entries[0][0]}`;
     const tail = entries.slice(1).map(([k, v]) => `+${v} ${k}`).join(', ');
     log(bot, tail ? `${head} (also: ${tail}).` : `${head}.`);
   }
   ```

**Pros**
- Single source of truth — every downstream consumer (the
  `[SPL] Command result` log line, `build_command_success_message`,
  trace projection to the failure_replanner) automatically sees the
  corrected text without further plumbing.
- No new layer to maintain; the skill is the right place to describe
  what the skill did.
- Reflects incidental pickups truthfully (e.g. `+13 cobblestone (also:
  +9 dirt)`) without inventing structure the replanner has to learn.

**Cons**
- Upstream Mindcraft file; relies on AH's marker-comment convention to
  survive future merges. Low risk in this file (already heavily
  AH-marked) but not zero.
- No `waitForTicks` here: a server `set_slot` packet for the *last*
  block in the loop could land just after the snapshot, so a single
  trailing item could still be missed. The tick-settle delay used by
  `executeCommandWithModeRecovery` is the safer place to read inventory.
- The skill has no idea what the *requested* item was vs. what
  incidental drops are noise. The message becomes accurate, but a
  reader who asked for `stone` and got `+9 dirt incidentally` sees that
  as a feature, not a quirk.

### Option B — Compute the delta in `command_utils.js` and rewrite the message

**Where:** `achievement_hunter/src/pipeline/command_utils.js`, inside
the success branch of `executeCommandWithModeRecovery` (currently
lines 95-151).

**Shape:**

1. The pre-state snapshot already exists at line 82
   (`verifier_pre_state`). The post-state snapshot already exists at
   line 114 (`verifier_post_state`) and has the 4-tick settle wait
   applied (line 109-113). Reuse both.
2. After the verifier check succeeds (or on the no-verifier path), if
   the command name is `!collectBlocks`, compute the delta from those
   two snapshots and overwrite the `Collected N <block>` line in
   `result.message` before returning.
3. Also attach `result.inventory_delta = {item: count, ...}` as a
   structured side-field (peer of the existing `result.verifier_reason`)
   so downstream consumers like the rollout-trace projection and the
   replanner prompts can read the delta without parsing the message.

   Sketch (inserted after line 150's verifier-passed branch):
   ```js
   if (extract_command_name(command) === '!collectBlocks' &&
       verifier_pre_state.inventory && verifier_post_state.inventory) {
     const delta = inventory_delta(
         verifier_post_state.inventory, verifier_pre_state.inventory);
     result.inventory_delta = delta;
     result.message = rewrite_collect_headline(result.message, delta);
   }
   ```

   `inventory_delta` is already implemented in
   `agent_state.js:19-26` but private — exporting it is a one-line
   change. `rewrite_collect_headline` would live in `result_messages.js`
   next to the other builders.

**Pros**
- Stays inside `achievement_hunter/` — no upstream patch.
- Reuses the same tick-settled snapshot the verifier already takes, so
  no extra race-window risk.
- Adds a structured `inventory_delta` field that the replanner prompt
  can document (paralleling how `verifier_reason` was added) without
  the LLM having to regex the message.
- Single command-type carve-out keeps blast radius small; other
  commands continue to be passed through unmodified.

**Cons**
- Two places now reason about the skill's text shape — the skill itself
  still emits the original misleading line, and `command_utils.js` has
  to know to overwrite it. The skill's raw output remains misleading if
  any other code path ever reads it directly (none today, but a future
  reader could).
- The rewrite is a regex/string substitution against the upstream skill
  blob; if `skills.js` changes the headline format upstream, the
  substitution silently no-ops. Mitigation: snapshot test against a
  captured real blob, same approach as `result_messages.test.js`.
- Adds a new (small) dependency arrow from `command_utils.js` to
  `result_messages.js` / `agent_state.js`.

### Option D — Hybrid: extract shared helpers, then fix at the source

#### Files changed

1. **New:** `achievement_hunter/src/pipeline/inventory_drops.js` (~75 lines).
2. **Edited (markered):** `src/agent/library/skills.js` — `collectBlock`
   only, lines 463-602.
3. **Edited:** `achievement_hunter/src/pipeline/command_verifier.js` —
   `BLOCK_DROPS`, `expand_to_concretes`, `sum_inventory` move out
   (verifier shrinks ~48 lines, gains a 1-line import).
4. **Edited:** `achievement_hunter/src/pipeline/command_utils.js` —
   `VERIFIER_SETTLE_TICKS` and `SERVER_DRIVEN_SHARDS` move into the
   shared module (replaced by a 1-line import).
5. **New / extended:** `achievement_hunter/src/pipeline/__tests__/inventory_drops.test.js`
   — unit tests on the new helpers, plus a regression case per audit
   example.

#### Concrete shapes

**`inventory_drops.js` (the only new file):**

```js
// Inventory drop knowledge shared between the upstream collectBlock
// skill (src/agent/library/skills.js) and the AH post-condition
// verifier (command_verifier.js). Centralising it here means the
// skill's "Collected N X" headline and the verifier's "did this
// command actually deliver?" check consult the same source of truth
// for what a mined block puts into inventory.

// Blocks whose drop item differs from the block name. Default for
// unlisted blocks is "drops itself" (drop_name === block_name).
// Silk-touch is not modelled — the verifier sums across both the
// block name AND its listed drop, so both outcomes count as success.
export const BLOCK_DROPS = {
  stone: 'cobblestone',
  coal_ore: 'coal',
  deepslate_coal_ore: 'coal',
  iron_ore: 'raw_iron',
  deepslate_iron_ore: 'raw_iron',
  gold_ore: 'raw_gold',
  deepslate_gold_ore: 'raw_gold',
  copper_ore: 'raw_copper',
  deepslate_copper_ore: 'raw_copper',
  diamond_ore: 'diamond',
  deepslate_diamond_ore: 'diamond',
  emerald_ore: 'emerald',
  deepslate_emerald_ore: 'emerald',
  lapis_ore: 'lapis_lazuli',
  deepslate_lapis_ore: 'lapis_lazuli',
  redstone_ore: 'redstone',
  deepslate_redstone_ore: 'redstone',
  nether_quartz_ore: 'quartz',
  nether_gold_ore: 'gold_nugget',
  grass_block: 'dirt',
  clay: 'clay_ball',
  glowstone: 'glowstone_dust',
  snow: 'snowball',
  bookshelf: 'book',
  melon: 'melon_slice',
  sea_lantern: 'prismarine_crystals',
  redstone_lamp: 'redstone',
  gilded_blackstone: 'gold_nugget',
  carrots: 'carrot',
  potatoes: 'potato',
  beetroots: 'beetroot',
  cocoa: 'cocoa_beans',
  sweet_berry_bush: 'sweet_berries',
  // Liquids: collectBlock's bucket branch converts the source block
  // into a filled bucket. AH's mediator currently routes liquids to
  // !useOn, so this path is rarely exercised through !collectBlocks —
  // but adding the mapping keeps the verifier and the skill in sync
  // if anything ever calls collectBlock(bot, 'lava'|'water') directly.
  lava: 'lava_bucket',
  water: 'water_bucket',
};

// Ticks (50 ms each) to wait between a successful skill call and a
// post-action inventory snapshot, so server response packets land
// before the read. Used by both the command_utils verifier path and
// the upstream collectBlock skill headline. Single source so the two
// readers cannot drift.
export const VERIFIER_SETTLE_TICKS = 4;

// Shards whose value depends on a server packet; verifier consults
// this list to decide whether to settle-wait before snapshotting.
export const SERVER_DRIVEN_SHARDS =
    new Set(['inventory', 'equipment', 'nearby_blocks', 'nearby_entities']);

// Re-exported abstract membership lookup. Kept here so the verifier's
// "block→concrete members" expansion shares a module with BLOCK_DROPS.
import {ABSTRACT_CLASS_MEMBERS} from './mc_sources.js';

export function expand_to_concretes(item) {
  if (typeof item !== 'string') return [];
  if (!item.startsWith('any_')) return [item];
  const members = ABSTRACT_CLASS_MEMBERS?.[item];
  return members?.length ? members : [item];
}

export function sum_inventory(inventory, items) {
  if (!inventory) return 0;
  let total = 0;
  for (const item of items) total += inventory[item] ?? 0;
  return total;
}

// Returns positive-only deltas of post over pre. Negative or zero
// deltas are omitted — collecting never consumes the player's existing
// inventory, so anything that went down is unrelated (e.g. tool
// durability loss, which isn't tracked at the inventory-count level
// anyway).
export function inventory_delta_positive(post, pre) {
  const out = {};
  for (const [item, count] of Object.entries(post ?? {})) {
    const delta = count - (pre?.[item] ?? 0);
    if (delta > 0) out[item] = delta;
  }
  return out;
}

// For a given mined blockType, classify the post-collect inventory
// delta into:
//   primary_item:  the item the caller most likely intended to receive
//                  (BLOCK_DROPS[blockType] ?? blockType), only if its
//                  delta is positive; otherwise the largest-delta entry
//                  in the expected-item set; otherwise blockType itself.
//   primary_count: delta on primary_item (>= 0).
//   extras:        remaining positive deltas, keyed by item.
//
// `pre_inv` / `post_inv` are item→count maps (as produced by
// world.getInventoryCounts). The function performs no I/O and is pure.
export function compute_collect_delta(blockType, pre_inv, post_inv) {
  const delta = inventory_delta_positive(post_inv, pre_inv);
  const expected_drop = BLOCK_DROPS[blockType] ?? blockType;

  // Primary-pick priority: expected drop if it's in delta, else
  // blockType if it's in delta (silk-touch case), else the largest
  // remaining delta entry, else the blockType (with count 0).
  let primary_item = expected_drop;
  let primary_count = delta[expected_drop] ?? 0;
  if (primary_count === 0 && expected_drop !== blockType &&
      (delta[blockType] ?? 0) > 0) {
    primary_item = blockType;
    primary_count = delta[blockType];
  }
  if (primary_count === 0) {
    // Nothing matched — pick the largest remaining delta if any,
    // otherwise stay on blockType with count 0.
    let best_item = null;
    let best_count = 0;
    for (const [item, count] of Object.entries(delta)) {
      if (count > best_count) { best_item = item; best_count = count; }
    }
    if (best_item != null) {
      primary_item = best_item;
      primary_count = best_count;
    } else {
      primary_item = blockType;
      primary_count = 0;
    }
  }

  const extras = {};
  for (const [item, count] of Object.entries(delta)) {
    if (item !== primary_item) extras[item] = count;
  }
  return {primary_item, primary_count, extras};
}
```

**Skill-side edit (`src/agent/library/skills.js`, inside `collectBlock`):**

Replace the existing function with this structure (AH markers wrap the
two new blocks; everything outside the markers is unchanged):

```js
export async function collectBlock(bot, blockType, num=1, exclude=null) {
    if (num < 1) { ... }                      // unchanged
    let blocktypes = [blockType];             // unchanged …
    ...                                       // (all existing logic)
    const unsafeBlocks = ['obsidian', 'crafting_table', 'furnace'];

    // Start of AH code — pre-collect inventory snapshot for accurate headline (see docs/messages/)
    const inv_before = world.getInventoryCounts(bot);
    // End of AH code

    for (let i=0; i<num; i++) {
        if (bot.interrupt_code) break;
        ...                                   // unchanged loop body
    }

    // Start of AH code — emit headline from actual inventory delta (see docs/messages/)
    let headline = `Collected ${collected} ${blockType}.`;  // legacy fallback
    try {
        if (!bot._ah_death_pending) {
            await bot.waitForTicks(VERIFIER_SETTLE_TICKS);
        }
        const inv_after = world.getInventoryCounts(bot);
        const {primary_item, primary_count, extras} =
            compute_collect_delta(blockType, inv_before, inv_after);
        const extras_str = Object.entries(extras)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `+${v} ${k}`).join(', ');
        headline = extras_str
            ? `Collected ${primary_count} ${primary_item} (also: ${extras_str}).`
            : `Collected ${primary_count} ${primary_item}.`;
    } catch (e) {
        // Never let a snapshot failure swallow the skill's success
        // signal. Fall back to the legacy counter-based headline.
    }
    log(bot, headline);
    return collected > 0;
    // End of AH code
}
```

Imports added at the top of `skills.js` (inside AH markers, alphabetically near the other library import):

```js
// Start of AH code — shared inventory-drop helpers
import {compute_collect_delta, VERIFIER_SETTLE_TICKS}
    from '../../../achievement_hunter/src/pipeline/inventory_drops.js';
// End of AH code
```

**`command_verifier.js` edit:**

- Remove the local `BLOCK_DROPS` definition (lines 498-533) and the local
  `expand_to_concretes` / `sum_inventory` definitions (lines 834-846).
- Add at the top: `import {BLOCK_DROPS, expand_to_concretes, sum_inventory} from './inventory_drops.js';`
- The verifier body at lines 30-57 is unchanged — same identifier names,
  same behaviour.

**`command_utils.js` edit:**

- Remove the local `VERIFIER_SETTLE_TICKS` constant (line 33) and
  `SERVER_DRIVEN_SHARDS` (lines 26-27).
- Add: `import {SERVER_DRIVEN_SHARDS, VERIFIER_SETTLE_TICKS} from './inventory_drops.js';`
- Line 112 usage is unchanged.

#### Why this is robust (not a band-aid)

- **No duplicated knowledge.** `BLOCK_DROPS` exists in exactly one
  place. Skill, verifier, future readers — all consult the same table.
  Drift between layers is structurally impossible.
- **Race-safe by construction.** Both the skill (post-loop) and the
  verifier (post-skill) share `VERIFIER_SETTLE_TICKS`. The 4-tick
  (~200 ms) wait is sufficient for inventory packets on local servers
  (already proven in the verifier's settle path — same packet round
  trip).
- **Graceful degradation.** The skill's new block is wrapped in
  try/catch and gated by `_ah_death_pending`. Snapshot or wait
  failure falls back to the legacy `Collected ${collected}
  ${blockType}.` headline rather than dropping the success log
  entirely. The skill's return value (`collected > 0`) is unchanged.
- **Downstream contract preserved.** The headline still starts with
  `Collected ${number} ${item}`. `success_re` at
  `result_messages.js:351` (`/^Collected \d+/`) continues to match,
  so the success-line hoisting in `build_command_success_message`
  keeps working. The `Failed to collect <X>: …` lines are untouched.
- **Replanner prompts forward-compatible.** Neither
  `failure_replanner.md` nor `search_replanner.md` pins the exact
  `<item>` name in the headline; both describe `Collected N X` as
  the general shape. No prompt edits required.
- **Plumbing-strip regex safe in practice.** The strip pattern
  `^Collected 1 crafting_table\.?$` (`result_messages.js:330`) only
  matches when the headline is exactly that string. After the fix,
  `craftRecipe`'s internal `collectBlock(bot, 'crafting_table', 1)`
  call (called immediately after `placeBlock` on the same spot — no
  pathfinding, no incidental pickups) will produce exactly
  `Collected 1 crafting_table.` with no `(also: …)` suffix. The
  regex matches, the line is stripped. The same applies to the
  furnace pickup at `result_messages.js:332`.
- **Edge case — interrupt / death.** If the bot is interrupted
  mid-collect, the loop's `if (bot.interrupt_code) break;` exits.
  The new code skips the settle wait when `_ah_death_pending` is set
  and falls back to the legacy headline on any throw. The skill
  never blocks on a dead bot.
- **Edge case — liquids.** `lava` and `water` now map to
  `lava_bucket` / `water_bucket` in `BLOCK_DROPS`. AH's mediator
  doesn't route liquids through `!collectBlocks` today, but the
  verifier would have silently false-failed if anything ever did
  (no `lava` ever lands in inventory). The fix repairs that latent
  bug at the same time.
- **No test-fixture breakage.** Existing tests in
  `result_messages.test.js` feed *literal skill output strings* into
  `build_command_success_message`. They test the builder's parsing,
  not what the skill emits. Old fixtures remain valid even though
  the skill now emits a different (more accurate) string in real
  runs.

#### Implementation checklist

1. Create `achievement_hunter/src/pipeline/inventory_drops.js` with the
   contents above. Run `node --check`.
2. Update `command_verifier.js`: remove the three moved constants /
   functions, add the import. `node --check` and `npm test --
   command_verifier` (existing 272/272 suite must still pass).
3. Update `command_utils.js`: remove the two moved constants, add the
   import. `node --check`.
4. Add AH-markered edits to `collectBlock` in `skills.js`: imports
   plus the two markered blocks. `node --check`.
5. Add `inventory_drops.test.js` with unit tests for
   `compute_collect_delta` covering:
   - `diamond_ore` → `diamond` (the audit Example 1 delta).
   - `iron_ore` → `raw_iron` (Example 2).
   - `stone` → `cobblestone` + incidental `dirt` (Example 3).
   - `spruce_log` exact match (Example 4 — legacy headline already
     correct, makes sure the fix doesn't regress).
   - Silk-touch path: `stone` with `+1 stone` delta → primary
     `stone`, not `cobblestone`.
   - Empty delta: `Collected 0 <blockType>` semantic.
   - Multiple equal-delta extras: stable ordering check.
6. Add one snapshot test in `result_messages.test.js` over a
   post-fix-shaped skill blob (e.g.
   `Collected 13 cobblestone (also: +9 dirt).`) confirming the
   builder hoists the new headline correctly.
7. Run the full `npm test` suite. Expect 272 + new tests pass.
8. Manually re-run one of the audit tasks (e.g. `diamonds`) and
   diff the new `runner_stdout.log` against the captured one — the
   `Collected N <block>` line should now show the drop item and the
   correct count. (Optional but high-confidence smoke test.)

#### Residual risks (called out, not band-aided)

- **Upstream `skills.js` now imports from `achievement_hunter/`.**
  This is a new direction for this file. It works (the repo is one
  package) and follows the AH fork's overall layering (AH owns this
  knowledge), but a future upstream-Mindcraft merge will need to
  preserve the import alongside the marker block. The marker comments
  make the patch obvious; the next merger will see "Start of AH
  code — shared inventory-drop helpers" and know to keep it.
- **`compute_collect_delta`'s primary-pick heuristic is opinionated.**
  When the requested block, its expected drop, *and* incidental items
  are all present (e.g. silk-touch `stone` collected while pathing
  through dirt: +1 `stone`, +13 `cobblestone`, +9 `dirt`), the
  function picks the expected drop first (`cobblestone`). That
  matches "what would happen without silk touch" — which is the
  common case — but is a judgment call the test cases pin explicitly
  so any future change is visible.
- **The skill's ~200 ms settle wait runs on every collect.** This
  is the only behavioural cost. The verifier already pays it for
  inventory shards (`command_utils.js:109-113`), so end-to-end the
  delay is unchanged when the verifier is consulted. The skill-side
  wait is redundant *with* the verifier's wait but not additive in
  practice — they're sequential across the same packet boundary; the
  skill returns, then the verifier waits, but inventory has had
  ~200ms to land by then anyway. Net cost in the success path:
  ~200 ms once. Acceptable.
- **`bot.waitForTicks` semantics.** Mineflayer's `Bot.waitForTicks(n)`
  awaits `n` server ticks. If the connection is severed, it may
  throw; the try/catch covers this. The `_ah_death_pending` gate
  covers the "we know the bot is dying" case.

#### Optional follow-ups (out of scope for this patch)

- Extend `compute_collect_delta` (or sibling helpers) to surface
  consumed items too, for reuse by `!craftRecipe` / `!smelt_item`
  verifier-side messaging. Today positive-only is sufficient for
  `!collectBlocks`.
- Surface `inventory_delta` as a structured side-field on the result
  object (like the existing `verifier_reason`), so replanner prompts
  can read it directly without parsing the headline. This was Option
  B/C's main ergonomic win; with Option D the headline is already
  accurate, so the side-field is gravy. Could land later if the
  prompts want to depend on it.

### Option C — Side-field only; do not rewrite the message text

**Where:** Same as Option B in `command_utils.js`, but stop after
attaching `result.inventory_delta`. Leave the upstream skill text
untouched.

**Shape:** Attach the structured delta. Update
`build_command_success_message` to *append* — not replace — a delta
summary segment when present:

```text
command_success: cmd=!collectBlocks("stone",11) | Collected 11 stone. | inventory_delta: +13 cobblestone, +9 dirt
```

**Pros**
- Most conservative: original skill text is preserved for debugging
  and audit; the corrected number is appended in a parseable form.
- Two-sources-of-truth pattern is explicit rather than hidden.

**Cons**
- The `[SPL] Command result:` line printed at `actions.js:235` runs
  *before* `build_command_success_message` is invoked, so that
  particular runner_stdout line would still show the wrong count.
  Fixing it would require a second message-rewrite at the log site or
  in `command_utils.js`, which collapses Option C back into Option B.
- Asks the LLM to trust the appended field over the original sentence;
  even with a prompt update, the conflicting numbers in the same
  message are noisier than they're worth.

### Comparison

| | Option A (skill, standalone) | Option B (command_utils rewrite) | Option C (side-field) | Option D (hybrid) |
|---|---|---|---|---|
| Fixes `[SPL] Command result` line | yes | yes | no | **yes** |
| Fixes `build_command_success_message` output | yes | yes | partial | **yes** |
| Uses tick-settled snapshot | no | yes | yes | **yes** (shared constant) |
| Shares one `BLOCK_DROPS` source | no (two copies) | yes (verifier only) | yes (verifier only) | **yes (one shared module)** |
| Skill and verifier stay aligned | no | partial | partial | **yes (same helpers)** |
| Upstream Mindcraft surface | edit (markered) | none | none | edit (markered) |
| New code surface | skill body | `command_utils.js` + small helper | `command_utils.js` only | shared module + skill body; verifier shrinks |
| Blast radius if wrong | all collect callers | only `!collectBlocks` | only `!collectBlocks` | all collect callers |
| Race-safe against last-block packet | weak | strong | strong (but text still wrong) | **strong** |
| Preserves legacy `Collected N <item>.` headline shape | yes | partial (rewrites in-place) | yes | **yes** |

### Recommended approach

**Option D (hybrid).** It produces the same message accuracy as B while
fixing the issue at the source like A, and uniquely solves the
duplicated-knowledge problem: today's verifier owns `BLOCK_DROPS` and
the skill is ignorant of drops, so the two layers can drift. The
hybrid factors that table (plus `expand_to_concretes`, `sum_inventory`,
and the `VERIFIER_SETTLE_TICKS` constant) into a shared module both
consume. The verifier becomes a thin consumer of the same helpers the
skill uses to assemble the headline, so by construction the skill's
message and the verifier's verdict can't disagree about what arrived
in inventory.

The hybrid is preferred over Option B because the source-level fix
eliminates a layer of text-rewriting that B requires
(`command_utils.js` would otherwise have to substring-match the skill
blob to swap the headline, which silently no-ops if the upstream
string format ever changes). It's preferred over Option A because A
duplicates `BLOCK_DROPS` knowledge across the skill and the verifier.

**Fallback ranking**, in order of decreasing preference if Option D is
declined:

1. **Option B** — Keeps everything inside `achievement_hunter/`. Right
   choice if AH decides not to grow upstream `skills.js` further.
   Accept the post-hoc message rewrite as the cost.
2. **Option A** — Source-level fix without the shared-module
   refactor. Right choice if the shared module feels like over-build
   for a one-skill problem and accepting the (small, contained)
   `BLOCK_DROPS` duplication is acceptable.
3. **Option C** — Not recommended on its own: it leaves the
   `[SPL] Command result` log line wrong (the print happens at
   `actions.js:235` before any rewriting), which defeats the purpose
   of the audit's first example. Reasonable only as a *step toward*
   Option B (ship the side-field first, then the rewrite), but
   standalone it under-fixes.

