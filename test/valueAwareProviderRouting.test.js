import test from 'node:test';
import assert from 'node:assert/strict';

import { EquivalentProviderRouter } from '../src/providers/equivalentProviderRouter.js';
import { ProviderStatsStore } from '../src/storage/providerStatsStore.js';

function memoryStats(initial = {}) {
  const data = structuredClone(initial);
  return {
    async get(id) {
      return data[id] || {};
    },
    async record(id, outcome) {
      const current = data[id] || {
        attempts: 0,
        passes: 0,
        generationFailures: 0,
        throttles: 0,
        latencyMsTotal: 0,
        latencyCount: 0,
        maxLatencyMs: 0,
        actualCostUsdObserved: 0,
        actualCostCount: 0,
        successCostUsdObserved: 0,
        successCostCount: 0,
        qualityScoreTotal: 0,
        qualityScoreCount: 0,
        recent: [],
      };
      current.attempts += 1;
      if (outcome.passed) current.passes += 1;
      if (outcome.generationFailed) current.generationFailures += 1;
      if (Number.isFinite(Number(outcome.latencyMs))) {
        current.latencyMsTotal += Number(outcome.latencyMs);
        current.latencyCount += 1;
      }
      if (Number.isFinite(Number(outcome.actualCostUsd))) {
        current.actualCostUsdObserved += Number(outcome.actualCostUsd);
        current.actualCostCount += 1;
        if (outcome.passed) {
          current.successCostUsdObserved += Number(outcome.actualCostUsd);
          current.successCostCount += 1;
        }
      }
      if (Number.isFinite(Number(outcome.qualityScore))) {
        current.qualityScoreTotal += Number(outcome.qualityScore);
        current.qualityScoreCount += 1;
      }
      current.recent.push({ passed: Boolean(outcome.passed) });
      data[id] = current;
    },
    async recordFeedback(id, outcome) {
      const current = data[id] || {};
      current.attempts = Number(current.attempts) || 0;
      current.passes = Number(current.passes) || 0;
      current.qualityScoreTotal = Number(current.qualityScoreTotal) || 0;
      current.qualityScoreCount = Number(current.qualityScoreCount) || 0;
      if (Number.isFinite(Number(outcome.qualityScore))) {
        current.qualityScoreTotal += Number(outcome.qualityScore);
        current.qualityScoreCount += 1;
      }
      data[id] = current;
    },
  };
}

function closedReliability() {
  return {
    async state(id) {
      return { providerId: id, state: 'CLOSED', reasons: [] };
    },
  };
}

test('value-aware router prefers higher success and lower cost among healthy providers', async () => {
  const stats = memoryStats({
    expensive: {
      attempts: 10,
      passes: 9,
      latencyMsTotal: 10000,
      latencyCount: 10,
      successCostUsdObserved: 9,
      successCostCount: 9,
      qualityScoreTotal: 900,
      qualityScoreCount: 10,
      recent: Array(10).fill({ passed: true }),
    },
    efficient: {
      attempts: 10,
      passes: 9,
      latencyMsTotal: 10000,
      latencyCount: 10,
      successCostUsdObserved: 0.9,
      successCostCount: 9,
      qualityScoreTotal: 900,
      qualityScoreCount: 10,
      recent: Array(10).fill({ passed: true }),
    },
  });
  const called = [];
  const router = new EquivalentProviderRouter({
    capability: 'llm',
    providers: [
      { id: 'expensive', provider: { async generateJson() { called.push('expensive'); return {}; } } },
      { id: 'efficient', provider: { async generateJson() { called.push('efficient'); return {}; } } },
    ],
    statsStore: stats,
    reliabilityService: closedReliability(),
    minRankingSamples: 3,
    successWeight: 0.4,
    qualityWeight: 0.2,
    latencyWeight: 0.1,
    costWeight: 0.3,
    maxCostReferenceUsd: 1,
    explorationRate: 0,
  });

  const result = await router.generateJson({});
  assert.equal(result.providerRouting.providerId, 'efficient');
  assert.deepEqual(called, ['efficient']);
  assert.ok(result.providerRouting.score > 0.5);
  assert.equal(result.providerRouting.evidence.costPerSuccessfulOutputUsd, 0.1);
});

