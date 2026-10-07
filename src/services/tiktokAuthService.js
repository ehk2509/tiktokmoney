import crypto from 'node:crypto';

const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_PATH = '/v2/oauth/token/';

export class TikTokAuthService {
  constructor({
    store,
    clientKey = process.env.TIKTOK_CLIENT_KEY,
    clientSecret = process.env.TIKTOK_CLIENT_SECRET,
    redirectUri = process.env.TIKTOK_REDIRECT_URI,
    scopes = process.env.TIKTOK_OAUTH_SCOPES || 'video.publish,video.list',
    baseUrl = process.env.TIKTOK_API_BASE_URL || 'https://open.tiktokapis.com',
    fetchImpl = fetch,
    now = () => new Date(),
    refreshSkewSeconds = Number(process.env.TIKTOK_REFRESH_SKEW_SECONDS || 1200),
  } = {}) {
    if (!store) throw new Error('TikTok auth service requires a store');
    this.store = store;
    this.clientKey = clientKey;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.scopes = scopes;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.refreshSkewSeconds = Math.max(60, Number(refreshSkewSeconds) || 1200);
  }

  get configured() {
    return Boolean(this.clientKey && this.clientSecret && this.redirectUri);
  }

  async createAuthorizationUrl() {
    this.requireConfigured();
    const state = crypto.randomBytes(32).toString('base64url');
    const createdAt = this.now();
    await this.store.savePendingState({
      state,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 10 * 60 * 1000).toISOString(),
    });

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_key', this.clientKey);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', this.scopes);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('state', state);
    return { url: url.toString(), state };
  }

  async handleCallback({ code, state, error, errorDescription } = {}) {
    if (error) throw new Error(`TikTok authorization failed: ${errorDescription || error}`);
    if (!code) throw new Error('TikTok callback is missing code');
    if (!state) throw new Error('TikTok callback is missing state');
    const pending = await this.store.consumePendingState(state);
    if (!pending) throw new Error('TikTok OAuth state is invalid or expired');
    return this.exchangeCode(code);
  }

  async exchangeCode(code) {
    this.requireConfigured();
    const payload = await this.tokenRequest({
      client_key: this.clientKey,
      client_secret: this.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri,
    });
    return this.persistTokenPayload(payload);
  }

  async refresh() {
    this.requireConfigured();
    const current = await this.store.getToken();
    if (!current?.refreshToken) throw new Error('TikTok refresh token is not available');
    const payload = await this.tokenRequest({
      client_key: this.clientKey,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
    });
    return this.persistTokenPayload(payload);
  }

  async getValidAccessToken() {
    const current = await this.store.getToken();
    if (!current?.accessToken) return null;
    const expiresAt = Date.parse(current.accessTokenExpiresAt || '');
    const threshold = this.now().getTime() + this.refreshSkewSeconds * 1000;
    if (Number.isFinite(expiresAt) && expiresAt <= threshold) {
      const refreshed = await this.refresh();
      return refreshed.accessToken;
    }
    return current.accessToken;
  }

  async status() {
    const token = await this.store.getToken();
    if (!token) {
      return {
        configured: this.configured,
        authorized: false,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scopes: [],
        needsReauthorization: false,
      };
    }
    const now = this.now().getTime();
    const refreshExpires = Date.parse(token.refreshTokenExpiresAt || '');
    return {
      configured: this.configured,
      authorized: Boolean(token.accessToken),
      accessTokenExpiresAt: token.accessTokenExpiresAt || null,
      refreshTokenExpiresAt: token.refreshTokenExpiresAt || null,
      scopes: token.scopes || [],
      openId: token.openId || null,
      needsReauthorization: Number.isFinite(refreshExpires) ? refreshExpires <= now : false,
    };
  }

  async tokenRequest(form) {
    const response = await this.fetchImpl(`${this.baseUrl}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.error) {
      const message = payload?.error_description || payload?.error?.message || payload?.error || `HTTP ${response.status}`;
      throw new Error(`TikTok OAuth token request failed: ${message}`);
    }
    return payload;
  }

  async persistTokenPayload(payload) {
    if (!payload?.access_token) throw new Error('TikTok OAuth response did not contain access_token');
    const now = this.now();
    const previous = await this.store.getToken();
    const accessExpiresIn = Math.max(0, Number(payload.expires_in) || 0);
    const refreshExpiresIn = Math.max(0, Number(payload.refresh_expires_in) || 0);
    const token = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || previous?.refreshToken || null,
      tokenType: payload.token_type || 'Bearer',
      openId: payload.open_id || previous?.openId || null,
      scopes: String(payload.scope || '').split(',').map((item) => item.trim()).filter(Boolean),
      accessTokenExpiresAt: accessExpiresIn
        ? new Date(now.getTime() + accessExpiresIn * 1000).toISOString()
        : null,
      refreshTokenExpiresAt: refreshExpiresIn
        ? new Date(now.getTime() + refreshExpiresIn * 1000).toISOString()
        : previous?.refreshTokenExpiresAt || null,
      updatedAt: now.toISOString(),
    };
    await this.store.saveToken(token);
    return token;
  }

  requireConfigured() {
    if (!this.configured) {
      throw new Error('TikTok OAuth requires TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_REDIRECT_URI');
    }
  }
}
