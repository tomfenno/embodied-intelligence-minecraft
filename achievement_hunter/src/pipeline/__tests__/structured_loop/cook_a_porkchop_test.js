/**
 * Tests anchored to cook_a_porkchop_rollout.json.
 * Every AM command string expectation matches the exact value logged in that rollout.
 *
 * Rollout stage summary:
 *   1. collect any_log (spruce_log nearby)     → !collectBlocks("spruce_log", 3)
 *   2. craft spruce_planks (3 logs, batch=4)   → !craftRecipe("spruce_planks", 3)
 *   3. craft stick (2 needed, batch=4)         → !craftRecipe("stick", 1)
 *   4. craft crafting_table                    → !craftRecipe("crafting_table", 1)
 *   5. craft wooden_pickaxe                    → !craftRecipe("wooden_pickaxe", 1)
 *   6. collect cobblestone (stone nearby)      → !collectBlocks("stone", 8)
 *   7. craft furnace                           → !craftRecipe("furnace", 1)
 *   8. kill pig (search then attack)           → !search("pig") → !attack("pig")
 *   9. smelt porkchop (any_plank → spruce_planks) → !smelt_item("porkchop", 1, "spruce_planks")
 */
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('../../../../../src/agent/commands/index.js', () => ({executeCommand: vi.fn()}));
vi.mock('../../checkpoint.js', () => ({
  saveCheckpoint: vi.fn(),
  clearCheckpoint: vi.fn(),
  loadCheckpoint: vi.fn(),
}));
vi.mock('../../json_utils.js', () => ({
  extract_json: vi.fn(),
  save_json: vi.fn(),
  to_snake_case: vi.fn(),
}));
vi.mock('../../mc_utils.js', () => ({get_item_batch_size: vi.fn()}));
vi.mock('../../prompt_utils.js', () => ({fill_ptd_prompt: vi.fn()}));
vi.mock('../../rollout_logger.js', () => ({
  createRolloutLogger: vi.fn(() => ({
    ptd: vi.fn(),
    scsg: vi.fn(),
    candidates: vi.fn(),
    nts: vi.fn(),
    am: vi.fn(),
    complete: vi.fn(),
  })),
}));
vi.mock('../../state.js', () => ({
  get_am_state: vi.fn(),
  get_nts_state: vi.fn(),
  get_sgsg_state: vi.fn(),
}));

import {get_item_batch_size} from '../../mc_utils.js';
import {
  build_incoming_edge_map,
  check_search_complete,
  edge_in_subgraph,
  edge_key,
  expand_search_item,
  get_canonical_block_source,
  get_canonical_mob_source,
  get_command_failure_signature,
  get_satisfied_inputs_by_type,
  get_single_satisfied_input_item,
  is_craft_command,
  is_entity_target,
  is_environmental_use_target,
  is_successful_command_result,
  make_fallback_acquisition_task,
  make_search_command,
  mediate_collect,
  mediate_craft,
  mediate_kill,
  mediate_smelt,
  parse_search_command,
  resolve_concrete_craft_target,
  resolve_fallback_block_source,
  resolve_nearby_block_source,
  resolve_nearby_mob_source,
  resolve_smelt_fuel_name,
  select_next_task,
  should_abort_repeated_failure,
  try_make_craft_task,
  try_make_immediate_acquisition_task,
  try_make_smelt_task,
} from '../../structured_loop.js';

// ── Rollout-derived fixtures ──────────────────────────────────────────────────

const CANDIDATE_ANY_LOG = {
  id: 'any_log',
  qty: 3,
  item_type: 'resource',
  acquisition_dependency: 'none',
  satisfied_inputs: [],
  source_hint: 'any_log',
  source_kind: 'block',
  grounded_nearby_source: 'spruce_log',
};

const CANDIDATE_PORKCHOP = {
  id: 'porkchop',
  qty: 1,
  item_type: 'resource',
  acquisition_dependency: 'mob',
  satisfied_inputs: [],
  source_hint: 'pig',
  source_kind: 'mob',
  grounded_nearby_source: null,
};

const CANDIDATE_ANY_PLANK = {
  id: 'any_plank',
  qty: 10,
  item_type: 'item',
  acquisition_dependency: 'none',
  satisfied_inputs: [
    {item: 'any_log', qty: 3, type: 'crafting_input', consumed: true},
  ],
  source_hint: null,
  source_kind: 'block',
  grounded_nearby_source: null,
};

const CANDIDATE_STICK = {
  id: 'stick',
  qty: 2,
  item_type: 'item',
  acquisition_dependency: 'none',
  satisfied_inputs: [
    {item: 'any_plank', qty: 2, type: 'crafting_input', consumed: true},
  ],
  source_hint: null,
  source_kind: 'block',
  grounded_nearby_source: null,
};

const CANDIDATE_CRAFTING_TABLE = {
  id: 'crafting_table',
  qty: 1,
  item_type: 'workstation',
  acquisition_dependency: 'none',
  satisfied_inputs: [
    {item: 'any_plank', qty: 4, type: 'crafting_input', consumed: true},
  ],
  source_hint: null,
  source_kind: 'block',
  grounded_nearby_source: null,
};

const CANDIDATE_WOODEN_PICKAXE = {
  id: 'wooden_pickaxe',
  qty: 1,
  item_type: 'tool',
  acquisition_dependency: 'none',
  satisfied_inputs: [
    {item: 'stick', qty: 2, type: 'crafting_input', consumed: true},
    {item: 'any_plank', qty: 3, type: 'crafting_input', consumed: true},
    {item: 'crafting_table', qty: 1, type: 'workstation_dependency', consumed: false},
  ],
  source_hint: null,
  source_kind: 'block',
  grounded_nearby_source: null,
};

const CANDIDATE_COBBLESTONE = {
  id: 'cobblestone',
  qty: 8,
  item_type: 'resource',
  acquisition_dependency: 'none',
  satisfied_inputs: [
    {item: 'wooden_pickaxe', qty: 1, type: 'tool_dependency', consumed: false},
  ],
  source_hint: 'stone',
  source_kind: 'block',
  grounded_nearby_source: 'stone',
};

const CANDIDATE_FURNACE = {
  id: 'furnace',
  qty: 1,
  item_type: 'workstation',
  acquisition_dependency: 'none',
  satisfied_inputs: [
    {item: 'cobblestone', qty: 8, type: 'crafting_input', consumed: true},
    {item: 'crafting_table', qty: 1, type: 'workstation_dependency', consumed: false},
  ],
  source_hint: null,
  source_kind: 'block',
  grounded_nearby_source: null,
};

const CANDIDATE_COOKED_PORKCHOP = {
  id: 'cooked_porkchop',
  qty: 1,
  item_type: 'item',
  acquisition_dependency: 'none',
  satisfied_inputs: [
    {item: 'porkchop', qty: 1, type: 'smelting_input', consumed: true},
    {item: 'any_plank', qty: 1, type: 'fuel_input', consumed: true},
    {item: 'furnace', qty: 1, type: 'workstation_dependency', consumed: false},
  ],
  source_hint: null,
  source_kind: 'block',
  grounded_nearby_source: null,
};

