import {getFirstBlockAboveHead} from '../../../src/agent/library/world.js';

import {get_am_state} from './agent_state.js';
import {ABSTRACT_CLASS_MEMBERS} from './mc_sources.js';

/**
 * Per-command post-condition verifier registry. Each entry maps a
 * command name (e.g. "!collectBlocks") to:
 *
 *   {
 *     needs: Set<string>,
 *       // Which state shards the verifier needs snapshotted before
 *       // and after the command runs. Supported shards (added as
 *       // verifiers need them): 'inventory', 'position',
 *       // 'nearby_blocks', 'nearby_entities', 'craftable_items',
 *       // 'equipment'.
 *     verify: ({args, pre, post, agent}) => {ok: boolean, reason: string},
 *       // Post-condition predicate. Called only on the success path
 *       // (when the skill reported `success: true`). Returning
 *       // `{ok: false, reason}` causes `executeCommandWithModeRecovery`
 *       // to reclassify the result as `success: false` with the message
 *       // prefixed by `verifier_failed:<reason>`.
 *   }
 */
export const command_verifiers = {
  '!collectBlocks': {
    needs: new Set(['inventory']),
    verify: ({args, pre, post}) => {
      const block = args?.[0];
      if (typeof block !== 'string' || block.length === 0) {
        // Pass-through on unparseable / empty arg — better than
        // reclassifying a legitimate success as failure.
        return {ok: true, reason: 'no_block_arg'};
      }
      // Mining a block doesn't always put that block's item in
      // inventory — `stone` drops `cobblestone`, `iron_ore` drops
      // `raw_iron`, etc. Check BOTH the block name AND its known
      // drop (per BLOCK_DROPS). With silk-touch tools the block
      // itself drops; without, the drop is different. Counting
      // both covers both cases. Unlisted blocks default to
      // dropping themselves (drop name = block name).
      const concretes = expand_to_concretes(block);
      const items_to_check = new Set();
      for (const concrete of concretes) {
        items_to_check.add(concrete);
        const drop = BLOCK_DROPS[concrete];
        if (typeof drop === 'string') items_to_check.add(drop);
      }
      const items_arr = [...items_to_check];
      const before = sum_inventory(pre?.inventory, items_arr);
      const after = sum_inventory(post?.inventory, items_arr);
      return after > before ?
          {ok: true, reason: `delta=${after - before}`} :
          {ok: false, reason: 'no_inventory_delta'};
    },
  },

  // ── Phase 2: navigation verifiers ────────────────────────────────────
  // Replace the legacy NAVIGATION_ONLY_COMMANDS / PATHFINDING_MESSAGE_REGEX
  // reclassification with post-condition checks. The bot's actual
  // position/surroundings are the ground truth; the skill's success flag
  // and message text are ignored.

  '!goToCoordinates': {
    needs: new Set(['position']),
    verify: ({args, post}) => {
      const [x, y, z, closeness] = args ?? [];
      if (typeof x !== 'number' || typeof y !== 'number' ||
          typeof z !== 'number') {
        return {ok: true, reason: 'missing_coords'};
      }
      if (!post?.position) {
        return {ok: true, reason: 'unknown_position'};
      }
      const dx = post.position.x - x;
      const dy = post.position.y - y;
      const dz = post.position.z - z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Threshold matches goToPosition's internal "you have reached at"
      // check: distance <= min_distance + 1. closeness defaults to 3
      // when omitted in the LLM's command.
      const threshold = (typeof closeness === 'number' ? closeness : 3) + 1;
      return dist <= threshold ?
          {ok: true, reason: `within_${dist.toFixed(1)}_of_target`} :
          {ok: false, reason: `${dist.toFixed(1)}_blocks_off_target`};
    },
  },

  '!goToXZ': {
    needs: new Set(['position']),
    verify: ({args, post}) => {
      const [x, z, closeness] = args ?? [];
      if (typeof x !== 'number' || typeof z !== 'number') {
        return {ok: true, reason: 'missing_coords'};
      }
      if (!post?.position) {
        return {ok: true, reason: 'unknown_position'};
      }
      const dx = post.position.x - x;
      const dz = post.position.z - z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      // XZ-only — y is intentionally chosen by the pathfinder, so a
      // successful column hop that lands at a different y must not be
      // penalised. Threshold matches goToXZPosition's "You have reached
      // column" check: xz_distance <= min_distance + 1. closeness
      // defaults to 2 (matches the skill's min_distance default).
      const threshold = (typeof closeness === 'number' ? closeness : 2) + 1;
      return dist <= threshold ?
          {ok: true, reason: `within_${dist.toFixed(1)}_of_column`} :
          {ok: false, reason: `${dist.toFixed(1)}_blocks_off_column`};
    },
  },

  '!moveAway': {
    needs: new Set(['position']),
    verify: ({pre, post}) => {
      if (!pre?.position || !post?.position) {
        return {ok: true, reason: 'unknown_position'};
      }
      const dx = post.position.x - pre.position.x;
      const dy = post.position.y - pre.position.y;
      const dz = post.position.z - pre.position.z;
      const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Loose: any meaningful movement counts. !moveAway doesn't
      // promise to reach a specific point, just to unstick / relocate.
      // 0.5 blocks rejects tiny pose adjustments while accepting any
      // real step.
      return moved > 0.5 ?
          {ok: true, reason: `moved_${moved.toFixed(1)}_blocks`} :
          {ok: false, reason: 'no_movement'};
    },
  },

  '!digDown': {
    needs: new Set(['position']),
    verify: ({pre, post}) => {
      if (!pre?.position || !post?.position) {
        return {ok: true, reason: 'unknown_position'};
      }
      const descent = pre.position.y - post.position.y;
      // Loose: any net descent counts. The skill stops at lava / water
      // / 4-block drops; partial descent still made progress and the
      // outer loop can re-emit if more depth is needed.
      return descent > 0.5 ?
          {ok: true, reason: `descended_${descent.toFixed(1)}_blocks`} :
          {ok: false, reason: 'no_descent'};
    },
  },

  '!goToSurface': {
    // Doesn't need pre/post snapshots — checks the agent's current
    // surroundings directly via getFirstBlockAboveHead. The skill returns
    // the *string* 'none' (not null) when no block was found within the
    // scan distance; treat that as open sky.
    needs: new Set(),
    verify: ({agent}) => {
      let first_above;
      try {
        first_above = getFirstBlockAboveHead(agent?.bot, null, 32);
      } catch (e) {
        return {ok: true, reason: `getFirstBlockAboveHead_threw:${e.message}`};
      }
      const has_block_above =
          first_above != null && first_above !== 'none';
      return has_block_above ?
          {ok: false, reason: `block_above_head:${first_above}`} :
          {ok: true, reason: 'open_sky_above'};
    },
  },

  '!goToNearestLand': {
    // No pre/post snapshot — checks the bot's current water state directly.
    // Mirrors the skill's multi-signal check (truthy isInWater + block-name
    // fallbacks at feet / head / one-below) so the verifier and skill agree
    // on what "in water" means. Truthy (not strict `=== true`) so a non-
    // boolean isInWater would still degrade safely to the block-name path.
    needs: new Set(),
    verify: ({agent}) => {
      const bot = agent?.bot;
      if (!bot?.entity?.position) return {ok: true, reason: 'no_position'};
      const pos = bot.entity.position;
      const in_water =
          !!bot.entity.isInWater ||
          bot.blockAt(pos)?.name === 'water' ||
          bot.blockAt(pos.offset(0, 1, 0))?.name === 'water' ||
          bot.blockAt(pos.offset(0, -1, 0))?.name === 'water';
      return in_water ?
          {ok: false, reason: 'still_in_water'} :
          {ok: true, reason: 'on_land'};
    },
  },

  '!goToPlayer': {
    needs: new Set(['position']),
    verify: ({args, post, agent}) => {
      const [player_name, closeness] = args ?? [];
      if (typeof player_name !== 'string' || player_name.length === 0) {
        return {ok: true, reason: 'no_player_arg'};
      }
      // "Go to self" carve-out matches the skill's special case.
      if (agent?.bot?.username === player_name) {
        return {ok: true, reason: 'self_target'};
      }
      if (!post?.position) {
        return {ok: true, reason: 'unknown_position'};
      }
      // Player position is a live re-query — the player is moving and
      // a snapshot would be stale. If the player went offline between
      // skill completion and verification, pass-through rather than
      // false-fail.
      const player_pos = agent?.bot?.players?.[player_name]?.entity?.position;
      if (!player_pos) {
        return {ok: true, reason: 'player_not_present'};
      }
      const dx = post.position.x - player_pos.x;
      const dy = post.position.y - player_pos.y;
      const dz = post.position.z - player_pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Skill defaults `distance` to 3. Threshold matches other
      // navigation verifiers: closeness + 1.
      const threshold = (typeof closeness === 'number' ? closeness : 3) + 1;
      return dist <= threshold ?
          {ok: true, reason: `within_${dist.toFixed(1)}_of_player`} :
          {ok: false, reason: `${dist.toFixed(1)}_blocks_from_player`};
    },
  },

  '!goToRememberedPlace': {
    needs: new Set(['position']),
    verify: ({args, post, agent}) => {
      const [name] = args ?? [];
      if (typeof name !== 'string' || name.length === 0) {
        return {ok: true, reason: 'no_name_arg'};
      }
      // Re-lookup the saved place. If unsaved, the wrapper already
      // classified the result non_retryable / success:false and the
      // verifier won't run — pass-through defensively if it does.
      const pos = agent?.memory_bank?.recallPlace(name);
      if (!pos) {
        return {ok: true, reason: 'place_not_saved'};
      }
      if (!post?.position) {
        return {ok: true, reason: 'unknown_position'};
      }
      const [px, py, pz] = pos;
      const dx = post.position.x - px;
      const dy = post.position.y - py;
      const dz = post.position.z - pz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Skill calls goToPosition(... 1), so the "you have reached at"
      // threshold inside the skill is 1 + 1 = 2.
      return dist <= 2 ?
          {ok: true, reason: `within_${dist.toFixed(1)}_of_place`} :
          {ok: false, reason: `${dist.toFixed(1)}_blocks_off_place`};
    },
  },

  // !goToBed: no verifier registered.
  //
  // The skill (skills.js:goToBed) blocks until the bot has gone to sleep
  // AND woken back up. By the time the skill returns success, isSleeping
  // is already false, so any post-condition check on `isSleeping` would
  // false-fail every successful sleep. Sleep failures (daytime / mob
  // interruption) throw from bot.sleep() and surface as
  // `!!Code threw exception!!` → non_retryable in the wrapper, so the
  // skill's success signal is already reliable. Add a `time_of_day`
  // pre/post shard if a real verifier is needed later.

  // ── Phase 3+4: crafting and smelting ─────────────────────────────────
  // Loose inventory-delta on the recipe output. Partial crafts (e.g.
  // crafted 2 oak_planks when 3 were requested) still count as
  // progress — the SCSG re-emits another !craftRecipe if more are
  // needed. Workstation-missing / inputs-missing failures already
  // return success: false from the skill, so the verifier never runs
  // in those cases.

  '!craftRecipe': {
    needs: new Set(['inventory']),
    verify: ({args, pre, post}) => {
      const recipe = args?.[0];
      if (typeof recipe !== 'string' || recipe.length === 0) {
        return {ok: true, reason: 'no_recipe_arg'};
      }
      const before = pre?.inventory?.[recipe] ?? 0;
      const after = post?.inventory?.[recipe] ?? 0;
      return after > before ?
          {ok: true, reason: `delta=${after - before}`} :
          {ok: false, reason: 'no_inventory_delta'};
    },
  },

  // ── Phase 4: smelting ────────────────────────────────────────────────
  // Catches the case-#4 false-positive: `!smelt_item` returns success when
  // the bot lacks sufficient input (skill places furnace, sees no input,
  // picks furnace back up, reports success with "You do not have enough
  // <X> to smelt"). Verifier checks the *output* inventory grew. Input
  // → output mapping is in SMELT_OUTPUT below.

  '!smelt_item': {
    needs: new Set(['inventory']),
    verify: ({args, pre, post}) => verify_smelt(args, pre, post),
  },

  // Camel-case variant used by failure_replanner's action menu.
  '!smeltItem': {
    needs: new Set(['inventory']),
    verify: ({args, pre, post}) => verify_smelt(args, pre, post),
  },

  // ── Phase 5: inventory-decrease verifiers ────────────────────────────
  // Both !placeHere and !consume should reduce the item count in the
  // bot's inventory if they actually worked. If the count is unchanged
  // (skill claimed success but the item is still in the inventory),
  // something went wrong.
  //
  // Note: !clearFurnace is intentionally NOT verified — its post-
  // condition is ambiguous. Clearing an empty furnace is a legitimate
  // success (no-op) but produces no inventory delta. A verifier on
  // total-inventory-growth would false-positive that case.

  '!placeHere': {
    needs: new Set(['inventory']),
    verify: ({args, pre, post}) => {
      const item = args?.[0];
      if (typeof item !== 'string' || item.length === 0) {
        return {ok: true, reason: 'no_item_arg'};
      }
      const before = pre?.inventory?.[item] ?? 0;
      const after = post?.inventory?.[item] ?? 0;
      return after < before ?
          {ok: true, reason: `placed=${before - after}`} :
          {ok: false, reason: 'item_still_in_inventory'};
    },
  },

  '!consume': {
    needs: new Set(['inventory']),
    verify: ({args, pre, post}) => {
      const item = args?.[0];
      if (typeof item !== 'string' || item.length === 0) {
        return {ok: true, reason: 'no_item_arg'};
      }
      const before = pre?.inventory?.[item] ?? 0;
      const after = post?.inventory?.[item] ?? 0;
      return after < before ?
          {ok: true, reason: `consumed=${before - after}`} :
          {ok: false, reason: 'item_still_in_inventory'};
    },
  },

  // ── Phase 6: entity-state verifiers ──────────────────────────────────
  // !attack uses the mob's drop appearing in inventory as the success
  // signal. Sidesteps the multi-mob-of-same-type problem ("chicken"
  // stays in nearby_entities after one is killed) and reliably detects
  // a kill via inventory delta on any of the mob's known drops.
  //
  // Drops are partial / random for some mobs — the verifier passes if
  // ANY of the listed drops increased. For mobs with at-least-one
  // guaranteed drop (chicken / cow / pig / sheep / pig / etc.), this is
  // essentially deterministic. For mobs with all-rare drops (silverfish
  // → nothing, etc.), the verifier conservatively returns
  // unknown_mob_or_no_drops and passes through.

  '!attack': {
    needs: new Set(['inventory']),
    verify: ({args, pre, post}) => {
      const mob = args?.[0];
      if (typeof mob !== 'string' || mob.length === 0) {
        return {ok: true, reason: 'no_mob_arg'};
      }
      const drops = MOB_DROPS[mob];
      if (!drops || drops.length === 0) {
        // Unknown mob or no inventory-detectable drops — pass-through.
        // Add to MOB_DROPS to enable verification for this mob.
        return {ok: true, reason: `unknown_mob_or_no_drops:${mob}`};
      }
      for (const drop of drops) {
        const before = pre?.inventory?.[drop] ?? 0;
        const after = post?.inventory?.[drop] ?? 0;
        if (after > before) {
          return {ok: true, reason: `${drop}_delta=${after - before}`};
        }
      }
      return {ok: false, reason: `no_drop_for_${mob}`};
    },
  },

  '!equip': {
    needs: new Set(['equipment']),
    verify: ({args, post, agent}) => {
      const item = args?.[0];
      if (typeof item !== 'string' || item.length === 0) {
        return {ok: true, reason: 'no_item_arg'};
      }
      // Special case mirroring the skill: equip("hand") unequips the hand.
      if (item === 'hand') {
        const held = post?.equipment?.hand ?? read_equipment_slot(agent?.bot, 'hand');
        return held == null ?
            {ok: true, reason: 'hand_unequipped'} :
            {ok: false, reason: `still_holding=${held}`};
      }
      // Armor / shield / hand items all land in different slots. The
      // skill's bot.equip(item, slot) dispatch is mirrored here so the
      // verifier reads the same slot the skill wrote.
      const dest = equip_destination_slot(item);
      const equipped = post?.equipment?.[dest] ?? read_equipment_slot(agent?.bot, dest);
      return equipped === item ?
          {ok: true, reason: `equipped_to_${dest}`} :
          {ok: false, reason: `${dest}=${equipped ?? 'nothing'}`};
    },
  },
};

