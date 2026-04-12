import OpenAI from 'openai';

import {getKey, hasKey} from '../../../src/utils/keys.js';

/**
 * Thin OpenAI client for the Structured Prompting Loop.
 *
 * Unlike the base GPT class (src/models/gpt.js), this is a single-turn,
 * prompt-in / text-out interface. There are no conversation turns, stop
 * sequences, vision requests, or embeddings.
 *
 * Each call sends the fully rendered prompt as the Responses API `input`
 * and returns the aggregated text output from `response.output_text`.
 */
export class SplGpt {
  constructor(model_name) {
    this.model_name = model_name;

    const config = {apiKey: getKey('OPENAI_API_KEY')};
    if (hasKey('OPENAI_ORG_ID')) {
      config.organization = getKey('OPENAI_ORG_ID');
    }

    this.openai = new OpenAI(config);
  }

  /**
   * Sends a single prompt to the model and returns the response text.
   * Returns null on error so callers can handle failure gracefully.
   *
   * @param {string} prompt
   * @returns {Promise<string|null>}
   */
  async send_prompt(prompt) {
    const model = this.model_name || 'gpt-4o-mini';

    try {
      console.log('[SPL] Awaiting response from', model);

      const response = await this.openai.responses.create({
        model,
        input: prompt,
      });

      console.log('[SPL] Received.');
      return response.output_text ?? null;
    } catch (err) {
      console.error('[SPL] Model error:', err);
      return null;
    }
  }
}