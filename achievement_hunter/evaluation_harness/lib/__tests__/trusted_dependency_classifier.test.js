import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {describe, expect, it} from 'vitest';

import {
  analyzeTrustedDependencyRecords,
} from '../trusted_dependency_classifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function make_context({
  tool = null,
  tool_in_inventory = null,
  tool_equipped = null,
  workstation = null,
  workstation_in_inventory = null,
  workstation_nearby = null,
  craftable_now = null,
  crafting_inputs = [],
  smelting_inputs = [],
  fuel_inputs = [],
  missing_inputs = [],
  missing_fuel = [],
} = {}) {
  return {
    required: {
      tool,
      workstation,
      crafting_inputs,
      smelting_inputs,
      fuel_inputs,
    },
    availability: {
      tool_in_inventory,
      tool_equipped,
      workstation_in_inventory,
      workstation_nearby,
      craftable_now,
      missing_inputs,
      missing_fuel,
    },
  };
}

function make_record({
  id,
  task_id = 'task-1',
  step = 1,
  command,
  success = false,
  message,
  task = null,
  dependency_context = null,
} = {}) {
  return {
    record_id: id ?? `${task_id}::${step}`,
    task_record_id: task_id,
    source_file: 'synthetic',
    step_index: step,
    command,
    task,
    result: {success, message},
    dependency_context,
  };
}

function extract_command(content) {
  return content.match(/!\w+\([^)]*\)/)?.[0] ?? content.trim();
}

function find_assistant_with(history, text) {
  const turn = history.find((entry) => {
    return entry.role === 'assistant' && String(entry.content).includes(text);
  });
  if (!turn) {
    throw new Error(`Could not find assistant turn containing "${text}"`);
  }
  return turn;
}

function find_system_with(history, text) {
  const turn = history.find((entry) => {
    return entry.role === 'system' && String(entry.content).includes(text);
  });
  if (!turn) {
    throw new Error(`Could not find system turn containing "${text}"`);
  }
  return turn;
}

