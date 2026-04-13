import {getCraftableItems, getInventoryCounts, getNearbyEntities, getNearestBlocks,} from '../../../src/agent/library/world.js';

/**
 * Returns a plain {item: count} object for all items with count > 0.
 */
function _get_inventory_counts(bot) {
  const raw = getInventoryCounts(bot);
  const result = {};
  for (const [item, count] of Object.entries(raw)) {
    if (count > 0) result[item] = count;
  }
  return result;
}

/**
 * Returns the four armor slot objects [helmet, chestplate, leggings, boots].
 * Slots are null when empty.
 */
function _get_armor_slots(bot) {
  return [
    bot.inventory.slots[5],
    bot.inventory.slots[6],
    bot.inventory.slots[7],
    bot.inventory.slots[8],
  ];
}

/**
 * Returns the state object for the Action Mediator (AM) prompt.
 *
 * Example:
 *   import { get_am_state } from './state.js';
 *   const state = get_am_state(agent);
 *   // { inventory, craftable_items, nearby_blocks, nearby_entities: { mobs } }
 */
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

/**
 * Returns a minimal state object for the Next Task Selector (NTS) prompt.
 *
 * Example:
 *   import { nts_state } from './state.js';
 *   const state = nts_state(agent);
 *   // {
 *   //   craftable_items: ["acacia_slab", "stick"],
 *   //   nearby_blocks: ["water", "oak_log"],
 *   //   nearby_entities: { mobs: ["skeleton"] }
 *   // }
 */
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

/**
 * Returns the bot's inventory and worn equipment as a plain JS object —
 * the data behind !inventoryState.
 *
 * Example:
 *   import { get_inventory_state } from './state.js';
 *   const inv = get_inventory_state(agent);
 *   // { inventory: { oak_log: 3, ... } } or { inventory: 'Nothing' }
 */
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