import {describe, expect, it} from 'vitest';

import {
  BLOCK_DROPS,
  compute_collect_delta,
  expand_to_concretes,
  inventory_delta_positive,
  sum_inventory,
  VERIFIER_SETTLE_TICKS,
} from '../inventory_drops.js';

describe('inventory_delta_positive', () => {
  it('returns only positive deltas', () => {
    const pre = {oak_log: 3, dirt: 2};
    const post = {oak_log: 5, dirt: 1, cobblestone: 4};
    expect(inventory_delta_positive(post, pre))
        .toEqual({oak_log: 2, cobblestone: 4});
  });

  it('handles null/undefined inputs without throwing', () => {
    expect(inventory_delta_positive(null, null)).toEqual({});
    expect(inventory_delta_positive(undefined, undefined)).toEqual({});
    expect(inventory_delta_positive({a: 1}, null)).toEqual({a: 1});
    expect(inventory_delta_positive(null, {a: 1})).toEqual({});
  });

  it('treats missing pre as zero', () => {
    expect(inventory_delta_positive({iron_ore: 2}, {})).toEqual({iron_ore: 2});
  });
});

describe('sum_inventory', () => {
  it('sums counts across the listed items', () => {
    expect(sum_inventory({a: 1, b: 2, c: 3}, ['a', 'c'])).toBe(4);
  });

  it('treats missing items as zero', () => {
    expect(sum_inventory({a: 1}, ['a', 'b'])).toBe(1);
  });

  it('returns 0 for null/undefined inventory', () => {
    expect(sum_inventory(null, ['a'])).toBe(0);
    expect(sum_inventory(undefined, ['a'])).toBe(0);
  });
});

describe('expand_to_concretes', () => {
  it('passes through non-abstract names', () => {
    expect(expand_to_concretes('oak_log')).toEqual(['oak_log']);
    expect(expand_to_concretes('stone')).toEqual(['stone']);
  });

  it('returns [item] for unknown abstracts (defensive)', () => {
    expect(expand_to_concretes('any_unobtanium')).toEqual(['any_unobtanium']);
  });

  it('returns [] for non-string input', () => {
    expect(expand_to_concretes(null)).toEqual([]);
    expect(expand_to_concretes(42)).toEqual([]);
  });
});

describe('BLOCK_DROPS table', () => {
  it('maps the audit-example ores to their drops', () => {
    expect(BLOCK_DROPS.stone).toBe('cobblestone');
    expect(BLOCK_DROPS.iron_ore).toBe('raw_iron');
    expect(BLOCK_DROPS.diamond_ore).toBe('diamond');
  });

  it('maps liquids to filled buckets', () => {
    expect(BLOCK_DROPS.lava).toBe('lava_bucket');
    expect(BLOCK_DROPS.water).toBe('water_bucket');
  });

  it('omits blocks that drop themselves (defaults handled at call site)', () => {
    expect(BLOCK_DROPS.oak_log).toBeUndefined();
    expect(BLOCK_DROPS.spruce_log).toBeUndefined();
    expect(BLOCK_DROPS.cobblestone).toBeUndefined();
  });
});

