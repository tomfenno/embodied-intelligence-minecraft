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

  // Tier 4: fallback acquisition (search-based) for resource candidates.
  // Emits a single `search_sweep` task carrying ALL eligible resource
  // candidates as targets — the sweep handler in actions.js tries them
  // breadth-first across radii. Any one success exits the sweep and lets
  // the SPL outer loop resume normally; only if every target exhausts at
  // every radius does the search_replanner get invoked with the full
  // exhausted list.
  const sweep_task = make_fallback_search_sweep_task(candidates, state);
  if (sweep_task) return sweep_task;

  return null;
}

// Builds a craft task when inputs are already satisfied.
export function try_make_craft_task(candidate, state) {
  if (!itemish_types.has(candidate.item_type)) return null;

  const concrete_target =
      resolve_concrete_craft_target(candidate.id, state.craftable_items ?? []);
  if (!concrete_target) return null;

  return {
    target_item: concrete_target,
    qty: candidate.qty,
    action_type: 'craft',
    parameters: {
      crafting_inputs:
          get_satisfied_inputs_by_type(candidate, 'crafting_input'),
      workstation:
          get_single_satisfied_input_item(candidate, 'workstation_dependency'),
    },
  };
}

// Builds a smelt task when smelting prerequisites are satisfied.
export function try_make_smelt_task(candidate) {
  if (!itemish_types.has(candidate.item_type)) return null;

  const smelting_inputs =
      get_satisfied_inputs_by_type(candidate, 'smelting_input');
  const fuel_inputs = get_satisfied_inputs_by_type(candidate, 'fuel_input');
  const workstation =
      get_single_satisfied_input_item(candidate, 'workstation_dependency');

  if (!smelting_inputs.length || !fuel_inputs.length || workstation == null) {
    return null;
  }

  return {
    target_item: candidate.id,
    qty: candidate.qty,
    action_type: 'smelt',
    parameters: {smelting_inputs, fuel_inputs, workstation},
  };
}

// Builds an immediate nearby collect or kill task.
export function try_make_immediate_acquisition_task(candidate, state) {
  if (candidate.acquisition_dependency === 'mob') {
    const source_mob =
        resolve_nearby_mob_source(candidate, state.nearby_entities?.mobs ?? []);
    if (!source_mob) return null;
    return {
      target_item: candidate.id,
      qty: candidate.qty,
      action_type: 'kill',
      parameters: {
        source_mob,
        weapon: get_single_satisfied_input_item(candidate, 'tool_dependency'),
      },
    };
  }

  const source_block =
      resolve_nearby_block_source(candidate, state.nearby_blocks ?? []);
  if (!source_block) return null;
  return {
    target_item: candidate.id,
    qty: candidate.qty,
    action_type: 'collect',
    parameters: {
      source_block,
      item_dependency:
          get_single_satisfied_input_item(candidate, 'item_dependency'),
      tool: get_single_satisfied_input_item(candidate, 'tool_dependency'),
    },
  };
}

// Builds a multi-target search sweep task. Tier 4's emission per D1-D7:
// when no immediate craft / collect / interact task is available, collect
// every eligible resource candidate's fallback source into a single task
// for breadth-first sweeping in actions.js. Excludes:
//   - Non-resource candidates (interact / tool / workstation) per D1.
//   - Candidates whose fallback resolves to no source (defensive — e.g.
//     a mob with no canonical, or a block with no fallback block name).
//
// Returns null if no candidate produces a viable source — `select_next_task`
// then falls through to returning null (the outer loop re-evaluates state).
//
// Shape:
//   {
//     target_item: targets[0].target_item,  // canonical for trace/filename
//     action_type: 'search_sweep',
//     parameters: {
//       targets: [{target_item, source, kind: 'block'|'mob', qty}, ...]
//     }
//   }
export function make_fallback_search_sweep_task(candidates, state) {
  const targets = [];
  for (const candidate of candidates) {
    if (candidate.item_type !== 'resource') continue;
    const fallback = make_fallback_acquisition_task(candidate, state);
    if (!fallback) continue;

    const params = fallback.parameters;
    let source = null;
    let kind = null;
    if (fallback.action_type === 'kill' && params.source_mob != null) {
      source = params.source_mob;
      kind = 'mob';
    } else if (
        fallback.action_type === 'collect' && params.source_block != null) {
      source = params.source_block;
      kind = 'block';
    }
    if (source == null) continue;

    targets.push({
      target_item: candidate.id,
      source,
      kind,
      qty: candidate.qty,
    });
  }

  if (targets.length === 0) return null;

  return {
    target_item: targets[0].target_item,
    action_type: 'search_sweep',
    parameters: {targets},
  };
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
  if (target == null) return null;

  return {
    target_item: candidate.id,
    qty: candidate.qty,
    action_type: 'interact',
    parameters: {
      tool: crafting_input,
      target,
    },
  };
}

export function resolve_acquisition_dependency(candidate) {
  if (candidate.acquisition_dependency === 'water_source') return 'water';
  if (candidate.acquisition_dependency === 'lava_source') return 'lava';
  return null;
}