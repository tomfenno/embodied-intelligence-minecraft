// dependency_error_classifier.js
//
// Single-file dependency-error classifier for rollout experiments.
//
// Purpose:
//   After each executeCommand result, classify whether the command failed
//   because a required dependency was missing or unsatisfied.
//
// Primary experiment metric:
//   dependency_error_rate = dependencyFailures / totalCommands
//
// Conservative dependency policy:
//   A command is a dependency failure iff:
//     1. success !== true
//     2. at least one matched template has kind starting with "dependency_"
//
// Broad policy:
//   Optional sensitivity mode that also counts selected partial successes
//   and dependency-like generic failures.
//
// --------------------------------------------------------------------------
// Taxonomy
// --------------------------------------------------------------------------

export const KIND = Object.freeze({
  PARSE_ERROR: 'parse_error',

  DEPENDENCY_INVENTORY: 'dependency_inventory',
  DEPENDENCY_RESOURCE: 'dependency_resource',
  DEPENDENCY_TOOL: 'dependency_tool',
  DEPENDENCY_BLOCK_NOT_FOUND: 'dependency_block_not_found',
  DEPENDENCY_ENTITY_NOT_FOUND: 'dependency_entity_not_found',
  DEPENDENCY_TARGET_UNREACHABLE: 'dependency_target_unreachable',
  DEPENDENCY_ENVIRONMENT: 'dependency_environment',
  DEPENDENCY_RECIPE: 'dependency_recipe',
  DEPENDENCY_VILLAGER_TRADE: 'dependency_villager_trade',

  AGENT_STATE: 'agent_state',
  AGENT_INTERRUPTED: 'agent_interrupted',
  AGENT_EXCEPTION: 'agent_exception',
  AGENT_LOOP: 'agent_loop',
  AGENT_CONFIG: 'agent_config',

  INFO: 'info',
  PARTIAL_SUCCESS: 'partial_success',
  SUCCESS: 'success',
  META: 'meta',
  QUERY_RESULT: 'query_result',
});

export const DEPENDENCY_POLICY = Object.freeze({
  CONSERVATIVE: 'conservative',
  BROAD: 'broad',
});

export const CLASSIFIER_VERSION = 'dependency-classifier-single-file-v1';
export const POLICY_VERSION = 'dependency-policy-v1';

export function isDependencyKind(kind) {
  return typeof kind === 'string' && kind.startsWith('dependency_');
}

function t(id, pattern, kind, source, actions, example = null, notes = null) {
  return {
    id,
    pattern,
    kind,
    isDependencyFailure: isDependencyKind(kind),
    source,
    actions,
    example,
    notes,
  };
}

// --------------------------------------------------------------------------
// Parse / validation templates
// --------------------------------------------------------------------------

const PARSE_TEMPLATES = [
  t('parse.bad_format', /^Command is incorrectly formatted$/, KIND.PARSE_ERROR,
    'index.js', ['*'], 'Command is incorrectly formatted'),
  t('parse.unknown_command', /^!\w+ is not a command\.$/, KIND.PARSE_ERROR,
    'index.js', ['*'], '!foo is not a command.'),
  t('parse.arg_count',
    /^Command !\w+ was given \d+ args, but requires \d+ args\.$/,
    KIND.PARSE_ERROR, 'index.js', ['*'],
    'Command !goToCoordinates was given 2 args, but requires 4 args.'),
  t('parse.bad_type', /^Error: Param '[^']+' must be of type \w+\.$/,
    KIND.PARSE_ERROR, 'index.js', ['*'],
    'Error: Param \'num\' must be of type int.'),
  t('parse.out_of_domain',
    /^Error: Param '[^']+' must be an element of [\[(].+, .+[\])]\.$/,
    KIND.PARSE_ERROR, 'index.js', ['*'],
    'Error: Param \'y\' must be an element of [-64, 320).'),
  t('parse.invalid_block', /^Invalid block type: .+\.$/, KIND.PARSE_ERROR,
    'index.js', ['BlockName params'], 'Invalid block type: foo.'),
  t('parse.invalid_item', /^Invalid item type: .+\.$/, KIND.PARSE_ERROR,
    'index.js', ['ItemName params'], 'Invalid item type: foo.'),
  t('parse.invalid_block_or_item', /^Invalid block or item type: .+\.$/,
    KIND.PARSE_ERROR, 'index.js', ['BlockOrItemName params'],
    'Invalid block or item type: foo.'),
];

// --------------------------------------------------------------------------
// Wrapper templates
// --------------------------------------------------------------------------

const WRAPPER_TEMPLATES = [
  t('wrap.action_output_prefix', /^Action output:\n/, KIND.META,
    'action_manager.js', ['runAsAction wrapper'], 'Action output:\n...'),
  t('wrap.action_output_truncated',
    /^Action output is very long \(\d+ chars\) and has been shortened\.\n[\s\S]*First outputs:\n[\s\S]*\.\.\.skipping many lines\.\nFinal outputs:\n[\s\S]*$/,
    KIND.META, 'action_manager.js', ['runAsAction wrapper'],
    'Action output is very long (1234 chars) and has been shortened. ...'),
  t('wrap.interrupted_empty', /^$/, KIND.AGENT_INTERRUPTED,
    'actions.js / action_manager.js', ['runAsAction wrapper'], ''),
  t('wrap.exception_block',
    /!!Code threw exception!!\nError: [\s\S]*\nStack trace:\n[\s\S]*/,
    KIND.AGENT_EXCEPTION, 'action_manager.js', ['runAsAction wrapper'],
    'Action output:\n!!Code threw exception!!\nError: TypeError: ...\nStack trace:\n...'),
  t('wrap.infinite_loop', /^Infinite action loop detected, shutting down\.$/,
    KIND.AGENT_LOOP, 'action_manager.js', ['runAsAction wrapper'],
    'Infinite action loop detected, shutting down.'),
];

// --------------------------------------------------------------------------
// Direct action-return templates
// --------------------------------------------------------------------------