describe('analyzeTrustedDependencyRecords', () => {
  it('confirms a missing-tool event when the required tool is absent', () => {
    const events = analyzeTrustedDependencyRecords([
      make_record({
        command: '!collectBlocks("stone", 11)',
        message: 'Action output:\nDon\'t have right tools to harvest stone.',
        task: {target_item: 'cobblestone', action_type: 'collect'},
        dependency_context: make_context({
          tool: 'wooden_pickaxe',
          tool_in_inventory: false,
          tool_equipped: false,
        }),
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].dependency_kind).toBe('tool');
    expect(events[0].status).toBe('confirmed_missing');
  });

  it('confirms a missing-resource event even when the wrapper reported success', () => {
    const events = analyzeTrustedDependencyRecords([
      make_record({
        command: '!craftRecipe("furnace", 1)',
        success: true,
        message:
            'Action output:\nYou do not have the resources to craft a furnace. It requires: cobblestone: 8.',
        task: {target_item: 'furnace', action_type: 'craft'},
        dependency_context: make_context({
          workstation: 'crafting_table',
          workstation_in_inventory: true,
          craftable_now: false,
          crafting_inputs: [{item: 'cobblestone', qty: 8}],
          missing_inputs: [
            {item: 'cobblestone', required: 8, available: 0, missing: 8},
          ],
        }),
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].dependency_kind).toBe('resource');
    expect(events[0].status).toBe('confirmed_missing');
  });

  it('confirms a missing-fuel event from trusted context', () => {
    const events = analyzeTrustedDependencyRecords([
      make_record({
        command: '!smelt_item("raw_iron", 3, "coal")',
        message:
            'Action output:\nYou have no fuel to smelt raw_iron, you need coal, charcoal, or wood.',
        task: {target_item: 'iron_ingot', action_type: 'smelt'},
        dependency_context: make_context({
          workstation: 'furnace',
          workstation_in_inventory: true,
          smelting_inputs: [{item: 'raw_iron', qty: 3}],
          fuel_inputs: [{item: 'coal', qty: 1}],
          missing_fuel: [{item: 'coal', required: 1, available: 0, missing: 1}],
        }),
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].dependency_kind).toBe('fuel');
    expect(events[0].status).toBe('confirmed_missing');
  });

  it('confirms a missing-workstation event when the workstation was unavailable', () => {
    const events = analyzeTrustedDependencyRecords([
      make_record({
        command: '!craftRecipe("stone_pickaxe", 1)',
        message: 'Action output:\nCrafting stone_pickaxe requires a crafting table.',
        task: {target_item: 'stone_pickaxe', action_type: 'craft'},
        dependency_context: make_context({
          workstation: 'crafting_table',
          workstation_in_inventory: false,
          workstation_nearby: false,
          craftable_now: false,
        }),
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].dependency_kind).toBe('workstation');
    expect(events[0].status).toBe('confirmed_missing');
  });

  it('suppresses a crafting-table placement glitch when the workstation was already available', () => {
    const task = {target_item: 'furnace', action_type: 'craft'};
    const context = make_context({
      workstation: 'crafting_table',
      workstation_in_inventory: true,
      workstation_nearby: false,
      craftable_now: true,
      crafting_inputs: [{item: 'cobblestone', qty: 8}],
    });
    const events = analyzeTrustedDependencyRecords([
      make_record({
        task_id: 'task-glitch',
        step: 1,
        command: '!craftRecipe("furnace", 1)',
        message:
            'Action output:\nFailed to place crafting_table at (-129, 56, -27).\n!!Code threw exception!!\nError: Error: Recipe requires craftingTable, but one was not supplied.',
        task,
        dependency_context: context,
      }),
      make_record({
        task_id: 'task-glitch',
        step: 2,
        command: '!craftRecipe("furnace", 1)',
        success: true,
        message:
            'Action output:\nPlaced crafting_table at (-130, 61, -26).\nSuccessfully crafted furnace, you now have 1 furnace.\nCollected 1 crafting_table.',
        task,
        dependency_context: context,
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].dependency_kind).toBe('workstation');
    expect(events[0].status).toBe('suppressed_transient');
  });

  it('suppresses repeated workstation glitches but still confirms the later real missing-resource failure', () => {
    const task = {target_item: 'furnace', action_type: 'craft'};
    const glitch_context = make_context({
      workstation: 'crafting_table',
      workstation_in_inventory: true,
      craftable_now: true,
      crafting_inputs: [{item: 'cobblestone', qty: 8}],
      missing_inputs: [],
    });
    const missing_resource_context = make_context({
      workstation: 'crafting_table',
      workstation_in_inventory: true,
      craftable_now: false,
      crafting_inputs: [{item: 'cobblestone', qty: 8}],
      missing_inputs: [
        {item: 'cobblestone', required: 8, available: 0, missing: 8},
      ],
    });
    const events = analyzeTrustedDependencyRecords([
      make_record({
        task_id: 'task-resource-after-glitch',
        step: 1,
        command: '!craftRecipe("furnace", 1)',
        message:
            'Action output:\nFailed to place crafting_table at (64, 57, -16).\n!!Code threw exception!!\nError: Error: Recipe requires craftingTable, but one was not supplied.',
        task,
        dependency_context: glitch_context,
      }),
      make_record({
        task_id: 'task-resource-after-glitch',
        step: 2,
        command: '!craftRecipe("furnace", 1)',
        message:
            'Action output:\nFailed to place crafting_table at (64, 59, -16).\n!!Code threw exception!!\nError: Error: Recipe requires craftingTable, but one was not supplied.',
        task,
        dependency_context: glitch_context,
      }),
      make_record({
        task_id: 'task-resource-after-glitch',
        step: 3,
        command: '!craftRecipe("furnace", 1)',
        success: true,
        message:
            'Action output:\nYou do not have the resources to craft a furnace. It requires: cobblestone: 8.',
        task,
        dependency_context: missing_resource_context,
      }),
    ]);

    expect(events).toHaveLength(3);
    expect(events[0].status).toBe('suppressed_transient');
    expect(events[1].status).toBe('suppressed_transient');
    expect(events[2].dependency_kind).toBe('resource');
    expect(events[2].status).toBe('confirmed_missing');
  });

  it('suppresses the archived hot_stuff crafting-table false positive after immediate local recovery', () => {
    const fixturePath = path.resolve(
        __dirname,
        '../../timing_experiments/5_12/baseline_andy/seed_50873/hot_stuff/agent_artifacts/andy/histories/5-11-2026_10-44-20PM.json');
    const history = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const events = analyzeTrustedDependencyRecords([
      make_record({
        task_id: null,
        step: 'h1',
        command: '!craftRecipe("furnace", 1)',
        message: history[0].content,
      }),
      make_record({
        task_id: null,
        step: 'h2',
        command: extract_command(history[1].content),
        success: true,
        message: history[2].content,
      }),
      make_record({
        task_id: null,
        step: 'h3',
        command: extract_command(history[3].content),
        success: true,
        message: history[4].content,
      }),
      make_record({
        task_id: null,
        step: 'h4',
        command: extract_command(history[5].content),
        success: true,
        message: history[6].content,
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].dependency_kind).toBe('workstation');
    expect(events[0].status).toBe('suppressed_transient');
  });

  it('confirms the archived stone tool shortage when the required pickaxe is absent', () => {
    const fixturePath = path.resolve(
        __dirname,
        '../../timing_experiments/5_12/baseline_andy/seed_50873/acquire_hardware/agent_artifacts/andy/histories/5-11-2026_10-27-00PM.json');
    const history = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const assistant = find_assistant_with(history, '!collectBlocks("stone", 11)');
    const system = find_system_with(history, 'Don\'t have right tools to harvest stone.');
    const events = analyzeTrustedDependencyRecords([
      make_record({
        task_id: null,
        step: 'stone-shortage',
        command: extract_command(assistant.content),
        message: system.content,
        task: {target_item: 'cobblestone', action_type: 'collect'},
        dependency_context: make_context({
          tool: 'wooden_pickaxe',
          tool_in_inventory: false,
          tool_equipped: false,
        }),
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].dependency_kind).toBe('tool');
    expect(events[0].status).toBe('confirmed_missing');
  });

  it('confirms the archived missing-cobblestone furnace craft failure', () => {
    const fixturePath = path.resolve(
        __dirname,
        '../../timing_experiments/5_12/baseline_andy/seed_152896/acquire_hardware/agent_artifacts/andy/histories/5-11-2026_11-40-36PM.json');
    const history = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const assistant = find_assistant_with(history, '!craftRecipe("furnace", 1)');
    const system = find_system_with(
        history,
        'You do not have the resources to craft a furnace. It requires: cobblestone: 8.');
    const events = analyzeTrustedDependencyRecords([
      make_record({
        task_id: null,
        step: 'furnace-resource-shortage',
        command: extract_command(assistant.content),
        success: false,
        message: system.content,
        task: {target_item: 'furnace', action_type: 'craft'},
        dependency_context: make_context({
          workstation: 'crafting_table',
          workstation_in_inventory: true,
          craftable_now: false,
          crafting_inputs: [{item: 'cobblestone', qty: 8}],
          missing_inputs: [
            {item: 'cobblestone', required: 8, available: 1, missing: 7},
          ],
        }),
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].dependency_kind).toBe('resource');
    expect(events[0].status).toBe('confirmed_missing');
  });

  it('suppresses the furnace-placement false positive behind a no-furnace message when a furnace was already available', () => {
    const events = analyzeTrustedDependencyRecords([
      make_record({
        command: '!smelt_item("raw_iron", 1, "coal")',
        message:
            'Action output:\nFailed to place furnace at (-34, 49, -49).\nThere is no furnace nearby and you have no furnace.\n',
        task: {target_item: 'iron_ingot', action_type: 'smelt'},
        dependency_context: make_context({
          workstation: 'furnace',
          workstation_in_inventory: true,
          workstation_nearby: false,
          fuel_inputs: [{item: 'coal', qty: 1}],
          smelting_inputs: [{item: 'raw_iron', qty: 1}],
        }),
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].dependency_kind).toBe('workstation');
    expect(events[0].status).toBe('suppressed_transient');
  });
});
