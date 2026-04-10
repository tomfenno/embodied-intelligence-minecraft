/**
 * Implements the Self-Refine LLM algorithm with Transcript Logging.
 *
 * @param {object} model - Any model instance with a sendRequest(turns,
 *     systemMessage) method (e.g. GPT, Claude, Gemini).
 * @param {Array}  turns          - Conversation turns to seed the request.
 * @param {string} critiquePrompt - System message used when critiquing a response.
 * @param {string} refinePrompt  - System message used when refining a response.
 * @param {number} [n=3] - Maximum number of critique/refine rounds.
 * @returns {{ finalResult: string, transcript: Array, totalRounds: number }}
 */
export async function sendRefinedRequest(
    model, turns, critiquePrompt, refinePrompt, n = 3, verbose = false) {
  const log = verbose ? console.log.bind(console) : () => {};
  let transcript = [];

  log('Generating initial response...');
  let r = await model.sendRequest(turns);
  transcript.push({stage: 'Initial Generation', content: r});

  for (let i = 0; i < n; i++) {
    log(`Starting Critique Round ${i + 1}...`);

    // 1. Critique Phase
    const feedbackTurns = [
      ...turns,
      {role: 'assistant', content: r},
    ];
    let feedback = await model.sendRequest(feedbackTurns, critiquePrompt);

    transcript.push({stage: `Critique Round ${i + 1}`, content: feedback});

    log(`Starting Refinement Round ${i + 1}...`);

    // 2. Refinement Phase
    const refineTurns = [
      ...feedbackTurns,
      {role: 'assistant', content: feedback},
    ];
    const refined = await model.sendRequest(refineTurns, refinePrompt);

    transcript.push({stage: `Refined Output Round ${i + 1}`, content: refined});

    // Check for pass condition after refining. DogNamedMud's validator outputs
    // {"verdict": "pass"}
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
