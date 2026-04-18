import * as mc from '../../../src/utils/mcdata.js';
import * as world from '../../../src/agent/library/world.js';
import { log, placeBlock, collectBlock, goToNearestBlock } from '../../../src/agent/library/skills.js';
import { registerCommands } from '../../../src/agent/commands/index.js';

async function smelt_item(bot, item_name, num = 1, fuel_name = null) {
    if (!mc.isSmeltable(item_name)) {
        log(bot, `Cannot smelt ${item_name}. Hint: make sure you are smelting the 'raw' item.`);
        return false;
    }

    let placedFurnace = false;
    const furnaceRange = 16;
    let furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock) {
        const hasFurnace = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            const pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
            await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
            furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
            placedFurnace = true;
        }
    }
    if (!furnaceBlock) {
        log(bot, `There is no furnace nearby and you have no furnace.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, furnaceRange);
    }
    bot.modes.pause('unstuck');
    await bot.lookAt(furnaceBlock.position);

    console.log('smelting...');
    const furnace = await bot.openFurnace(furnaceBlock);

    const input_item = furnace.inputItem();
    if (input_item && input_item.type !== mc.getItemId(item_name) && input_item.count > 0) {
        log(bot, `The furnace is currently smelting ${mc.getItemName(input_item.type)}.`);
        if (placedFurnace) await collectBlock(bot, 'furnace', 1);
        return false;
    }

    const inv_counts = world.getInventoryCounts(bot);
    if (!inv_counts[item_name] || inv_counts[item_name] < num) {
        log(bot, `You do not have enough ${item_name} to smelt.`);
        if (placedFurnace) await collectBlock(bot, 'furnace', 1);
        return false;
    }

    if (!furnace.fuelItem()) {
        let fuel;
        if (fuel_name) {
            fuel = bot.inventory.items().find(i => i.name === fuel_name);
            if (!fuel) {
                log(bot, `You have no ${fuel_name} in your inventory to use as fuel.`);
                if (placedFurnace) await collectBlock(bot, 'furnace', 1);
                return false;
            }
        } else {
            fuel = mc.getSmeltingFuel(bot);
            if (!fuel) {
                log(bot, `You have no fuel to smelt ${item_name}, you need coal, charcoal, or wood.`);
                if (placedFurnace) await collectBlock(bot, 'furnace', 1);
                return false;
            }
        }

        const put_fuel = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));
        if (fuel.count < put_fuel) {
            log(bot, `You don't have enough ${fuel.name} to smelt ${num} ${item_name}; you need ${put_fuel}.`);
            if (placedFurnace) await collectBlock(bot, 'furnace', 1);
            return false;
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
    if (placedFurnace) await collectBlock(bot, 'furnace', 1);

    if (total === 0) {
        log(bot, `Failed to smelt ${item_name}.`);
        return false;
    }
    if (total < num) {
        log(bot, `Only smelted ${total} ${mc.getItemName(smelted_item.type)}.`);
        return false;
    }
    log(bot, `Successfully smelted ${item_name}, got ${total} ${mc.getItemName(smelted_item.type)}.`);
    return true;
}

const ah_commands = [
    {
        name: '!smelt_item',
        description: 'Smelt the given item the given number of times using the specified fuel.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of items to smelt.', domain: [1, Number.MAX_SAFE_INTEGER] },
            'fuel': { type: 'ItemName', description: 'The fuel item to use (e.g. "coal", "oak_log"). If omitted, the best available fuel is chosen automatically.' }
        },
        perform: async function(agent, item_name, num, fuel) {
            const result = await agent.actions.runAction('action:smelt_item', async () => {
                await smelt_item(agent.bot, item_name, num, fuel);
            });
            if (result.interrupted && !result.timedout)
                return { success: false, message: '' };
            return { success: result.success, message: result.message };
        }
    }
];

registerCommands(ah_commands);
