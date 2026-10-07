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
