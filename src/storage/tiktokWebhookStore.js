import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class TikTokWebhookStore {
  constructor(filePath = process.env.TIKTOK_WEBHOOK_STORE_PATH || './data/tiktok-webhooks.json') {
    this.filePath = filePath;
  }

  async saveEvent(event) {
    const state = await this.load();
    const index = state.events.findIndex((item) => item.id === event.id);
    if (index >= 0) state.events[index] = event;
    else state.events.push(event);
    state.events = state.events
      .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))
      .slice(0, 5000);
    await this.save(state);
    return event;
  }

  async getEvent(id) {
    return (await this.load()).events.find((item) => item.id === id) || null;
  }

  async listEvents({ limit = 200, status = null } = {}) {
    const events = (await this.load()).events;
    const filtered = status ? events.filter((item) => item.status === status) : events;
    return filtered.slice(0, Math.max(1, Math.min(5000, Number(limit) || 200)));
  }

  async pendingEvents({ limit = 100 } = {}) {
    return (await this.load()).events
      .filter((item) => ['RECEIVED', 'RETRY'].includes(item.status))
      .slice(0, Math.max(1, Math.min(1000, Number(limit) || 100)));
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      return {
        version: 1,
        events: Array.isArray(parsed?.events) ? parsed.events : [],
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, events: [] };
      throw error;
    }
  }

  async save(state) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2));
  }
}
