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
