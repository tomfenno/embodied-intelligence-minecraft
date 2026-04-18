import * as mc from '../../../src/utils/mcdata.js';

export function get_item_batch_size(itemName) {
    const recipes = mc.getItemCraftingRecipes(itemName);
    if (!recipes || recipes.length === 0) return null;
    return recipes[0][1].craftedCount;
}
