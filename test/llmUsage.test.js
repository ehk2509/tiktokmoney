import test from 'node:test';
import assert from 'node:assert/strict';

import { OpenAICompatibleLlmProvider } from '../src/providers/openaiCompatibleLlmProvider.js';

test('OpenAI-compatible LLM responses retain token/cost usage provenance', async () => {
  const provider = new OpenAICompatibleLlmProvider({
    apiKey: 'test-key',
    baseUrl: 'https://llm.example/v1',
    model: 'test-model',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          id: 'chatcmpl-1',
          model: 'test-model',
          choices: [{
            message: {
              content: JSON.stringify({
                hook: 'A meaningful hook for this test.',
                body: ['First point.', 'Second point.'],
                payoff: 'The answer.',
                cta: 'Follow for more.',
              }),
            },
          }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 40,
            total_tokens: 140,
            cost: 0.021,
          },
        };
      },
    }),
  });

  const script = await provider.generateStructuredScript({
    topic: 'Test topic',
    audience: 'testers',
    durationSeconds: 30,
  });

  assert.equal(script.providerUsage.provider, 'openai-compatible');
  assert.equal(script.providerUsage.operation, 'llm-completion');
  assert.equal(script.providerUsage.model, 'test-model');
  assert.equal(script.providerUsage.costUsd, 0.021);
  assert.equal(script.providerUsage.promptTokens, 100);
  assert.equal(script.providerUsage.completionTokens, 40);
  assert.equal(script.providerUsage.totalTokens, 140);
});