describe('compute_collect_delta — audit examples', () => {
  // From diamonds/runner_stdout.log:245-248 — Example 1.
  // Bot mines diamond_ore with iron_pickaxe, gets a diamond.
  it('diamond_ore → diamond (Example 1)', () => {
    const pre = {iron_pickaxe: 1};
    const post = {iron_pickaxe: 1, diamond: 1};
    const result = compute_collect_delta('diamond_ore', pre, post);
    expect(result).toEqual({
      primary_item: 'diamond',
      primary_count: 1,
      extras: {},
    });
  });

  // From acquire_hardware/runner_stdout.log:161 — Example 2.
  // Bot mines iron_ore with stone_pickaxe, gets raw_iron.
  it('iron_ore → raw_iron (Example 2)', () => {
    const pre = {stone_pickaxe: 1};
    const post = {stone_pickaxe: 1, raw_iron: 1};
    const result = compute_collect_delta('iron_ore', pre, post);
    expect(result).toEqual({
      primary_item: 'raw_iron',
      primary_count: 1,
      extras: {},
    });
  });

  // From acquire_hardware/runner_stdout.log:112 — Example 3.
  // Bot mines stone with wooden_pickaxe, gets cobblestone + incidental dirt.
  it('stone → cobblestone with incidental dirt (Example 3)', () => {
    const pre = {wooden_pickaxe: 1};
    const post = {wooden_pickaxe: 1, cobblestone: 13, dirt: 9};
    const result = compute_collect_delta('stone', pre, post);
    expect(result).toEqual({
      primary_item: 'cobblestone',
      primary_count: 13,
      extras: {dirt: 9},
    });
  });

  // From acquire_hardware/runner_stdout.log:52-57 — Example 4.
  // Bot collects spruce_log; legacy headline was off by one (4 vs +5).
  // After the fix, the delta-based headline reports the true 5.
  it('spruce_log exact match (Example 4 — verifies last-packet-race fix)', () => {
    const pre = {};
    const post = {spruce_log: 5};
    const result = compute_collect_delta('spruce_log', pre, post);
    expect(result).toEqual({
      primary_item: 'spruce_log',
      primary_count: 5,
      extras: {},
    });
  });
});

describe('compute_collect_delta — edge cases', () => {
  it('silk-touch: stone block in inventory wins over (zero) cobblestone', () => {
    // Hypothetical silk-touch pickaxe yields the block itself.
    const pre = {};
    const post = {stone: 13};
    const result = compute_collect_delta('stone', pre, post);
    expect(result).toEqual({
      primary_item: 'stone',
      primary_count: 13,
      extras: {},
    });
  });

  it('empty delta → blockType with count 0', () => {
    const pre = {wooden_pickaxe: 1};
    const post = {wooden_pickaxe: 1};
    const result = compute_collect_delta('stone', pre, post);
    expect(result).toEqual({
      primary_item: 'stone',
      primary_count: 0,
      extras: {},
    });
  });

  it('only incidentals in delta → largest entry wins', () => {
    const pre = {};
    const post = {dirt: 5, gravel: 2};
    const result = compute_collect_delta('stone', pre, post);
    expect(result).toEqual({
      primary_item: 'dirt',
      primary_count: 5,
      extras: {gravel: 2},
    });
  });

  it('expected drop AND incidentals: drop is primary, others are extras', () => {
    const pre = {};
    const post = {cobblestone: 5, dirt: 3, gravel: 1};
    const result = compute_collect_delta('stone', pre, post);
    expect(result.primary_item).toBe('cobblestone');
    expect(result.primary_count).toBe(5);
    expect(result.extras).toEqual({dirt: 3, gravel: 1});
  });

  it('liquid: lava → lava_bucket', () => {
    const pre = {bucket: 1};
    const post = {lava_bucket: 1};
    const result = compute_collect_delta('lava', pre, post);
    expect(result.primary_item).toBe('lava_bucket');
    expect(result.primary_count).toBe(1);
  });

  it('block that drops itself with no remapping: spruce_log delta', () => {
    const pre = {};
    const post = {spruce_log: 7};
    const result = compute_collect_delta('spruce_log', pre, post);
    expect(result.primary_item).toBe('spruce_log');
    expect(result.primary_count).toBe(7);
  });
});

describe('shared constants', () => {
  it('VERIFIER_SETTLE_TICKS matches the legacy value', () => {
    // The constant moved from command_utils.js where it was 4. The
    // value is load-bearing for the inventory-update race-window
    // mitigation; pin it so an accidental change is visible.
    expect(VERIFIER_SETTLE_TICKS).toBe(4);
  });
});
