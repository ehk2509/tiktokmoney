import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  TikTokWebhookService,
  verifyTikTokWebhookSignature,
} from '../src/services/tiktokWebhookService.js';

function sign(rawBody, timestamp, secret) {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `t=${timestamp},s=${signature}`;
}

function memoryWebhookStore() {
  const events = [];
  return {
    events,
    async getEvent(id) {
      return events.find((item) => item.id === id) || null;
    },
    async saveEvent(event) {
      const index = events.findIndex((item) => item.id === event.id);
      if (index >= 0) events[index] = structuredClone(event);
      else events.push(structuredClone(event));
      return event;
    },
    async pendingEvents() {
      return events.filter((item) => ['RECEIVED', 'RETRY'].includes(item.status));
    },
  };
}

test('verifies TikTok webhook signature and rejects replay-window violations', () => {
  const rawBody = '{"event":"authorization.removed"}';
  const timestamp = 1791367200;
  const header = sign(rawBody, timestamp, 'secret');

  assert.equal(verifyTikTokWebhookSignature({
    rawBody,
    signatureHeader: header,
    clientSecret: 'secret',
    now: new Date(timestamp * 1000),
    maxTimestampAgeSeconds: 300,
  }), true);

  assert.throws(() => verifyTikTokWebhookSignature({
    rawBody,
    signatureHeader: header,
    clientSecret: 'secret',
    now: new Date((timestamp + 301) * 1000),
    maxTimestampAgeSeconds: 300,
  }), /replay window/);
});

test('webhook receipt is idempotent for duplicate deliveries', async () => {
  const store = memoryWebhookStore();
  const now = () => new Date('2026-10-07T12:00:00.000Z');
  const service = new TikTokWebhookService({
    store,
    publicationStore: { async listPublications() { return []; } },
    clientSecret: 'secret',
    clientKey: 'client-key',
    now,
  });
  const payload = {
    client_key: 'client-key',
    event: 'post.publish.complete',
    create_time: 1791374400,
    user_openid: 'open-1',
    content: JSON.stringify({ publish_id: 'pub-id-1' }),
  };
  const rawBody = JSON.stringify(payload);
  const signatureHeader = sign(rawBody, payload.create_time, 'secret');

  const first = await service.receive({ rawBody, signatureHeader });
  const second = await service.receive({ rawBody, signatureHeader });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.event.id, second.event.id);
  assert.equal(store.events.length, 1);
});

test('authorization.removed clears matching durable OAuth token', async () => {
  const store = memoryWebhookStore();
  let token = { openId: 'open-1', accessToken: 'access' };
  const service = new TikTokWebhookService({
    store,
    publicationStore: { async listPublications() { return []; } },
    authStore: {
      async getToken() { return token; },
      async clearToken() { token = null; },
    },
    clientSecret: 'secret',
    now: () => new Date('2026-10-07T12:00:00.000Z'),
  });
  const payload = {
    event: 'authorization.removed',
    create_time: 1791374400,
    user_openid: 'open-1',
    content: JSON.stringify({ reason: 1 }),
  };
  const rawBody = JSON.stringify(payload);
  const received = await service.receive({
    rawBody,
    signatureHeader: sign(rawBody, payload.create_time, 'secret'),
  });
  const processed = await service.processEvent(received.event.id);

  assert.equal(processed.status, 'PROCESSED');
  assert.equal(token, null);
});

test('post.publish.complete updates publication and refreshes status', async () => {
  const store = memoryWebhookStore();
  const publications = [{
    id: 'pub-local-1',
    publishId: 'publish-remote-1',
    status: 'PROCESSING_UPLOAD',
  }];
  let refreshed = null;
  const service = new TikTokWebhookService({
    store,
    publicationStore: {
      async listPublications() { return publications; },
      async savePublication(publication) {
        publications[0] = structuredClone(publication);
      },
    },
    publishingService: {
      async refreshStatus(id) { refreshed = id; },
    },
    clientSecret: 'secret',
    now: () => new Date('2026-10-07T12:00:00.000Z'),
  });
  const payload = {
    event: 'post.publish.complete',
    create_time: 1791374400,
    content: JSON.stringify({ publish_id: 'publish-remote-1', publish_type: 'DIRECT_POST' }),
  };
  const rawBody = JSON.stringify(payload);
  const received = await service.receive({
    rawBody,
    signatureHeader: sign(rawBody, payload.create_time, 'secret'),
  });
  await service.processEvent(received.event.id);

  assert.equal(publications[0].status, 'PUBLISH_COMPLETE');
  assert.equal(publications[0].webhook.event, 'post.publish.complete');
  assert.equal(refreshed, 'pub-local-1');
});
