import OpenAI from 'openai';

import {getKey, hasKey} from '../../../src/utils/keys.js';

/**
 * Thin OpenAI client for the Structured Prompting Loop.
 *
 * This is a single-turn, prompt-in / text-out interface with optional
 * streaming support for long-running generations like PTD.
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
   * Sends a single prompt to the model and returns the aggregated response
   * text. Returns null on error so callers can handle failure gracefully.
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

  /**
   * Streams a single prompt to the model and reports incremental text deltas.
   * Returns the aggregated final text, latency, and any error encountered.
   *
   * @param {string} prompt
   * @param {{on_text_delta?: function(string, string, object):
   *     (void|Promise<void>)}} [handlers]
   * @returns {Promise<{response: string|null, latency_ms: number, error:
   *     Error|null}>}
   */
  async stream_prompt(prompt, handlers = {}) {
    const model = this.model_name || 'gpt-4o-mini';
    const started_ms = Date.now();

    let full_text = '';

    try {
      console.log('[SPL] Awaiting streamed response from', model);

      const stream = await this.openai.responses.create({
        model,
        input: prompt,
        stream: true,
      });

      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          const delta = event.delta ?? '';
          if (!delta) continue;

          full_text += delta;

          if (handlers.on_text_delta) {
            await handlers.on_text_delta(delta, full_text, event);
          }
        } else if (
            event.type === 'response.completed' && !full_text &&
            event.response?.output_text) {
          full_text = event.response.output_text;
        }
      }

      console.log('[SPL] Stream complete.');
      return {
        response: full_text || null,
        latency_ms: Date.now() - started_ms,
        error: null,
      };
    } catch (err) {
      console.error('[SPL] Stream error:', err);
      return {
        response: full_text || null,
        latency_ms: Date.now() - started_ms,
        error: err,
      };
    }
  }
}