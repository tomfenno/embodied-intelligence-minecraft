/**
 * Baseline tests for sendRefinedRequest, ptd_self_refine, scsg_self_refine.
 *
 * The model is mocked via a simple factory — no real LLM calls are made.
 * ptd_self_refine / scsg_self_refine read real template files from disk to
 * verify the prompt-fill pipeline is wired up correctly end-to-end.
 *
 * Known bug documented here (Issue #5 in refactoring report):
 *   The verdict check uses string matching instead of JSON parsing, so
 *   edge-case JSON formatting (e.g. spaces around the colon) causes the
 *   early-exit to be missed and unnecessary refinement rounds to run.
 *   The skipped test below will be unskipped after Phase 2d fixes this.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  sendRefinedRequest,
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

// ── sendRefinedRequest ────────────────────────────────────────────────────────

describe('sendRefinedRequest', () => {
  const taskPrompt     = 'generate a graph';
  const feedbackPrompt = (ans) => `critique: ${ans}`;
  const refinePrompt   = (ans, fb) => `refine: ${ans} with ${fb}`;

  it('returns the initial response when n=0', async () => {
    const model = make_model([INITIAL_ANSWER]);
    const result = await sendRefinedRequest(model, taskPrompt, feedbackPrompt, refinePrompt, 0);
    expect(result.finalResult).toBe(INITIAL_ANSWER);
    expect(result.totalRounds).toBe(0);
    expect(model.sendRequest).toHaveBeenCalledTimes(1);
  });

  it('runs exactly n rounds when verdict never passes', async () => {
    const n = 3;
    // responses: initial, then (feedback + refined) × n
    const model = make_model([INITIAL_ANSWER, FAIL_VERDICT, REFINED_ANSWER]);
    const result = await sendRefinedRequest(model, taskPrompt, feedbackPrompt, refinePrompt, n);
    expect(result.totalRounds).toBe(n);
    // 1 initial + 2 calls per round (feedback + refine) × n
    expect(model.sendRequest).toHaveBeenCalledTimes(1 + n * 2);
  });

  it('exits early when verdict is "pass" (no spaces)', async () => {
    // Round 1: feedback = pass → should stop after 1 round
    const model = make_model([INITIAL_ANSWER, PASS_VERDICT, REFINED_ANSWER]);
    const result = await sendRefinedRequest(model, taskPrompt, feedbackPrompt, refinePrompt, 3);
    expect(result.totalRounds).toBe(1);
    expect(model.sendRequest).toHaveBeenCalledTimes(3); // initial + feedback + refined
  });

  it('exits early when verdict is "pass" with space after colon', async () => {
    const model = make_model([INITIAL_ANSWER, PASS_VERDICT_SP, REFINED_ANSWER]);
    const result = await sendRefinedRequest(model, taskPrompt, feedbackPrompt, refinePrompt, 3);
    expect(result.totalRounds).toBe(1);
    expect(model.sendRequest).toHaveBeenCalledTimes(3);
  });

  it('returns the refined answer (not the feedback) as finalResult', async () => {
    const model = make_model([INITIAL_ANSWER, PASS_VERDICT, REFINED_ANSWER]);
    const result = await sendRefinedRequest(model, taskPrompt, feedbackPrompt, refinePrompt, 3);
    expect(result.finalResult).toBe(REFINED_ANSWER);
  });

  it('builds a transcript with one entry per stage', async () => {
    // 2 rounds of fail then pass: initial + (fb+ref)×2 = 5 entries
    const model = make_model([INITIAL_ANSWER, FAIL_VERDICT, REFINED_ANSWER, PASS_VERDICT, REFINED_ANSWER]);
    const result = await sendRefinedRequest(model, taskPrompt, feedbackPrompt, refinePrompt, 3);
    expect(result.transcript).toHaveLength(1 + result.totalRounds * 2);
  });

  it('transcript first entry is the initial generation', async () => {
    const model = make_model([INITIAL_ANSWER, PASS_VERDICT, REFINED_ANSWER]);
    const result = await sendRefinedRequest(model, taskPrompt, feedbackPrompt, refinePrompt, 3);
    expect(result.transcript[0].stage).toBe('Initial Generation');
    expect(result.transcript[0].content).toBe(INITIAL_ANSWER);
  });

  // ── Known bug: Issue #5 ──────────────────────────────────────────────────
  // The current implementation misses early-exit when the verdict JSON has
  // spaces around the colon (e.g. '"verdict" : "pass"').
  // Unskip this test after Phase 2d fixes the verdict check with extract_json.
  it('exits early when verdict has spaces around the colon', async () => {
    const PASS_VERDICT_EXTRA_SP = '{"verdict" : "pass"}';
    const model = make_model([INITIAL_ANSWER, PASS_VERDICT_EXTRA_SP, REFINED_ANSWER]);
    const result = await sendRefinedRequest(model, taskPrompt, feedbackPrompt, refinePrompt, 3);
    expect(result.totalRounds).toBe(1);
  });
});

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