// Maps an item name to the equipment slot it lands in. Mirrors the
// dispatch in skills.js:equip — keep in sync with that function.
function equip_destination_slot(item_name) {
  if (typeof item_name !== 'string') return 'hand';
  if (item_name.includes('leggings')) return 'legs';
  if (item_name.includes('boots')) return 'feet';
  if (item_name.includes('helmet')) return 'head';
  if (item_name.includes('chestplate') || item_name.includes('elytra')) return 'torso';
  if (item_name.includes('shield')) return 'off-hand';
  return 'hand';
}

// Mineflayer's standard inventory slot indices for non-hotbar equipment.
// The 'hand' slot reads bot.heldItem directly (selected hotbar slot).
const EQUIP_SLOT_INDEX = {
  head: 5,
  torso: 6,
  legs: 7,
  feet: 8,
  'off-hand': 45,
};

function read_equipment_slot(bot, dest) {
  if (!bot) return null;
  if (dest === 'hand') return bot.heldItem?.name ?? null;
  const idx = EQUIP_SLOT_INDEX[dest];
  if (idx == null) return null;
  return bot.inventory?.slots?.[idx]?.name ?? null;
}

// Block → dropped-item mapping. Lists ONLY blocks where the dropped
// item name differs from the block name without silk touch. Blocks not
// in this table default to dropping themselves (handled by the
// `!collectBlocks` verifier's block-name check).
//
// The verifier checks BOTH the block name and the drop, so silk-touch
// tooling (which makes the block drop itself) also classifies as
// success. Net effect: collecting `stone` succeeds whether the bot
// gets `cobblestone` (no silk) or `stone` (silk).
//
// Blocks that yield no item at all without silk touch (ice, glass)
// are intentionally omitted — the verifier will correctly flag a
// no-silk-touch attempt on those as `no_inventory_delta`.
const BLOCK_DROPS = {
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
  // Crops: block name (often plural) differs from item name (singular).
  carrots: 'carrot',
  potatoes: 'potato',
  beetroots: 'beetroot',
  cocoa: 'cocoa_beans',
  sweet_berry_bush: 'sweet_berries',
};