const ACTION_DIRECT_TEMPLATES = [
  t('newAction.disabled',
    /^newAction not allowed! Code writing is disabled in settings\. Notify the user\.$/,
    KIND.AGENT_CONFIG, 'actions.js', ['!newAction'],
    'newAction not allowed! Code writing is disabled in settings. Notify the user.'),

  t('stop.ok', /^Agent stopped\.( Self-prompting still active\.)?$/,
    KIND.SUCCESS, 'actions.js', ['!stop'], 'Agent stopped.'),

  t('clearChat.ok',
    /^.+'s chat history was cleared, starting new conversation from scratch\.$/,
    KIND.SUCCESS, 'actions.js', ['!clearChat'],
    'Bot\'s chat history was cleared, starting new conversation from scratch.'),

  t('rememberHere.ok', /^Location saved as ".+"\.$/, KIND.SUCCESS, 'actions.js',
    ['!rememberHere'], 'Location saved as "home".'),

  t('setMode.unknown', /^Mode .+ does not exist\./, KIND.PARSE_ERROR,
    'actions.js', ['!setMode'], 'Mode foo does not exist.'),
  t('setMode.already', /^Mode .+ is already (on|off)\.$/, KIND.AGENT_STATE,
    'actions.js', ['!setMode'], 'Mode self_defense is already on.'),
  t('setMode.ok', /^Mode .+ is now (on|off)\.$/, KIND.SUCCESS, 'actions.js',
    ['!setMode'], 'Mode self_defense is now off.'),

  t('endGoal.ok', /^Self-prompting stopped\.$/, KIND.SUCCESS, 'actions.js',
    ['!endGoal'], 'Self-prompting stopped.'),

  t('startConversation.not_a_bot',
    /^.+ is not a bot, cannot start conversation\.$/, KIND.PARSE_ERROR,
    'actions.js', ['!startConversation'],
    'Steve is not a bot, cannot start conversation.'),

  t('endConversation.not_in_convo', /^Not in conversation with .+\.$/,
    KIND.AGENT_STATE, 'actions.js', ['!endConversation'],
    'Not in conversation with Steve.'),
  t('endConversation.ok', /^Converstaion with .+ ended\.$/, KIND.SUCCESS,
    'actions.js', ['!endConversation'], 'Converstaion with Steve ended.'),

  t('lookAtPlayer.bad_dir', /^Invalid direction\. Use 'at' or 'with'\.$/,
    KIND.PARSE_ERROR, 'actions.js', ['!lookAtPlayer'],
    'Invalid direction. Use \'at\' or \'with\'.'),
];

// --------------------------------------------------------------------------
// Skill templates
// --------------------------------------------------------------------------

