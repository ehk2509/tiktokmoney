import test from 'node:test';
import assert from 'node:assert/strict';

import { DailyContentPlanner } from '../src/core/dailyContentPlanner.js';
import { ExperimentService } from '../src/services/experimentService.js';

test('planner assigns control and challenger to one experiment', async () => {
  const planner = new DailyContentPlanner({
    opportunitySource: { async list() {
      return [{
        id: 'opp-1',
        topic: 'basketball coaching',
        opportunityScore: 90,
        velocity: 80,
        acceleration: 80,
        sourceCount: 3,
        signals: [{}, {}],
      }];
    } },
    store: {
      async recentTopics() { return []; },
      async savePlan() {},
    },
    dailyBudgetUsd: 10,
    maxVideos: 3,
    maxVideosPerOpportunity: 2,
    estimatedVideoCostUsd: 1,
  });

  const plan = await planner.createPlan({ date: '2026-10-07' });
  assert.equal(plan.jobs.length, 2);
  assert.ok(plan.jobs[0].experiment.id);
  assert.equal(plan.jobs[0].experiment.id, plan.jobs[1].experiment.id);
  assert.equal(plan.jobs[0].experiment.arm, 'control');
  assert.equal(plan.jobs[1].experiment.arm, 'challenger-1');
});


test('experiment evaluates only mature comparable arm snapshots', async () => {
  const outcomes = [
    {
      id: 'o1',
      projectId: 'p1',
      publicationId: 'pub1',
      metrics: { viewCount: 1000, engagementRate: 0.1 },
      experiment: { id: 'exp-1', arm: 'control', observationWindowHours: 24, comparisonToleranceHours: 3, learningEligible: false },
      observation: { ageHours: 24 },
    },
    {
      id: 'o2',
      projectId: 'p2',
      publicationId: 'pub2',
      metrics: { viewCount: 1500, engagementRate: 0.12 },
      experiment: { id: 'exp-1', arm: 'challenger-1', observationWindowHours: 24, comparisonToleranceHours: 3, learningEligible: false },
      observation: { ageHours: 25 },
    },
  ];
  const service = new ExperimentService({
    store: {
      async listOutcomes() { return outcomes; },
      async saveOutcome(outcome) {
        const index = outcomes.findIndex((item) => item.id === outcome.id);
        outcomes[index] = structuredClone(outcome);
      },
    },
  });

  const result = await service.evaluate('exp-1');
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.winner.arm, 'challenger-1');
  assert.ok(outcomes.every((item) => item.experiment.learningEligible));
});

test('experiment stays pending while one arm is immature', async () => {
  const outcomes = [
    {
      id: 'o1',
      metrics: { viewCount: 1000, engagementRate: 0.1 },
      experiment: { id: 'exp-2', arm: 'control', observationWindowHours: 24, comparisonToleranceHours: 3 },
      observation: { ageHours: 24 },
    },
    {
      id: 'o2',
      metrics: { viewCount: 2000, engagementRate: 0.2 },
      experiment: { id: 'exp-2', arm: 'challenger-1', observationWindowHours: 24, comparisonToleranceHours: 3 },
      observation: { ageHours: 12 },
    },
  ];
  const service = new ExperimentService({
    store: {
      async listOutcomes() { return outcomes; },
      async saveOutcome() {},
    },
  });

  const result = await service.evaluate('exp-2');
  assert.equal(result.status, 'PENDING');
});
