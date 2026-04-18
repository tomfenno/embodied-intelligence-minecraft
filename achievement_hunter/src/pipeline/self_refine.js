import { extract_json } from './json_utils.js';
import {
  fill_ptd_prompt,
  fill_ptd_feedback_prompt,
  fill_ptd_refinement_prompt,
  fill_scsg_prompt,
  fill_scsg_feedback_prompt,
  fill_scsg_refiner_prompt,
} from './prompt_utils.js';

/**
 * Runs Self-Refine for the PTD (Prerequisite Task DAG) pipeline.
 *
 * @param {object} model     - Model instance with sendRequest.
 * @param {string} objective - The Minecraft objective string.
 * @param {number} [n=3]
 * @param {boolean} [verbose=false]
 * @returns {{ finalResult: string, transcript: Array, totalRounds: number }}
 */
export async function ptd_self_refine(model, objective, n = 3, verbose = false) {
  return _send_refined_request(
      model,
      fill_ptd_prompt(objective),
      (answer) => fill_ptd_feedback_prompt(objective, answer),
      (answer, feedback) => fill_ptd_refinement_prompt(objective, answer, feedback),
      n,
      verbose,
  );
}

/**
 * Runs Self-Refine for the SCSG (Subgraph) pipeline.
 *
 * @param {object} model  - Model instance with sendRequest.
 * @param {object} graph  - The PTD graph object.
 * @param {object} state  - The current bot state object.
 * @param {number} [n=3]
 * @param {boolean} [verbose=false]
 * @returns {{ finalResult: string, transcript: Array, totalRounds: number }}
 */
export async function scsg_self_refine(model, graph, state, n = 3, verbose = false) {
  const taskPrompt = fill_scsg_prompt(graph, state);
  return _send_refined_request(
      model,
      taskPrompt,
      (answer) => fill_scsg_feedback_prompt(taskPrompt, answer),
      (answer, feedback) => fill_scsg_refiner_prompt(taskPrompt, answer, feedback),
      n,
      verbose,
  );
}

/**
 * Core Self-Refine loop. Generates an initial answer, then iterates through
 * up to n rounds of feedback + refinement. Exits early when the feedback
 * contains a {"verdict":"pass"} signal.
 *
 * Each phase is a fresh, independent model call — all context is embedded
 * in the filled prompt, not accumulated as conversation turns.
 *
 * @param {object}   model          - Any model instance with sendRequest(turns, systemMessage).
 * @param {string}   taskPrompt     - Filled system prompt for the initial generation.
 * @param {Function} feedbackPrompt - (answer) => string — critique prompt for a candidate.
 * @param {Function} refinePrompt   - (answer, feedback) => string — refinement prompt.
 * @param {number}   [n=3]          - Maximum critique/refine rounds.
 * @param {boolean}  [verbose=false]
 * @returns {{ finalResult: string, transcript: Array, totalRounds: number }}
 */
async function _send_refined_request(
    model, taskPrompt, feedbackPrompt, refinePrompt, n = 3, verbose = false) {
  const log = verbose ? console.log.bind(console) : () => {};
  const transcript = [];

  log('Generating initial response...');
  let r = await model.sendRequest([], taskPrompt);
  transcript.push({stage: 'Initial Generation', content: r});

  for (let i = 0; i < n; i++) {
    log(`Starting Feedback Round ${i + 1}...`);

    // 1. Feedback Phase — fresh request with candidate embedded in the prompt
    const feedback = await model.sendRequest([], feedbackPrompt(r));
    transcript.push({stage: `Feedback Round ${i + 1}`, content: feedback});

    log(`Starting Refinement Round ${i + 1}...`);

    // 2. Refinement Phase — fresh request with candidate + feedback embedded
    const refined = await model.sendRequest([], refinePrompt(r, feedback));
    transcript.push({stage: `Refined Output Round ${i + 1}`, content: refined});

    const verdict_obj = extract_json(feedback);
    if (verdict_obj?.verdict?.toLowerCase() === 'pass') {
      log(`Refinement passed after ${i + 1} rounds.`);
      return {finalResult: refined, transcript, totalRounds: i + 1};
    }

    r = refined;
  }

  log('Max refinement rounds reached.');
  return {finalResult: r, transcript, totalRounds: n};
}