const SKILL_TEMPLATES = [
  // Crafting
  t('craft.no_recipe',
    /^.+ is either not an item, or it does not have a crafting recipe!$/m,
    KIND.DEPENDENCY_RECIPE, 'skills.js', ['!craftRecipe']),
  t('craft.needs_table', /^Crafting .+ requires a crafting table\.$/m,
    KIND.DEPENDENCY_ENVIRONMENT, 'skills.js', ['!craftRecipe']),
  t('craft.no_resources',
    /^You do not have the resources to craft a .+\. It requires: .+\.$/m,
    KIND.DEPENDENCY_RESOURCE, 'skills.js', ['!craftRecipe']),
  t('craft.partial',
    /^Not enough .+ to craft \d+, crafted \d+\. You now have \d+ .+\.$/m,
    KIND.PARTIAL_SUCCESS, 'skills.js', ['!craftRecipe']),
  t('craft.ok', /^Successfully crafted .+, you now have \d+ .+\.$/m,
    KIND.SUCCESS, 'skills.js', ['!craftRecipe']),

  // Smelting
  t('smelt.bad_input',
    /^Cannot smelt .+\. Hint: make sure you are smelting the 'raw' item\.$/m,
    KIND.DEPENDENCY_RECIPE, 'skills.js', ['!smeltItem']),
  t('smelt.no_furnace',
    /^There is no furnace nearby and you have no furnace\.$/m,
    KIND.DEPENDENCY_ENVIRONMENT, 'skills.js', ['!smeltItem']),
  t('smelt.busy', /^The furnace is currently smelting .+\.$/m, KIND.AGENT_STATE,
    'skills.js', ['!smeltItem']),
  t('smelt.not_enough_input', /^You do not have enough .+ to smelt\.$/m,
    KIND.DEPENDENCY_RESOURCE, 'skills.js', ['!smeltItem']),
  t('smelt.no_fuel',
    /^You have no fuel to smelt .+, you need coal, charcoal, or wood\.$/m,
    KIND.DEPENDENCY_RESOURCE, 'skills.js', ['!smeltItem']),
  t('smelt.using_fuel', /^Using .+ as fuel\.$/m, KIND.INFO, 'skills.js',
    ['!smeltItem']),
  t('smelt.not_enough_fuel',
    /^You don't have enough .+ to smelt \d+ .+; you need \d+\.$/m,
    KIND.DEPENDENCY_RESOURCE, 'skills.js', ['!smeltItem']),
  t('smelt.added_fuel', /^Added \d+ .+ to furnace fuel\.$/m, KIND.INFO,
    'skills.js', ['!smeltItem']),
  t('smelt.failed', /^Failed to smelt .+\.$/m, KIND.AGENT_EXCEPTION,
    'skills.js', ['!smeltItem']),
  t('smelt.partial', /^Only smelted \d+ .+\.$/m, KIND.PARTIAL_SUCCESS,
    'skills.js', ['!smeltItem']),
  t('smelt.ok', /^Successfully smelted .+, got \d+ .+\.$/m, KIND.SUCCESS,
    'skills.js', ['!smeltItem']),

  // Furnace
  t('clearFurnace.no_furnace', /^No furnace nearby to clear\.$/m,
    KIND.DEPENDENCY_ENTITY_NOT_FOUND, 'skills.js', ['!clearFurnace']),
  t('clearFurnace.ok', /^Cleared furnace, received .+, .+, and .+\.$/m,
    KIND.SUCCESS, 'skills.js', ['!clearFurnace']),

  // Combat
  t('attack.no_target', /^Could not find any .+ to attack\.$/m,
    KIND.DEPENDENCY_ENTITY_NOT_FOUND, 'skills.js', ['!attack']),
  t('attack.killed', /^Successfully killed .+\.$/m, KIND.SUCCESS, 'skills.js',
    ['!attack', '!attackPlayer']),
  t('defend.ok', /^Successfully defended self\.$/m, KIND.SUCCESS, 'skills.js',
    ['(self_defense mode)']),
  t('defend.none', /^No enemies nearby to defend self from\.$/m, KIND.INFO,
    'skills.js', ['(self_defense mode)']),

  // Collect / pickup
  t('collect.bad_num', /^Invalid number of blocks to collect: \d+\.$/m,
    KIND.PARSE_ERROR, 'skills.js', ['!collectBlocks']),
  t('collect.none_nearby', /^No .+ nearby to collect\.$/m,
    KIND.DEPENDENCY_BLOCK_NOT_FOUND, 'skills.js', ['!collectBlocks']),
  t('collect.no_more', /^No more .+ nearby to collect\.$/m,
    KIND.DEPENDENCY_BLOCK_NOT_FOUND, 'skills.js', ['!collectBlocks']),
  t('collect.no_bucket', /^Don't have bucket to harvest .+\.$/m,
    KIND.DEPENDENCY_TOOL, 'skills.js', ['!collectBlocks']),
  t('collect.no_tool', /^Don't have right tools to harvest .+\.$/m,
    KIND.DEPENDENCY_TOOL, 'skills.js', ['!collectBlocks']),
  t('collect.inv_full',
    /^Failed to collect .+: Inventory full, no place to deposit\.$/m,
    KIND.DEPENDENCY_ENVIRONMENT, 'skills.js', ['!collectBlocks']),
  t('collect.failed_err', /^Failed to collect .+: .+\.$/m, KIND.AGENT_EXCEPTION,
    'skills.js', ['!collectBlocks']),
  t('collect.ok', /^Collected \d+ .+\.$/m, KIND.SUCCESS, 'skills.js',
    ['!collectBlocks']),
  t('pickup.ok', /^Picked up \d+ items\.$/m, KIND.INFO, 'skills.js',
    ['(pickup loop)']),

  // Break / place
  t('break.setblock',
    /^Used \/setblock to break block at -?\d+, -?\d+, -?\d+\.$/m, KIND.INFO,
    'skills.js', ['(break path / placeBlock)']),
  t('break.no_tool', /^Don't have right tools to break .+\.$/m,
    KIND.DEPENDENCY_TOOL, 'skills.js', ['(break helper)']),
  t('break.ok',
    /^Broke .+ at x:-?\d+(?:\.\d+)?, y:-?\d+(?:\.\d+)?, z:-?\d+(?:\.\d+)?\.$/m,
    KIND.INFO, 'skills.js', ['(break helper)']),
  t('break.skip',
    /^Skipping block at x:-?\d+(?:\.\d+)?, y:-?\d+(?:\.\d+)?, z:-?\d+(?:\.\d+)?  ?because it is .+\.$/m,
    KIND.INFO, 'skills.js', ['(break helper)']),

  t('place.air', /^Placing air \(removing block\) at .+\.$/m, KIND.INFO,
    'skills.js', ['!placeHere', '(placeBlock)']),
  t('place.restricted',
    /^Cannot place .+, you are restricted to your current inventory\.$/m,
    KIND.DEPENDENCY_ENVIRONMENT, 'skills.js', ['!placeHere', '(placeBlock)']),
  t('place.setblock', /^Used \/setblock to place .+ at .+\.$/m, KIND.INFO,
    'skills.js', ['!placeHere', '(placeBlock)']),
  t('place.no_item', /^Don't have any .+ to place\.$/m,
    KIND.DEPENDENCY_INVENTORY, 'skills.js', ['!placeHere', '(placeBlock)']),
  t('place.already_there', /^.+ already at .+\.$/m, KIND.AGENT_STATE,
    'skills.js', ['!placeHere', '(placeBlock)']),
  t('place.in_way', /^.+ in the way at .+\.$/m, KIND.DEPENDENCY_ENVIRONMENT,
    'skills.js', ['!placeHere', '(placeBlock)']),
  t('place.cant_block_in_way', /^Cannot place .+ at .+: block in the way\.$/m,
    KIND.DEPENDENCY_ENVIRONMENT, 'skills.js', ['!placeHere', '(placeBlock)']),
  t('place.unknown_placeOn',
    /^Unknown placeOn value ".+"\. Defaulting to bottom\.$/m, KIND.INFO,
    'skills.js', ['(placeBlock)']),
  t('place.no_anchor', /^Cannot place .+ at .+: nothing to place on\.$/m,
    KIND.DEPENDENCY_ENVIRONMENT, 'skills.js', ['!placeHere', '(placeBlock)']),
  t('place.ok', /^Placed .+ at .+\.$/m, KIND.SUCCESS, 'skills.js',
    ['!placeHere', '(placeBlock)']),
  t('place.failed', /^Failed to place .+ at .+\.$/m, KIND.AGENT_EXCEPTION,
    'skills.js', ['!placeHere', '(placeBlock)']),

  // Equip / discard
  t('equip.unequipped_hand', /^Unequipped hand\.$/m, KIND.SUCCESS, 'skills.js',
    ['!equip']),
  t('equip.no_item', /^You do not have any .+ to equip\.$/m,
    KIND.DEPENDENCY_INVENTORY, 'skills.js', ['!equip']),
  t('equip.ok', /^Equipped .+\.$/m, KIND.SUCCESS, 'skills.js', ['!equip']),
  t('discard.no_item', /^You do not have any .+ to discard\.$/m,
    KIND.DEPENDENCY_INVENTORY, 'skills.js', ['!discard']),
  t('discard.ok', /^Discarded \d+ .+\.$/m, KIND.SUCCESS, 'skills.js',
    ['!discard']),

  // Chest
  t('chest.not_found', /^Could not find a chest nearby\.$/m,
    KIND.DEPENDENCY_ENTITY_NOT_FOUND, 'skills.js',
    ['!putInChest', '!takeFromChest', '!viewChest']),
  t('chest.put_no_item', /^You do not have any .+ to put in the chest\.$/m,
    KIND.DEPENDENCY_INVENTORY, 'skills.js', ['!putInChest']),
  t('chest.put_ok', /^Successfully put \d+ .+ in the chest\.$/m, KIND.SUCCESS,
    'skills.js', ['!putInChest']),
  t('chest.take_not_found', /^Could not find any .+ in the chest\.$/m,
    KIND.DEPENDENCY_INVENTORY, 'skills.js', ['!takeFromChest']),
  t('chest.take_ok', /^Successfully took \d+ .+ from the chest\.$/m,
    KIND.SUCCESS, 'skills.js', ['!takeFromChest']),
  t('chest.empty', /^The chest is empty\.$/m, KIND.INFO, 'skills.js',
    ['!viewChest']),
  t('chest.contents_header', /^The chest contains:$/m, KIND.INFO, 'skills.js',
    ['!viewChest']),
  t('chest.contents_line', /^\d+ \w+$/m, KIND.INFO, 'skills.js',
    ['!viewChest']),

  // Consume
  t('consume.no_item', /^You do not have any .+ to eat\.$/m,
    KIND.DEPENDENCY_INVENTORY, 'skills.js', ['!consume']),
  t('consume.ok', /^Consumed .+\.$/m, KIND.SUCCESS, 'skills.js', ['!consume']),

  // Give / player
  t('give.self', /^You cannot give items to yourself\.$/m, KIND.AGENT_STATE,
    'skills.js', ['!givePlayer']),
  t('give.no_player', /^Could not find .+\.$/m,
    KIND.DEPENDENCY_ENTITY_NOT_FOUND, 'skills.js',
    ['!givePlayer', '!goToPlayer']),
  t('give.too_close', /^Failed to give .+ to .+, too close\.$/m,
    KIND.AGENT_EXCEPTION, 'skills.js', ['!givePlayer']),
  t('give.received', /^.+ received .+\.$/m, KIND.SUCCESS, 'skills.js',
    ['!givePlayer']),
  t('give.never_received',
    /^Failed to give .+ to .+, it was never received\.$/m, KIND.AGENT_EXCEPTION,
    'skills.js', ['!givePlayer']),

  // Pathfinding / search
  t('path.non_destructive', /^Found non-destructive path\.$/m, KIND.INFO,
    'skills.js', ['(pathfinding helper)']),
  t('path.destructive', /^Found destructive path\.$/m, KIND.INFO, 'skills.js',
    ['(pathfinding helper)']),
  t('path.not_found_attempting',
    /^Path not found, but attempting to navigate anyway using destructive movements\.$/m,
    KIND.INFO, 'skills.js', ['(pathfinding helper)']),
  t('path.missing_coords', /^Missing coordinates, given x:.+ y:.+ z:.+$/m,
    KIND.PARSE_ERROR, 'skills.js', ['!goToCoordinates']),
  t('path.teleported', /^Teleported to .+, .+, .+\.$/m, KIND.SUCCESS,
    'skills.js', ['!goToCoordinates', '!goToPlayer']),
  t('path.cant_break',
    /^Pathfinding stopped: Cannot break .+ with current tools\.$/m,
    KIND.DEPENDENCY_TOOL, 'skills.js', ['(pathfinding helper)']),
  t('path.reached_xyz',
    /^You have reached at -?\d+(?:\.\d+)?, -?\d+(?:\.\d+)?, -?\d+(?:\.\d+)?\.$/m,
    KIND.SUCCESS, 'skills.js', ['!goToCoordinates']),
  t('path.unreachable',
    /^Unable to reach -?\d+(?:\.\d+)?, -?\d+(?:\.\d+)?, -?\d+(?:\.\d+)?, you are \d+ blocks away\.$/m,
    KIND.DEPENDENCY_TARGET_UNREACHABLE, 'skills.js', ['!goToCoordinates']),
  t('path.stopped', /^Pathfinding stopped: .+\.$/m,
    KIND.DEPENDENCY_TARGET_UNREACHABLE, 'skills.js', ['(pathfinding helper)']),
  t('path.range_capped', /^Maximum search range capped at \d+\. $/m, KIND.INFO,
    'skills.js', ['!searchForBlock']),
  t('search.flowing_fallback',
    /^Could not find any source .+ in \d+ blocks, looking for uncollectable flowing instead\.\.\.$/m,
    KIND.INFO, 'skills.js', ['!searchForBlock']),
  t('search.block_not_found', /^Could not find any .+ in \d+ blocks\.$/m,
    KIND.DEPENDENCY_BLOCK_NOT_FOUND, 'skills.js', ['!searchForBlock']),
  t('search.block_found', /^Found .+ at .+\. Navigating\.\.\.$/m, KIND.INFO,
    'skills.js', ['!searchForBlock']),
  t('search.entity_not_found', /^Could not find any .+ in \d+ blocks\.$/m,
    KIND.DEPENDENCY_ENTITY_NOT_FOUND, 'skills.js', ['!searchForEntity']),
  t('search.entity_found', /^Found .+ \d+ blocks away\.$/m, KIND.INFO,
    'skills.js', ['!searchForEntity']),
  t('player.already_there', /^You are already at .+\.$/m, KIND.AGENT_STATE,
    'skills.js', ['!goToPlayer']),
  t('player.reached', /^You have reached .+\.$/m, KIND.SUCCESS, 'skills.js',
    ['!goToPlayer']),
  t('follow.started', /^You are now actively following player .+\.$/m,
    KIND.INFO, 'skills.js', ['!followPlayer']),

  // Movement
  t('moveAway.ok', /^Moved away from .+ to .+\.$/m, KIND.SUCCESS, 'skills.js',
    ['!moveAway']),
  t('moveAway.from_enemies', /^Moved \d+ away from enemies\.$/m, KIND.SUCCESS,
    'skills.js', ['(self_preservation)']),
  t('stay.ok', /^Stayed for \d+(?:\.\d+)? seconds\.$/m, KIND.SUCCESS,
    'skills.js', ['!stay']),

  // Doors / beds
  t('door.not_found', /^Could not find a door to use\.$/m,
    KIND.DEPENDENCY_ENTITY_NOT_FOUND, 'skills.js', ['(door helper)']),
  t('door.used', /^Used door at .+\.$/m, KIND.SUCCESS, 'skills.js',
    ['(door helper)']),
  t('bed.not_found', /^Could not find a bed to sleep in\.$/m,
    KIND.DEPENDENCY_ENTITY_NOT_FOUND, 'skills.js', ['!goToBed']),
  t('bed.in_bed', /^You are in bed\.$/m, KIND.INFO, 'skills.js', ['!goToBed']),
  t('bed.woken', /^You have woken up\.$/m, KIND.SUCCESS, 'skills.js',
    ['!goToBed']),

  // Farming
  t('plant.placing',
    /^Planting .+ at x:-?\d+(?:\.\d+)?, y:-?\d+(?:\.\d+)?, z:-?\d+(?:\.\d+)?\.$/m,
    KIND.INFO, 'skills.js', ['(plant helper)']),
  t('till.bad_block', /^Cannot till .+, must be grass_block or dirt\.$/m,
    KIND.DEPENDENCY_ENVIRONMENT, 'skills.js', ['(till helper)']),
  t('till.already_farmed', /^Land is already farmed with .+\.$/m,
    KIND.AGENT_STATE, 'skills.js', ['(till helper)']),
  t('till.cant_break_above', /^Cannot cannot break above block to till\.$/m,
    KIND.DEPENDENCY_ENVIRONMENT, 'skills.js', ['(till helper)']),
  t('till.no_hoe', /^Cannot till, no hoes\.$/m, KIND.DEPENDENCY_TOOL,
    'skills.js', ['(till helper)']),
  t('till.ok',
    /^Tilled block x:-?\d+(?:\.\d+)?, y:-?\d+(?:\.\d+)?, z:-?\d+(?:\.\d+)?\.$/m,
    KIND.INFO, 'skills.js', ['(till helper)']),
  t('plant.no_seed', /^No .+ to plant\.$/m, KIND.DEPENDENCY_INVENTORY,
    'skills.js', ['(plant helper)']),
  t('plant.ok',
    /^Planted .+ at x:-?\d+(?:\.\d+)?, y:-?\d+(?:\.\d+)?, z:-?\d+(?:\.\d+)?\.$/m,
    KIND.SUCCESS, 'skills.js', ['(plant helper)']),

  // Activate
  t('activate.not_found', /^Could not find any .+ to activate\.$/m,
    KIND.DEPENDENCY_ENTITY_NOT_FOUND, 'skills.js', ['(activate helper)']),
  t('activate.ok',
    /^Activated .+ at x:-?\d+(?:\.\d+)?, y:-?\d+(?:\.\d+)?, z:-?\d+(?:\.\d+)?\.$/m,
    KIND.SUCCESS, 'skills.js', ['(activate helper)']),

  // Villager / trades
  t('villager.id_not_found', /^Cannot find villager with id \d+$/m,
    KIND.DEPENDENCY_ENTITY_NOT_FOUND, 'skills.js',
    ['!showVillagerTrades', '!tradeWithVillager']),
  t('villager.none_nearby', /^No villagers found nearby\.$/m,
    KIND.DEPENDENCY_ENTITY_NOT_FOUND, 'skills.js', ['!showVillagerTrades']),
  t('villager.not_villager', /^Entity is not a villager$/m, KIND.PARSE_ERROR,
    'skills.js', ['!showVillagerTrades', '!tradeWithVillager']),
  t('villager.baby_or_jobless',
    /^This is either a baby villager or a villager with no job - neither can trade$/m,
    KIND.DEPENDENCY_VILLAGER_TRADE, 'skills.js',
    ['!showVillagerTrades', '!tradeWithVillager']),
  t('villager.moving_closer',
    /^Villager is \d+(?:\.\d+)? blocks away, moving closer\.\.\.$/m, KIND.INFO,
    'skills.js', ['!showVillagerTrades', '!tradeWithVillager']),
  t('villager.reached', /^Successfully reached villager$/m, KIND.INFO,
    'skills.js', ['!showVillagerTrades', '!tradeWithVillager']),
  t('villager.unreached',
    /^Failed to reach villager - pathfinding error or villager moved$/m,
    KIND.DEPENDENCY_TARGET_UNREACHABLE, 'skills.js',
    ['!showVillagerTrades', '!tradeWithVillager']),
  t('villager.no_trades',
    /^This villager has no trades available - might be sleeping, a baby, or jobless$/m,
    KIND.DEPENDENCY_VILLAGER_TRADE, 'skills.js',
    ['!showVillagerTrades', '!tradeWithVillager']),
  t('villager.has_trades_header', /^Villager has \d+ available trades:$/m,
    KIND.INFO, 'skills.js', ['!showVillagerTrades']),
  t('villager.open_failed_with_hint',
    /^Failed to open villager trading interface - they might be sleeping, a baby, or jobless$/m,
    KIND.AGENT_EXCEPTION, 'skills.js', ['!showVillagerTrades']),
  t('trade.not_found',
    /^Trade \d+ not found\. This villager has \d+ trades available\.$/m,
    KIND.DEPENDENCY_VILLAGER_TRADE, 'skills.js', ['!tradeWithVillager']),
  t('trade.disabled', /^Trade \d+ is currently disabled$/m,
    KIND.DEPENDENCY_VILLAGER_TRADE, 'skills.js', ['!tradeWithVillager']),
  t('trade.executing_summary', /^Trading [\s\S]+ for [\s\S]+\.\.\.$/m,
    KIND.INFO, 'skills.js', ['!tradeWithVillager']),
  t('trade.maxed', /^Trade \d+ has been used to its maximum limit$/m,
    KIND.DEPENDENCY_VILLAGER_TRADE, 'skills.js', ['!tradeWithVillager']),
  t('trade.no_resources',
    /^Don't have enough resources to execute trade \d+ \d+ time\(s\)$/m,
    KIND.DEPENDENCY_RESOURCE, 'skills.js', ['!tradeWithVillager']),
  t('trade.executing_count', /^Executing trade \d+ \d+ time\(s\)\.\.\.$/m,
    KIND.INFO, 'skills.js', ['!tradeWithVillager']),
  t('trade.ok', /^Successfully traded \d+ time\(s\)$/m, KIND.SUCCESS,
    'skills.js', ['!tradeWithVillager']),
  t('trade.error', /^An error occurred while trying to execute the trade$/m,
    KIND.AGENT_EXCEPTION, 'skills.js', ['!tradeWithVillager']),
  t('trade.open_failed', /^Failed to open villager trading interface$/m,
    KIND.AGENT_EXCEPTION, 'skills.js', ['!tradeWithVillager']),

  // Dig / surface
  t('digDown.end_of_world',
    /^Dug down \d+ blocks, but reached the end of the world\.$/m,
    KIND.PARTIAL_SUCCESS, 'skills.js', ['!digDown']),
  t('digDown.hit_hazard', /^Dug down \d+ blocks, but reached .+$/m,
    KIND.PARTIAL_SUCCESS, 'skills.js', ['!digDown']),
  t('digDown.drop',
    /^Dug down \d+ blocks, but reached a drop below the next block\.$/m,
    KIND.PARTIAL_SUCCESS, 'skills.js', ['!digDown']),
  t('digDown.skip_air', /^Skipping air block$/m, KIND.INFO, 'skills.js',
    ['!digDown']),
  t('digDown.failed', /^Failed to dig block at position:.+$/m,
    KIND.AGENT_EXCEPTION, 'skills.js', ['!digDown']),
  t('digDown.ok', /^Dug down \d+ blocks\.$/m, KIND.SUCCESS, 'skills.js',
    ['!digDown']),
  t('surface.going', /^Going to the surface at y=-?\d+\.$/m, KIND.INFO,
    'skills.js', ['!goToSurface']),

  // Use tool on target
  t('use.no_tool', /^You do not have any .+ to use\.$/m,
    KIND.DEPENDENCY_INVENTORY, 'skills.js', ['!useOn']),
  t('use.no_target_simple', /^Used .+\.$/m, KIND.SUCCESS, 'skills.js',
    ['!useOn']),
  t('use.target_not_found', /^Could not find any .+\.$/m,
    KIND.DEPENDENCY_ENTITY_NOT_FOUND, 'skills.js', ['!useOn']),
  t('use.ok_target', /^Used .+ on .+\.$/m, KIND.SUCCESS, 'skills.js',
    ['!useOn']),
  t('use.no_source', /^Could not find any source .+\.$/m,
    KIND.DEPENDENCY_BLOCK_NOT_FOUND, 'skills.js', ['!useOn']),
  t('use.blocked_unbreakable',
    /^Block .+ is in the way and cannot be broken, not using .+\.$/m,
    KIND.DEPENDENCY_ENVIRONMENT, 'skills.js', ['!useOn']),
  t('use.breaking_to_reach', /^Breaking .+ to reach .+\.\.\.$/m, KIND.INFO,
    'skills.js', ['!useOn']),
  t('use.still_blocked', /^Block .+ is still in the way, not using .+\.$/m,
    KIND.DEPENDENCY_ENVIRONMENT, 'skills.js', ['!useOn']),
  t('use.cant_equip', /^Could not equip .+\.$/m, KIND.DEPENDENCY_TOOL,
    'skills.js', ['!useOn']),
];

