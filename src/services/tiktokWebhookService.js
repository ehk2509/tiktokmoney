import crypto from 'node:crypto';

export class TikTokWebhookService {
  constructor({
    store,
    publicationStore,
    publishingService,
    authStore,
    clientSecret = process.env.TIKTOK_CLIENT_SECRET,
    clientKey = process.env.TIKTOK_CLIENT_KEY,
    now = () => new Date(),
    maxTimestampAgeSeconds = Number(process.env.TIKTOK_WEBHOOK_MAX_AGE_SECONDS || 300),
  } = {}) {
    if (!store) throw new Error('TikTok webhook service requires a store');
    this.store = store;
    this.publicationStore = publicationStore;
    this.publishingService = publishingService;
    this.authStore = authStore;
    this.clientSecret = clientSecret;
    this.clientKey = clientKey;
    this.now = now;
    this.maxTimestampAgeSeconds = Math.max(30, Number(maxTimestampAgeSeconds) || 300);
  }

  async receive({ rawBody, signatureHeader }) {
    if (!this.clientSecret) throw new Error('TikTok webhook verification requires TIKTOK_CLIENT_SECRET');
    verifyTikTokWebhookSignature({
      rawBody,
      signatureHeader,
      clientSecret: this.clientSecret,
      now: this.now(),
      maxTimestampAgeSeconds: this.maxTimestampAgeSeconds,
    });

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new Error('TikTok webhook body must be valid JSON');
    }

    if (this.clientKey && payload.client_key && payload.client_key !== this.clientKey) {
      throw new Error('TikTok webhook client_key does not match configured client');
    }

    const content = parseContent(payload.content);
    const id = webhookEventId(payload, rawBody);
    const existing = await this.store.getEvent(id);
    if (existing) return { event: existing, duplicate: true };

    const event = {
      id,
      provider: 'tiktok',
      event: String(payload.event || ''),
      clientKey: payload.client_key || null,
      userOpenId: payload.user_openid || null,
      createTime: Number(payload.create_time) || null,
      content,
      status: 'RECEIVED',
      attempts: 0,
      receivedAt: this.now().toISOString(),
      processedAt: null,
      lastError: null,
    };
    await this.store.saveEvent(event);
    return { event, duplicate: false };
  }

  async processEvent(eventId) {
    const event = await this.store.getEvent(eventId);
    if (!event) throw new Error(`TikTok webhook event ${eventId} was not found`);
    if (event.status === 'PROCESSED') return event;

    event.attempts = (Number(event.attempts) || 0) + 1;
    try {
      await this.applyEvent(event);
      event.status = 'PROCESSED';
      event.processedAt = this.now().toISOString();
      event.lastError = null;
    } catch (error) {
      event.status = 'RETRY';
      event.lastError = error?.message || String(error);
    }
    await this.store.saveEvent(event);
    return event;
  }

  async processPending({ limit = 100 } = {}) {
    const events = await this.store.pendingEvents({ limit });
    const results = [];
    for (const event of events) results.push(await this.processEvent(event.id));
    return results;
  }

  async applyEvent(event) {
    switch (event.event) {
      case 'authorization.removed':
        await this.handleAuthorizationRemoved(event);
        return;
      case 'post.publish.complete':
      case 'video.publish.completed':
        await this.handlePublishComplete(event);
        return;
      case 'post.publish.failed':
      case 'video.upload.failed':
        await this.handlePublishFailed(event);
        return;
      case 'post.publish.inbox_delivered':
        await this.handleInboxDelivered(event);
        return;
      default:
        return;
    }
  }

  async handleAuthorizationRemoved(event) {
    const token = await this.authStore?.getToken?.();
    if (!token || !event.userOpenId || token.openId === event.userOpenId) {
      await this.authStore?.clearToken?.();
    }
  }

  async handlePublishComplete(event) {
    const publishId = event.content?.publish_id || event.content?.publishId || null;
    if (!publishId) return;
    const publication = await this.findPublicationByPublishId(publishId);
    if (!publication) return;
    publication.webhook = {
      eventId: event.id,
      event: event.event,
      receivedAt: event.receivedAt,
    };
    publication.status = 'PUBLISH_COMPLETE';
    publication.failure = null;
    await this.publicationStore.savePublication(publication);
    if (this.publishingService?.refreshStatus) {
      await this.publishingService.refreshStatus(publication.id);
    }
  }

  async handlePublishFailed(event) {
    const publishId = event.content?.publish_id || event.content?.publishId || null;
    if (!publishId) return;
    const publication = await this.findPublicationByPublishId(publishId);
    if (!publication) return;
    publication.status = 'FAILED';
    publication.failure = event.content?.reason || 'TikTok publish failed';
    publication.webhook = {
      eventId: event.id,
      event: event.event,
      receivedAt: event.receivedAt,
    };
    publication.updatedAt = this.now().toISOString();
    await this.publicationStore.savePublication(publication);
  }

  async handleInboxDelivered(event) {
    const publishId = event.content?.publish_id || event.content?.publishId || null;
    if (!publishId) return;
    const publication = await this.findPublicationByPublishId(publishId);
    if (!publication) return;
    publication.status = 'INBOX_DELIVERED';
    publication.webhook = {
      eventId: event.id,
      event: event.event,
      receivedAt: event.receivedAt,
    };
    publication.updatedAt = this.now().toISOString();
    await this.publicationStore.savePublication(publication);
  }

  async findPublicationByPublishId(publishId) {
    const publications = await this.publicationStore?.listPublications?.({ limit: 1000 });
    return publications?.find((item) => item.publishId === publishId) || null;
  }
}

export function verifyTikTokWebhookSignature({
  rawBody,
  signatureHeader,
  clientSecret,
  now = new Date(),
  maxTimestampAgeSeconds = 300,
}) {
  if (!signatureHeader) throw new Error('TikTok-Signature header is required');
  const values = Object.fromEntries(String(signatureHeader)
    .split(',')
    .map((part) => part.trim().split('=', 2))
    .filter(([key, value]) => key && value));
  const timestamp = Number(values.t);
  const signature = values.s;
  if (!Number.isFinite(timestamp) || !signature) {
    throw new Error('TikTok-Signature header is malformed');
  }

  const ageSeconds = Math.abs(now.getTime() / 1000 - timestamp);
  if (ageSeconds > maxTimestampAgeSeconds) {
    throw new Error('TikTok webhook timestamp is outside the allowed replay window');
  }

  const expected = crypto
    .createHmac('sha256', clientSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const actualBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (
    actualBuffer.length !== expectedBuffer.length
    || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error('TikTok webhook signature is invalid');
  }
  return true;
}

function parseContent(value) {
  if (value == null || value === '') return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return { raw: String(value) };
  }
}

function webhookEventId(payload, rawBody) {
  return `twh_${crypto.createHash('sha256')
    .update([
      payload.event || '',
      payload.create_time || '',
      payload.user_openid || '',
      rawBody,
    ].join('|'))
    .digest('hex')}`;
}
