/**
 * Achievement Hunter custom bot commands.
 * Registers additional commands into the base Mindcraft command map via
 * registerCommands().
 */

import {registerCommands} from '../../../src/agent/commands/index.js';
import {collectBlock, goToNearestBlock, log, moveAway, placeBlock} from '../../../src/agent/library/skills.js';
import * as world from '../../../src/agent/library/world.js';
import * as mc from '../../../src/utils/mcdata.js';

/**
 * Smelts num units of item_name, using fuel_name or the best available fuel.
 * Places a furnace from inventory if none is within range, and collects it on
 * exit. Returns true on full success, false on any failure.
 */
async function smelt_item(bot, item_name, num = 1, fuel_name = null) {
  if (!mc.isSmeltable(item_name)) {
    log(bot,
        `Cannot smelt ${
            item_name}. Hint: make sure you are smelting the 'raw' item.`);
    return false;
  }

  let placed_furnace = false;
  const furnace_range = 16;
  let furnace_block = world.getNearestBlock(bot, 'furnace', furnace_range);
  if (!furnace_block) {
    const has_furnace = world.getInventoryCounts(bot)['furnace'] > 0;
    if (has_furnace) {
      let pos = world.getNearestFreeSpace(bot, 1, furnace_range);
      // Mirrors the smeltItem AH fix in upstream src/agent/library/skills.js:
      // getNearestFreeSpace returns undefined when no 1x1 free space
      // exists within range (cramped caves, surrounded by non-air on all
      // sides). Without this guard the next line throws
      // "Cannot read properties of undefined (reading 'x')" — a
      // runner_exception the replanner can't act on. Try a small
      // moveAway-and-retry to escape wedge cases automatically; bail
      // with a clear message if there's still no space afterward so
      // the replanner can plan a larger relocation.
      if (!pos) {
        log(bot, `No free space within ${
            furnace_range} blocks to place furnace; moving away to retry.`);
        try {
          await moveAway(bot, 5);
        } catch (err) {
          log(bot, `moveAway during smelt recovery failed: ${
              err.message}. Retrying space search anyway.`);
        }
        pos = world.getNearestFreeSpace(bot, 1, furnace_range);
        if (!pos) {
          log(bot, `Smelting ${item_name} requires placing a furnace, but ` +
              `no free space was found within ${furnace_range} blocks ` +
              `even after moving. Move to a more open area first.`);
          return false;
        }
      }
      await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
      furnace_block = world.getNearestBlock(bot, 'furnace', furnace_range);
      // placeBlock can silently fail (returns false, logs the cause to
      // bot.output, but doesn't throw). Without this guard the
      // fall-through below emits "There is no furnace nearby and you
      // have no furnace." — misleading because the agent DOES have a
      // furnace in inventory; placement is what failed. placeBlock has
      // already logged the actual cause (e.g. "Failed to place furnace
      // at (x, y, z).") to bot.output, so returning false here surfaces
      // the real message to the replanner rather than the stale
      // post-placement-check artifact. Also avoids setting
      // placed_furnace=true when nothing was actually placed (which
      // would otherwise trigger a stray collectBlock('furnace', 1)
      // attempt on the failure cleanup path below).
      if (!furnace_block) {
        return false;
      }
      placed_furnace = true;
    }
  }
  if (!furnace_block) {
    log(bot, `There is no furnace nearby and you have no furnace.`);
    return false;
  }
  if (bot.entity.position.distanceTo(furnace_block.position) > 4) {
    await goToNearestBlock(bot, 'furnace', 4, furnace_range);
  }
  bot.modes.pause('unstuck');
  await bot.lookAt(furnace_block.position);

  console.log('smelting...');
  const furnace = await bot.openFurnace(furnace_block);

  const fail = async (msg) => {
    log(bot, msg);
    if (placed_furnace) await collectBlock(bot, 'furnace', 1);
    return false;
  };

  const input_item = furnace.inputItem();
  if (input_item && input_item.type !== mc.getItemId(item_name) &&
      input_item.count > 0) {
    return fail(`The furnace is currently smelting ${
        mc.getItemName(input_item.type)}.`);
  }

  const inv_counts = world.getInventoryCounts(bot);
  if (!inv_counts[item_name] || inv_counts[item_name] < num) {
    return fail(`You do not have enough ${item_name} to smelt.`);
  }

  if (!furnace.fuelItem()) {
    let fuel;
    if (fuel_name) {
      fuel = bot.inventory.items().find(i => i.name === fuel_name);
      if (!fuel) {
        return fail(
            `You have no ${fuel_name} in your inventory to use as fuel.`);
      }
    } else {
      fuel = mc.getSmeltingFuel(bot);
      if (!fuel) {
        return fail(`You have no fuel to smelt ${
            item_name}, you need coal, charcoal, or wood.`);
      }
    }

    const put_fuel = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));
    if (fuel.count < put_fuel) {
      return fail(`You don't have enough ${fuel.name} to smelt ${num} ${
          item_name}; you need ${put_fuel}.`);
    }
    await furnace.putFuel(fuel.type, null, put_fuel);
    log(bot, `Added ${put_fuel} ${fuel.name} to furnace fuel.`);
  }

  await furnace.putInput(mc.getItemId(item_name), null, num);

  let total = 0;
  let smelted_item = null;
  await new Promise(resolve => setTimeout(resolve, 200));
  let last_collected = Date.now();
  while (total < num) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (furnace.outputItem()) {
      smelted_item = await furnace.takeOutput();
      if (smelted_item) {
        total += smelted_item.count;
        last_collected = Date.now();
      }
    }
    if (Date.now() - last_collected > 11000) break;
    if (bot.interrupt_code) break;
  }

  if (furnace.inputItem()) await furnace.takeInput();
  if (furnace.fuelItem()) await furnace.takeFuel();
  await bot.closeWindow(furnace);
  if (placed_furnace) await collectBlock(bot, 'furnace', 1);

  if (total === 0) {
    log(bot, `Failed to smelt ${item_name}.`);
    return false;
  }
  if (total < num) {
    log(bot, `Only smelted ${total} ${mc.getItemName(smelted_item.type)}.`);
    return false;
  }
  log(bot,
      `Successfully smelted ${item_name}, got ${total} ${
          mc.getItemName(smelted_item.type)}.`);
  return true;
}

const ah_commands = [{
  name: '!smelt_item',
  description:
      'Smelt the given item the given number of times using the specified fuel.',
  params: {
    'item_name':
        {type: 'ItemName', description: 'The name of the input item to smelt.'},
    'num': {
      type: 'int',
      description: 'The number of items to smelt.',
      domain: [1, Number.MAX_SAFE_INTEGER]
    },
    'fuel': {
      type: 'ItemName',
      description:
          'The fuel item to use (e.g. "coal", "oak_log"). If omitted, the best available fuel is chosen automatically.'
    }
  },
  perform: async function(agent, item_name, num, fuel) {
    const result =
        await agent.actions.runAction('action:smelt_item', async () => {
          await smelt_item(agent.bot, item_name, num, fuel);
        });
    if (result.interrupted && !result.timedout)
      return {success: false, message: ''};
    return {success: result.success, message: result.message};
  }
}];

registerCommands(ah_commands);
