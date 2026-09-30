import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class ProviderStatsStore {
  constructor(filePath = process.env.PROVIDER_STATS_PATH || './data/provider-stats.json') {
    this.filePath = filePath;
  }

  async get(providerId) {
    const data = await this.readAll();
    return normalize(data[providerId]);
  }

  async record(providerId, outcome) {
    const data = await this.readAll();
    const current = normalize(data[providerId]);

    current.attempts += 1;
    if (outcome.generationFailed) current.generationFailures += 1;
    if (outcome.passed) current.passes += 1;
    if (Number.isFinite(Number(outcome.overallScore))) {
      current.staticScoreTotal += Number(outcome.overallScore);
      current.staticScoreCount += 1;
    }
    if (Number.isFinite(Number(outcome.temporalScore))) {
      current.temporalScoreTotal += Number(outcome.temporalScore);
      current.temporalScoreCount += 1;
    }
    if (outcome.sceneClass) {
      const bucket = current.sceneClasses[outcome.sceneClass] || {
        attempts: 0,
        passes: 0,
        staticScoreTotal: 0,
        staticScoreCount: 0,
        temporalScoreTotal: 0,
        temporalScoreCount: 0,
      };
      bucket.attempts += 1;
      if (outcome.passed) bucket.passes += 1;
      if (Number.isFinite(Number(outcome.overallScore))) {
        bucket.staticScoreTotal += Number(outcome.overallScore);
        bucket.staticScoreCount += 1;
      }
      if (Number.isFinite(Number(outcome.temporalScore))) {
        bucket.temporalScoreTotal += Number(outcome.temporalScore);
        bucket.temporalScoreCount += 1;
      }
      current.sceneClasses[outcome.sceneClass] = bucket;
    }

    current.estimatedSpendUsd += Math.max(0, Number(outcome.estimatedCostUsd) || 0);
    current.updatedAt = new Date().toISOString();
    data[providerId] = current;

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2));
    return summarize(current, outcome.sceneClass);
  }

  async readAll() {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }
}

export function summarizeProviderStats(raw, sceneClass = null) {
  return summarize(normalize(raw), sceneClass);
}

function summarize(stats, sceneClass) {
  const bucket = sceneClass ? stats.sceneClasses?.[sceneClass] : null;
  const source = bucket || stats;

  return {
    attempts: source.attempts || 0,
    passRate: source.attempts ? (source.passes || 0) / source.attempts : null,
    averageStaticScore: source.staticScoreCount
      ? source.staticScoreTotal / source.staticScoreCount
      : null,
    averageTemporalScore: source.temporalScoreCount
      ? source.temporalScoreTotal / source.temporalScoreCount
      : null,
    generationFailureRate: stats.attempts
      ? stats.generationFailures / stats.attempts
      : null,
    estimatedSpendUsd: stats.estimatedSpendUsd || 0,
  };
}

function normalize(value = {}) {
  return {
    attempts: Number(value.attempts) || 0,
    passes: Number(value.passes) || 0,
    generationFailures: Number(value.generationFailures) || 0,
    staticScoreTotal: Number(value.staticScoreTotal) || 0,
    staticScoreCount: Number(value.staticScoreCount) || 0,
    temporalScoreTotal: Number(value.temporalScoreTotal) || 0,
    temporalScoreCount: Number(value.temporalScoreCount) || 0,
    estimatedSpendUsd: Number(value.estimatedSpendUsd) || 0,
    sceneClasses: value.sceneClasses && typeof value.sceneClasses === 'object'
      ? value.sceneClasses
      : {},
    updatedAt: value.updatedAt || null,
  };
}