// Mob → possible inventory drops. The verifier passes if ANY listed
// drop's count increased post-kill. Mobs with all-rare-or-nothing drops
// (silverfish, etc.) intentionally omitted — they'd false-negative more
// often than help.
//
// Item names match mineflayer's item registry (mob "chicken" → drops
// raw chicken item also named "chicken", smelts to "cooked_chicken").
const MOB_DROPS = {
  // Passive animals — at least one guaranteed drop each.
  chicken: ['chicken', 'feather'],
  cow: ['beef', 'leather'],
  pig: ['porkchop'],
  sheep: ['mutton'],
  rabbit: ['rabbit', 'rabbit_hide'],
  squid: ['ink_sac'],
  cod: ['cod'],
  salmon: ['salmon'],
  pufferfish: ['pufferfish'],
  tropical_fish: ['tropical_fish'],
  glow_squid: ['glow_ink_sac'],

  // Hostile / neutral mobs commonly attacked.
  zombie: ['rotten_flesh'],
  zombie_villager: ['rotten_flesh'],
  husk: ['rotten_flesh'],
  drowned: ['rotten_flesh', 'copper_ingot'],
  skeleton: ['bone', 'arrow'],
  stray: ['bone', 'arrow'],
  spider: ['string', 'spider_eye'],
  cave_spider: ['string', 'spider_eye'],
  creeper: ['gunpowder'],
  enderman: ['ender_pearl'],
  witch: ['glowstone_dust', 'gunpowder', 'redstone', 'spider_eye', 'sugar', 'stick'],
  blaze: ['blaze_rod'],
  ghast: ['gunpowder', 'ghast_tear'],
  slime: ['slimeball'],
  magma_cube: ['magma_cream'],
  hoglin: ['porkchop', 'leather'],
  piglin: ['gold_ingot', 'gold_nugget'],
  wither_skeleton: ['bone', 'coal'],
  zoglin: ['rotten_flesh'],
};

