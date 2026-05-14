import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('../commands.js', () => ({}));

vi.mock('../../pipeline/checkpoint.js', () => ({
  loadCheckpoint: vi.fn(),
  clearCheckpoint: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../pipeline/llm_client.js', () => ({
  LlmClient: class MockLlmClient {},
}));

vi.mock('../../pipeline/structured_loop/loop.js', () => ({
  structured_loop: vi.fn(() => Promise.resolve()),
}));

vi.mock('../ah_modes.js', () => ({
  init_ah_modes: vi.fn(),
}));

vi.mock('../../../evaluation_harness/episode_runtime.js', () => ({
  recordEpisodeCompleted: vi.fn(),
}));

vi.mock('../../../../src/agent/agent.js', () => ({
  Agent: class MockAgent {
    async _setupEventHandlers(save_data, init_message) {
      this.base_setup_args = [save_data, init_message];
    }

    async handleMessage(source, message, max_responses = null) {
      this.base_handle_message_args = [source, message, max_responses];
      return 'base-handle-message';
    }

    cleanKill(msg = 'Killing agent process...', code = 1) {
      this.base_clean_kill_args = [msg, code];
    }

    killAll() {
      this.base_kill_all_calls = (this.base_kill_all_calls || 0) + 1;
    }
  },
}));

import {clearCheckpoint, loadCheckpoint} from '../../pipeline/checkpoint.js';
import {structured_loop} from '../../pipeline/structured_loop/loop.js';
import {AchievementAgent} from '../achievement_agent.js';

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function makeAgent(taskData = null, {stubLaunch = true} = {}) {
  const agent = new AchievementAgent();
  agent.task = taskData ? {data: taskData} : null;
  agent._init_spl_models = vi.fn();
  agent._silence_chat_listeners = vi.fn();
  if (stubLaunch) {
    agent._launch_spl = vi.fn();
  }
  agent.openChat = vi.fn();
  return agent;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AchievementAgent startup behavior', () => {
  it('resumes a checkpoint when its objective matches the current benchmark task', async () => {
    const matching_goal =
        'Smelt an Iron Ingot. Have an iron ingot in the inventory.';
    vi.mocked(loadCheckpoint).mockReturnValue({
      objective: matching_goal,
      graph: {nodes: []},
      saved_at: '2026-04-27T00:00:00.000Z',
    });
    const agent = makeAgent({
      type: 'inventory',
      goal: matching_goal,
    });

    await agent._setupEventHandlers(null, null);

    expect(agent._waiting_for_objective).toBe(false);
    expect(agent._launch_spl).toHaveBeenCalledWith(matching_goal, {nodes: []});
    expect(agent.openChat)
        .toHaveBeenCalledWith(`Resuming previous task: "${matching_goal}"`);
    expect(clearCheckpoint).not.toHaveBeenCalled();
  });

  it('discards a stale checkpoint whose objective does not match the current benchmark task',
     async () => {
       vi.mocked(loadCheckpoint).mockReturnValue({
         objective: 'Fill a Bucket with lava. Have a lava bucket in the inventory.',
         graph: {nodes: []},
         saved_at: '2026-04-27T00:00:00.000Z',
       });
       const current_goal =
           'Smelt an Iron Ingot. Have an iron ingot in the inventory.';
       const agent = makeAgent({type: 'inventory', goal: current_goal});

       await agent._setupEventHandlers(null, null);

       // Stale checkpoint should be discarded, and the agent should
       // launch the current benchmark goal instead of the stale one.
       expect(clearCheckpoint).toHaveBeenCalledOnce();
       expect(agent._launch_spl).toHaveBeenCalledWith(current_goal);
       expect(agent.openChat).not.toHaveBeenCalledWith(
           expect.stringContaining('Resuming previous task'));
     });

  it('resumes a checkpoint in non-benchmark (manual) mode without objective check',
     async () => {
       vi.mocked(loadCheckpoint).mockReturnValue({
         objective: 'Some manually-set objective',
         graph: {nodes: []},
         saved_at: '2026-04-27T00:00:00.000Z',
       });
       // No task data → non-benchmark mode. Resume regardless of objective.
       const agent = makeAgent(null);

       await agent._setupEventHandlers(null, null);

       expect(agent._waiting_for_objective).toBe(false);
       expect(agent._launch_spl)
           .toHaveBeenCalledWith('Some manually-set objective', {nodes: []});
       expect(clearCheckpoint).not.toHaveBeenCalled();
     });

  it('auto-starts SPL from the attached benchmark inventory goal', async () => {
    vi.mocked(loadCheckpoint).mockReturnValue(null);
    const agent = makeAgent({
      type: 'inventory',
      goal: 'Acquire a diamond. Have a diamond in the inventory.',
    });

    await agent._setupEventHandlers(null, null);

    expect(agent._waiting_for_objective).toBe(false);
    expect(agent._launch_spl)
        .toHaveBeenCalledWith('Acquire a diamond. Have a diamond in the inventory.');
    expect(agent.openChat).not.toHaveBeenCalledWith(
        'Achievement Hunter ready! Send me an objective to begin.');
  });

  it('stays in manual ready mode when no task is attached and accepts chat objectives', async () => {
    vi.mocked(loadCheckpoint).mockReturnValue(null);
    const agent = makeAgent();

    await agent._setupEventHandlers(null, null);

    expect(agent._waiting_for_objective).toBe(true);
    expect(agent.openChat)
        .toHaveBeenCalledWith('Achievement Hunter ready! Send me an objective to begin.');

    const handled = await agent.handleMessage('ADMIN', 'Craft a stone pickaxe');
    expect(handled).toBe(true);
    expect(agent._waiting_for_objective).toBe(false);
    expect(agent._launch_spl).toHaveBeenCalledWith('Craft a stone pickaxe');
  });
});

describe('AchievementAgent benchmark and manual completion behavior', () => {
  it('requests benchmark shutdown instead of reopening manual objective mode', async () => {
    const agent = makeAgent({
      type: 'inventory',
      goal: 'Acquire a diamond. Have a diamond in the inventory.',
    }, {stubLaunch: false});
    agent._benchmark_task_mode = true;
    agent.checkTaskDone = vi.fn(async () => true);

    agent._launch_spl('Acquire a diamond. Have a diamond in the inventory.');
    await flushPromises();

    expect(vi.mocked(structured_loop)).toHaveBeenCalled();
    expect(agent.checkTaskDone).toHaveBeenCalledTimes(1);
    expect(agent.openChat).not.toHaveBeenCalledWith(
        'Task complete! Send me a new objective.');
  });

  it('keeps the manual completion prompt for chat-driven objectives', async () => {
    const agent = makeAgent(null, {stubLaunch: false});
    agent._benchmark_task_mode = false;
    agent.checkTaskDone = vi.fn();

    agent._launch_spl('Craft a stone pickaxe');
    await flushPromises();

    expect(agent.checkTaskDone).not.toHaveBeenCalled();
    expect(agent.openChat)
        .toHaveBeenCalledWith('Task complete! Send me a new objective.');
  });

  it('marks benchmark disconnects as handled before delegating shutdown', () => {
    const agent = makeAgent({
      type: 'inventory',
      goal: 'Acquire a diamond. Have a diamond in the inventory.',
    });
    agent._benchmark_task_mode = true;
    agent._disconnectHandled = false;

    agent.killAll();
    agent.killAll();

    expect(agent._disconnectHandled).toBe(true);
    expect(agent.base_kill_all_calls).toBe(1);
  });
});
