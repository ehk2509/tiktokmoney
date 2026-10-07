import test from 'node:test';
import assert from 'node:assert/strict';

import { EquivalentProviderRouter } from '../src/providers/equivalentProviderRouter.js';

function statsRecorder() {
  const records = [];
  return {
    records,
    async record(id, outcome) {
      records.push({ id, outcome: structuredClone(outcome) });
    },
  };
}

test('equivalent router falls through after transport failure', async () => {
  const stats = statsRecorder();
  const router = new EquivalentProviderRouter({
    capability: 'llm',
    providers: [
      {
        id: 'llm:primary',
        provider: {
          async generateStructuredScript() {
            const error = new Error('429 rate limit');
            error.status = 429;
            throw error;
          },
        },
      },
      {
        id: 'llm:fallback',
        provider: {
          async generateStructuredScript() {
            return { hook: 'ok' };
          },
        },
      },
    ],
    statsStore: stats,
    reliabilityService: {
      async state(id) {
        return { providerId: id, state: 'CLOSED', reasons: [] };
      },
    },
  });

  const result = await router.generateStructuredScript({ topic: 'x' });
  assert.equal(result.hook, 'ok');
  assert.equal(result.providerRouting.providerId, 'llm:fallback');
  assert.equal(stats.records[0].id, 'llm:primary');
  assert.equal(stats.records[0].outcome.generationFailed, true);
  assert.equal(stats.records[0].outcome.throttled, true);
  assert.equal(stats.records[1].id, 'llm:fallback');
  assert.equal(stats.records[1].outcome.generationFailed, false);
});

test('QC rejection is treated as successful provider execution, not infrastructure failure', async () => {
  const stats = statsRecorder();
  const router = new EquivalentProviderRouter({
    capability: 'qc:realism',
    providers: [{
      id: 'qc:realism:model-a',
      provider: {
        threshold: 80,
        maxRegenerations: 2,
        async evaluateScene() {
          return {
            passed: false,
            overallScore: 42,
            issues: [{ code: 'artifact', severity: 'high' }],
          };
        },
      },
    }],
    statsStore: stats,
    reliabilityService: {
      async state(id) {
        return { providerId: id, state: 'CLOSED', reasons: [] };
      },
    },
  });

  const result = await router.evaluateScene({}, {});
  assert.equal(result.passed, false);
  assert.equal(result.providerRouting.providerId, 'qc:realism:model-a');
  assert.equal(stats.records.length, 1);
  assert.equal(stats.records[0].outcome.generationFailed, false);
  assert.equal(stats.records[0].outcome.passed, true);
});

test('OPEN equivalent is skipped and healthy equivalent handles the call', async () => {
  const called = [];
  const router = new EquivalentProviderRouter({
    capability: 'voice',
    providers: [
      {
        id: 'voice:a',
        provider: {
          async synthesize() {
            called.push('a');
            return { localPath: 'a.mp3' };
          },
        },
      },
      {
        id: 'voice:b',
        provider: {
          async synthesize() {
            called.push('b');
            return { localPath: 'b.mp3' };
          },
        },
      },
    ],
    reliabilityService: {
      async state(id) {
        return id === 'voice:a'
          ? { providerId: id, state: 'OPEN', reasons: ['failure-rate'] }
          : { providerId: id, state: 'CLOSED', reasons: [] };
      },
    },
  });

  const result = await router.synthesize({ text: 'hello' });
  assert.equal(result.localPath, 'b.mp3');
  assert.deepEqual(called, ['b']);
});

test('router fails closed when every equivalent is unavailable', async () => {
  const router = new EquivalentProviderRouter({
    capability: 'qc:transcription',
    providers: [
      { id: 'qc:a', provider: { async evaluate() { return {}; } } },
      { id: 'qc:b', provider: { async evaluate() { return {}; } } },
    ],
    reliabilityService: {
      async state(id) {
        return { providerId: id, state: 'OPEN', reasons: ['throttle-rate'] };
      },
    },
  });

  await assert.rejects(
    () => router.evaluate({}, {}),
    /all equivalent qc:transcription providers are unavailable/,
  );
});