// Mapping from smelt input → smelt output. Covers the cases AH PTD
// graphs actually use today. Unknown inputs pass-through (verifier
// returns ok: true with `unknown_input` reason) so adding a new
// smeltable to a graph doesn't silently fail until this table is
// updated.
const SMELT_OUTPUT = {
  // Ores → ingots / drops.
  raw_iron: 'iron_ingot',
  raw_gold: 'gold_ingot',
  raw_copper: 'copper_ingot',
  // Pre-1.18 ore-direct smelting still works on some servers.
  iron_ore: 'iron_ingot',
  gold_ore: 'gold_ingot',
  copper_ore: 'copper_ingot',
  deepslate_iron_ore: 'iron_ingot',
  deepslate_gold_ore: 'gold_ingot',
  deepslate_copper_ore: 'copper_ingot',
  nether_gold_ore: 'gold_ingot',
  ancient_debris: 'netherite_scrap',

  // Stone chain.
  cobblestone: 'stone',
  stone: 'smooth_stone',
  cobbled_deepslate: 'deepslate',
  sandstone: 'smooth_sandstone',
  red_sandstone: 'smooth_red_sandstone',
  quartz_block: 'smooth_quartz',
  basalt: 'smooth_basalt',

  // Glass / clay.
  sand: 'glass',
  red_sand: 'glass',
  clay_ball: 'brick',
  clay: 'terracotta',
  wet_sponge: 'sponge',

  // Food.
  raw_chicken: 'cooked_chicken',
  chicken: 'cooked_chicken',
  raw_porkchop: 'cooked_porkchop',
  porkchop: 'cooked_porkchop',
  raw_beef: 'cooked_beef',
  beef: 'cooked_beef',
  raw_mutton: 'cooked_mutton',
  mutton: 'cooked_mutton',
  raw_rabbit: 'cooked_rabbit',
  rabbit: 'cooked_rabbit',
  raw_cod: 'cooked_cod',
  cod: 'cooked_cod',
  raw_salmon: 'cooked_salmon',
  salmon: 'cooked_salmon',
  potato: 'baked_potato',
  kelp: 'dried_kelp',
  chorus_fruit: 'popped_chorus_fruit',

  // Wood → charcoal (every log type smelts to the same output).
  oak_log: 'charcoal',
  birch_log: 'charcoal',
  spruce_log: 'charcoal',
  jungle_log: 'charcoal',
  acacia_log: 'charcoal',
  dark_oak_log: 'charcoal',
  mangrove_log: 'charcoal',
  cherry_log: 'charcoal',
  crimson_stem: 'charcoal',
  warped_stem: 'charcoal',

  // Nether quartz.
  nether_quartz_ore: 'quartz',
};

