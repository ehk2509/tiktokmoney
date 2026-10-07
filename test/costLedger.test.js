import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeProviderUsage, summarizeProviderUsage } from '../src/core/providerUsage.js';
import { buildProjectCostLedger, reconcileEstimatedCost } from '../src/services/costLedger.js';
import { reconcilePlanBudget } from '../src/core/dailyContentPlanner.js';

test('normalizes provider-reported USD and credit billing without inventing zeroes', () => {
  assert.deepEqual(
    normalizeProviderUsage({
      id: 'task-1',
      status: 'SUCCEEDED',
      model: 'wan3',
      usage: { costUsd: 1.25, credits: 18 },
    }, { provider: 'runway', operation: 'video-generation' }),
    {
      provider: 'runway',
      operation: 'video-generation',
      taskId: 'task-1',
      status: 'SUCCEEDED',
      model: 'wan3',
      costUsd: 1.25,
      credits: 18,
      providerReported: true,
    },
  );

  assert.equal(
    normalizeProviderUsage({ id: 'task-2', status: 'SUCCEEDED' }).costUsd,
    null,
  );
});

test('summarizes partial billing coverage conservatively', () => {
  const summary = summarizeProviderUsage([
    { taskId: 'a', costUsd: 1, credits: 10, providerReported: true },
    { taskId: 'b', costUsd: null, credits: null, providerReported: false },
  ]);

  assert.equal(summary.taskCount, 2);
  assert.equal(summary.costUsdObserved, 1);
  assert.equal(summary.costUsdComplete, false);
  assert.equal(summary.costUsd, null);
  assert.equal(summary.source, 'provider-reported-partial');
});

test('project cost ledger deduplicates provider tasks across nested provenance', () => {
  const usage = {
    provider: 'runway',
    operation: 'video-generation',
    taskId: 'task-1',
    model: 'wan3',
    costUsd: 2,
    credits: null,
    providerReported: true,
  };
  const project = {
    id: 'vid-1',
    scenes: [{
      asset: {
        providerUsage: usage,
        qc: { acceptedAsset: { providerUsage: usage } },
        keyframes: {
          first: {
            providerUsage: {
              provider: 'runway',
              operation: 'keyframe-image',
              taskId: 'task-2',
              model: 'gen4_image',
              costUsd: 0.25,
              credits: null,
              providerReported: true,
            },
          },
        },
      },
    }],
  };

  const ledger = buildProjectCostLedger(project);
  assert.equal(ledger.taskCount, 2);
  assert.equal(ledger.costUsdComplete, true);
  assert.equal(ledger.costUsd, 2.25);
  assert.equal(ledger.events.length, 2);
});

test('estimated-vs-actual reconciliation stays null until all captured tasks report USD', () => {
  const partial = reconcileEstimatedCost({
    estimatedCostUsd: 1.5,
    ledger: {
      taskCount: 2,
      usdReportedTaskCount: 1,
      costUsdObserved: 1.2,
      costUsdComplete: false,
      costUsd: null,
    },
  });
  assert.equal(partial.actualCostUsd, null);
  assert.equal(partial.observedCostUsd, 1.2);
  assert.equal(partial.varianceUsd, null);
  assert.equal(partial.coverage, 0.5);

  const complete = reconcileEstimatedCost({
    estimatedCostUsd: 1.5,
    ledger: {
      taskCount: 2,
      usdReportedTaskCount: 2,
      costUsdObserved: 2,
      costUsdComplete: true,
      costUsd: 2,
    },
  });
  assert.equal(complete.actualCostUsd, 2);
  assert.equal(complete.varianceUsd, 0.5);
  assert.equal(complete.variancePct, 33.33);
});

test('daily plan budget only claims actual total when every job is complete', () => {
  const partial = reconcilePlanBudget({
    jobs: [
      { estimatedCostUsd: 1.5, cost: { actualComplete: true, actualCostUsd: 1.2, observedCostUsd: 1.2 } },
      { estimatedCostUsd: 1.5, cost: { actualComplete: false, actualCostUsd: null, observedCostUsd: 0.8 } },
    ],
  });
  assert.equal(partial.estimatedUsd, 3);
  assert.equal(partial.actualUsd, null);
  assert.equal(partial.observedUsd, 2);
  assert.equal(partial.coverage, 0.5);

  const complete = reconcilePlanBudget({
    jobs: [
      { estimatedCostUsd: 1.5, cost: { actualComplete: true, actualCostUsd: 1.2, observedCostUsd: 1.2 } },
      { estimatedCostUsd: 1.5, cost: { actualComplete: true, actualCostUsd: 1.8, observedCostUsd: 1.8 } },
    ],
  });
  assert.equal(complete.actualUsd, 3);
  assert.equal(complete.varianceUsd, 0);
  assert.equal(complete.coverage, 1);
});


test('plan reconciliation supports legacy plans that have no budget object yet', () => {
  const result = reconcilePlanBudget({
    jobs: [
      { estimatedCostUsd: 1.5, cost: { actualComplete: false, observedCostUsd: 1.1 } },
    ],
  });
  assert.equal(result.estimatedUsd, 1.5);
  assert.equal(result.actualUsd, null);
  assert.equal(result.observedUsd, 1.1);
});


test('project ledger captures OpenRouter raw usage with reported cost and token counts', () => {
  const project = {
    id: 'vid-openrouter',
    scenes: [{
      realismQc: {
        provider: 'openrouter',
        model: 'google/gemini-test',
        rawUsage: {
          cost: 0.0123,
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
        },
      },
      lipSyncQc: {
        provider: 'openrouter',
        model: 'google/gemini-test',
        rawUsage: {
          cost: 0.004,
          prompt_tokens: 40,
          completion_tokens: 10,
          total_tokens: 50,
        },
      },
    }],
  };

  const ledger = buildProjectCostLedger(project);
  assert.equal(ledger.taskCount, 2);
  assert.equal(ledger.costUsdComplete, true);
  assert.equal(ledger.costUsd, 0.0163);
  assert.deepEqual(
    ledger.events.map((event) => event.operation).sort(),
    ['lip-sync-qc', 'realism-qc'],
  );
  assert.equal(ledger.events[0].totalTokens + ledger.events[1].totalTokens, 200);
});
