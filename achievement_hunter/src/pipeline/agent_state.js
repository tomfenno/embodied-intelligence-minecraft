import {getCraftableItems, getInventoryCounts, getNearbyEntities, getNearestBlocks,} from '../../../src/agent/library/world.js';

function _get_inventory_counts(bot) {
  const raw = getInventoryCounts(bot);
  const result = {};
  for (const [item, count] of Object.entries(raw)) {
    if (count > 0) result[item] = count;
  }
  return result;
}

function _get_armor_slots(bot) {
  return [
    bot.inventory.slots[5],
    bot.inventory.slots[6],
    bot.inventory.slots[7],
    bot.inventory.slots[8],
  ];
}

export function get_am_state(agent) {
  const bot = agent.bot;

  const inventory = _get_inventory_counts(bot);

  const craftable_items = getCraftableItems(bot);

  const block_set = new Set();
  for (const block of getNearestBlocks(bot)) {
    block_set.add(block.name);
  }
  const nearby_blocks = Array.from(block_set);

  const mobs = [];
  for (const entity of getNearbyEntities(bot)) {
    if (entity.type === 'player' || entity.name === 'item') continue;
    if (!mobs.includes(entity.name)) mobs.push(entity.name);
  }

  return {
    inventory,
    craftable_items,
    nearby_blocks,
    nearby_entities: {mobs},
  };
}

export function get_nts_state(agent) {
  const bot = agent.bot;

  const craftable_items = getCraftableItems(bot);

  const block_set = new Set();
  for (const block of getNearestBlocks(bot)) {
    block_set.add(block.name);
  }
  const nearby_blocks = Array.from(block_set);

  const mobs = [];
  for (const entity of getNearbyEntities(bot)) {
    if (entity.type === 'player' || entity.name === 'item') continue;
    if (!mobs.includes(entity.name)) mobs.push(entity.name);
  }

  return {
    craftable_items,
    nearby_blocks,
    nearby_entities: {mobs},
  };
}

export function get_sgsg_state(agent) {
  const bot = agent.bot;
  const inventory = _get_inventory_counts(bot);

  for (const slot of _get_armor_slots(bot)) {
    if (slot) inventory[slot.name] = (inventory[slot.name] || 0) + 1;
  }

  return {
    inventory: Object.keys(inventory).length > 0 ? inventory : 'Nothing',
  };
}