// State at stage 1: empty inventory, spruce_log nearby, no mobs
const STATE_STAGE_1 = {
  craftable_items: [],
  nearby_blocks: [
    'sand', 'spruce_log', 'dirt', 'grass_block', 'sandstone',
    'stone', 'podzol', 'large_fern', 'fern', 'mossy_cobblestone',
  ],
  nearby_entities: {mobs: []},
};

// State at stage 2: has logs, spruce_planks now craftable
const STATE_STAGE_2 = {
  craftable_items: ['spruce_planks'],
  nearby_blocks: [
    'podzol', 'spruce_log', 'sand', 'large_fern', 'dirt',
    'mossy_cobblestone', 'stone', 'sandstone', 'grass_block', 'copper_ore',
    'fern', 'short_grass',
  ],
  nearby_entities: {mobs: []},
};

// State at stage 5: has planks + sticks + crafting_table, wooden_pickaxe craftable
const STATE_STAGE_5 = {
  craftable_items: [
    'spruce_planks', 'spruce_slab', 'crafting_table', 'spruce_fence',
    'spruce_stairs', 'spruce_button', 'spruce_pressure_plate', 'spruce_door',
    'spruce_trapdoor', 'spruce_fence_gate', 'spruce_boat', 'bowl',
    'wooden_sword', 'wooden_shovel', 'wooden_pickaxe', 'wooden_axe',
    'wooden_hoe', 'stick', 'spruce_sign',
  ],
  nearby_blocks: [
    'podzol', 'spruce_log', 'sand', 'large_fern', 'dirt',
    'mossy_cobblestone', 'stone', 'sandstone', 'grass_block', 'copper_ore',
    'fern', 'short_grass',
  ],
  nearby_entities: {mobs: []},
};

// State at stage 6: has wooden_pickaxe, stone nearby
const STATE_STAGE_6 = {
  craftable_items: [
    'spruce_planks', 'spruce_slab', 'spruce_button', 'spruce_pressure_plate',
    'bowl', 'wooden_sword', 'wooden_shovel', 'wooden_pickaxe', 'wooden_axe',
    'wooden_hoe', 'stick',
  ],
  nearby_blocks: [
    'podzol', 'spruce_log', 'sand', 'large_fern', 'dirt',
    'mossy_cobblestone', 'stone', 'sandstone', 'grass_block', 'copper_ore',
    'fern', 'short_grass',
  ],
  nearby_entities: {mobs: []},
};

// State at stage 7: has cobblestone + crafting_table, furnace craftable
const STATE_STAGE_7 = {
  craftable_items: [
    'spruce_planks', 'spruce_slab', 'cobblestone_slab', 'furnace',
    'cobblestone_stairs', 'cobblestone_wall', 'lever', 'spruce_button',
    'spruce_pressure_plate', 'bowl', 'wooden_sword', 'wooden_shovel',
    'wooden_pickaxe', 'wooden_axe', 'wooden_hoe', 'stone_sword',
    'stone_shovel', 'stone_pickaxe', 'stone_axe', 'stone_hoe', 'stick',
  ],
  nearby_blocks: [
    'stone', 'gravel', 'dirt', 'grass_block', 'fern', 'large_fern',
    'copper_ore', 'spruce_log', 'iron_ore', 'spruce_leaves', 'podzol',
    'short_grass', 'water', 'sand', 'sandstone',
  ],
  nearby_entities: {mobs: []},
};

// State at stage 8 kill attempt 2: pig found nearby
const STATE_PIG_FOUND = {
  inventory: {
    spruce_log: 1, stick: 2, furnace: 1, wooden_pickaxe: 1,
    spruce_planks: 3, dirt: 10, crafting_table: 1,
  },
  craftable_items: [
    'spruce_planks', 'spruce_slab', 'spruce_button', 'spruce_pressure_plate',
    'bowl', 'wooden_sword', 'wooden_shovel', 'wooden_pickaxe', 'wooden_axe',
    'wooden_hoe', 'stick',
  ],
  nearby_blocks: [
    'podzol', 'mossy_cobblestone', 'large_fern', 'dirt', 'spruce_leaves',
    'grass_block', 'stone', 'fern', 'short_grass', 'spruce_log', 'brown_mushroom',
  ],
  nearby_entities: {mobs: ['pig', 'chicken']},
};

// State at stage 9 smelt: has porkchop and spruce_planks, furnace in inventory
const STATE_SMELT = {
  inventory: {
    spruce_log: 1, stick: 2, furnace: 1, wooden_pickaxe: 1,
    spruce_planks: 3, dirt: 10, crafting_table: 1, porkchop: 2,
  },
  craftable_items: [
    'spruce_planks', 'spruce_slab', 'spruce_button', 'spruce_pressure_plate',
    'bowl', 'wooden_sword', 'wooden_shovel', 'wooden_pickaxe', 'wooden_axe',
    'wooden_hoe', 'stick',
  ],
  nearby_blocks: [
    'grass_block', 'podzol', 'mossy_cobblestone', 'dirt', 'fern',
    'spruce_leaves', 'large_fern', 'stone', 'spruce_log', 'brown_mushroom',
    'short_grass',
  ],
  nearby_entities: {mobs: ['chicken']},
};

// ── is_entity_target ──────────────────────────────────────────────────────────

