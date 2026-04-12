import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock heavy dependencies before importing structured_loop
vi.mock('../../../../src/agent/commands/index.js', () => ({
  executeCommand: vi.fn(),
}));
vi.mock('../state.js', () => ({
  get_state: vi.fn(),
  get_inventory_state: vi.fn(),
}));
vi.mock('../prompt_utils.js', () => ({
  fill_ptd_prompt: vi.fn(),
  fill_next_task_selector_prompt: vi.fn(),
  fill_action_mediator_prompt: vi.fn(() => 'am-prompt'),
}));
vi.mock('../rollout_logger.js', () => ({
  createRolloutLogger: vi.fn(() => ({
    ptd: vi.fn(), scsg: vi.fn(), nts: vi.fn(), am: vi.fn(), complete: vi.fn(),
  })),
}));
vi.mock('../checkpoint.js', () => ({
  saveCheckpoint: vi.fn(),
  clearCheckpoint: vi.fn(),
}));
vi.mock('../scsg.js', () => ({ compute_scsg: vi.fn() }));
vi.mock('../graph_utils.js', () => ({ enrich_subgraph: vi.fn() }));
vi.mock('../json_utils.js', () => ({ extract_json: vi.fn() }));

import { executeCommand } from '../../../../src/agent/commands/index.js';
import { get_state } from '../state.js';
import { fill_action_mediator_prompt } from '../prompt_utils.js';
import { extract_json } from '../json_utils.js';
import {
  is_entity_target,
  check_search_complete,
  make_search_command,
  run_expanded_search_tasks,
} from '../structured_loop.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

const make_search_task = (targets) => ({
  action_type: 'search',
  parameters: { targets: targets.map(t => ({ target: t, match_mode: 'concrete' })) },
  rationale: 'test',
});

const make_log = () => ({ am: vi.fn(), ptd: vi.fn(), scsg: vi.fn(), nts: vi.fn(), complete: vi.fn() });

const make_model = (responses = []) => {
  let i = 0;
  return { sendRequest: vi.fn(() => Promise.resolve(responses[i++] ?? '')) };
};

const EMPTY_STATE = {
  nearby_blocks: [],
  nearby_entities: { mobs: {} },
};

// ── is_entity_target ──────────────────────────────────────────────────────────

describe('is_entity_target', () => {
  it('returns true for known hostile mobs', () => {
    expect(is_entity_target('skeleton')).toBe(true);
    expect(is_entity_target('zombie')).toBe(true);
    expect(is_entity_target('creeper')).toBe(true);
    expect(is_entity_target('spider')).toBe(true);
    expect(is_entity_target('enderman')).toBe(true);
    expect(is_entity_target('blaze')).toBe(true);
    expect(is_entity_target('ghast')).toBe(true);
  });

  it('returns true for known passive mobs', () => {
    expect(is_entity_target('cow')).toBe(true);
    expect(is_entity_target('sheep')).toBe(true);
    expect(is_entity_target('pig')).toBe(true);
    expect(is_entity_target('chicken')).toBe(true);
    expect(is_entity_target('rabbit')).toBe(true);
  });

  it('returns false for block targets', () => {
    expect(is_entity_target('oak_log')).toBe(false);
    expect(is_entity_target('iron_ore')).toBe(false);
    expect(is_entity_target('water')).toBe(false);
    expect(is_entity_target('stone')).toBe(false);
  });

  it('returns false for item names that are not mobs', () => {
    expect(is_entity_target('bone')).toBe(false);
    expect(is_entity_target('arrow')).toBe(false);
    expect(is_entity_target('leather')).toBe(false);
  });
});

// ── check_search_complete ─────────────────────────────────────────────────────