function verify_smelt(args, pre, post) {
  const input = args?.[0];
  if (typeof input !== 'string' || input.length === 0) {
    return {ok: true, reason: 'no_input_arg'};
  }
  const output = SMELT_OUTPUT[input];
  if (!output) {
    // Unknown smeltable — pass-through. Add to SMELT_OUTPUT to enable
    // verification for this recipe.
    return {ok: true, reason: `unknown_smelt_input:${input}`};
  }
  const before = pre?.inventory?.[output] ?? 0;
  const after = post?.inventory?.[output] ?? 0;
  return after > before ?
      {ok: true, reason: `${output}_delta=${after - before}`} :
      {ok: false, reason: `no_${output}_delta`};
}

const EMPTY_NEEDS = new Set();

/**
 * Returns the set of pre-state shards needed to verify `command`, or an
 * empty Set if no verifier is registered for the command. Drives the
 * conditional pre-state snapshot in `executeCommandWithModeRecovery`
 * (commands without verifiers skip snapshotting entirely).
 */
export function required_pre_state(command) {
  const name = extract_command_name(command);
  if (name == null) return EMPTY_NEEDS;
  return command_verifiers[name]?.needs ?? EMPTY_NEEDS;
}

/**
 * Snapshots the requested state shards from the agent. Each shard is
 * captured independently — commands only pay for what their verifier
 * actually uses. Returns a plain object with the snapshotted fields.
 *
 * `get_am_state` is called at most once even when multiple AM-derived
 * shards (inventory + nearby_blocks + …) are requested.
 */