test('missing cost evidence stays neutral instead of being treated as free', async () => {
  const stats = memoryStats({
    unknownCost: {
      attempts: 5,
      passes: 5,
      latencyMsTotal: 5000,
      latencyCount: 5,
      recent: Array(5).fill({ passed: true }),
    },
    knownCheap: {
      attempts: 5,
      passes: 5,
      latencyMsTotal: 5000,
      latencyCount: 5,
      successCostUsdObserved: 0.25,
      successCostCount: 5,
      recent: Array(5).fill({ passed: true }),
    },
  });
  const router = new EquivalentProviderRouter({
    providers: [
      { id: 'unknownCost', provider: { async generateJson() { return {}; } } },
      { id: 'knownCheap', provider: { async generateJson() { return {}; } } },
    ],
    statsStore: stats,
    reliabilityService: closedReliability(),
    minRankingSamples: 3,
    costWeight: 1,
    successWeight: 0,
    qualityWeight: 0,
    latencyWeight: 0,
    maxCostReferenceUsd: 1,
    explorationRate: 0,
  });

  const result = await router.generateJson({});
  assert.equal(result.providerRouting.providerId, 'knownCheap');
  assert.equal(result.providerRouting.evidence.cost, 0.95);
});

test('bounded exploration only activates after every candidate has enough evidence', async () => {
  const sparse = memoryStats({
    primary: { attempts: 5, passes: 5, recent: Array(5).fill({ passed: true }) },
    fallback: { attempts: 1, passes: 1, recent: [{ passed: true }] },
  });
  let randomCalls = 0;
  const router = new EquivalentProviderRouter({
    providers: [
      { id: 'primary', provider: { async generateJson() { return {}; } } },
      { id: 'fallback', provider: { async generateJson() { return {}; } } },
    ],
    statsStore: sparse,
    reliabilityService: closedReliability(),
    minRankingSamples: 3,
    explorationRate: 1,
    random: () => {
      randomCalls += 1;
      return 0;
    },
  });

  const result = await router.generateJson({});
  assert.equal(result.providerRouting.providerId, 'primary');
  assert.equal(result.providerRouting.explored, false);
  assert.equal(randomCalls, 0);
});

test('explicit downstream quality feedback does not increment provider attempts', async () => {
  const stats = memoryStats({
    p1: {
      attempts: 4,
      passes: 4,
      recent: Array(4).fill({ passed: true }),
    },
  });
  const router = new EquivalentProviderRouter({
    providers: [{ id: 'p1', provider: { async generateJson() { return {}; } } }],
    statsStore: stats,
    reliabilityService: closedReliability(),
    explorationRate: 0,
  });

  await router.recordOutcome({
    providerRouting: { providerId: 'p1' },
  }, {
    qualityScore: 92,
  });

  const raw = await stats.get('p1');
  assert.equal(raw.attempts, 4);
  assert.equal(raw.qualityScoreCount, 1);
  assert.equal(raw.qualityScoreTotal, 92);
});

test('provider-reported cost is captured from successful routed result', async () => {
  const stats = memoryStats();
  const router = new EquivalentProviderRouter({
    providers: [{
      id: 'p1',
      provider: {
        async generateJson() {
          return {
            providerUsage: {
              costUsd: 0.12,
            },
          };
        },
      },
    }],
    statsStore: stats,
    reliabilityService: closedReliability(),
    explorationRate: 0,
  });

  await router.generateJson({});
  const raw = await stats.get('p1');
  assert.equal(raw.actualCostCount, 1);
  assert.equal(raw.actualCostUsdObserved, 0.12);
  assert.equal(raw.successCostCount, 1);
});
