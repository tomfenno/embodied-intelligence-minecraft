/**
 * Implements the Self-Refine LLM algorithm with Transcript Logging.
 *
 * Each phase is a fresh, independent model call — all context is embedded
 * in the filled prompt, not accumulated as conversation turns.
 *
 * @param {object}   model          - Any model instance with a
 *     sendRequest(turns, systemMessage) method (e.g. GPT, Claude, Gemini).
 * @param {string}   taskPrompt     - Filled system prompt for the initial
 *     generation (e.g. fill_ptd_prompt(objective)).
 * @param {Function} feedbackPrompt - Function (answer) => string that returns
 *     the filled feedback/critique system prompt for a given candidate answer.
 * @param {Function} refinePrompt   - Function (answer, feedback) => string that
 *     returns the filled refinement system prompt given a candidate and
 * feedback.
 * @param {number}   [n=3]         - Maximum number of critique/refine rounds.
 * @param {boolean}  [verbose=false]
 * @returns {{ finalResult: string, transcript: Array, totalRounds: number }}
 */
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
  return sendRefinedRequest(
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
export async function scsg_self_refine(
    model, graph, state, n = 3, verbose = false) {
  const taskPrompt = fill_scsg_prompt(graph, state);
  return sendRefinedRequest(
      model,
      taskPrompt,
      (answer) => fill_scsg_feedback_prompt(taskPrompt, answer),
      (answer, feedback) => fill_scsg_refiner_prompt(taskPrompt, answer, feedback),
      n,
      verbose,
  );
}

export async function sendRefinedRequest(
    model, taskPrompt, feedbackPrompt, refinePrompt, n = 3, verbose = false) {
  const log = verbose ? console.log.bind(console) : () => {};
  let transcript = [];

  log('Generating initial response...');
  let r = await model.sendRequest([], taskPrompt);
  transcript.push({stage: 'Initial Generation', content: r});

  for (let i = 0; i < n; i++) {
    log(`Starting Feedback Round ${i + 1}...`);

    // 1. Feedback Phase — fresh request with candidate embedded in the prompt
    let feedback = await model.sendRequest([], feedbackPrompt(r));
    transcript.push({stage: `Feedback Round ${i + 1}`, content: feedback});

    log(`Starting Refinement Round ${i + 1}...`);

    // 2. Refinement Phase — fresh request with candidate + feedback embedded
    const refined = await model.sendRequest([], refinePrompt(r, feedback));
    transcript.push({stage: `Refined Output Round ${i + 1}`, content: refined});

    if (feedback.toLowerCase().includes('"verdict":"pass"') ||
        feedback.toLowerCase().includes('"verdict": "pass"')) {
      log(`Refinement passed after ${i + 1} rounds.`);
      return {finalResult: refined, transcript, totalRounds: i + 1};
    }

    r = refined;
  }

  log('Max refinement rounds reached.');
  return {finalResult: r, transcript, totalRounds: n};
}