export function snapshot_state(agent, needs) {
  const state = {};
  if (!needs || needs.size === 0) return state;

  const wants_am = needs.has('inventory') || needs.has('nearby_blocks') ||
      needs.has('nearby_entities') || needs.has('craftable_items');
  const am_state = wants_am ? get_am_state(agent) : null;

  if (am_state && needs.has('inventory')) {
    state.inventory = {...(am_state.inventory ?? {})};
  }
  if (am_state && needs.has('nearby_blocks')) {
    state.nearby_blocks = [...(am_state.nearby_blocks ?? [])];
  }
  if (am_state && needs.has('nearby_entities')) {
    state.nearby_entities = {
      mobs: [...(am_state.nearby_entities?.mobs ?? [])],
    };
  }
  if (am_state && needs.has('craftable_items')) {
    state.craftable_items = [...(am_state.craftable_items ?? [])];
  }

  if (needs.has('position')) {
    const pos = agent?.bot?.entity?.position;
    if (pos != null) {
      state.position = {x: pos.x, y: pos.y, z: pos.z};
    }
  }
  if (needs.has('equipment')) {
    const bot = agent?.bot;
    state.equipment = {
      hand: read_equipment_slot(bot, 'hand'),
      head: read_equipment_slot(bot, 'head'),
      torso: read_equipment_slot(bot, 'torso'),
      legs: read_equipment_slot(bot, 'legs'),
      feet: read_equipment_slot(bot, 'feet'),
      'off-hand': read_equipment_slot(bot, 'off-hand'),
    };
  }

  return state;
}