// --------------------------------------------------------------------------
// Query templates
// --------------------------------------------------------------------------
//
// Note:
//   The original catalog had some intentionally dynamic catch-all query
//   templates using /[\s\S]+/. This version excludes those catch-alls from
//   the active catalog to avoid accidental overmatching.
//
//   The classifier also has a defensive skip for exact catch-all patterns
//   in case one is added later.

const QUERY_TEMPLATES = [
  t('query.stats', /^\nSTATS\n/, KIND.QUERY_RESULT, 'queries.js', ['!stats']),
  t('query.inventory', /^\nINVENTORY/, KIND.QUERY_RESULT, 'queries.js',
    ['!inventory']),
  t('query.nearby_blocks', /^\nNEARBY_BLOCKS/, KIND.QUERY_RESULT, 'queries.js',
    ['!nearbyBlocks']),
  t('query.craftable', /^\nCRAFTABLE_ITEMS/, KIND.QUERY_RESULT, 'queries.js',
    ['!craftable']),
  t('query.entities', /^\nNEARBY_ENTITIES/, KIND.QUERY_RESULT, 'queries.js',
    ['!entities']),
  t('query.saved_places', /^Saved place names: /, KIND.QUERY_RESULT,
    'queries.js', ['!savedPlaces']),
  t('query.crafting_plan_err',
    /^An error occurred while generating the crafting plan: /,
    KIND.AGENT_EXCEPTION, 'queries.js', ['!getCraftingPlan']),
  t('query.wiki_404',
    /^.+ was not found on the Minecraft Wiki\. Try adjusting your search term\.$/,
    KIND.DEPENDENCY_ENTITY_NOT_FOUND, 'queries.js', ['!searchWiki']),
  t('query.wiki_err', /^The following error occurred: /, KIND.AGENT_EXCEPTION,
    'queries.js', ['!searchWiki']),
];

