import test from 'node:test';
import assert from 'node:assert/strict';

import { TikTokAuthService } from '../src/services/tiktokAuthService.js';
import { TikTokPublisher } from '../src/providers/tiktokPublisher.js';

function memoryAuthStore() {
  let token = null;
  const states = new Map();
  return {
    async saveToken(value) { token = structuredClone(value); return value; },
    async getToken() { return token ? structuredClone(token) : null; },
    async savePendingState(entry) { states.set(entry.state, structuredClone(entry)); },
    async consumePendingState(state) {
      const entry = states.get(state) || null;
      states.delete(state);
      return entry;
    },
    async clearToken() { token = null; },
  };
}

test('OAuth callback consumes state once and exchanges code with form encoding', async () => {
  const store = memoryAuthStore();
  const calls = [];
  const auth = new TikTokAuthService({
    store,
    clientKey: 'client-key',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/api/tiktok/oauth/callback',
    scopes: 'video.publish,video.list',
    now: () => new Date('2026-10-07T10:00:00.000Z'),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 86400,
            refresh_expires_in: 31536000,
            open_id: 'open-1',
            scope: 'video.publish,video.list',
            token_type: 'Bearer',
          };
        },
      };
    },
  });

  const started = await auth.createAuthorizationUrl();
  const url = new URL(started.url);
  assert.equal(url.origin + url.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(url.searchParams.get('state'), started.state);

  const token = await auth.handleCallback({ code: 'code-1', state: started.state });
  assert.equal(token.accessToken, 'access-1');
  assert.equal(token.refreshToken, 'refresh-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[0].options.body.get('grant_type'), 'authorization_code');
  assert.equal(calls[0].options.body.get('redirect_uri'), 'https://example.com/api/tiktok/oauth/callback');

  await assert.rejects(
    () => auth.handleCallback({ code: 'code-2', state: started.state }),
    /invalid or expired/,
  );
});

test('refresh rotates refresh token and updates expiry', async () => {
  const store = memoryAuthStore();
  await store.saveToken({
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    accessTokenExpiresAt: '2026-10-07T10:05:00.000Z',
    refreshTokenExpiresAt: '2027-10-07T10:00:00.000Z',
    scopes: ['video.publish'],
  });

  const auth = new TikTokAuthService({
    store,
    clientKey: 'client-key',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/api/tiktok/oauth/callback',
    now: () => new Date('2026-10-07T10:00:00.000Z'),
    refreshSkewSeconds: 1200,
    fetchImpl: async (_url, options) => {
      assert.equal(options.body.get('grant_type'), 'refresh_token');
      assert.equal(options.body.get('refresh_token'), 'old-refresh');
      return {
        ok: true,
        async json() {
          return {
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 86400,
            refresh_expires_in: 31536000,
            scope: 'video.publish,video.list',
          };
        },
      };
    },
  });

  const access = await auth.getValidAccessToken();
  assert.equal(access, 'new-access');
  const stored = await store.getToken();
  assert.equal(stored.refreshToken, 'new-refresh');
  assert.equal(stored.accessToken, 'new-access');
});

test('TikTok publisher resolves OAuth access token before API request', async () => {
  let authorization = null;
  const publisher = new TikTokPublisher({
    accessToken: null,
    authService: {
      configured: true,
      async getValidAccessToken() { return 'oauth-access'; },
    },
    fetchImpl: async (_url, options) => {
      authorization = options.headers.authorization;
      return {
        ok: true,
        async json() {
          return { data: { creator_username: 'creator' }, error: { code: 'ok' } };
        },
      };
    },
  });

  const creator = await publisher.queryCreatorInfo();
  assert.equal(authorization, 'Bearer oauth-access');
  assert.equal(creator.creator_username, 'creator');
});
