import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class PerformanceLearningStore {
  constructor(filePath = process.env.PERFORMANCE_LEARNING_PATH || './data/performance-learning.json') {
    this.filePath = filePath;
  }

  async saveOutcome(outcome) {
    const state = await this.load();
    const index = state.outcomes.findIndex((item) => item.id === outcome.id);
    if (index >= 0) state.outcomes[index] = outcome;
    else state.outcomes.push(outcome);
    state.outcomes = state.outcomes
      .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))
      .slice(0, 5000);
    await this.save(state);
    return outcome;
  }

  async listOutcomes({ limit = 1000 } = {}) {
    const state = await this.load();
    return state.outcomes.slice(0, Math.max(1, Math.min(5000, Number(limit) || 1000)));
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      return {
        version: 1,
        outcomes: Array.isArray(parsed?.outcomes) ? parsed.outcomes : [],
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, outcomes: [] };
      throw error;
    }
  }

  async save(state) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2));
  }
}