// --------------------------------------------------------------------------
// Verifier templates
// --------------------------------------------------------------------------
//
// `command_verifier.js` (see `command_verifier_plan.md`) reclassifies
// success-with-bad-postcondition results as `success: false` and
// prepends `verifier_failed:<reason>` to the message. These templates
// catch the reclassified messages and assign a semantic kind so the
// experiment metrics (dependency_error_rate, etc.) reflect what really
// went wrong instead of falling into a generic-failure bucket.
//
// Each template is scoped via `actions` to its specific command — the
// same verifier reason can mean different things for different commands
// (e.g. `no_inventory_delta` from !collectBlocks vs !craftRecipe has
// different root causes).

const VERIFIER_TEMPLATES = [
  // Inventory-delta verifiers.
  t('verifier.collect_no_delta',
    /^verifier_failed:no_inventory_delta/m,
    KIND.DEPENDENCY_TARGET_UNREACHABLE, 'command_verifier.js',
    ['!collectBlocks']),
  t('verifier.craft_no_delta',
    /^verifier_failed:no_inventory_delta/m,
    KIND.DEPENDENCY_RESOURCE, 'command_verifier.js', ['!craftRecipe']),
  t('verifier.smelt_no_delta',
    /^verifier_failed:no_\w+_delta/m,
    KIND.DEPENDENCY_RESOURCE, 'command_verifier.js',
    ['!smelt_item', '!smeltItem']),

  // Inventory-decrease verifiers.
  t('verifier.place_blocked',
    /^verifier_failed:item_still_in_inventory/m,
    KIND.DEPENDENCY_ENVIRONMENT, 'command_verifier.js', ['!placeHere']),
  t('verifier.consume_failed',
    /^verifier_failed:item_still_in_inventory/m,
    KIND.AGENT_STATE, 'command_verifier.js', ['!consume']),

  // Position-based nav verifiers.
  t('verifier.goto_off_target',
    /^verifier_failed:[\d.]+_blocks_off_target/m,
    KIND.DEPENDENCY_TARGET_UNREACHABLE, 'command_verifier.js',
    ['!goToCoordinates']),
  t('verifier.moveaway_stuck',
    /^verifier_failed:no_movement/m,
    KIND.DEPENDENCY_TARGET_UNREACHABLE, 'command_verifier.js', ['!moveAway']),
  t('verifier.digdown_blocked',
    /^verifier_failed:no_descent/m,
    KIND.DEPENDENCY_ENVIRONMENT, 'command_verifier.js', ['!digDown']),
  t('verifier.surface_obstructed',
    /^verifier_failed:block_above_head:/m,
    KIND.DEPENDENCY_TARGET_UNREACHABLE, 'command_verifier.js',
    ['!goToSurface']),

  // Entity-state verifiers.
  t('verifier.attack_no_drop',
    /^verifier_failed:no_drop_for_/m,
    KIND.DEPENDENCY_ENTITY_NOT_FOUND, 'command_verifier.js', ['!attack']),
  t('verifier.equip_failed',
    /^verifier_failed:held=/m,
    KIND.AGENT_STATE, 'command_verifier.js', ['!equip']),
];

