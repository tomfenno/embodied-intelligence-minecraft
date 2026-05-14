// Inventory drop knowledge shared between the upstream collectBlock
// skill (src/agent/library/skills.js) and the AH post-condition
// verifier (command_verifier.js). Centralising it here means the
// skill's "Collected N X" headline and the verifier's "did this
// command actually deliver?" check consult the same source of truth
// for what a mined block puts into inventory.

import {ABSTRACT_CLASS_MEMBERS} from './mc_sources.js';

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

// Shards whose value depends on a server packet; verifier consults
// this list to decide whether to settle-wait before snapshotting.
// `position` is intentionally excluded — bot.entity.position updates
// locally as physics ticks, no server-roundtrip required.
export const SERVER_DRIVEN_SHARDS =
    new Set(['inventory', 'equipment', 'nearby_blocks', 'nearby_entities']);

// Ticks (50 ms each) to wait between a successful skill call and a
// post-action inventory snapshot, so server response packets land
// before the read. Used by both the command_utils verifier path and
// the upstream collectBlock skill headline. Single source so the two
// readers cannot drift.
export const VERIFIER_SETTLE_TICKS = 4;

// Abstract → concrete members. For non-abstract names (anything not
// starting with "any_"), returns `[item]` unchanged. For unknown
// abstracts, returns `[item]` — defensive pass-through.
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
//   primary_item:  the item the caller most likely intended to receive.
//                  Priority: BLOCK_DROPS[blockType] ?? blockType if its
//                  delta is positive; else blockType (silk-touch case)
//                  if its delta is positive; else the largest-delta
//                  entry in the remaining set; else blockType with
//                  count 0.
//   primary_count: delta on primary_item (>= 0).
//   extras:        remaining positive deltas, keyed by item.
//
// `pre_inv` / `post_inv` are item→count maps (as produced by
// world.getInventoryCounts). The function performs no I/O and is pure.
export function compute_collect_delta(blockType, pre_inv, post_inv) {
  const delta = inventory_delta_positive(post_inv, pre_inv);
  const expected_drop = BLOCK_DROPS[blockType] ?? blockType;

  let primary_item = expected_drop;
  let primary_count = delta[expected_drop] ?? 0;
  if (primary_count === 0 && expected_drop !== blockType &&
      (delta[blockType] ?? 0) > 0) {
    primary_item = blockType;
    primary_count = delta[blockType];
  }
  if (primary_count === 0) {
    let best_item = null;
    let best_count = 0;
    for (const [item, count] of Object.entries(delta)) {
      if (count > best_count) {
        best_item = item;
        best_count = count;
      }
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
