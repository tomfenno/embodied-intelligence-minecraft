import * as mc from '../../../src/utils/mcdata.js';

/**
 * Returns the number of items produced by a single craft operation for the
 * given item (i.e. the batch size). Mirrors the recipe selection order used
 * by skills.craftRecipe — first entry returned by getItemCraftingRecipes.
 *
 * @param {string} itemName - The Minecraft item name (e.g. 'stick').
 * @returns {number|null} Batch size, or null if the item has no crafting recipe.
 *
 * @example
 * get_item_batch_size('stick'); // 4
 * get_item_batch_size('crafting_table'); // 1
 */
export function get_item_batch_size(itemName) {
    const recipes = mc.getItemCraftingRecipes(itemName);
    if (!recipes || recipes.length === 0) return null;
    return recipes[0][1].craftedCount;
}