describe('is_entity_target', () => {
  it('returns true for pig', () => {
    expect(is_entity_target('pig')).toBe(true);
  });

  it('returns true for skeleton', () => {
    expect(is_entity_target('skeleton')).toBe(true);
  });

  it('returns true for chicken (co-located with pig in rollout stage 8)', () => {
    expect(is_entity_target('chicken')).toBe(true);
  });

  it('returns false for spruce_log', () => {
    expect(is_entity_target('spruce_log')).toBe(false);
  });

  it('returns false for stone', () => {
    expect(is_entity_target('stone')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(is_entity_target('')).toBe(false);
  });
});

// ── check_search_complete ─────────────────────────────────────────────────────

describe('check_search_complete', () => {
  it('returns true when pig is in nearby_entities.mobs', () => {
    expect(check_search_complete('pig', STATE_PIG_FOUND)).toBe(true);
  });

  it('returns false when pig is not in nearby_entities.mobs', () => {
    expect(check_search_complete('pig', STATE_STAGE_1)).toBe(false);
  });

  it('returns true when spruce_log is in nearby_blocks', () => {
    expect(check_search_complete('spruce_log', STATE_STAGE_1)).toBe(true);
  });

  it('returns false when stone is not in nearby_blocks (stage 1 has stone but checking a missing block)', () => {
    const state = {nearby_blocks: ['dirt', 'grass_block'], nearby_entities: {mobs: []}};
    expect(check_search_complete('stone', state)).toBe(false);
  });

  it('returns false when state has no nearby_entities', () => {
    expect(check_search_complete('pig', {nearby_blocks: [], nearby_entities: {}})).toBe(false);
  });

  it('returns false when state has no nearby_blocks', () => {
    expect(check_search_complete('oak_log', {nearby_blocks: [], nearby_entities: {mobs: []}})).toBe(false);
  });
});

// ── make_search_command ───────────────────────────────────────────────────────

describe('make_search_command', () => {
  it('generates searchForEntity for pig at radius 32 (rollout stage 8 search)', () => {
    expect(make_search_command('pig', 32)).toBe('!searchForEntity("pig", 32)');
  });

  it('generates searchForEntity for pig at radius 64 (rollout stage 8 second attempt)', () => {
    expect(make_search_command('pig', 64)).toBe('!searchForEntity("pig", 64)');
  });

  it('generates searchForBlock for spruce_log at radius 32', () => {
    expect(make_search_command('spruce_log', 32)).toBe('!searchForBlock("spruce_log", 32)');
  });

  it('generates searchForBlock for stone at radius 128', () => {
    expect(make_search_command('stone', 128)).toBe('!searchForBlock("stone", 128)');
  });
});

// ── parse_search_command ──────────────────────────────────────────────────────

describe('parse_search_command', () => {
  it('extracts "pig" from !search("pig") — rollout stage 8 AM attempt 1', () => {
    expect(parse_search_command('!search("pig")')).toBe('pig');
  });

  it('extracts "stone" from !search("stone")', () => {
    expect(parse_search_command('!search("stone")')).toBe('stone');
  });

  it('extracts "spruce_log" from !search("spruce_log")', () => {
    expect(parse_search_command('!search("spruce_log")')).toBe('spruce_log');
  });

  it('returns null for !attack("pig") — must not intercept real commands', () => {
    expect(parse_search_command('!attack("pig")')).toBeNull();
  });

  it('returns null for !collectBlocks("spruce_log", 3)', () => {
    expect(parse_search_command('!collectBlocks("spruce_log", 3)')).toBeNull();
  });

  it('returns null for !craftRecipe("stick", 1)', () => {
    expect(parse_search_command('!craftRecipe("stick", 1)')).toBeNull();
  });

  it('strips leading/trailing whitespace before matching', () => {
    expect(parse_search_command('  !search("pig")  ')).toBe('pig');
  });
});

// ── expand_search_item ────────────────────────────────────────────────────────

describe('expand_search_item', () => {
  it('expands any_log to all 9 concrete log types', () => {
    const result = expand_search_item('any_log');
    expect(result).toHaveLength(9);
    expect(result).toContain('spruce_log');
    expect(result).toContain('oak_log');
  });

  it('includes spruce_log in any_log expansion (matches rollout stage 1 nearby block)', () => {
    expect(expand_search_item('any_log')).toContain('spruce_log');
  });

  it('returns a single-element array for a concrete target like "pig"', () => {
    expect(expand_search_item('pig')).toEqual(['pig']);
  });

  it('returns a single-element array for "stone"', () => {
    expect(expand_search_item('stone')).toEqual(['stone']);
  });

  it('throws for an unsupported abstract target like "any_plank"', () => {
    expect(() => expand_search_item('any_plank')).toThrow('Unsupported abstract search target');
  });
});

// ── is_successful_command_result ──────────────────────────────────────────────

describe('is_successful_command_result', () => {
  it('returns true for a non-string result (object)', () => {
    expect(is_successful_command_result({ok: true})).toBe(true);
  });

  it('returns true for a non-string result (null)', () => {
    expect(is_successful_command_result(null)).toBe(true);
  });

  it('returns true for a clean Action output string', () => {
    expect(is_successful_command_result('Action output: collected 3 spruce_log')).toBe(true);
  });

  it('returns false for a string containing "Error:"', () => {
    expect(is_successful_command_result('Action output: Error: could not reach block')).toBe(false);
  });

  it('returns false for a string containing "Could not find"', () => {
    expect(is_successful_command_result('Action output: Could not find spruce_log')).toBe(false);
  });

  it('returns false for a string containing "!!Code threw exception!!"', () => {
    expect(is_successful_command_result('Action output: !!Code threw exception!!')).toBe(false);
  });

  it('returns false for a raw error string not starting with Action output:', () => {
    expect(is_successful_command_result('Error: bot timed out')).toBe(false);
  });
});

// ── get_command_failure_signature ─────────────────────────────────────────────

describe('get_command_failure_signature', () => {
  it('returns null for a successful result', () => {
    expect(get_command_failure_signature(
        '!craftRecipe("stick", 1)',
        'Action output: crafted 4 stick',
    )).toBeNull();
  });

  it('returns null for a non-string result', () => {
    expect(get_command_failure_signature('!attack("pig")', null)).toBeNull();
  });

  it('returns a string signature for a failure result', () => {
    const sig = get_command_failure_signature(
        '!craftRecipe("stick", 1)',
        'Action output: Error: slot timeout 250ms',
    );
    expect(typeof sig).toBe('string');
    expect(sig).toContain('!craftRecipe("stick", 1)');
  });

  it('normalizes different timeout durations to the same signature', () => {
    const cmd = '!craftRecipe("stick", 1)';
    const result_a = 'Action output: Error: Event updateSlot:0 did not fire within timeout 250ms';
    const result_b = 'Action output: Error: Event updateSlot:0 did not fire within timeout 300ms';
    expect(get_command_failure_signature(cmd, result_a)).toBe(
        get_command_failure_signature(cmd, result_b),
    );
  });

  it('produces different signatures for different commands', () => {
    const result = 'Action output: Error: Could not find';
    const sig_a = get_command_failure_signature('!craftRecipe("stick", 1)', result);
    const sig_b = get_command_failure_signature('!craftRecipe("furnace", 1)', result);
    expect(sig_a).not.toBe(sig_b);
  });
});

// ── should_abort_repeated_failure ─────────────────────────────────────────────

describe('should_abort_repeated_failure', () => {
  const SLOT_TIMEOUT = 'Action output: Error: Event updateSlot:0 did not fire within timeout 250ms';
  const CRAFT_CMD = '!craftRecipe("stick", 1)';
  const STUB_TASK = {};

  it('returns true when craftRecipe slot-timeout repeated >= 2 times', () => {
    expect(should_abort_repeated_failure(STUB_TASK, CRAFT_CMD, SLOT_TIMEOUT, 2)).toBe(true);
  });

  it('returns true for repeated_count > 2', () => {
    expect(should_abort_repeated_failure(STUB_TASK, CRAFT_CMD, SLOT_TIMEOUT, 5)).toBe(true);
  });

  it('returns false when repeated_count is only 1', () => {
    expect(should_abort_repeated_failure(STUB_TASK, CRAFT_CMD, SLOT_TIMEOUT, 1)).toBe(false);
  });

  it('returns false for a non-craftRecipe command', () => {
    expect(should_abort_repeated_failure(STUB_TASK, '!collectBlocks("stone", 8)', SLOT_TIMEOUT, 5)).toBe(false);
  });

  it('returns false for craftRecipe without the slot-timeout error message', () => {
    expect(should_abort_repeated_failure(
        STUB_TASK, CRAFT_CMD, 'Action output: Error: Could not find', 2,
    )).toBe(false);
  });

  it('returns false when result is not a string', () => {
    expect(should_abort_repeated_failure(STUB_TASK, CRAFT_CMD, null, 5)).toBe(false);
  });
});

// ── is_craft_command ──────────────────────────────────────────────────────────

describe('is_craft_command', () => {
  it('returns true for !craftRecipe(...) — all craft stages in rollout', () => {
    expect(is_craft_command('!craftRecipe("spruce_planks", 3)')).toBe(true);
  });

  it('returns true for !smelt_item(...) — rollout stage 9', () => {
    expect(is_craft_command('!smelt_item("porkchop", 1, "spruce_planks")')).toBe(true);
  });

  it('returns true for !smeltItem(...)', () => {
    expect(is_craft_command('!smeltItem("iron_ore", 1)')).toBe(true);
  });

  it('returns false for !collectBlocks(...)', () => {
    expect(is_craft_command('!collectBlocks("spruce_log", 3)')).toBe(false);
  });

  it('returns false for !attack(...)', () => {
    expect(is_craft_command('!attack("pig")')).toBe(false);
  });

  it('returns false for !search(...)', () => {
    expect(is_craft_command('!search("pig")')).toBe(false);
  });

  it('returns false for a non-string', () => {
    expect(is_craft_command(null)).toBe(false);
  });
});

// ── is_environmental_use_target ───────────────────────────────────────────────

describe('is_environmental_use_target', () => {
  it('returns true for "water" (bucket fill target)', () => {
    expect(is_environmental_use_target('water')).toBe(true);
  });

  it('returns true for "lava" (obsidian / lava bucket)', () => {
    expect(is_environmental_use_target('lava')).toBe(true);
  });

  it('returns false for "stone"', () => {
    expect(is_environmental_use_target('stone')).toBe(false);
  });

  it('returns false for "spruce_log"', () => {
    expect(is_environmental_use_target('spruce_log')).toBe(false);
  });
});

// ── get_canonical_block_source ────────────────────────────────────────────────

describe('get_canonical_block_source', () => {
  it('maps cobblestone → stone (rollout stage 6 source_block)', () => {
    expect(get_canonical_block_source('cobblestone')).toBe('stone');
  });

  it('maps spruce_log → spruce_log (self-referential)', () => {
    expect(get_canonical_block_source('spruce_log')).toBe('spruce_log');
  });

  it('maps spruce_planks → spruce_log via _planks suffix rule', () => {
    expect(get_canonical_block_source('spruce_planks')).toBe('spruce_log');
  });

  it('maps oak_planks → oak_log via _planks suffix rule', () => {
    expect(get_canonical_block_source('oak_planks')).toBe('oak_log');
  });

  it('maps diamond → diamond_ore', () => {
    expect(get_canonical_block_source('diamond')).toBe('diamond_ore');
  });

  it('maps raw_iron → iron_ore', () => {
    expect(get_canonical_block_source('raw_iron')).toBe('iron_ore');
  });

  it('maps flint → gravel', () => {
    expect(get_canonical_block_source('flint')).toBe('gravel');
  });

  it('returns null for an unknown item with no suffix rule', () => {
    expect(get_canonical_block_source('ghost_item')).toBeNull();
  });
});

// ── get_canonical_mob_source ──────────────────────────────────────────────────

describe('get_canonical_mob_source', () => {
  it('maps porkchop → pig (core of the rollout objective)', () => {
    expect(get_canonical_mob_source('porkchop')).toBe('pig');
  });

  it('maps beef → cow', () => {
    expect(get_canonical_mob_source('beef')).toBe('cow');
  });

  it('maps leather → cow', () => {
    expect(get_canonical_mob_source('leather')).toBe('cow');
  });

  it('maps blaze_rod → blaze', () => {
    expect(get_canonical_mob_source('blaze_rod')).toBe('blaze');
  });

  it('maps chicken → chicken', () => {
    expect(get_canonical_mob_source('chicken')).toBe('chicken');
  });

  it('returns null for an unknown drop', () => {
    expect(get_canonical_mob_source('ghost_drop')).toBeNull();
  });

  it('returns null for a block item like cobblestone', () => {
    expect(get_canonical_mob_source('cobblestone')).toBeNull();
  });
});

// ── resolve_nearby_block_source ───────────────────────────────────────────────

describe('resolve_nearby_block_source', () => {
  it('resolves any_log → spruce_log when spruce_log is nearby (rollout stage 1)', () => {
    expect(resolve_nearby_block_source(CANDIDATE_ANY_LOG, STATE_STAGE_1.nearby_blocks)).toBe('spruce_log');
  });

  it('resolves cobblestone → stone when stone is nearby (rollout stage 6)', () => {
    expect(resolve_nearby_block_source(CANDIDATE_COBBLESTONE, STATE_STAGE_6.nearby_blocks)).toBe('stone');
  });

  it('returns null for porkchop — it has no block source', () => {
    expect(resolve_nearby_block_source(CANDIDATE_PORKCHOP, STATE_STAGE_1.nearby_blocks)).toBeNull();
  });

  it('returns null for any_log when no log types are nearby', () => {
    expect(resolve_nearby_block_source(CANDIDATE_ANY_LOG, ['dirt', 'grass_block', 'sand'])).toBeNull();
  });

  it('resolves water_bucket → water when water is nearby', () => {
    const candidate = {id: 'water_bucket', qty: 1};
    expect(resolve_nearby_block_source(candidate, ['water', 'stone'])).toBe('water');
  });

  it('returns null for water_bucket when water is not nearby', () => {
    const candidate = {id: 'water_bucket', qty: 1};
    expect(resolve_nearby_block_source(candidate, ['dirt', 'stone'])).toBeNull();
  });

  it('resolves lava_bucket → lava when lava is nearby', () => {
    const candidate = {id: 'lava_bucket', qty: 1};
    expect(resolve_nearby_block_source(candidate, ['lava', 'stone'])).toBe('lava');
  });
});

// ── resolve_fallback_block_source ─────────────────────────────────────────────

describe('resolve_fallback_block_source', () => {
  it('falls back to "stone" for cobblestone when nothing nearby', () => {
    expect(resolve_fallback_block_source(CANDIDATE_COBBLESTONE, [])).toBe('stone');
  });

  it('falls back to "any_log" for any_log when no concrete log is nearby', () => {
    expect(resolve_fallback_block_source(CANDIDATE_ANY_LOG, ['dirt', 'grass_block'])).toBe('any_log');
  });

  it('returns "water" for water_bucket regardless of nearby_blocks', () => {
    const candidate = {id: 'water_bucket', qty: 1};
    expect(resolve_fallback_block_source(candidate, [])).toBe('water');
  });

  it('returns "lava" for lava_bucket regardless of nearby_blocks', () => {
    const candidate = {id: 'lava_bucket', qty: 1};
    expect(resolve_fallback_block_source(candidate, [])).toBe('lava');
  });

  it('uses a nearby log type when available for any_log fallback', () => {
    expect(resolve_fallback_block_source(CANDIDATE_ANY_LOG, ['oak_log', 'dirt'])).toBe('oak_log');
  });
});

// ── resolve_nearby_mob_source ─────────────────────────────────────────────────

describe('resolve_nearby_mob_source', () => {
  it('resolves porkchop candidate → pig when pig is in nearby_mobs (rollout stage 8 attempt 2)', () => {
    expect(resolve_nearby_mob_source(CANDIDATE_PORKCHOP, ['pig', 'chicken'])).toBe('pig');
  });

  it('returns null for porkchop when only chicken is nearby', () => {
    expect(resolve_nearby_mob_source(CANDIDATE_PORKCHOP, ['chicken'])).toBeNull();
  });

  it('returns null for porkchop when mobs list is empty (rollout stage 1)', () => {
    expect(resolve_nearby_mob_source(CANDIDATE_PORKCHOP, [])).toBeNull();
  });

  it('returns null for cobblestone — has no mob source', () => {
    expect(resolve_nearby_mob_source(CANDIDATE_COBBLESTONE, ['pig', 'cow'])).toBeNull();
  });
});

// ── build_incoming_edge_map / edge_key / edge_in_subgraph ─────────────────────

describe('edge_key', () => {
  it('produces a stable string key from from/to/type', () => {
    expect(edge_key('porkchop', 'cooked_porkchop', 'smelting_input'))
        .toBe('porkchop→cooked_porkchop→smelting_input');
  });

  it('produces different keys for different types', () => {
    const a = edge_key('cobblestone', 'furnace', 'crafting_input');
    const b = edge_key('cobblestone', 'furnace', 'workstation_dependency');
    expect(a).not.toBe(b);
  });
});

describe('build_incoming_edge_map', () => {
  const EDGES = [
    {from: 'porkchop', to: 'cooked_porkchop', type: 'smelting_input', qty: 1, consumed: true},
    {from: 'any_plank', to: 'cooked_porkchop', type: 'fuel_input', qty: 1, consumed: true},
    {from: 'furnace', to: 'cooked_porkchop', type: 'workstation_dependency', qty: 1, consumed: false},
    {from: 'cobblestone', to: 'furnace', type: 'crafting_input', qty: 8, consumed: true},
  ];

  it('groups all three cooked_porkchop edges under that key', () => {
    const map = build_incoming_edge_map(EDGES);
    expect(map.get('cooked_porkchop')).toHaveLength(3);
  });

  it('groups the single furnace incoming edge correctly', () => {
    const map = build_incoming_edge_map(EDGES);
    expect(map.get('furnace')).toHaveLength(1);
    expect(map.get('furnace')[0].from).toBe('cobblestone');
  });

  it('returns undefined for a vertex with no incoming edges', () => {
    const map = build_incoming_edge_map(EDGES);
    expect(map.get('porkchop')).toBeUndefined();
  });
});

describe('edge_in_subgraph', () => {
  it('returns true when edge is in the set', () => {
    const edge = {from: 'any_log', to: 'any_plank', type: 'crafting_input'};
    const set = new Set([edge_key('any_log', 'any_plank', 'crafting_input')]);
    expect(edge_in_subgraph(edge, set)).toBe(true);
  });

  it('returns false when edge is not in the set (pruned)', () => {
    const edge = {from: 'any_log', to: 'any_plank', type: 'crafting_input'};
    const set = new Set([edge_key('cobblestone', 'furnace', 'crafting_input')]);
    expect(edge_in_subgraph(edge, set)).toBe(false);
  });
});

// ── get_satisfied_inputs_by_type ──────────────────────────────────────────────

describe('get_satisfied_inputs_by_type', () => {
  it('extracts crafting_inputs from wooden_pickaxe candidate (rollout stage 5)', () => {
    const result = get_satisfied_inputs_by_type(CANDIDATE_WOODEN_PICKAXE, 'crafting_input');
    expect(result).toEqual([
      {item: 'stick', qty: 2},
      {item: 'any_plank', qty: 3},
    ]);
  });

  it('returns only {item, qty} — no type, consumed, or other fields', () => {
    const result = get_satisfied_inputs_by_type(CANDIDATE_WOODEN_PICKAXE, 'crafting_input');
    for (const input of result) {
      expect(Object.keys(input)).toEqual(['item', 'qty']);
    }
  });

  it('returns empty array when no inputs match the type', () => {
    expect(get_satisfied_inputs_by_type(CANDIDATE_ANY_LOG, 'crafting_input')).toEqual([]);
  });

  it('extracts smelting_input from cooked_porkchop candidate (rollout stage 9)', () => {
    const result = get_satisfied_inputs_by_type(CANDIDATE_COOKED_PORKCHOP, 'smelting_input');
    expect(result).toEqual([{item: 'porkchop', qty: 1}]);
  });

  it('extracts fuel_input from cooked_porkchop candidate', () => {
    const result = get_satisfied_inputs_by_type(CANDIDATE_COOKED_PORKCHOP, 'fuel_input');
    expect(result).toEqual([{item: 'any_plank', qty: 1}]);
  });

  it('handles a candidate with no satisfied_inputs', () => {
    expect(get_satisfied_inputs_by_type(CANDIDATE_PORKCHOP, 'crafting_input')).toEqual([]);
  });
});

// ── get_single_satisfied_input_item ───────────────────────────────────────────

describe('get_single_satisfied_input_item', () => {
  it('returns "crafting_table" as workstation for wooden_pickaxe (rollout stage 5)', () => {
    expect(get_single_satisfied_input_item(CANDIDATE_WOODEN_PICKAXE, 'workstation_dependency'))
        .toBe('crafting_table');
  });

  it('returns "furnace" as workstation for cooked_porkchop (rollout stage 9)', () => {
    expect(get_single_satisfied_input_item(CANDIDATE_COOKED_PORKCHOP, 'workstation_dependency'))
        .toBe('furnace');
  });

  it('returns null when the type is not present', () => {
    expect(get_single_satisfied_input_item(CANDIDATE_ANY_PLANK, 'workstation_dependency'))
        .toBeNull();
  });

  it('returns null for porkchop candidate with empty satisfied_inputs', () => {
    expect(get_single_satisfied_input_item(CANDIDATE_PORKCHOP, 'tool_dependency')).toBeNull();
  });

  it('returns "wooden_pickaxe" as tool for cobblestone candidate (rollout stage 6)', () => {
    expect(get_single_satisfied_input_item(CANDIDATE_COBBLESTONE, 'tool_dependency'))
        .toBe('wooden_pickaxe');
  });
});

// ── resolve_concrete_craft_target ─────────────────────────────────────────────

describe('resolve_concrete_craft_target', () => {
  it('resolves any_plank → spruce_planks when spruce_planks is craftable (rollout stage 2)', () => {
    expect(resolve_concrete_craft_target('any_plank', ['spruce_planks'])).toBe('spruce_planks');
  });

  it('resolves concrete "stick" when stick is craftable (rollout stage 3)', () => {
    expect(resolve_concrete_craft_target('stick', STATE_STAGE_2.craftable_items.concat(['stick'])))
        .toBe('stick');
  });

  it('resolves "crafting_table" when craftable (rollout stage 4)', () => {
    expect(resolve_concrete_craft_target('crafting_table', ['spruce_planks', 'crafting_table']))
        .toBe('crafting_table');
  });

  it('resolves "wooden_pickaxe" when craftable (rollout stage 5)', () => {
    expect(resolve_concrete_craft_target('wooden_pickaxe', STATE_STAGE_5.craftable_items))
        .toBe('wooden_pickaxe');
  });

  it('resolves "furnace" when craftable (rollout stage 7)', () => {
    expect(resolve_concrete_craft_target('furnace', STATE_STAGE_7.craftable_items))
        .toBe('furnace');
  });

  it('returns null when item is not in craftable_items', () => {
    expect(resolve_concrete_craft_target('furnace', ['stick', 'crafting_table'])).toBeNull();
  });

  it('returns null when any_plank has no matching member in craftable_items', () => {
    expect(resolve_concrete_craft_target('any_plank', ['furnace', 'stick'])).toBeNull();
  });
});

// ── try_make_craft_task ───────────────────────────────────────────────────────

describe('try_make_craft_task', () => {
  it('builds craft task for any_plank → spruce_planks (rollout stage 2 NTS)', () => {
    const task = try_make_craft_task(CANDIDATE_ANY_PLANK, {craftable_items: ['spruce_planks']});
    expect(task).toEqual({
      target_item: 'spruce_planks',
      qty: 10,
      action_type: 'craft',
      parameters: {
        crafting_inputs: [{item: 'any_log', qty: 3}],
        workstation: null,
      },
    });
  });

  it('builds craft task for stick with no workstation (rollout stage 3 NTS)', () => {
    const task = try_make_craft_task(CANDIDATE_STICK, {craftable_items: ['stick']});
    expect(task).toEqual({
      target_item: 'stick',
      qty: 2,
      action_type: 'craft',
      parameters: {
        crafting_inputs: [{item: 'any_plank', qty: 2}],
        workstation: null,
      },
    });
  });

  it('builds craft task for wooden_pickaxe with crafting_table workstation (rollout stage 5)', () => {
    const task = try_make_craft_task(CANDIDATE_WOODEN_PICKAXE, {craftable_items: STATE_STAGE_5.craftable_items});
    expect(task).toEqual({
      target_item: 'wooden_pickaxe',
      qty: 1,
      action_type: 'craft',
      parameters: {
        crafting_inputs: [{item: 'stick', qty: 2}, {item: 'any_plank', qty: 3}],
        workstation: 'crafting_table',
      },
    });
  });

  it('builds craft task for furnace with crafting_table workstation (rollout stage 7)', () => {
    const task = try_make_craft_task(CANDIDATE_FURNACE, {craftable_items: STATE_STAGE_7.craftable_items});
    expect(task).toEqual({
      target_item: 'furnace',
      qty: 1,
      action_type: 'craft',
      parameters: {
        crafting_inputs: [{item: 'cobblestone', qty: 8}],
        workstation: 'crafting_table',
      },
    });
  });

  it('returns null when the item is not yet craftable', () => {
    expect(try_make_craft_task(CANDIDATE_ANY_PLANK, {craftable_items: []})).toBeNull();
  });

  it('returns null for a resource candidate (porkchop is not itemish)', () => {
    expect(try_make_craft_task(CANDIDATE_PORKCHOP, {craftable_items: ['porkchop']})).toBeNull();
  });
});

// ── try_make_smelt_task ───────────────────────────────────────────────────────

describe('try_make_smelt_task', () => {
  it('builds smelt task for cooked_porkchop when all inputs satisfied (rollout stage 9 NTS)', () => {
    const task = try_make_smelt_task(CANDIDATE_COOKED_PORKCHOP);
    expect(task).toEqual({
      target_item: 'cooked_porkchop',
      qty: 1,
      action_type: 'smelt',
      parameters: {
        smelting_inputs: [{item: 'porkchop', qty: 1}],
        fuel_inputs: [{item: 'any_plank', qty: 1}],
        workstation: 'furnace',
      },
    });
  });

  it('returns null when fuel_input is missing from satisfied_inputs', () => {
    const no_fuel = {
      ...CANDIDATE_COOKED_PORKCHOP,
      satisfied_inputs: [
        {item: 'porkchop', qty: 1, type: 'smelting_input', consumed: true},
        {item: 'furnace', qty: 1, type: 'workstation_dependency', consumed: false},
      ],
    };
    expect(try_make_smelt_task(no_fuel)).toBeNull();
  });

  it('returns null when workstation is missing from satisfied_inputs', () => {
    const no_ws = {
      ...CANDIDATE_COOKED_PORKCHOP,
      satisfied_inputs: [
        {item: 'porkchop', qty: 1, type: 'smelting_input', consumed: true},
        {item: 'any_plank', qty: 1, type: 'fuel_input', consumed: true},
      ],
    };
    expect(try_make_smelt_task(no_ws)).toBeNull();
  });

  it('returns null for a resource candidate', () => {
    expect(try_make_smelt_task(CANDIDATE_PORKCHOP)).toBeNull();
  });
});

// ── try_make_immediate_acquisition_task ───────────────────────────────────────

describe('try_make_immediate_acquisition_task', () => {
  it('builds kill task for porkchop when pig is nearby (rollout stage 8 attempt 2)', () => {
    const task = try_make_immediate_acquisition_task(CANDIDATE_PORKCHOP, STATE_PIG_FOUND);
    expect(task).toEqual({
      target_item: 'porkchop',
      qty: 1,
      action_type: 'kill',
      parameters: {source_mob: 'pig', weapon: null},
    });
  });

  it('returns null for porkchop when pig is not nearby (rollout stages 1-7)', () => {
    expect(try_make_immediate_acquisition_task(CANDIDATE_PORKCHOP, STATE_STAGE_1)).toBeNull();
  });

  it('builds collect task for any_log when spruce_log is nearby (rollout stage 1)', () => {
    const task = try_make_immediate_acquisition_task(CANDIDATE_ANY_LOG, STATE_STAGE_1);
    expect(task).toEqual({
      target_item: 'any_log',
      qty: 3,
      action_type: 'collect',
      parameters: {source_block: 'spruce_log', item_dependency: null, tool: null},
    });
  });

  it('builds collect task for cobblestone with tool=wooden_pickaxe (rollout stage 6)', () => {
    const task = try_make_immediate_acquisition_task(CANDIDATE_COBBLESTONE, STATE_STAGE_6);
    expect(task).toEqual({
      target_item: 'cobblestone',
      qty: 8,
      action_type: 'collect',
      parameters: {source_block: 'stone', item_dependency: null, tool: 'wooden_pickaxe'},
    });
  });

  it('returns null for cobblestone when stone is not nearby', () => {
    const no_stone = {...STATE_STAGE_6, nearby_blocks: ['dirt', 'grass_block']};
    expect(try_make_immediate_acquisition_task(CANDIDATE_COBBLESTONE, no_stone)).toBeNull();
  });
});

// ── make_fallback_acquisition_task ────────────────────────────────────────────

describe('make_fallback_acquisition_task', () => {
  it('builds fallback kill task for porkchop using canonical mob pig', () => {
    const task = make_fallback_acquisition_task(CANDIDATE_PORKCHOP, {nearby_blocks: []});
    expect(task).toEqual({
      target_item: 'porkchop',
      qty: 1,
      action_type: 'kill',
      parameters: {source_mob: 'pig', weapon: null},
    });
  });

  it('builds fallback collect task for cobblestone using canonical source stone', () => {
    const task = make_fallback_acquisition_task(CANDIDATE_COBBLESTONE, {nearby_blocks: []});
    expect(task).toEqual({
      target_item: 'cobblestone',
      qty: 8,
      action_type: 'collect',
      parameters: {source_block: 'stone', item_dependency: null, tool: 'wooden_pickaxe'},
    });
  });

  it('builds fallback collect for any_log using "any_log" as source when nothing nearby', () => {
    const task = make_fallback_acquisition_task(CANDIDATE_ANY_LOG, {nearby_blocks: []});
    expect(task.parameters.source_block).toBe('any_log');
  });
});

// ── select_next_task ──────────────────────────────────────────────────────────

describe('select_next_task', () => {
  it('stage 1: picks collect any_log over porkchop (log nearby, no pig)', () => {
    const candidates = [CANDIDATE_PORKCHOP, CANDIDATE_ANY_LOG];
    const task = select_next_task(candidates, STATE_STAGE_1);
    expect(task.action_type).toBe('collect');
    expect(task.target_item).toBe('any_log');
    expect(task.parameters.source_block).toBe('spruce_log');
  });

  it('stage 2: picks craft spruce_planks over porkchop (craft tier wins)', () => {
    const candidates = [CANDIDATE_PORKCHOP, CANDIDATE_ANY_PLANK];
    const task = select_next_task(candidates, STATE_STAGE_2);
    expect(task.action_type).toBe('craft');
    expect(task.target_item).toBe('spruce_planks');
  });

  it('stage 3: picks craft stick (now craftable)', () => {
    const state = {...STATE_STAGE_2, craftable_items: [...STATE_STAGE_2.craftable_items, 'stick', 'crafting_table']};
    const task = select_next_task([CANDIDATE_PORKCHOP, CANDIDATE_STICK, CANDIDATE_CRAFTING_TABLE], state);
    expect(task.action_type).toBe('craft');
    expect(task.target_item).toBe('stick');
  });

  it('stage 5: picks craft wooden_pickaxe with crafting_table workstation', () => {
    const task = select_next_task(
        [CANDIDATE_PORKCHOP, CANDIDATE_WOODEN_PICKAXE],
        STATE_STAGE_5,
    );
    expect(task.action_type).toBe('craft');
    expect(task.target_item).toBe('wooden_pickaxe');
    expect(task.parameters.workstation).toBe('crafting_table');
  });

  it('stage 8: picks kill porkchop when pig found nearby', () => {
    const task = select_next_task([CANDIDATE_PORKCHOP], STATE_PIG_FOUND);
    expect(task.action_type).toBe('kill');
    expect(task.parameters.source_mob).toBe('pig');
  });

  it('stage 9: picks smelt cooked_porkchop when all inputs satisfied', () => {
    const task = select_next_task([CANDIDATE_COOKED_PORKCHOP], STATE_SMELT);
    expect(task.action_type).toBe('smelt');
    expect(task.target_item).toBe('cooked_porkchop');
  });

  it('returns null when no candidate can produce a task', () => {
    const unsatisfiable = {
      ...CANDIDATE_COOKED_PORKCHOP,
      satisfied_inputs: [],
    };
    expect(select_next_task([unsatisfiable], {craftable_items: [], nearby_blocks: [], nearby_entities: {mobs: []}})).toBeNull();
  });

  it('craft tier takes priority over immediate acquisition (craft beats nearby block)', () => {
    const state = {
      craftable_items: ['spruce_planks'],
      nearby_blocks: ['spruce_log'],
      nearby_entities: {mobs: []},
    };
    const task = select_next_task([CANDIDATE_ANY_LOG, CANDIDATE_ANY_PLANK], state);
    expect(task.action_type).toBe('craft');
  });
});

// ── mediate_collect ───────────────────────────────────────────────────────────

describe('mediate_collect', () => {
  const TASK_COLLECT_LOG = {
    target_item: 'any_log',
    qty: 3,
    action_type: 'collect',
    parameters: {source_block: 'spruce_log', item_dependency: null, tool: null},
  };

  const TASK_COLLECT_COBBLESTONE = {
    target_item: 'cobblestone',
    qty: 8,
    action_type: 'collect',
    parameters: {source_block: 'stone', item_dependency: null, tool: 'wooden_pickaxe'},
  };

  it('generates !collectBlocks("spruce_log", 3) when spruce_log is nearby (rollout stage 1 AM)', () => {
    const action = mediate_collect(TASK_COLLECT_LOG, STATE_STAGE_1);
    expect(action).toEqual({kind: 'command', command: '!collectBlocks("spruce_log", 3)'});
  });

  it('generates !collectBlocks("stone", 8) when stone is nearby (rollout stage 6 AM)', () => {
    const action = mediate_collect(TASK_COLLECT_COBBLESTONE, STATE_STAGE_6);
    expect(action).toEqual({kind: 'command', command: '!collectBlocks("stone", 8)'});
  });

  it('generates !search("spruce_log") when spruce_log is not nearby', () => {
    const state = {...STATE_STAGE_1, nearby_blocks: ['dirt', 'grass_block']};
    const action = mediate_collect(TASK_COLLECT_LOG, state);
    expect(action).toEqual({kind: 'command', command: '!search("spruce_log")'});
  });

  it('generates !search("stone") when stone is not nearby', () => {
    const state = {...STATE_STAGE_6, nearby_blocks: ['dirt', 'grass_block']};
    const action = mediate_collect(TASK_COLLECT_COBBLESTONE, state);
    expect(action).toEqual({kind: 'command', command: '!search("stone")'});
  });

  it('generates !useOn for water + item_dependency (bucket fill)', () => {
    const task = {
      target_item: 'water_bucket',
      qty: 1,
      action_type: 'collect',
      parameters: {source_block: 'water', item_dependency: 'bucket', tool: null},
    };
    const action = mediate_collect(task, {nearby_blocks: ['water']});
    expect(action).toEqual({kind: 'command', command: '!useOn("bucket", "water")'});
  });

  it('generates !collectBlocks for stone even if tool is provided (stone is not environmental)', () => {
    const action = mediate_collect(TASK_COLLECT_COBBLESTONE, STATE_STAGE_6);
    expect(action.command).toBe('!collectBlocks("stone", 8)');
  });
});

// ── mediate_kill ──────────────────────────────────────────────────────────────

describe('mediate_kill', () => {
  const TASK_KILL_PIG = {
    target_item: 'porkchop',
    qty: 1,
    action_type: 'kill',
    parameters: {source_mob: 'pig', weapon: null},
  };

  it('generates !search("pig") when pig is not nearby (rollout stage 8 AM attempt 1)', () => {
    const action = mediate_kill(TASK_KILL_PIG, STATE_STAGE_7);
    expect(action).toEqual({kind: 'command', command: '!search("pig")'});
  });

  it('generates !attack("pig") when pig is nearby (rollout stage 8 AM attempt 2)', () => {
    const action = mediate_kill(TASK_KILL_PIG, STATE_PIG_FOUND);
    expect(action).toEqual({kind: 'command', command: '!attack("pig")'});
  });

  it('generates !search when nearby_entities is missing', () => {
    const action = mediate_kill(TASK_KILL_PIG, {});
    expect(action.command).toBe('!search("pig")');
  });
});

// ── mediate_craft ─────────────────────────────────────────────────────────────

describe('mediate_craft', () => {
  beforeEach(() => {
    vi.mocked(get_item_batch_size).mockReset();
  });

  it('generates !craftRecipe("spruce_planks", 3) — qty=10, batch=4, ceil(10/4)=3 (rollout stage 2 AM)', () => {
    vi.mocked(get_item_batch_size).mockReturnValue(4);
    const task = {target_item: 'spruce_planks', qty: 10, action_type: 'craft', parameters: {}};
    expect(mediate_craft(task).command).toBe('!craftRecipe("spruce_planks", 3)');
  });

  it('generates !craftRecipe("stick", 1) — qty=2, batch=4, ceil(2/4)=1 (rollout stage 3 AM)', () => {
    vi.mocked(get_item_batch_size).mockReturnValue(4);
    const task = {target_item: 'stick', qty: 2, action_type: 'craft', parameters: {}};
    expect(mediate_craft(task).command).toBe('!craftRecipe("stick", 1)');
  });

  it('generates !craftRecipe("crafting_table", 1) — qty=1, batch=1 (rollout stage 4 AM)', () => {
    vi.mocked(get_item_batch_size).mockReturnValue(1);
    const task = {target_item: 'crafting_table', qty: 1, action_type: 'craft', parameters: {}};
    expect(mediate_craft(task).command).toBe('!craftRecipe("crafting_table", 1)');
  });

  it('generates !craftRecipe("wooden_pickaxe", 1) — qty=1, batch=1 (rollout stage 5 AM)', () => {
    vi.mocked(get_item_batch_size).mockReturnValue(1);
    const task = {target_item: 'wooden_pickaxe', qty: 1, action_type: 'craft', parameters: {}};
    expect(mediate_craft(task).command).toBe('!craftRecipe("wooden_pickaxe", 1)');
  });

  it('generates !craftRecipe("furnace", 1) — qty=1, batch=1 (rollout stage 7 AM)', () => {
    vi.mocked(get_item_batch_size).mockReturnValue(1);
    const task = {target_item: 'furnace', qty: 1, action_type: 'craft', parameters: {}};
    expect(mediate_craft(task).command).toBe('!craftRecipe("furnace", 1)');
  });

  it('uses raw qty when batch_size is null (no recipe found)', () => {
    vi.mocked(get_item_batch_size).mockReturnValue(null);
    const task = {target_item: 'custom_item', qty: 5, action_type: 'craft', parameters: {}};
    expect(mediate_craft(task).command).toBe('!craftRecipe("custom_item", 5)');
  });

  it('returns kind: command', () => {
    vi.mocked(get_item_batch_size).mockReturnValue(1);
    const task = {target_item: 'crafting_table', qty: 1, action_type: 'craft', parameters: {}};
    expect(mediate_craft(task).kind).toBe('command');
  });
});

// ── resolve_smelt_fuel_name ───────────────────────────────────────────────────

describe('resolve_smelt_fuel_name', () => {
  const SMELT_TASK = {
    target_item: 'cooked_porkchop',
    qty: 1,
    action_type: 'smelt',
    parameters: {
      smelting_inputs: [{item: 'porkchop', qty: 1}],
      fuel_inputs: [{item: 'any_plank', qty: 1}],
      workstation: 'furnace',
    },
  };

  it('resolves any_plank → spruce_planks when spruce_planks is in inventory (rollout stage 9)', () => {
    expect(resolve_smelt_fuel_name(SMELT_TASK, STATE_SMELT)).toBe('spruce_planks');
  });

  it('returns null when inventory has none of the any_plank members', () => {
    const empty_inv = {...STATE_SMELT, inventory: {porkchop: 2}};
    expect(resolve_smelt_fuel_name(SMELT_TASK, empty_inv)).toBeNull();
  });

  it('resolves a concrete fuel item directly from inventory', () => {
    const concrete_task = {
      ...SMELT_TASK,
      parameters: {
        ...SMELT_TASK.parameters,
        fuel_inputs: [{item: 'coal', qty: 1}],
      },
    };
    expect(resolve_smelt_fuel_name(concrete_task, {inventory: {coal: 3}})).toBe('coal');
  });

  it('returns null for concrete fuel when item is not in inventory', () => {
    const concrete_task = {
      ...SMELT_TASK,
      parameters: {
        ...SMELT_TASK.parameters,
        fuel_inputs: [{item: 'coal', qty: 1}],
      },
    };
    expect(resolve_smelt_fuel_name(concrete_task, {inventory: {}})).toBeNull();
  });

  it('returns null when fuel_inputs is missing from parameters', () => {
    const no_fuel = {
      ...SMELT_TASK,
      parameters: {smelting_inputs: [{item: 'porkchop', qty: 1}], workstation: 'furnace'},
    };
    expect(resolve_smelt_fuel_name(no_fuel, STATE_SMELT)).toBeNull();
  });
});

// ── mediate_smelt ─────────────────────────────────────────────────────────────

describe('mediate_smelt', () => {
  const SMELT_TASK = {
    target_item: 'cooked_porkchop',
    qty: 1,
    action_type: 'smelt',
    parameters: {
      smelting_inputs: [{item: 'porkchop', qty: 1}],
      fuel_inputs: [{item: 'any_plank', qty: 1}],
      workstation: 'furnace',
    },
  };

  it('generates !smelt_item("porkchop", 1, "spruce_planks") (rollout stage 9 AM)', () => {
    const action = mediate_smelt(SMELT_TASK, STATE_SMELT);
    expect(action).toEqual({
      kind: 'command',
      command: '!smelt_item("porkchop", 1, "spruce_planks")',
    });
  });

  it('omits fuel argument when no fuel can be resolved', () => {
    const action = mediate_smelt(SMELT_TASK, {inventory: {}});
    expect(action.command).toBe('!smelt_item("porkchop", 1)');
  });

  it('throws when smelting_inputs is empty', () => {
    const bad_task = {...SMELT_TASK, parameters: {...SMELT_TASK.parameters, smelting_inputs: []}};
    expect(() => mediate_smelt(bad_task, STATE_SMELT)).toThrow('Smelt task missing smelting_inputs');
  });
});
