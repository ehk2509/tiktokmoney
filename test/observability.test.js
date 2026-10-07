import test from 'node:test';
import assert from 'node:assert/strict';

import { ObservabilityService } from '../src/services/observabilityService.js';

function fixedNow() {
  return new Date('2026-10-07T12:00:00.000Z');
}

test('healthy snapshot stays healthy with clean queues and low failure rates', async () => {
  const service = new ObservabilityService({
    projectStore: {
      async listProjects() {
        return [
          {
            id: 'vid-1',
            status: 'RENDERED',
            createdAt: '2026-10-07T10:00:00.000Z',
            costLedger: {
              costUsdComplete: true,
              costUsd: 1.2,
              costUsdObserved: 1.2,
            },
          },
        ];
      },
    },
    dailyPlanStore: {
      async listPlans() {
        return [{
          id: 'plan-1',
          budget: { limitUsd: 5, actualUsd: 1.2 },
          jobs: [{ id: 'job-1', status: 'COMPLETED' }],
        }];
      },
    },
    orchestrationStore: {
      async listJobs() { return []; },
    },
    webhookStore: {
      async listEvents() { return []; },
    },
    authService: {
      async status() {
        return {
          configured: true,
          authorized: true,
          needsReauthorization: false,
          accessTokenExpiresAt: '2026-10-08T12:00:00.000Z',
          refreshTokenExpiresAt: '2027-10-07T12:00:00.000Z',
          scopes: ['video.publish'],
        };
      },
    },
    publicationStore: {
      async listPublications() { return []; },
    },
    now: fixedNow,
  });

  const result = await service.snapshot();
  assert.equal(result.status, 'healthy');
  assert.deepEqual(result.incidents, []);
  assert.equal(result.metrics.projects.failureRate, 0);
});

test('missing TikTok authorization and failed orchestration create critical health', async () => {
  const service = new ObservabilityService({
    projectStore: { async listProjects() { return []; } },
    dailyPlanStore: { async listPlans() { return []; } },
    orchestrationStore: {
      async listJobs() {
        return [{
          id: 'orq-1',
          type: 'publish',
          status: 'FAILED',
          attempts: 12,
          lastError: 'provider failed',
          runAt: '2026-10-07T10:00:00.000Z',
        }];
      },
    },
    webhookStore: { async listEvents() { return []; } },
    authService: {
      async status() {
        return {
          configured: true,
          authorized: false,
          needsReauthorization: false,
        };
      },
    },
    publicationStore: { async listPublications() { return []; } },
    now: fixedNow,
  });

  const result = await service.snapshot();
  assert.equal(result.status, 'critical');
  assert.ok(result.incidents.some((item) => item.code === 'tiktok_auth_missing'));
  assert.ok(result.incidents.some((item) => item.code === 'orchestration_failed_jobs'));
});

test('elevated project failures, webhook retries and cost gaps degrade health', async () => {
  const service = new ObservabilityService({
    projectStore: {
      async listProjects() {
        return [
          {
            id: 'vid-ok',
            status: 'RENDERED',
            createdAt: '2026-10-07T10:00:00.000Z',
            costLedger: { costUsdComplete: false, costUsdObserved: 1 },
          },
          {
            id: 'vid-fail',
            status: 'VISUAL_QC_FAILED',
            createdAt: '2026-10-07T09:00:00.000Z',
            error: 'realism',
            costLedger: { costUsdComplete: false, costUsdObserved: 0.4 },
          },
          {
            id: 'vid-ok-2',
            status: 'RENDERED',
            createdAt: '2026-10-07T08:00:00.000Z',
            costLedger: { costUsdComplete: true, costUsd: 1, costUsdObserved: 1 },
          },
        ];
      },
    },
    dailyPlanStore: {
      async listPlans() {
        return [{
          budget: { limitUsd: 5, actualUsd: 6 },
          jobs: [{ status: 'COMPLETED' }, { status: 'FAILED' }],
        }];
      },
    },
    orchestrationStore: {
      async listJobs() {
        return [{
          id: 'orq-retry',
          status: 'RETRY',
          type: 'metrics-refresh',
          runAt: '2026-10-07T10:00:00.000Z',
          updatedAt: '2026-10-07T10:00:00.000Z',
        }];
      },
    },
    webhookStore: {
      async listEvents() {
        return [{
          id: 'twh-1',
          event: 'post.publish.complete',
          status: 'RETRY',
          receivedAt: '2026-10-07T11:00:00.000Z',
          attempts: 3,
          lastError: 'status API unavailable',
        }];
      },
    },
    authService: {
      async status() {
        return {
          configured: true,
          authorized: true,
          needsReauthorization: false,
          accessTokenExpiresAt: '2026-10-08T12:00:00.000Z',
        };
      },
    },
    publicationStore: {
      async listPublications() { return []; },
    },
    thresholds: {
      orchestrationRetryWarn: 1,
      webhookRetryWarn: 1,
      projectFailureRateWarn: 0.3,
      projectFailureRateCritical: 0.8,
      incompleteCostRateWarn: 0.3,
      dailyBudgetOverrunPctWarn: 10,
    },
    now: fixedNow,
  });

  const result = await service.snapshot();
  assert.equal(result.status, 'degraded');
  assert.ok(result.incidents.some((item) => item.code === 'orchestration_retry_backlog'));
  assert.ok(result.incidents.some((item) => item.code === 'webhook_retry_backlog'));
  assert.ok(result.incidents.some((item) => item.code === 'project_failure_rate_elevated'));
  assert.ok(result.incidents.some((item) => item.code === 'cost_coverage_incomplete'));
  assert.ok(result.incidents.some((item) => item.code === 'daily_budget_overrun'));
});
