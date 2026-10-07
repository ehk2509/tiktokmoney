import test from 'node:test';
import assert from 'node:assert/strict';

import { ProviderStatsStore } from '../src/storage/providerStatsStore.js';
import { ProviderReliabilityService } from '../src/services/providerReliabilityService.js';
import { VideoModelRouter } from '../src/providers/videoModelRouter.js';

function memoryStatsStore(initial = {}) {
  const data = structuredClone(initial);
  return {
    async get(id) {
      return data[id] || {
        attempts: 0,
        passes: 0,
        generationFailures: 0,
        throttles: 0,
        latencyMsTotal: 0,
        latencyCount: 0,
        maxLatencyMs: 0,
        estimatedSpendUsd: 0,
        recent: [],
        sceneClasses: {},
        updatedAt: null,
      };
    },
    async record(id, outcome) {
      const current = await this.get(id);
      current.attempts += 1;
      if (outcome.generationFailed) current.generationFailures += 1;
      if (outcome.throttled) current.throttles += 1;
      if (outcome.passed) current.passes += 1;
      if (Number.isFinite(Number(outcome.latencyMs))) {
        current.latencyMsTotal += Number(outcome.latencyMs);
        current.latencyCount += 1;
        current.maxLatencyMs = Math.max(current.maxLatencyMs, Number(outcome.latencyMs));
      }
      current.recent.push({
        at: new Date().toISOString(),
        generationFailed: Boolean(outcome.generationFailed),
        throttled: Boolean(outcome.throttled),
        passed: Boolean(outcome.passed),
        latencyMs: Number.isFinite(Number(outcome.latencyMs)) ? Number(outcome.latencyMs) : null,
      });
      current.recent = current.recent.slice(-100);
      current.updatedAt = new Date().toISOString();
      data[id] = current;
      return current;
    },
  };
}

test('provider reliability opens circuit on recent failure rate', async () => {
  const now = () => new Date('2026-10-07T12:00:00.000Z');
  const store = memoryStatsStore({
    runway: {
      attempts: 4,
      passes: 1,
      generationFailures: 3,
      throttles: 0,
      latencyMsTotal: 4000,
      latencyCount: 4,
      maxLatencyMs: 1000,
      estimatedSpendUsd: 0,
      recent: [
        { generationFailed: true, throttled: false, latencyMs: 1000 },
        { generationFailed: true, throttled: false, latencyMs: 1000 },
        { generationFailed: true, throttled: false, latencyMs: 1000 },
        { generationFailed: false, throttled: false, latencyMs: 1000 },
      ],
      sceneClasses: {},
      updatedAt: '2026-10-07T11:55:00.000Z',
    },
  });

  const service = new ProviderReliabilityService({
    statsStore: store,
    now,
    minSamples: 4,
    failureRateOpen: 0.5,
    cooldownMinutes: 20,
  });

  const state = await service.state('runway');
  assert.equal(state.state, 'OPEN');
  assert.ok(state.reasons.includes('failure-rate'));
});

test('provider circuit closes automatically after cooldown', async () => {
  const now = () => new Date('2026-10-07T12:30:00.000Z');
  const store = memoryStatsStore({
    runway: {
      attempts: 4,
      passes: 0,
      generationFailures: 4,
      throttles: 0,
      latencyMsTotal: 0,
      latencyCount: 0,
      maxLatencyMs: 0,
      estimatedSpendUsd: 0,
      recent: Array.from({ length: 4 }, () => ({ generationFailed: true, throttled: false, latencyMs: 1000 })),
      sceneClasses: {},
      updatedAt: '2026-10-07T12:00:00.000Z',
    },
  });

  const service = new ProviderReliabilityService({
    statsStore: store,
    now,
    minSamples: 4,
    failureRateOpen: 0.5,
    cooldownMinutes: 20,
  });

  const state = await service.state('runway');
  assert.equal(state.state, 'CLOSED');
  assert.equal(state.cooldownExpired, true);
});

test('video router skips open provider and falls through to healthy provider', async () => {
  const called = [];
  const unhealthy = {
    id: 'runway',
    profile: { id: 'runway', strengths: { general: 1, continuity: 1, temporal: 1 } },
    async resolveScene() {
      called.push('runway');
      return { url: 'runway.mp4' };
    },
  };
  const healthy = {
    id: 'luma',
    profile: { id: 'luma', strengths: { general: 0.8, continuity: 0.8, temporal: 0.8 } },
    async resolveScene() {
      called.push('luma');
      return { url: 'luma.mp4' };
    },
  };

  const router = new VideoModelRouter({
    providers: [unhealthy, healthy],
    reliabilityService: {
      async state(id) {
        return id === 'runway'
          ? { providerId: id, state: 'OPEN', reasons: ['failure-rate'] }
          : { providerId: id, state: 'CLOSED', reasons: [] };
      },
    },
  });

  const asset = await router.resolveScene({ narration: 'a calm landscape' });
  assert.equal(asset.routing.providerId, 'luma');
  assert.deepEqual(called, ['luma']);
});

test('router records throttled failures and tries next provider', async () => {
  const outcomes = [];
  const first = {
    id: 'runway',
    profile: { id: 'runway', strengths: { general: 1, continuity: 1, temporal: 1 } },
    async resolveScene() {
      const error = new Error('429 rate limit');
      error.status = 429;
      throw error;
    },
  };
  const second = {
    id: 'luma',
    profile: { id: 'luma', strengths: { general: 0.8, continuity: 0.8, temporal: 0.8 } },
    async resolveScene() {
      return { url: 'luma.mp4' };
    },
  };

  const router = new VideoModelRouter({
    providers: [first, second],
    statsStore: {
      async get() { return null; },
      async record(id, outcome) { outcomes.push({ id, outcome }); },
    },
    reliabilityService: {
      async state(id) { return { providerId: id, state: 'CLOSED', reasons: [] }; },
    },
  });

  const asset = await router.resolveScene({ narration: 'a quiet office' });
  assert.equal(asset.routing.providerId, 'luma');
  assert.equal(outcomes[0].id, 'runway');
  assert.equal(outcomes[0].outcome.throttled, true);
  assert.equal(outcomes[0].outcome.generationFailed, true);
});
