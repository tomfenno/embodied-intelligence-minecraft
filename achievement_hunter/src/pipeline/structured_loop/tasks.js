import {get_canonical_mob_source, resolve_fallback_block_source, resolve_nearby_block_source, resolve_nearby_mob_source,} from '../mc_sources.js';

import {get_satisfied_inputs_by_type, get_single_satisfied_input_item, resolve_concrete_craft_target,} from './graph.js';

const itemish_types = new Set(['item', 'tool', 'workstation']);

// Applies tiered task selection.
export function select_next_task(candidates, state) {
  for (const candidate of candidates) {
    const task =
        try_make_craft_task(candidate, state) ?? try_make_smelt_task(candidate);
    if (task) return task;
  }

  for (const candidate of candidates) {
    if (candidate.item_type !== 'resource') continue;
    const task = try_make_immediate_acquisition_task(candidate, state);
    if (task) return task;
  }

  for (const candidate of candidates) {
    const task = try_make_interact_task(candidate, state);
    if (task) return task;
  }

  for (const candidate of candidates) {
    if (candidate.item_type !== 'resource') continue;
    const task = make_fallback_acquisition_task(candidate, state);
    if (task) return task;
  }

  return null;
}

// Builds a craft task when inputs are already satisfied.
export function try_make_craft_task(candidate, state) {
  if (!itemish_types.has(candidate.item_type)) return null;

  const concrete_target =
      resolve_concrete_craft_target(candidate.id, state.craftable_items ?? []);
  return concrete_target ? {
    target_item: concrete_target,
    qty: candidate.qty,
    action_type: 'craft',
    parameters: {
      crafting_inputs:
          get_satisfied_inputs_by_type(candidate, 'crafting_input'),
      workstation:
          get_single_satisfied_input_item(candidate, 'workstation_dependency'),
    },
  } :
                           null;
}

// Builds a smelt task when smelting prerequisites are satisfied.
export function try_make_smelt_task(candidate) {
  if (!itemish_types.has(candidate.item_type)) return null;

  const smelting_inputs =
      get_satisfied_inputs_by_type(candidate, 'smelting_input');
  const fuel_inputs = get_satisfied_inputs_by_type(candidate, 'fuel_input');
  const workstation =
      get_single_satisfied_input_item(candidate, 'workstation_dependency');

  return smelting_inputs.length && fuel_inputs.length && workstation != null ?
      {
        target_item: candidate.id,
        qty: candidate.qty,
        action_type: 'smelt',
        parameters: {smelting_inputs, fuel_inputs, workstation},
      } :
      null;
}

// Builds an immediate nearby collect or kill task.
export function try_make_immediate_acquisition_task(candidate, state) {
  if (candidate.acquisition_dependency === 'mob') {
    const source_mob =
        resolve_nearby_mob_source(candidate, state.nearby_entities?.mobs ?? []);
    return source_mob ? {
      target_item: candidate.id,
      qty: candidate.qty,
      action_type: 'kill',
      parameters: {
        source_mob,
        weapon: get_single_satisfied_input_item(candidate, 'tool_dependency'),
      },
    } :
                        null;
  }

  const source_block =
      resolve_nearby_block_source(candidate, state.nearby_blocks ?? []);
  return source_block ? {
    target_item: candidate.id,
    qty: candidate.qty,
    action_type: 'collect',
    parameters: {
      source_block,
      item_dependency:
          get_single_satisfied_input_item(candidate, 'item_dependency'),
      tool: get_single_satisfied_input_item(candidate, 'tool_dependency'),
    },
  } :
                        null;
}

// Builds a fallback collect or kill task.
export function make_fallback_acquisition_task(candidate, state) {
  return candidate.acquisition_dependency === 'mob' ?
      {
        target_item: candidate.id,
        qty: candidate.qty,
        action_type: 'kill',
        parameters: {
          source_mob: get_canonical_mob_source(candidate.id),
          weapon: get_single_satisfied_input_item(candidate, 'tool_dependency'),
        },
      } :
      {
        target_item: candidate.id,
        qty: candidate.qty,
        action_type: 'collect',
        parameters: {
          source_block: resolve_fallback_block_source(
              candidate, state.nearby_blocks ?? []),
          item_dependency:
              get_single_satisfied_input_item(candidate, 'item_dependency'),
          tool: get_single_satisfied_input_item(candidate, 'tool_dependency'),
        },
      };
}

export function try_make_interact_task(candidate, state) {
  if (candidate.item_type === 'resource') return null;

  const tool = get_single_satisfied_input_item(candidate, 'tool_dependency');
  const crafting_input =
      get_single_satisfied_input_item(candidate, 'crafting_input');

  // Case 1: explicit tool-on-item interaction, e.g. shears on pumpkin.
  if (tool != null && crafting_input != null) {
    return {
      target_item: candidate.id,
      qty: candidate.qty,
      action_type: 'interact',
      parameters: {
        tool,
        target: crafting_input,
      },
    };
  }

  if (crafting_input == null) return null;

  const target =
      resolve_nearby_block_source(candidate, state.nearby_blocks ?? []) ??
      resolve_acquisition_dependency(candidate);

  return target != null ? {
    target_item: candidate.id,
    qty: candidate.qty,
    action_type: 'interact',
    parameters: {
      tool: crafting_input,
      target,
    },
  } :
                          null;
}

export function resolve_acquisition_dependency(candidate) {
  if (candidate.acquisition_dependency === 'water_source') return 'water';
  if (candidate.acquisition_dependency === 'lava_source') return 'lava';
  return null;
}