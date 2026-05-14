import {getBlockTool} from '../../../../src/utils/mcdata.js';

import {ABSTRACT_CLASS_MEMBERS} from '../mc_sources.js';

const WORKSTATIONS = new Set(['crafting_table', 'furnace']);
const ENVIRONMENTAL_TOOL_TARGETS = new Set(['water', 'lava']);

function normalize_inputs(inputs) {
  return (inputs ?? []).map(({item, qty}) => ({item, qty}));
}

function expand_item_members(item) {
  if (typeof item !== 'string') return [];
  if (!item.startsWith('any_')) return [item];
  const members = ABSTRACT_CLASS_MEMBERS[item];
  return Array.isArray(members) && members.length > 0 ? members : [item];
}

function sum_inventory_count(inventory, item) {
  return expand_item_members(item)
      .reduce((total, member) => total + (inventory?.[member] ?? 0), 0);
}

function has_inventory_item(inventory, item) {
  if (item == null) return null;
  return sum_inventory_count(inventory, item) > 0;
}

function is_equipped(item, equipped_item) {
  if (item == null) return null;
  return expand_item_members(item).includes(equipped_item ?? null);
}

function list_missing_inputs(inputs, inventory) {
  return normalize_inputs(inputs).flatMap(({item, qty}) => {
    const available = sum_inventory_count(inventory, item);
    const missing = Math.max(0, qty - available);
    return missing > 0 ? [{item, required: qty, available, missing}] : [];
  });
}

function resolve_required_tool(task) {
  const parameters = task?.parameters ?? {};

  if (task?.action_type === 'interact') {
    return parameters.tool ?? null;
  }

  if (task?.action_type === 'kill') {
    return parameters.weapon ?? null;
  }

  if (task?.action_type !== 'collect') {
    return parameters.tool ?? null;
  }

  if (parameters.item_dependency != null &&
      ENVIRONMENTAL_TOOL_TARGETS.has(parameters.source_block)) {
    return parameters.item_dependency;
  }

  if (parameters.tool != null) {
    return parameters.tool;
  }

  if (typeof parameters.source_block !== 'string' ||
      parameters.source_block.startsWith('any_')) {
    return null;
  }

  try {
    return getBlockTool(parameters.source_block);
  } catch {
    return null;
  }
}

function resolve_required_workstation(task) {
  return task?.parameters?.workstation ?? null;
}

function is_craftable_now(task, craftable_items) {
  if (task?.action_type !== 'craft' || typeof task?.target_item !== 'string') {
    return null;
  }

  const members = expand_item_members(task.target_item);
  return members.some((item) => craftable_items.includes(item));
}

function infer_workstation_nearby(workstation, nearby_blocks) {
  if (workstation == null) return null;
  return nearby_blocks.includes(workstation);
}

export function is_workstation_item(item) {
  return WORKSTATIONS.has(item);
}

export function build_dependency_context(
    task, am_state, {equipped_item = null} = {}) {
  const inventory = am_state?.inventory ?? {};
  const craftable_items = am_state?.craftable_items ?? [];
  const nearby_blocks = am_state?.nearby_blocks ?? [];

  const required_tool = resolve_required_tool(task);
  const required_workstation = resolve_required_workstation(task);
  const crafting_inputs = normalize_inputs(task?.parameters?.crafting_inputs);
  const smelting_inputs = normalize_inputs(task?.parameters?.smelting_inputs);
  const fuel_inputs = normalize_inputs(task?.parameters?.fuel_inputs);

  return {
    required: {
      tool: required_tool,
      workstation: required_workstation,
      crafting_inputs: crafting_inputs,
      smelting_inputs: smelting_inputs,
      fuel_inputs: fuel_inputs,
    },
    availability: {
      tool_in_inventory: has_inventory_item(inventory, required_tool),
      tool_equipped: is_equipped(required_tool, equipped_item),
      workstation_in_inventory:
          has_inventory_item(inventory, required_workstation),
      workstation_nearby:
          infer_workstation_nearby(required_workstation, nearby_blocks),
      craftable_now: is_craftable_now(task, craftable_items),
      missing_inputs:
          list_missing_inputs([...crafting_inputs, ...smelting_inputs], inventory),
      missing_fuel: list_missing_inputs(fuel_inputs, inventory),
    },
  };
}
