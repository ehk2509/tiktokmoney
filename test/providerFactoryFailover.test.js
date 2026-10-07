import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLlmProvider,
  createRealismQcProvider,
  createDialogueQcProvider,
  createVoiceProvider,
} from '../src/providers/providerFactory.js';

test('LLM fallback group preserves default primary model and becomes reliability-aware', () => {
  const llm = createLlmProvider({
    LLM_PROVIDER: 'openai',
    OPENAI_API_KEY: 'test-key',
    LLM_FALLBACK_MODELS: 'fallback-model',
  });

  assert.equal(llm.model, 'gpt-5.6-luna');
  assert.equal(typeof llm.reliabilitySnapshot, 'function');
});

test('realism QC fallback group preserves fail-closed QC settings', () => {
  const qc = createRealismQcProvider({
    REALISM_QC_ENABLED: 'true',
    OPENROUTER_API_KEY: 'test-key',
    REALISM_QC_MODEL: 'primary-qc',
    REALISM_QC_FALLBACK_MODELS: 'backup-qc',
    REALISM_QC_FAIL_CLOSED: 'true',
    REALISM_MAX_REGENERATIONS: '2',
  });

  assert.equal(qc.model, 'primary-qc');
  assert.equal(qc.failClosed, true);
  assert.equal(qc.maxRegenerations, 2);
  assert.equal(typeof qc.reliabilitySnapshot, 'function');
});

test('dialogue QC fallback group preserves default transcription model', () => {
  const qc = createDialogueQcProvider({
    VIDEO_PIPELINE_MODE: 'audiovisual',
    DIALOGUE_QC_ENABLED: 'true',
    TRANSCRIPTION_API_KEY: 'test-key',
    TRANSCRIPTION_FALLBACK_MODELS: 'backup-transcribe',
  });

  assert.equal(qc.model, 'gpt-transcribe');
  assert.equal(typeof qc.reliabilitySnapshot, 'function');
});

test('voice fallback group remains real TTS and never falls back to null voice', () => {
  const voice = createVoiceProvider({
    ELEVENLABS_API_KEY: 'test-key',
    ELEVENLABS_VOICE_ID: 'voice-id',
    ELEVENLABS_FALLBACK_MODELS: 'eleven_turbo_v2',
  });

  assert.equal(voice.modelId, 'eleven_multilingual_v2');
  assert.equal(typeof voice.reliabilitySnapshot, 'function');
});
