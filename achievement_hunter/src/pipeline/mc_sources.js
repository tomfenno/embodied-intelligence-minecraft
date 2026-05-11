// Synonym groups: items that are functionally interchangeable in
// recipes / SCSG inventory checks. Distinct from `ABSTRACT_CLASS_MEMBERS`
// in that these are *concrete* item names (no `any_*` prefix) — when a
// PTD graph asks for "egg", we want any egg variant in the bot's
// inventory to count.
//
// Each entry maps an item name → the set of all interchangeable items
// (including itself). Membership is symmetric: any member can stand in
// for any other.
//
// Currently used for the 1.21.5+ chicken-variant eggs:
//   - egg        (temperate chicken)
//   - brown_egg  (warm chicken)
//   - blue_egg   (cold chicken)
// All three function identically for cake / pumpkin_pie / etc.
const _SYNONYM_GROUPS = [
  ['egg', 'brown_egg', 'blue_egg'],
];
export const ITEM_SYNONYMS = (() => {
  const out = {};
  for (const group of _SYNONYM_GROUPS) {
    for (const member of group) out[member] = group;
  }
  return out;
})();

export const ABSTRACT_CLASS_MEMBERS = {
  any_log: [
    'oak_log',
    'spruce_log',
    'birch_log',
    'jungle_log',
    'acacia_log',
    'dark_oak_log',
    'mangrove_log',
    'cherry_log',
    'pale_oak_log',
  ],
  any_plank: [
    'oak_planks',
    'spruce_planks',
    'birch_planks',
    'jungle_planks',
    'acacia_planks',
    'dark_oak_planks',
    'mangrove_planks',
    'cherry_planks',
    'pale_oak_planks',
    'bamboo_planks',
    'crimson_planks',
    'warped_planks',
  ],
  any_wood_slab: [
    'oak_slab',
    'spruce_slab',
    'birch_slab',
    'jungle_slab',
    'acacia_slab',
    'dark_oak_slab',
    'mangrove_slab',
    'cherry_slab',
    'pale_oak_slab',
    'bamboo_slab',
    'crimson_slab',
    'warped_slab',
  ],
  any_wool: [
    'white_wool',
    'orange_wool',
    'magenta_wool',
    'light_blue_wool',
    'yellow_wool',
    'lime_wool',
    'pink_wool',
    'gray_wool',
    'light_gray_wool',
    'cyan_wool',
    'purple_wool',
    'blue_wool',
    'brown_wool',
    'green_wool',
    'red_wool',
    'black_wool',
  ],
};

export const mob_search_targets = new Set([
  'skeleton',
  'stray',
  'wither_skeleton',
  'zombie',
  'zombie_villager',
  'drowned',
  'husk',
  'zombified_piglin',
  'creeper',
  'spider',
  'cave_spider',
  'enderman',
  'witch',
  'slime',
  'magma_cube',
  'blaze',
  'ghast',
  'phantom',
  'silverfish',
  'shulker',
  'guardian',
  'elder_guardian',
  'vindicator',
  'evoker',
  'pillager',
  'ravager',
  'cow',
  'mooshroom',
  'sheep',
  'pig',
  'chicken',
  'rabbit',
  'squid',
  'glow_squid',
  'fox',
  'wolf',
  'llama',
  'trader_llama',
  'horse',
  'donkey',
  'mule',
  'bee',
  'panda',
  'polar_bear',
  'turtle',
  'axolotl',
  'goat',
  'frog',
  'sniffer',
  'armadillo',
]);

export const any_log_search_targets = [
  'oak_log',
  'spruce_log',
  'birch_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'pale_oak_log',
];