// --------------------------------------------------------------------------
// Catalog
// --------------------------------------------------------------------------

export const TEMPLATES = [
  ...PARSE_TEMPLATES,
  ...WRAPPER_TEMPLATES,
  ...ACTION_DIRECT_TEMPLATES,
  ...SKILL_TEMPLATES,
  ...QUERY_TEMPLATES,
  ...VERIFIER_TEMPLATES,
];

export const TEMPLATES_BY_ID =
    Object.fromEntries(TEMPLATES.map((template) => [template.id, template]));

export const TEMPLATES_BY_KIND = TEMPLATES.reduce((acc, template) => {
  if (!acc[template.kind]) acc[template.kind] = [];
  acc[template.kind].push(template);
  return acc;
}, {});

export const DEPENDENCY_TEMPLATES =
    TEMPLATES.filter((template) => template.isDependencyFailure);

// --------------------------------------------------------------------------
// Matching helpers
// --------------------------------------------------------------------------

function templateAppliesTo(template, actionName) {
  if (!actionName) return true;

  for (const action of template.actions) {
    if (action === '*') return true;
    if (action === actionName) return true;
    if (action.startsWith('(')) return true;
    if (action === 'runAsAction wrapper') return true;
    if (action === 'BlockName params') return true;
    if (action === 'ItemName params') return true;
    if (action === 'BlockOrItemName params') return true;
  }

  return false;
}

