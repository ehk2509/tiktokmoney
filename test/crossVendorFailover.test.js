import test from 'node:test';
import assert from 'node:assert/strict';

import { OpenAiVoiceProvider } from '../src/providers/openAiVoiceProvider.js';
import {
  createLlmProvider,
  createRealismQcProvider,
  createVoiceProvider,
} from '../src/providers/providerFactory.js';

test('OpenAI voice provider writes real binary audio through the voice contract', async () => {
  let request = null;
  const files = [];
  const provider = new OpenAiVoiceProvider({
    apiKey: 'openai-key',
    baseUrl: 'https://api.openai.test/v1',
    modelId: 'tts-model',
    voice: 'alloy',
    outputDir: '/tmp',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async arrayBuffer() {
          return Uint8Array.from([1, 2, 3, 4]).buffer;
        },
      };
    },
  });

  const result = await provider.synthesize({
    text: 'hello world',
    projectId: 'vid-cross-vendor',
  });

  assert.equal(request.url, 'https://api.openai.test/v1/audio/speech');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'tts-model');
  assert.equal(body.voice, 'alloy');
  assert.equal(body.input, 'hello world');
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'tts-model');
  assert.match(result.localPath, /vid-cross-vendor\.voice\.openai\.mp3$/);
  assert.deepEqual(result.wordTimings, []);
});

test('OpenAI primary LLM can fail over to OpenRouter vendor models', () => {
  const llm = createLlmProvider({
    LLM_PROVIDER: 'openai',
    OPENAI_API_KEY: 'openai-key',
    LLM_MODEL: 'openai-primary',
    OPENROUTER_API_KEY: 'openrouter-key',
    OPENROUTER_LLM_FALLBACK_MODELS: 'anthropic/backup,google/backup',
  });

  assert.equal(llm.providers.length, 3);
  assert.deepEqual(
    llm.providers.map((entry) => entry.id),
    [
      'llm:openai:openai-primary',
      'llm:openrouter:anthropic/backup',
      'llm:openrouter:google/backup',
    ],
  );
  assert.equal(llm.providers[0].provider.providerName, 'openai');
  assert.equal(llm.providers[1].provider.providerName, 'openrouter');
});

test('OpenRouter primary LLM can fail over to OpenAI vendor models', () => {
  const llm = createLlmProvider({
    LLM_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'openrouter-key',
    OPENROUTER_LLM_MODEL: 'anthropic/primary',
    OPENAI_API_KEY: 'openai-key',
    OPENAI_LLM_FALLBACK_MODELS: 'openai-backup',
  });

  assert.deepEqual(
    llm.providers.map((entry) => entry.id),
    ['llm:openrouter:anthropic/primary', 'llm:openai:openai-backup'],
  );
});

test('realism QC can fail over across OpenRouter and OpenAI-compatible vendors', () => {
  const qc = createRealismQcProvider({
    REALISM_QC_ENABLED: 'true',
    REALISM_QC_MODEL: 'openrouter-primary',
    OPENROUTER_API_KEY: 'openrouter-key',
    OPENAI_API_KEY: 'openai-key',
    OPENAI_REALISM_QC_FALLBACK_MODELS: 'openai-vision-backup',
  });

  assert.deepEqual(
    qc.providers.map((entry) => entry.id),
    [
      'qc:realism:openrouter:openrouter-primary',
      'qc:realism:openai:openai-vision-backup',
    ],
  );
  assert.equal(qc.providers[0].provider.providerName, 'openrouter');
  assert.equal(qc.providers[1].provider.providerName, 'openai');
});

test('voice group crosses vendors instead of falling back to null voice', () => {
  const voice = createVoiceProvider({
    ELEVENLABS_API_KEY: 'eleven-key',
    ELEVENLABS_VOICE_ID: 'voice-id',
    ELEVENLABS_MODEL_ID: 'eleven-primary',
    OPENAI_API_KEY: 'openai-key',
    OPENAI_TTS_FALLBACK_ENABLED: 'true',
    OPENAI_TTS_MODEL: 'openai-tts',
    OPENAI_TTS_VOICE: 'alloy',
  });

  assert.deepEqual(
    voice.providers.map((entry) => entry.id),
    ['voice:elevenlabs:eleven-primary', 'voice:openai:openai-tts'],
  );
  assert.equal(voice.providers[1].provider.constructor.name, 'OpenAiVoiceProvider');
});
