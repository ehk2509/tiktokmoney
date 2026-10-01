import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class TrendHistoryStore {
  constructor(filePath = process.env.TREND_HISTORY_PATH || './data/trend-history.json') {
    this.filePath = filePath;
  }

  async enrich(clusters, { observedAt = new Date().toISOString() } = {}) {
    const state = await this.load();
    const now = Date.parse(observedAt) || Date.now();

    const enriched = clusters.map((cluster) => {
      const key = cluster.clusterKey;
      const series = Array.isArray(state[key]) ? state[key] : [];
      const previous = series.at(-1) || null;
      const current = clamp(cluster.strength);
      const delta = previous ? current - clamp(previous.strength) : 0;

      const velocity = previous
        ? clamp((current * 0.65) + (clamp(50 + delta * 2) * 0.35))
        : current;
      const acceleration = previous
        ? clamp(50 + delta * 3)
        : 50;

      const nextSeries = [
        ...series,
        {
          observedAt,
          strength: round(current),
          sourceCount: cluster.sourceCount,
          evidenceCount: cluster.signals.length,
        },
      ]
        .filter((snapshot) => now - (Date.parse(snapshot.observedAt) || now) <= 7 * 24 * 3600 * 1000)
        .slice(-64);

      state[key] = nextSeries;

      return {
        ...cluster,
        velocity: round(velocity),
        acceleration: round(acceleration),
        history: {
          samples: nextSeries.length,
          previousStrength: previous ? round(previous.strength) : null,
          currentStrength: round(current),
          delta: round(delta),
        },
      };
    });

    await this.save(state);
    return enriched;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
  }

  async save(state) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2));
  }
}

function clamp(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}
