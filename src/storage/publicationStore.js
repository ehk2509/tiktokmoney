import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class PublicationStore {
  constructor(filePath = process.env.PUBLICATION_STORE_PATH || './data/publications.json') {
    this.filePath = filePath;
  }

  async savePublication(publication) {
    const state = await this.load();
    const index = state.publications.findIndex((item) => item.id === publication.id);
    if (index >= 0) state.publications[index] = publication;
    else state.publications.push(publication);
    state.publications = state.publications
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 1000);
    await this.save(state);
    return publication;
  }

  async getPublication(id) {
    const state = await this.load();
    return state.publications.find((item) => item.id === id) || null;
  }

  async listPublications({ limit = 50 } = {}) {
    const state = await this.load();
    return state.publications.slice(0, Math.max(1, Math.min(1000, Number(limit) || 50)));
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      return {
        version: 1,
        publications: Array.isArray(parsed?.publications) ? parsed.publications : [],
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, publications: [] };
      throw error;
    }
  }

  async save(state) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2));
  }
}