function isDynamicCatchAllTemplate(template) {
  // Defensive check matching the original classifier's intent:
  // skip templates whose regex is exactly /[\s\S]+/.
  return template.pattern?.source === '[\\s\\S]+';
}

function makeGlobalRegex(pattern) {
  const flags = pattern.flags.includes('m') ? 'gm' : 'g';
  return new RegExp(pattern.source, flags);
}

function normalizeResult(result) {
  let success = null;
  let rawMessage = '';

  if (result == null) {
    rawMessage = '';
  } else if (typeof result === 'string') {
    rawMessage = result;
  } else if (typeof result === 'object' && 'message' in result) {
    success = result.success ?? null;
    rawMessage = result.message ?? '';
  } else {
    rawMessage = String(result);
  }

  return {success, rawMessage};
}

function resolveTemplateCollisions(matches) {
  const hasCantBlock =
      matches.some((match) => match.template.id === 'place.cant_block_in_way');

  if (!hasCantBlock) return matches;

  return matches.filter((match) => match.template.id !== 'place.in_way');
}

// --------------------------------------------------------------------------
// Core classifier
// --------------------------------------------------------------------------

export function classifyMessage(actionName, result) {
  const {success, rawMessage} = normalizeResult(result);

  let matches = [];

  for (const template of TEMPLATES) {
    // Disambiguate identical search patterns by action name.
    if (template.id === 'search.entity_not_found' &&
        actionName !== '!searchForEntity') {
      continue;
    }

    if (template.id === 'search.block_not_found' &&
        actionName === '!searchForEntity') {
      continue;
    }

    // Preserve the original intent to skip dynamic /[\s\S]+/ catch-alls.
    if (isDynamicCatchAllTemplate(template)) {
      continue;
    }

    if (!templateAppliesTo(template, actionName)) {
      continue;
    }

    const regex = makeGlobalRegex(template.pattern);
    let match;

    while ((match = regex.exec(rawMessage)) !== null) {
      matches.push({
        template,
        snippet: match[0],
      });

      // Avoid infinite loops on zero-width matches.
      if (match.index === regex.lastIndex) {
        regex.lastIndex++;
      }
    }
  }

  matches = resolveTemplateCollisions(matches);

  const kinds = new Set(matches.map((match) => match.template.kind));

  const dependencyMatches =
      matches.filter((match) => match.template.isDependencyFailure)
          .map((match) => match.template);

  return {
    success,
    rawMessage,
    matches,
    kinds,
    isDependencyFailure: dependencyMatches.length > 0,
    dependencyMatches,
    isInterrupted: success === false && rawMessage === '',
    isException: kinds.has(KIND.AGENT_EXCEPTION),
    isParseError: kinds.has(KIND.PARSE_ERROR),
  };
}

// --------------------------------------------------------------------------
// Policy helpers
// --------------------------------------------------------------------------

const BROAD_DEPENDENCY_TEMPLATE_IDS = new Set([
  // Partial successes that indicate the requested command could not be fully
  // completed because a resource/environment condition blocked completion.
  'craft.partial',
  'smelt.partial',
  'digDown.end_of_world',
  'digDown.hit_hazard',
  'digDown.drop',

  // Generic failures that may hide dependency-like causes.
  // Use only for sensitivity analysis, not the main metric.
  'collect.failed_err',
  'place.failed',
  'give.never_received',
  'trade.error',
  'trade.open_failed',
  'villager.open_failed_with_hint',
]);

function classifyBroadDependencyIssue(classification) {
  // Conservative dependency failures are always broad dependency issues.
  if (classification.success !== true && classification.isDependencyFailure) {
    return true;
  }

  // Broad mode intentionally includes selected partial successes and
  // dependency-like generic failures as sensitivity-analysis labels.
  return classification.matches.some(
      (match) => BROAD_DEPENDENCY_TEMPLATE_IDS.has(match.template.id));
}

