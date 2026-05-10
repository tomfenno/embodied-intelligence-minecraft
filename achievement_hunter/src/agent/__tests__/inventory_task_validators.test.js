import {describe, expect, it} from 'vitest';

import {
  InventoryTaskValidator,
} from '../../../evaluation_harness/task_validators.js';

function makeAgent(items) {
  return {
    bot: {
      inventory: {
        slots: items.map((item) => ({
          name: item.name,
          count: item.count,
        })),
      },
    },
    count_id: 0,
  };
}

describe('InventoryTaskValidator', () => {
  it('returns valid when a single target count is present', () => {
    const validator = new InventoryTaskValidator(
        {target: 'diamond', number_of_target: 2},
        makeAgent([{name: 'diamond', count: 2}]),
    );

    expect(validator.validate()).toEqual({valid: true, score: 1});
  });

  it('returns invalid when a single target count is missing', () => {
    const validator = new InventoryTaskValidator(
        {target: 'diamond', number_of_target: 2},
        makeAgent([{name: 'diamond', count: 1}]),
    );

    expect(validator.validate()).toEqual({valid: false, score: 0});
  });

  it('returns valid when the first OR bundle is satisfied', () => {
    const validator = new InventoryTaskValidator(
        {
          target_any_of: [
            {
              wooden_pickaxe: 1,
              wooden_shovel: 1,
              wooden_axe: 1,
              wooden_hoe: 1,
            },
            {
              stone_pickaxe: 1,
              stone_shovel: 1,
              stone_axe: 1,
              stone_hoe: 1,
            },
          ],
        },
        makeAgent([
          {name: 'wooden_pickaxe', count: 1},
          {name: 'wooden_shovel', count: 1},
          {name: 'wooden_axe', count: 1},
          {name: 'wooden_hoe', count: 1},
        ]),
    );

    expect(validator.validate()).toEqual({valid: true, score: 1});
  });

  it('returns valid when the second OR bundle is satisfied', () => {
    const validator = new InventoryTaskValidator(
        {
          target_any_of: [
            {
              wooden_pickaxe: 1,
              wooden_shovel: 1,
              wooden_axe: 1,
              wooden_hoe: 1,
            },
            {
              stone_pickaxe: 1,
              stone_shovel: 1,
              stone_axe: 1,
              stone_hoe: 1,
            },
          ],
        },
        makeAgent([
          {name: 'stone_pickaxe', count: 1},
          {name: 'stone_shovel', count: 1},
          {name: 'stone_axe', count: 1},
          {name: 'stone_hoe', count: 1},
        ]),
    );

    expect(validator.validate()).toEqual({valid: true, score: 1});
  });

  it('returns invalid when no OR bundle is fully satisfied', () => {
    const validator = new InventoryTaskValidator(
        {
          target_any_of: [
            {
              wooden_pickaxe: 1,
              wooden_shovel: 1,
              wooden_axe: 1,
              wooden_hoe: 1,
            },
            {
              stone_pickaxe: 1,
              stone_shovel: 1,
              stone_axe: 1,
              stone_hoe: 1,
            },
          ],
        },
        makeAgent([
          {name: 'wooden_pickaxe', count: 1},
          {name: 'wooden_shovel', count: 1},
          {name: 'wooden_axe', count: 1},
        ]),
    );

    expect(validator.validate()).toEqual({valid: false, score: 0});
  });
});