const canonical_block_source_by_target = {
  any_log: 'any_log',
  oak_log: 'oak_log',
  spruce_log: 'spruce_log',
  birch_log: 'birch_log',
  jungle_log: 'jungle_log',
  acacia_log: 'acacia_log',
  dark_oak_log: 'dark_oak_log',
  mangrove_log: 'mangrove_log',
  cherry_log: 'cherry_log',
  pale_oak_log: 'pale_oak_log',

  cobblestone: 'stone',
  coal: 'coal_ore',
  raw_iron: 'iron_ore',
  raw_gold: 'gold_ore',
  redstone: 'redstone_ore',
  diamond: 'diamond_ore',
  lapis_lazuli: 'lapis_ore',
  emerald: 'emerald_ore',
  obsidian: 'lava',
  flint: 'gravel',

  sand: 'sand',
  clay_ball: 'clay',
  sugar_cane: 'sugar_cane',
  wheat: 'wheat',
  pumpkin: 'pumpkin',
  melon_slice: 'melon',
  cactus: 'cactus',
  kelp: 'kelp',
  bamboo: 'bamboo',
};

const canonical_mob_source_by_target = {
  bone: 'skeleton',
  arrow: 'skeleton',
  gunpowder: 'creeper',
  string: 'spider',
  spider_eye: 'spider',
  rotten_flesh: 'zombie',
  ender_pearl: 'enderman',
  blaze_rod: 'blaze',
  ghast_tear: 'ghast',
  slime_ball: 'slime',
  magma_cream: 'magma_cube',
  phantom_membrane: 'phantom',
  ink_sac: 'squid',
  glow_ink_sac: 'glow_squid',
  leather: 'cow',
  beef: 'cow',
  milk_bucket: 'cow',
  mutton: 'sheep',
  wool: 'sheep',
  porkchop: 'pig',
  chicken: 'chicken',
  egg: 'chicken',
  rabbit_hide: 'rabbit',
  rabbit: 'rabbit',
};

export function get_canonical_block_source(target_id) {
  const explicit = canonical_block_source_by_target[target_id];
  if (explicit) return explicit;
  if (target_id.endsWith('_log')) return target_id;
  return target_id.endsWith('_planks') ? target_id.replace(/_planks$/, '_log') :
                                         null;
}

export function get_canonical_mob_source(target_id) {
  return canonical_mob_source_by_target[target_id] ?? null;
}

export function get_canonical_source_for_target(target_id) {
  return get_canonical_mob_source(target_id) ??
      get_canonical_block_source(target_id);
}

export function get_source_kind_for_target(vertex) {
  return vertex.acquisition_dependency === 'mob' ? 'mob' : 'block';
}

export function is_environmental_use_target(source_block) {
  return source_block === 'water' || source_block === 'lava';
}

export function get_grounded_nearby_source(vertex, state) {
  return vertex.acquisition_dependency === 'mob' ?
      resolve_nearby_mob_source(vertex, state.nearby_entities?.mobs ?? []) :
      resolve_nearby_block_source(vertex, state.nearby_blocks ?? []);
}

export function resolve_nearby_block_source(candidate, nearby_blocks) {
  if (candidate.id === 'water_bucket') {
    return nearby_blocks.includes('water') ? 'water' : null;
  }
  if (candidate.id === 'lava_bucket') {
    return nearby_blocks.includes('lava') ? 'lava' : null;
  }

  if (candidate.id.startsWith('any_')) {
    const members = candidate.id === 'any_log' ?
        any_log_search_targets :
        (ABSTRACT_CLASS_MEMBERS[candidate.id] ?? []);
    return members.find(block => nearby_blocks.includes(block)) ?? null;
  }

  const canonical = get_canonical_block_source(candidate.id);
  return canonical && nearby_blocks.includes(canonical) ? canonical :
      nearby_blocks.includes(candidate.id)              ? candidate.id :
                                                          null;
}

export function resolve_fallback_block_source(candidate, nearby_blocks) {
  if (candidate.id === 'water_bucket') return 'water';
  if (candidate.id === 'lava_bucket') return 'lava';
  return candidate.id.startsWith('any_') ?
      (resolve_nearby_block_source(candidate, nearby_blocks) ?? candidate.id) :
      (get_canonical_block_source(candidate.id) ?? candidate.id);
}

export function resolve_nearby_mob_source(candidate, nearby_mobs) {
  const canonical = get_canonical_mob_source(candidate.id);
  return canonical && nearby_mobs.includes(canonical) ? canonical : null;
}