describe('check_search_complete', () => {
  it('returns true when a block target is in nearby_blocks', () => {
    const state = { nearby_blocks: ['oak_log', 'stone'], nearby_entities: { mobs: {} } };
    expect(check_search_complete('oak_log', state)).toBe(true);
  });

  it('returns false when a block target is absent from nearby_blocks', () => {
    const state = { nearby_blocks: ['stone'], nearby_entities: { mobs: {} } };
    expect(check_search_complete('oak_log', state)).toBe(false);
  });

  it('returns true when an entity target has count > 0 in nearby_entities.mobs', () => {
    const state = { nearby_blocks: [], nearby_entities: { mobs: { skeleton: 2 } } };
    expect(check_search_complete('skeleton', state)).toBe(true);
  });

  it('returns false when an entity target is absent from nearby_entities.mobs', () => {
    expect(check_search_complete('skeleton', EMPTY_STATE)).toBe(false);
  });

  it('returns false when entity count is 0', () => {
    const state = { nearby_blocks: [], nearby_entities: { mobs: { skeleton: 0 } } };
    expect(check_search_complete('skeleton', state)).toBe(false);
  });

  it('handles missing nearby_blocks gracefully', () => {
    expect(check_search_complete('oak_log', {})).toBe(false);
  });

  it('handles missing nearby_entities gracefully', () => {
    expect(check_search_complete('skeleton', {})).toBe(false);
  });
});

// ── make_search_command ───────────────────────────────────────────────────────

describe('make_search_command', () => {
  it('returns !searchForBlock for block targets', () => {
    expect(make_search_command('oak_log', 32)).toBe('!searchForBlock("oak_log", 32)');
    expect(make_search_command('iron_ore', 64)).toBe('!searchForBlock("iron_ore", 64)');
    expect(make_search_command('water', 128)).toBe('!searchForBlock("water", 128)');
  });

  it('returns !searchForEntity for entity targets', () => {
    expect(make_search_command('skeleton', 32)).toBe('!searchForEntity("skeleton", 32)');
    expect(make_search_command('cow', 64)).toBe('!searchForEntity("cow", 64)');
  });

  it('encodes the radius as a number, not a string', () => {
    const cmd = make_search_command('oak_log', 32);
    expect(cmd).toBe('!searchForBlock("oak_log", 32)');
    expect(cmd).not.toContain('"32"');
  });
});

// ── run_expanded_search_tasks ─────────────────────────────────────────────────

