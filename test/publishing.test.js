import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TikTokPublisher, buildUploadPlan } from '../src/providers/tiktokPublisher.js';
import { PublicationStore } from '../src/storage/publicationStore.js';
import { PublishingService } from '../src/services/publishingService.js';

test('TikTok upload planner keeps small files whole and merges the tail into the final chunk', () => {
  const mb = 1024 * 1024;
  assert.deepEqual(buildUploadPlan(4 * mb), {
    chunkSize: 4 * mb,
    totalChunkCount: 1,
    ranges: [{ start: 0, end: 4 * mb - 1, length: 4 * mb }],
  });

  const plan = buildUploadPlan(130 * mb, 64 * mb);
  assert.equal(plan.chunkSize, 64 * mb);
  assert.equal(plan.totalChunkCount, 2);
  assert.deepEqual(plan.ranges.map((item) => item.length), [64 * mb, 66 * mb]);
});

test('publishing service is fail-closed and only accepts rendered projects', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-publish-'));
  try {
    const publicationStore = new PublicationStore(path.join(dir, 'publications.json'));
    const projectStore = {
      async getProject(id) {
        return {
          id,
          status: 'RENDERED',
          topic: 'A safe test',
          render: { outputPath: path.join(dir, 'video.mp4') },
        };
      },
    };
    await writeFile(path.join(dir, 'video.mp4'), 'fake-video');
    const publisher = {
      configured: true,
      async publishFile() {
        return {
          publishId: 'v_pub_file~test',
          creator: { username: 'creator', nickname: 'Creator' },
          privacyLevel: 'SELF_ONLY',
          upload: { videoSize: 10, chunkSize: 10, totalChunkCount: 1 },
        };
      },
    };
    const service = new PublishingService({ projectStore, publicationStore, publisher });

    await assert.rejects(
      service.publishProject('vid-1', { privacyLevel: 'SELF_ONLY' }),
      /explicit confirmPublish=true is required/,
    );

    const publication = await service.publishProject('vid-1', {
      confirmPublish: true,
      privacyLevel: 'SELF_ONLY',
    });
    assert.equal(publication.projectId, 'vid-1');
    assert.equal(publication.status, 'PROCESSING_UPLOAD');
    assert.equal(publication.publishId, 'v_pub_file~test');
    assert.equal((await publicationStore.listPublications()).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('status refresh captures public post ids and metrics snapshots without inventing values', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-publish-metrics-'));
  try {
    const publicationStore = new PublicationStore(path.join(dir, 'publications.json'));
    await publicationStore.savePublication({
      id: 'pub-1',
      provider: 'tiktok',
      projectId: 'vid-1',
      createdAt: '2026-10-07T09:00:00.000Z',
      updatedAt: '2026-10-07T09:00:00.000Z',
      status: 'PROCESSING_UPLOAD',
      publishId: 'publish-1',
      postIds: [],
      metricsSnapshots: [],
    });
    const publisher = {
      configured: true,
      async getStatus() {
        return {
          status: 'PUBLISH_COMPLETE',
          publicaly_available_post_id: [12345],
          uploaded_bytes: 99,
        };
      },
      async queryVideos(ids) {
        assert.deepEqual(ids, ['12345']);
        return [{
          id: '12345',
          view_count: 200,
          like_count: 20,
          comment_count: 3,
          share_count: 4,
          duration: 31,
          is_aigc: true,
        }];
      },
    };
    const service = new PublishingService({
      projectStore: {},
      publicationStore,
      publisher,
      now: () => new Date('2026-10-07T10:00:00.000Z'),
    });

    const publication = await service.refreshMetrics('pub-1');
    assert.equal(publication.status, 'PUBLISH_COMPLETE');
    assert.deepEqual(publication.postIds, ['12345']);
    assert.equal(publication.metricsSnapshots.length, 1);
    assert.equal(publication.metricsSnapshots[0].videos[0].viewCount, 200);
    assert.equal(publication.metricsSnapshots[0].videos[0].shareUrl, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('TikTok publisher validates creator privacy options before initializing a post', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-tiktok-provider-'));
  try {
    const filePath = path.join(dir, 'video.mp4');
    await writeFile(filePath, 'video');
    const calls = [];
    const publisher = new TikTokPublisher({
      accessToken: 'test-token',
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (String(url).includes('creator_info')) {
          return response(200, {
            data: { privacy_level_options: ['SELF_ONLY'], creator_username: 'creator' },
            error: { code: 'ok', message: '' },
          });
        }
        throw new Error('unexpected request');
      },
    });

    await assert.rejects(
      publisher.publishFile({ filePath, privacyLevel: 'PUBLIC_TO_EVERYONE' }),
      /is not available for this TikTok creator/,
    );
    assert.equal(calls.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function response(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  };
}
