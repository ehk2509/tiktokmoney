import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class TikTokAuthStore {
  constructor(filePath = process.env.TIKTOK_AUTH_STORE_PATH || './data/tiktok-auth.json') {
    this.filePath = filePath;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      return {
        version: 1,
        token: parsed?.token || null,
        pendingStates: Array.isArray(parsed?.pendingStates) ? parsed.pendingStates : [],
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, token: null, pendingStates: [] };
      throw error;
    }
  }

  async saveToken(token) {
    const state = await this.load();
    state.token = token;
    await this.save(state);
    return token;
  }

  async getToken() {
    return (await this.load()).token;
  }

  async savePendingState(entry) {
    const state = await this.load();
    state.pendingStates = [
      ...state.pendingStates.filter((item) => item.state !== entry.state),
      entry,
    ].filter((item) => Date.parse(item.expiresAt || '') > Date.now());
    await this.save(state);
    return entry;
  }

  async consumePendingState(value) {
    const state = await this.load();
    const index = state.pendingStates.findIndex((item) => item.state === value);
    if (index < 0) return null;
    const [entry] = state.pendingStates.splice(index, 1);
    await this.save(state);
    if (Date.parse(entry.expiresAt || '') <= Date.now()) return null;
    return entry;
  }

  async clearToken() {
    const state = await this.load();
    state.token = null;
    await this.save(state);
  }

  async save(state) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    await chmod(this.filePath, 0o600).catch(() => {});
  }
}
