import { describe, it, expect, vi } from 'vitest';

import { generate_self_refined_ptd } from '../self_refine.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function make_model(responses) {
  let i = 0;
  return {
    send_prompt: vi.fn(async () => responses[i++ % responses.length]),
  };
}

function make_models(ptd_responses, feedback_responses, refinement_responses = null) {
  return {
    ptd: make_model(ptd_responses),
    ptd_feedback: make_model(feedback_responses),
    ptd_refinement: make_model(refinement_responses ?? ptd_responses),
  };
}

const VALID_GRAPH = JSON.stringify({
  objective: 'craft a wooden pickaxe',
  sinks: ['wooden_pickaxe'],
  vertices: [
    { id: 'wooden_pickaxe', qty: 1, item_type: 'item', acquisition_dependency: 'craft' },
    { id: 'oak_log', qty: 3, item_type: 'resource', acquisition_dependency: 'mine' },
  ],
  edges: [
    { from: 'oak_log', to: 'wooden_pickaxe', type: 'crafting_input', qty: 3, consumed: true },
  ],
});

const PASS_VERDICT = JSON.stringify({
  verdict: 'pass',
  definite_issues: [],
  possible_issues: [],
  summary: 'looks good',
});

const FAIL_VERDICT = JSON.stringify({
  verdict: 'fail',
  definite_issues: ['missing oak_log'],
  possible_issues: [],
  summary: 'incomplete graph',
});

const DEFAULT_OPTS = { max_rounds: 1, save_final_json: false };

// ── generate_self_refined_ptd ─────────────────────────────────────────────────

describe('generate_self_refined_ptd', () => {
  it('calls send_prompt at least once with a non-empty string', async () => {
    const models = make_models([VALID_GRAPH], [PASS_VERDICT]);
    await generate_self_refined_ptd(models, 'craft a wooden pickaxe', null, null, DEFAULT_OPTS);
    expect(models.ptd.send_prompt).toHaveBeenCalled();
    const [prompt] = models.ptd.send_prompt.mock.calls[0];
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('embeds the task name in the initial prompt', async () => {
    const models = make_models([VALID_GRAPH], [PASS_VERDICT]);
    const task_name = 'craft a golden helmet';
    await generate_self_refined_ptd(models, task_name, null, null, DEFAULT_OPTS);
    const [prompt] = models.ptd.send_prompt.mock.calls[0];
    expect(prompt).toContain(task_name);
  });

  it('returns ok:true with graph and trace when validator passes', async () => {
    const models = make_models([VALID_GRAPH], [PASS_VERDICT]);
    const result = await generate_self_refined_ptd(models, 'mine 10 diamonds', null, null, DEFAULT_OPTS);
    expect(result.ok).toBe(true);
    expect(result.graph).not.toBeNull();
    expect(typeof result.rounds_used).toBe('number');
    expect(Array.isArray(result.trace)).toBe(true);
    expect(result.failure_reason).toBeNull();
  });

  it('returns ok:false when validator always fails within max_rounds', async () => {
    const models = make_models([VALID_GRAPH, VALID_GRAPH], [FAIL_VERDICT, FAIL_VERDICT]);
    const result = await generate_self_refined_ptd(models, 'mine 10 diamonds', null, null, DEFAULT_OPTS);
    expect(result.ok).toBe(false);
    expect(result.graph).toBeNull();
    expect(typeof result.failure_reason).toBe('string');
  });

  it('skips generation and returns existing graph when one is provided', async () => {
    const existing = JSON.parse(VALID_GRAPH);
    const models = make_models([VALID_GRAPH], [PASS_VERDICT]);
    const result = await generate_self_refined_ptd(models, 'craft a wooden pickaxe', existing, null, DEFAULT_OPTS);
    expect(result.ok).toBe(true);
    expect(result.graph).toBe(existing);
    expect(models.ptd.send_prompt).not.toHaveBeenCalled();
  });
});