describe('run_expanded_search_tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get_state.mockReturnValue(EMPTY_STATE);
    extract_json.mockReturnValue(null); // no TASK_COMPLETE by default
  });

  it('returns success immediately when target is already in nearby_blocks', async () => {
    get_state.mockReturnValue({ nearby_blocks: ['oak_log'], nearby_entities: { mobs: {} } });
    const task = make_search_task(['oak_log']);
    const result = await run_expanded_search_tasks(make_model(), task, {}, make_log());
    expect(result).toBe('success');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('returns success immediately when entity target is already nearby', async () => {
    get_state.mockReturnValue({ nearby_blocks: [], nearby_entities: { mobs: { skeleton: 1 } } });
    const task = make_search_task(['skeleton']);
    const result = await run_expanded_search_tasks(make_model(), task, {}, make_log());
    expect(result).toBe('success');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('uses !searchForBlock for block targets', async () => {
    executeCommand.mockResolvedValue('Action output:\nFound oak_log at (1, 64, 1). Navigating...');
    const task = make_search_task(['oak_log']);
    await run_expanded_search_tasks(make_model(), task, {}, make_log());
    expect(executeCommand).toHaveBeenCalledWith({}, '!searchForBlock("oak_log", 32)');
  });

  it('uses !searchForEntity for entity targets', async () => {
    executeCommand.mockResolvedValue('Action output:\nFound skeleton at (1, 64, 1). Navigating...');
    const task = make_search_task(['skeleton']);
    await run_expanded_search_tasks(make_model(), task, {}, make_log());
    expect(executeCommand).toHaveBeenCalledWith({}, '!searchForEntity("skeleton", 32)');
  });

  it('returns success when action output contains no "Could not find"', async () => {
    executeCommand.mockResolvedValue('Action output:\nFound oak_log at (5, 64, 3). Navigating...');
    const task = make_search_task(['oak_log']);
    const result = await run_expanded_search_tasks(make_model(), task, {}, make_log());
    expect(result).toBe('success');
  });

  it('returns success when executeCommand returns undefined (interrupted)', async () => {
    executeCommand.mockResolvedValue(undefined);
    const task = make_search_task(['oak_log']);
    const result = await run_expanded_search_tasks(make_model(), task, {}, make_log());
    expect(result).toBe('success');
  });

  it('continues to next radius when block not found', async () => {
    executeCommand
      .mockResolvedValueOnce('Action output:\nCould not find any oak_log in 32 blocks.')
      .mockResolvedValue('Action output:\nFound oak_log at (50, 64, 50). Navigating...');
    const task = make_search_task(['oak_log']);
    const result = await run_expanded_search_tasks(make_model(), task, {}, make_log());
    expect(result).toBe('success');
    expect(executeCommand).toHaveBeenCalledTimes(2);
    expect(executeCommand).toHaveBeenNthCalledWith(1, {}, '!searchForBlock("oak_log", 32)');
    expect(executeCommand).toHaveBeenNthCalledWith(2, {}, '!searchForBlock("oak_log", 64)');
  });

  it('returns fail when all radii are exhausted without finding the target', async () => {
    executeCommand.mockResolvedValue('Action output:\nCould not find any oak_log in 512 blocks.');
    const task = make_search_task(['oak_log']);
    const result = await run_expanded_search_tasks(make_model(), task, {}, make_log());
    expect(result).toBe('fail');
  });

  it('returns fail when task has no targets', async () => {
    const task = make_search_task([]);
    const result = await run_expanded_search_tasks(make_model(), task, {}, make_log());
    expect(result).toBe('fail');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('stops at first successful concrete item when any_log expands to multiple', async () => {
    // oak_log fails, spruce_log succeeds
    executeCommand
      .mockResolvedValueOnce('Action output:\nCould not find any oak_log in 32 blocks.')
      .mockResolvedValue('Action output:\nFound spruce_log at (10, 64, 10). Navigating...');
    const task = make_search_task(['any_log']);
    const result = await run_expanded_search_tasks(make_model(), task, {}, make_log());
    expect(result).toBe('success');
    expect(executeCommand).toHaveBeenCalledTimes(2);
    expect(executeCommand).toHaveBeenNthCalledWith(1, {}, '!searchForBlock("oak_log", 32)');
    expect(executeCommand).toHaveBeenNthCalledWith(2, {}, '!searchForBlock("spruce_log", 32)');
  });

  describe('AM fallback', () => {
    it('calls AM when executeCommand returns a non-action-output error', async () => {
      executeCommand
        .mockResolvedValueOnce('Command !searchForBlock was given invalid args.')
        .mockResolvedValue('Action output:\nFound oak_log at (1, 64, 1). Navigating...');
      const model = make_model(['!searchForBlock("oak_log", 32)']);
      fill_action_mediator_prompt.mockReturnValue('am-prompt');
      extract_json.mockReturnValue(null);

      const task = make_search_task(['oak_log']);
      const result = await run_expanded_search_tasks(model, task, {}, make_log());

      expect(model.sendRequest).toHaveBeenCalledOnce();
      expect(result).toBe('success');
    });

    it('returns success when AM signals TASK_COMPLETE in fallback', async () => {
      executeCommand.mockResolvedValueOnce('Command !searchForBlock was given invalid args.');
      const model = make_model(['{"status":"TASK_COMPLETE"}']);
      extract_json.mockReturnValue({ status: 'TASK_COMPLETE' });

      const task = make_search_task(['oak_log']);
      const result = await run_expanded_search_tasks(model, task, {}, make_log());

      expect(result).toBe('success');
      // executeCommand called once for hardcoded, not again for AM (TASK_COMPLETE short-circuits)
      expect(executeCommand).toHaveBeenCalledTimes(1);
    });

    it('does not call AM for a normal "Could not find" failure', async () => {
      executeCommand.mockResolvedValue('Action output:\nCould not find any oak_log in 512 blocks.');
      const model = make_model();

      const task = make_search_task(['oak_log']);
      await run_expanded_search_tasks(model, task, {}, make_log());

      expect(model.sendRequest).not.toHaveBeenCalled();
    });
  });
});