export function isDependencyRelatedFailure(actionName, result, options = {}) {
  const {policy = DEPENDENCY_POLICY.CONSERVATIVE} = options;
  const classification = classifyMessage(actionName, result);

  if (policy === DEPENDENCY_POLICY.CONSERVATIVE) {
    if (classification.success === true) return false;
    return classification.isDependencyFailure;
  }

  if (policy === DEPENDENCY_POLICY.BROAD) {
    return classifyBroadDependencyIssue(classification);
  }

  throw new Error(`Unknown dependency policy: ${policy}`);
}

// --------------------------------------------------------------------------
// Experiment-facing wrapper
// --------------------------------------------------------------------------

export function classifyCommandResult({
  rolloutId = null,
  achievementId = null,
  stepIndex = null,
  command = null,
  actionName,
  result,
  policy = DEPENDENCY_POLICY.CONSERVATIVE,
} = {}) {
  if (!actionName) {
    throw new Error('classifyCommandResult requires actionName');
  }

  if (policy !== DEPENDENCY_POLICY.CONSERVATIVE &&
      policy !== DEPENDENCY_POLICY.BROAD) {
    throw new Error(`Unknown dependency policy: ${policy}`);
  }

  const classification = classifyMessage(actionName, result);

  const matchedTemplateIds =
      classification.matches.map((match) => match.template.id);

  const dependencyTemplateIds =
      classification.dependencyMatches.map((template) => template.id);

  const dependencyKinds = [
    ...new Set(
        classification.dependencyMatches.map((template) => template.kind)),
  ];

  const conservativeDependencyFailure =
      classification.success !== true && classification.isDependencyFailure;

  const broadDependencyIssue = classifyBroadDependencyIssue(classification);

  const isDependencyFailure = policy === DEPENDENCY_POLICY.CONSERVATIVE ?
      conservativeDependencyFailure :
      broadDependencyIssue;

  return {
    classifierVersion: CLASSIFIER_VERSION,
    policyVersion: POLICY_VERSION,
    policy,

    rolloutId,
    achievementId,
    stepIndex,
    command,
    actionName,

    success: classification.success,
    rawMessage: classification.rawMessage,

    isFailure: classification.success === false,
    isDependencyFailure,
    isDependencyFailureConservative: conservativeDependencyFailure,
    isDependencyIssueBroad: broadDependencyIssue,

    dependencyKinds,
    matchedTemplateIds,
    dependencyTemplateIds,

    isInterrupted: classification.isInterrupted,
    isException: classification.isException,
    isParseError: classification.isParseError,
  };
}

// --------------------------------------------------------------------------
// Metrics
// --------------------------------------------------------------------------

function countBy(values) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function safeRate(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function summarizeDependencyErrors(commandRecords) {
  const totalCommands = commandRecords.length;

  const totalFailures =
      commandRecords.filter((record) => record.isFailure).length;

  const dependencyFailures =
      commandRecords.filter((record) => record.isDependencyFailure).length;

  const conservativeDependencyFailures =
      commandRecords.filter((record) => record.isDependencyFailureConservative)
          .length;

  const broadDependencyIssues =
      commandRecords.filter((record) => record.isDependencyIssueBroad).length;

  const dependencyFailureRecords =
      commandRecords.filter((record) => record.isDependencyFailure);

  return {
    classifierVersion: CLASSIFIER_VERSION,
    policyVersion: POLICY_VERSION,

    totalCommands,
    totalFailures,

    dependencyFailures,
    conservativeDependencyFailures,
    broadDependencyIssues,

    dependencyErrorRate: safeRate(dependencyFailures, totalCommands),
    dependencyFailureShare: safeRate(dependencyFailures, totalFailures),

    conservativeDependencyErrorRate:
        safeRate(conservativeDependencyFailures, totalCommands),

    broadDependencyIssueRate: safeRate(broadDependencyIssues, totalCommands),

    dependencyFailuresByKind: countBy(dependencyFailureRecords.flatMap(
        (record) => record.dependencyKinds ?? [])),

    dependencyFailuresByTemplate: countBy(dependencyFailureRecords.flatMap(
        (record) => record.dependencyTemplateIds ?? [])),
  };
}

// --------------------------------------------------------------------------
// Optional smoke test helper
// --------------------------------------------------------------------------

export function runDependencyClassifierSmokeTest() {
  const examples = [
    {
      name: 'tool dependency',
      actionName: '!collectBlocks',
      result: {
        success: false,
        message: 'Action output:\nDon\'t have right tools to harvest stone.',
      },
      expectedConservative: true,
      expectedBroad: true,
    },
    {
      name: 'resource dependency',
      actionName: '!craftRecipe',
      result: {
        success: false,
        message:
            'Action output:\nYou do not have the resources to craft a stick. It requires: oak_planks: 2.',
      },
      expectedConservative: true,
      expectedBroad: true,
    },
    {
      name: 'agent state no-op',
      actionName: '!setMode',
      result: 'Mode self_defense is already on.',
      expectedConservative: false,
      expectedBroad: false,
    },
    {
      name: 'parse error',
      actionName: '!goToCoordinates',
      result: {
        success: false,
        message:
            'Command !goToCoordinates was given 2 args, but requires 4 args.',
      },
      expectedConservative: false,
      expectedBroad: false,
    },
    {
      name: 'partial success broad only',
      actionName: '!craftRecipe',
      result: {
        success: true,
        message:
            'Action output:\nNot enough oak_planks to craft 5, crafted 2. You now have 8 stick.',
      },
      expectedConservative: false,
      expectedBroad: true,
    },
  ];

  for (const example of examples) {
    const conservative = isDependencyRelatedFailure(
        example.actionName, example.result,
        {policy: DEPENDENCY_POLICY.CONSERVATIVE});

    if (conservative !== example.expectedConservative) {
      throw new Error(
          `Conservative smoke test failed for ${example.name}: expected ${
              example.expectedConservative}, got ${conservative}`);
    }

    const broad = isDependencyRelatedFailure(
        example.actionName, example.result, {policy: DEPENDENCY_POLICY.BROAD});

    if (broad !== example.expectedBroad) {
      throw new Error(`Broad smoke test failed for ${example.name}: expected ${
          example.expectedBroad}, got ${broad}`);
    }
  }

  return true;
}