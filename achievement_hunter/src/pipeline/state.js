import convoManager from '../../../src/agent/conversation.js';
import {
  getBiomeName,
  getBlockAtPosition,
  getCraftableItems,
  getFirstBlockAboveHead,
  getInventoryCounts,
  getNearbyEntities,
  getNearbyPlayerNames,
  getNearestBlocks,
} from '../../../src/agent/library/world.js';

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
 * Returns the full bot state as a plain JS object — the data behind !state.
 *
 * Example:
 *   import { get_state } from './state.js';
 *   const state = get_state(agent);
 *   // { position, status, inventory, wearing, craftable_items, nearby_blocks,
 *   //   relative_blocks, nearby_entities }
 */
export function get_state(agent) {
  const bot = agent.bot;

  const pos = bot.entity.position;
  const position = {
    x: Number(pos.x.toFixed(2)),
    y: Number(pos.y.toFixed(2)),
    z: Number(pos.z.toFixed(2)),
  };

  let weather = 'clear';
  if (bot.thunderState > 0) weather = 'thunderstorm';
  else if (bot.rainState > 0) weather = 'rain';

  let time_of_day = 'night';
  if (bot.time.timeOfDay < 6000) time_of_day = 'morning';
  else if (bot.time.timeOfDay < 12000) time_of_day = 'afternoon';

  const status = {
    health: `${Math.round(bot.health)}/20`,
    hunger: `${Math.round(bot.food)}/20`,
    biome: getBiomeName(bot),
    weather,
    time_of_day,
    current_action: agent.isIdle() ? 'idle' : agent.actions.currentActionLabel,
  };

  const inventory = _get_inventory_counts(bot);

  const wearing = _get_armor_slots(bot)
    .filter(Boolean)
    .map(slot => slot.name);

  const craftable_items = getCraftableItems(bot);

  const block_set = new Set();
  for (const block of getNearestBlocks(bot)) {
    block_set.add(block.name);
  }
  const nearby_blocks = Array.from(block_set);

  const above_head_raw = getFirstBlockAboveHead(bot, null, 32);
  const relative_blocks = {
    below: getBlockAtPosition(bot, 0, -1, 0).name,
    legs: getBlockAtPosition(bot, 0, 0, 0).name,
    head: getBlockAtPosition(bot, 0, 1, 0).name,
    above_head_solid: (above_head_raw === null || above_head_raw === 'none')
      ? null
      : above_head_raw,
  };

  let players = getNearbyPlayerNames(bot);
  const bot_players = convoManager.getInGameAgents().filter(b => b !== agent.name);
  players = players.filter(p => !bot_players.includes(p));

  const mobs = {};
  for (const entity of getNearbyEntities(bot)) {
    if (entity.type === 'player' || entity.name === 'item') continue;
    mobs[entity.name] = (mobs[entity.name] || 0) + 1;
  }

  return {
    position,
    status,
    inventory,
    wearing,
    craftable_items,
    nearby_blocks,
    relative_blocks,
    nearby_entities: { human_players: players, mobs, bot_players },
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
export function get_inventory_state(agent) {
  const bot = agent.bot;
  const inventory = _get_inventory_counts(bot);

  for (const slot of _get_armor_slots(bot)) {
    if (slot) inventory[slot.name] = (inventory[slot.name] || 0) + 1;
  }

  return {
    inventory: Object.keys(inventory).length > 0 ? inventory : 'Nothing',
  };
}
