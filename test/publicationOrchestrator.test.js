import test from 'node:test';
import assert from 'node:assert/strict';

import { PublicationOrchestrator } from '../src/services/publicationOrchestrator.js';

function memoryStore() {
  const jobs = [];
  return {
    jobs,
    async saveJob(job) {
      const index = jobs.findIndex((item) => item.id === job.id);
      if (index >= 0) jobs[index] = structuredClone(job);
      else jobs.push(structuredClone(job));
      return job;
    },
    async getJob(id) {
      return jobs.find((item) => item.id === id) || null;
    },
    async dueJobs(now) {
      return jobs.filter((job) => ['QUEUED', 'RETRY'].includes(job.status)
        && Date.parse(job.runAt) <= now.getTime());
    },
  };
}

test('scheduled publish requires explicit confirmation and creates a durable job', async () => {
  const store = memoryStore();
  const now = () => new Date('2026-10-07T12:00:00.000Z');
  const orchestrator = new PublicationOrchestrator({
    store,
    now,
    publishingService: {},
    projectStore: {
      async getProject() {
        return { id: 'vid-1', status: 'RENDERED', render: { outputPath: '/tmp/video.mp4' } };
      },
    },
  });

  await assert.rejects(
    () => orchestrator.schedulePublish('vid-1', {
      runAt: '2026-10-07T13:00:00.000Z',
      privacyLevel: 'SELF_ONLY',
    }),
    /confirmPublish=true/,
  );

  const job = await orchestrator.schedulePublish('vid-1', {
    runAt: '2026-10-07T13:00:00.000Z',
    privacyLevel: 'SELF_ONLY',
    confirmPublish: true,
  });

  assert.equal(job.status, 'QUEUED');
  assert.equal(job.payload.confirmPublish, true);
  assert.equal(store.jobs.length, 1);
});


test('due publish creates metrics refresh at experiment observation window', async () => {
  const store = memoryStore();
  let current = new Date('2026-10-07T12:00:00.000Z');
  const now = () => new Date(current);
  const project = {
    id: 'vid-exp',
    status: 'RENDERED',
    render: { outputPath: '/tmp/video.mp4' },
    planning: {
      experiment: {
        id: 'exp-1',
        observationWindowHours: 24,
      },
    },
  };
  const orchestrator = new PublicationOrchestrator({
    store,
    now,
    publishingService: {
      async publishProject(projectId, payload) {
        assert.equal(projectId, 'vid-exp');
        assert.equal(payload.confirmPublish, true);
        return { id: 'pub-1' };
      },
    },
    projectStore: {
      async getProject() { return project; },
    },
  });

  await orchestrator.schedulePublish('vid-exp', {
    runAt: '2026-10-07T12:00:00.000Z',
    privacyLevel: 'SELF_ONLY',
    confirmPublish: true,
  });

  const [result] = await orchestrator.runDue();
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.publicationId, 'pub-1');

  const metricsJob = store.jobs.find((item) => item.type === 'metrics-refresh');
  assert.ok(metricsJob);
  assert.equal(metricsJob.experimentId, 'exp-1');
  assert.equal(metricsJob.runAt, '2026-10-08T12:00:00.000Z');
});

test('metrics refresh retries while TikTok post metrics are unavailable', async () => {
  const store = memoryStore();
  const now = () => new Date('2026-10-08T12:00:00.000Z');
  const job = {
    id: 'orq-metrics',
    type: 'metrics-refresh',
    status: 'QUEUED',
    projectId: 'vid-1',
    publicationId: 'pub-1',
    experimentId: null,
    runAt: '2026-10-08T12:00:00.000Z',
    attempts: 0,
    payload: {},
  };
  await store.saveJob(job);

  const orchestrator = new PublicationOrchestrator({
    store,
    now,
    retryDelayMinutes: 15,
    maxAttempts: 3,
    projectStore: { async getProject() { return null; } },
    publishingService: {
      async refreshMetrics() {
        return { id: 'pub-1', postIds: [], metricsSnapshots: [] };
      },
    },
  });

  const [result] = await orchestrator.runDue();
  assert.equal(result.status, 'RETRY');
  assert.equal(result.attempts, 1);
  assert.equal(result.runAt, '2026-10-08T12:15:00.000Z');
  assert.match(result.lastError, /not available yet/);
});

test('metrics refresh completes and finalizes experiment when comparable metrics exist', async () => {
  const store = memoryStore();
  const now = () => new Date('2026-10-08T12:00:00.000Z');
  const job = {
    id: 'orq-metrics-2',
    type: 'metrics-refresh',
    status: 'QUEUED',
    projectId: 'vid-2',
    publicationId: 'pub-2',
    experimentId: 'exp-2',
    runAt: '2026-10-08T12:00:00.000Z',
    attempts: 0,
    payload: {},
  };
  await store.saveJob(job);

  const orchestrator = new PublicationOrchestrator({
    store,
    now,
    projectStore: { async getProject() { return null; } },
    publishingService: {
      async refreshMetrics() {
        return {
          id: 'pub-2',
          postIds: ['post-2'],
          metricsSnapshots: [{
            capturedAt: '2026-10-08T12:00:00.000Z',
            videos: [{ id: 'post-2', viewCount: 100 }],
          }],
          latestOutcome: { id: 'outcome-2' },
        };
      },
    },
    experimentService: {
      async evaluate(id) {
        assert.equal(id, 'exp-2');
        return { id, status: 'COMPLETED', winner: { arm: 'challenger-1' } };
      },
    },
  });

  const [result] = await orchestrator.runDue();
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.latestOutcomeId, 'outcome-2');
  assert.equal(result.experimentResult.status, 'COMPLETED');
});
