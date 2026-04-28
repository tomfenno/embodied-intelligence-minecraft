import {getBiomeName, getBlockAtPosition, getCraftableItems, getFirstBlockAboveHead, getInventoryCounts, getNearbyEntities, getNearestBlocks, getPosition,} from '../../../src/agent/library/world.js';

// Water and lava source blocks (metadata 0) are collectable with a bucket.
// Flowing blocks (metadata 1-7) share the same name but cannot be collected.
const COLLECTIBLE_LIQUIDS = new Set(['water', 'lava']);

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
    if (COLLECTIBLE_LIQUIDS.has(block.name) && block.metadata !== 0) continue;
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
    if (COLLECTIBLE_LIQUIDS.has(block.name) && block.metadata !== 0) continue;
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

export function get_recovery_trace_state(agent) {
  const raw_state = get_am_state(agent);
  const bot = agent?.bot;
  const state = {};

  const world = {};
  try {
    const pos = getPosition(bot);
    if (pos != null) {
      world.position = {
        x: Number(pos.x.toFixed(2)),
        y: Number(pos.y.toFixed(2)),
        z: Number(pos.z.toFixed(2)),
      };
    }
  } catch {
  }
  if (bot?.game?.dimension != null) world.dimension = bot.game.dimension;
  try {
    const biome = getBiomeName(bot);
    if (biome != null) world.biome = biome;
  } catch {
  }
  if (bot?.time?.timeOfDay != null) {
    const t = bot.time.timeOfDay;
    world.timeLabel = t < 6000 ? 'Morning' : t < 12000 ? 'Afternoon' : 'Night';
  }
  if (Object.keys(world).length > 0) state.world = world;

  const self = {};
  if (bot?.health != null) self.health = Math.round(bot.health);
  if (bot?.food != null) self.hunger = Math.round(bot.food);
  if (Object.keys(self).length > 0) state.self = self;

  try {
    const action = {};
    const is_idle =
        typeof agent?.isIdle === 'function' ? agent.isIdle() : undefined;

    if (typeof is_idle === 'boolean') {
      action.isIdle = is_idle;
      if (is_idle) {
        action.current = 'Idle';
      } else if (agent?.actions?.currentActionLabel != null) {
        action.current = agent.actions.currentActionLabel;
      }
    } else if (agent?.actions?.currentActionLabel != null) {
      action.current = agent.actions.currentActionLabel;
    }

    if (Object.keys(action).length > 0) state.action = action;
  } catch {
  }

  try {
    const surroundings = {};
    const b_below = getBlockAtPosition(bot, 0, -1, 0);
    if (b_below?.name) surroundings.below = b_below.name;
    const b_legs = getBlockAtPosition(bot, 0, 0, 0);
    if (b_legs?.name) surroundings.legs = b_legs.name;
    const b_head = getBlockAtPosition(bot, 0, 1, 0);
    if (b_head?.name) surroundings.head = b_head.name;
    const first_above = getFirstBlockAboveHead(bot, null, 32);
    if (first_above != null) surroundings.firstBlockAboveHead = first_above;
    if (Object.keys(surroundings).length > 0) state.surroundings = surroundings;
  } catch {
  }

  const inv = {};
  if (raw_state?.inventory != null) inv.counts = raw_state.inventory;

  const main_hand = bot?.heldItem?.name ?? null;
  inv.equipment = {mainHand: main_hand};

  if (Object.keys(inv).length > 0) state.inventory = inv;

  const nearby = {};
  if (raw_state?.nearby_blocks != null) nearby.blocks = raw_state.nearby_blocks;
  if (raw_state?.nearby_entities?.mobs != null) {
    nearby.entityTypes = raw_state.nearby_entities.mobs;
  }
  if (Object.keys(nearby).length > 0) state.nearby = nearby;

  if (raw_state?.craftable_items != null) {
    state.craftable_items = raw_state.craftable_items;
  }

  return state;
}