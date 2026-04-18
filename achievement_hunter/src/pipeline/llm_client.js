import OpenAI from 'openai';

import {getKey, hasKey} from '../../../src/utils/keys.js';

export class LlmClient {
  constructor(model_name) {
    this.model_name = model_name;

    const config = {apiKey: getKey('OPENAI_API_KEY')};
    if (hasKey('OPENAI_ORG_ID')) {
      config.organization = getKey('OPENAI_ORG_ID');
    }

    this.openai = new OpenAI(config);
  }

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