/**
 * Verifies a command's post-condition. Returns:
 *
 *   {verified: false}
 *     — no verifier registered for this command name. Caller should
 *       trust the skill's success flag (V4 pass-through).
 *
 *   {verified: true, ok: true, reason}
 *     — verifier passed. Caller should keep the skill's success flag.
 *
 *   {verified: true, ok: false, reason}
 *     — verifier failed. Caller should reclassify `success: true` to
 *       `success: false` and prepend `verifier_failed:<reason>` to the
 *       message.
 *
 * Throws in the verifier are caught here — a buggy verifier should
 * never silently fail a command. We log and return `{verified: true,
 * ok: true, reason: 'verifier_error:...'}` so the original success is
 * preserved.
 */
export function verify_command_outcome(command, pre_state, post_state, agent) {
  const name = extract_command_name(command);
  if (name == null) return {verified: false};
  const verifier = command_verifiers[name];
  if (verifier == null) return {verified: false};

  const args = extract_command_args(command);
  if (args == null) {
    return {verified: true, ok: true, reason: 'unparseable_args'};
  }

  try {
    const result = verifier.verify(
        {args, pre: pre_state, post: post_state, agent});
    return {verified: true, ok: result.ok === true, reason: result.reason ?? null};
  } catch (e) {
    console.warn(`[SPL][verifier] "${name}" verifier threw: ${e.message}`);
    return {verified: true, ok: true, reason: `verifier_error:${e.message}`};
  }
}

