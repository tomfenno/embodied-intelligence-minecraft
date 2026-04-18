import { describe, it, expect, vi } from 'vitest';

import {
  ptd_self_refine,
  scsg_self_refine,
} from '../self_refine.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a mock model whose sendRequest resolves each call with the next
 * string in the responses array (cycling if exhausted).
 */
function make_model(responses) {
  let i = 0;
  return {
    sendRequest: vi.fn(async () => responses[i++ % responses.length]),
  };
}

const PASS_VERDICT    = '{"verdict":"pass"}';
const PASS_VERDICT_SP = '{"verdict": "pass"}';        // space after colon — current passing case
const FAIL_VERDICT    = '{"verdict":"fail","issues":["missing oak_log"]}';
const INITIAL_ANSWER  = '{"vertices":[],"edges":[]}';
const REFINED_ANSWER  = '{"vertices":[{"id":"oak_log","qty":4}],"edges":[]}';

// ── ptd_self_refine (smoke test) ─────────────────────────────────────────────

describe('ptd_self_refine', () => {
  it('calls sendRequest at least once with a non-empty string', async () => {
    const model = make_model([INITIAL_ANSWER, PASS_VERDICT, REFINED_ANSWER]);
    await ptd_self_refine(model, 'craft a wooden pickaxe', 1);
    expect(model.sendRequest).toHaveBeenCalled();
    const [, systemMsg] = model.sendRequest.mock.calls[0];
    expect(typeof systemMsg).toBe('string');
    expect(systemMsg.length).toBeGreaterThan(0);
  });

  it('embeds the objective in the initial prompt', async () => {
    const model = make_model([INITIAL_ANSWER, PASS_VERDICT, REFINED_ANSWER]);
    const objective = 'craft a golden helmet';
    await ptd_self_refine(model, objective, 1);
    const [, systemMsg] = model.sendRequest.mock.calls[0];
    expect(systemMsg).toContain(objective);
  });

  it('returns finalResult and transcript', async () => {
    const model = make_model([INITIAL_ANSWER, PASS_VERDICT, REFINED_ANSWER]);
    const result = await ptd_self_refine(model, 'mine 10 diamonds', 1);
    expect(result).toHaveProperty('finalResult');
    expect(result).toHaveProperty('transcript');
    expect(result).toHaveProperty('totalRounds');
  });
});

// ── scsg_self_refine (smoke test) ─────────────────────────────────────────────

describe('scsg_self_refine', () => {
  const MOCK_GRAPH = {
    objective: 'craft diamond sword',
    sinks: ['diamond_sword'],
    vertices: [{ id: 'diamond_sword', qty: 1 }, { id: 'diamond', qty: 2 }],
    edges: [{ from: 'diamond', to: 'diamond_sword', qty: 2, consumed: true }],
  };
  const MOCK_STATE = { inventory: { diamond: 2 } };

  it('calls sendRequest at least once with a non-empty string', async () => {
    const model = make_model([INITIAL_ANSWER, PASS_VERDICT, REFINED_ANSWER]);
    await scsg_self_refine(model, MOCK_GRAPH, MOCK_STATE, 1);
    expect(model.sendRequest).toHaveBeenCalled();
    const [, systemMsg] = model.sendRequest.mock.calls[0];
    expect(typeof systemMsg).toBe('string');
    expect(systemMsg.length).toBeGreaterThan(0);
  });

  it('returns finalResult and transcript', async () => {
    const model = make_model([INITIAL_ANSWER, PASS_VERDICT, REFINED_ANSWER]);
    const result = await scsg_self_refine(model, MOCK_GRAPH, MOCK_STATE, 1);
    expect(result).toHaveProperty('finalResult');
    expect(result).toHaveProperty('transcript');
    expect(result).toHaveProperty('totalRounds');
  });
});
