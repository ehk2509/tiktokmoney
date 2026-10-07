import test from 'node:test';
import assert from 'node:assert/strict';

import { CircuitBreakerService } from '../src/services/circuitBreakerService.js';
import { PublicationOrchestrator } from '../src/services/publicationOrchestrator.js';

test('generation circuit opens on spend/failure incidents and auto-recovers when health clears', async () => {
  let incidents = [{
    severity: 'warning',
    code: 'daily_budget_overrun',
    message: 'budget exceeded',
  }];

  const breaker = new CircuitBreakerService({
    observabilityService: {
      async snapshot() {
        return {
          status: incidents.length ? 'degraded' : 'healthy',
          incidents,
        };
      },
    },
  });

  const blocked = await breaker.evaluate('generation');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.blockingIncidents[0].code, 'daily_budget_overrun');
  await assert.rejects(
    () => breaker.assertAllowed('generation'),
    (error) => error.code === 'CIRCUIT_BREAKER_OPEN',
  );

  incidents = [];
  const recovered = await breaker.evaluate('generation');
  assert.equal(recovered.allowed, true);
});

test('publishing circuit reacts only to publishing-relevant incidents', async () => {
  let incidents = [{
    severity: 'critical',
    code: 'project_failure_rate_high',
    message: 'generation failures',
  }];
  const breaker = new CircuitBreakerService({
    observabilityService: {
      async snapshot() {
        return { status: 'critical', incidents };
      },
    },
  });

  assert.equal((await breaker.evaluate('publishing')).allowed, true);

  incidents = [{
    severity: 'critical',
    code: 'tiktok_reauthorization_required',
    message: 'reauthorize',
  }];
  assert.equal((await breaker.evaluate('publishing')).allowed, false);
});

test('disabled breakers expose incidents without blocking work', async () => {
  const breaker = new CircuitBreakerService({
    enabled: false,
    observabilityService: {
      async snapshot() {
        return {
          status: 'critical',
          incidents: [{ severity: 'critical', code: 'project_failure_rate_high' }],
        };
      },
    },
  });

  const decision = await breaker.evaluate('generation');
  assert.equal(decision.allowed, true);
  assert.equal(decision.enabled, false);
  assert.deepEqual(decision.blockingIncidents, []);
});

test('orchestrator defers publish jobs without burning retry attempts while circuit is open', async () => {
  const jobs = [{
    id: 'orq-1',
    type: 'publish',
    status: 'QUEUED',
    attempts: 0,
    runAt: '2026-10-07T10:00:00.000Z',
    projectId: 'vid-1',
    payload: { confirmPublish: true, privacyLevel: 'SELF_ONLY' },
  }];

  const store = {
    async getJob(id) { return jobs.find((job) => job.id === id) || null; },
    async saveJob(job) {
      const index = jobs.findIndex((item) => item.id === job.id);
      if (index >= 0) jobs[index] = structuredClone(job);
      else jobs.push(structuredClone(job));
      return job;
    },
    async dueJobs() { return jobs; },
  };

  let allowed = false;
  const orchestrator = new PublicationOrchestrator({
    store,
    publishingService: {
      async publishProject() {
        throw new Error('must not publish while breaker is open');
      },
    },
    projectStore: {
      async getProject() {
        return { id: 'vid-1', status: 'RENDERED', render: { outputPath: '/tmp/video.mp4' } };
      },
    },
    circuitBreakerService: {
      async evaluate() {
        return {
          allowed,
          blockingIncidents: allowed ? [] : [{ code: 'tiktok_auth_missing' }],
        };
      },
      async assertAllowed() {
        if (!allowed) throw new Error('open');
      },
    },
    now: () => new Date('2026-10-07T12:00:00.000Z'),
    retryDelayMinutes: 15,
  });

  const deferred = await orchestrator.runJob('orq-1');
  assert.equal(deferred.status, 'RETRY');
  assert.equal(deferred.attempts, 0);
  assert.match(deferred.lastError, /circuit breaker open/);
  assert.equal(deferred.runAt, '2026-10-07T12:15:00.000Z');

  allowed = true;
  orchestrator.publishingService.publishProject = async () => ({ id: 'pub-1' });
  const recovered = await orchestrator.runJob('orq-1');
  assert.equal(recovered.status, 'COMPLETED');
  assert.equal(recovered.attempts, 1);
});