/**
 * Extracts the command name from a command string. E.g.
 *   "!collectBlocks(\"oak_log\", 3)" → "!collectBlocks"
 *   "!goToSurface()"                 → "!goToSurface"
 */
export function extract_command_name(command) {
  if (typeof command !== 'string') return null;
  const match = command.match(/^(!\w+)/);
  return match?.[1] ?? null;
}

/**
 * Parses command arguments by treating the contents of the outer parens
 * as a JSON array. Relies on `failure_replanner.js:format_action_as_command`
 * serializing args via `JSON.stringify` for strings, `String(arg)` for
 * numbers, 'true' / 'false' for booleans, and 'null' for null — all of
 * which produce valid JSON values.
 *
 * Returns `null` if the command can't be parsed; the verifier treats
 * that as `{verified: true, ok: true, reason: 'unparseable_args'}` so
 * a parser bug doesn't cascade into spurious failures.
 *
 * Examples:
 *   "!collectBlocks(\"oak_log\", 3)"               → ["oak_log", 3]
 *   "!goToCoordinates(-1042.5, 70, 2150, 3)"       → [-1042.5, 70, 2150, 3]
 *   "!goToSurface()"                               → []
 *   "!smelt_item(\"raw_iron\", 3, \"birch_planks\")" → ["raw_iron", 3, "birch_planks"]
 */
/**
 * Expands an item name to its concrete members. For non-abstract names
 * (anything not starting with "any_"), returns `[item]` unchanged. For
 * registered abstracts (e.g. "any_log"), returns the concrete list from
 * `ABSTRACT_CLASS_MEMBERS`. For unknown abstracts, returns `[item]` —
 * defensive pass-through so a verifier never falsely flips a legitimate
 * success on an unrecognized abstract.
 *
 * Today the mediators resolve abstracts before issuing commands, so
 * abstract args rarely reach the verifier. This is belt-and-suspenders
 * (V8 in the verifier plan).
 */
function expand_to_concretes(item) {
  if (typeof item !== 'string') return [];
  if (!item.startsWith('any_')) return [item];
  const members = ABSTRACT_CLASS_MEMBERS?.[item];
  return members?.length ? members : [item];
}

function sum_inventory(inventory, items) {
  if (!inventory) return 0;
  let total = 0;
  for (const item of items) total += inventory[item] ?? 0;
  return total;
}

export function extract_command_args(command) {
  if (typeof command !== 'string') return null;
  const open = command.indexOf('(');
  if (open === -1) return null;
  const close = command.lastIndexOf(')');
  if (close <= open) return null;
  const args_str = command.slice(open + 1, close).trim();
  if (args_str === '') return [];
  try {
    return JSON.parse('[' + args_str + ']');
  } catch {
    return null;
  }
}
