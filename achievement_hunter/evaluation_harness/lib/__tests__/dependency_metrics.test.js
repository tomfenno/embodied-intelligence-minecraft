import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {afterEach, describe, expect, it} from 'vitest';

import {collectDependencyMetrics} from '../dependency_metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = path.join(__dirname, '.tmp');

afterEach(() => {
  fs.rmSync(TMP_ROOT, {recursive: true, force: true});
});

function make_result_dir(name) {
  const resultDir = path.join(TMP_ROOT, name);
  fs.rmSync(resultDir, {recursive: true, force: true});
  fs.mkdirSync(resultDir, {recursive: true});
  return resultDir;
}

describe('collectDependencyMetrics', () => {
  it('leaves trusted metrics unavailable when only legacy history artifacts exist', () => {
    const resultDir = make_result_dir('history-only');
    const historyDir = path.join(resultDir, 'agent_artifacts', 'andy', 'histories');
    fs.mkdirSync(historyDir, {recursive: true});
    fs.writeFileSync(path.join(historyDir, 'sample.json'), JSON.stringify([
      {role: 'assistant', content: '!collectBlocks("stone", 11)'},
      {
        role: 'system',
        content: 'Action output:\nDon\'t have right tools to harvest stone.\n',
      },
    ], null, 2), 'utf8');

    const summary = collectDependencyMetrics(resultDir, {preferTaskTraces: false});

    expect(summary.dependencyFailures).toBe(1);
    expect(summary.trusted_dependency_available).toBe(false);
    expect(summary.trusted_dependency_failures).toBeNull();
    expect(summary.trusted?.available).toBe(false);
    expect(summary.trusted?.unavailable_reason).toBe('task_traces_unavailable');
  });

  it('populates trusted metrics when dependency_context is present in task traces', () => {
    const resultDir = make_result_dir('task-traces');
    const traceDir = path.join(resultDir, 'task_traces');
    fs.mkdirSync(traceDir, {recursive: true});
    const trace = {
      task: {
        target_item: 'furnace',
        qty: 1,
        action_type: 'craft',
        parameters: {
          crafting_inputs: [{item: 'cobblestone', qty: 8}],
          workstation: 'crafting_table',
        },
      },
      steps: [{
        i: 1,
        state: {},
        dependency_context: {
          required: {
            tool: null,
            workstation: 'crafting_table',
            crafting_inputs: [{item: 'cobblestone', qty: 8}],
            smelting_inputs: [],
            fuel_inputs: [],
          },
          availability: {
            tool_in_inventory: null,
            tool_equipped: null,
            workstation_in_inventory: true,
            workstation_nearby: false,
            craftable_now: false,
            missing_inputs: [
              {item: 'cobblestone', required: 8, available: 0, missing: 8},
            ],
            missing_fuel: [],
          },
        },
        action: '!craftRecipe("furnace", 1)',
        result: {
          success: true,
          kind: 'command_success',
          message:
              'Action output:\nYou do not have the resources to craft a furnace. It requires: cobblestone: 8.',
        },
      }],
    };
    fs.writeFileSync(
        path.join(traceDir, 'full_task_trace.jsonl'),
        `${JSON.stringify(trace)}\n`,
        'utf8');

    const summary = collectDependencyMetrics(resultDir, {preferTaskTraces: true});

    expect(summary.trusted_dependency_available).toBe(true);
    expect(summary.trusted_dependency_failures).toBe(1);
    expect(summary.trusted_dependency_total_commands).toBe(1);
    expect(summary.trusted_dependency_incidents).toBe(1);
    expect(summary.trusted_dependency_ambiguous_events).toBe(0);
    expect(summary.trusted?.available).toBe(true);
    expect(fs.existsSync(path.join(resultDir, 'trusted_dependency_events.jsonl')))
        .toBe(true);
    expect(fs.existsSync(path.join(resultDir, 'dependency_audit.md'))).toBe(true);
  });

  it('marks trusted metrics unavailable when task traces exist but dependency_context is missing', () => {
    const resultDir = make_result_dir('task-traces-missing-context');
    const traceDir = path.join(resultDir, 'task_traces');
    fs.mkdirSync(traceDir, {recursive: true});
    const trace = {
      task: {
        target_item: 'stone_pickaxe',
        qty: 1,
        action_type: 'craft',
        parameters: {crafting_inputs: [], workstation: 'crafting_table'},
      },
      steps: [{
        i: 1,
        state: {},
        action: '!craftRecipe("stone_pickaxe", 1)',
        result: {
          success: false,
          kind: 'command_failure',
          message: 'Action output:\nCrafting stone_pickaxe requires a crafting table.\n',
        },
      }],
    };
    fs.writeFileSync(
        path.join(traceDir, 'full_task_trace.jsonl'),
        `${JSON.stringify(trace)}\n`,
        'utf8');

    const summary = collectDependencyMetrics(resultDir, {preferTaskTraces: true});

    expect(summary.trusted_dependency_available).toBe(false);
    expect(summary.trusted_dependency_failures).toBeNull();
    expect(summary.trusted?.unavailable_reason)
        .toBe('dependency_context_unavailable');
  });
});
