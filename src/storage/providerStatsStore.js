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
    if (outcome.throttled) current.throttles += 1;
    if (Number.isFinite(Number(outcome.latencyMs))) {
      current.latencyMsTotal += Number(outcome.latencyMs);
      current.latencyCount += 1;
      current.maxLatencyMs = Math.max(current.maxLatencyMs, Number(outcome.latencyMs));
    }
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
    if (Number.isFinite(Number(outcome.actualCostUsd))) {
      current.actualCostUsdObserved += Math.max(0, Number(outcome.actualCostUsd));
      current.actualCostCount += 1;
      if (outcome.passed) {
        current.successCostUsdObserved += Math.max(0, Number(outcome.actualCostUsd));
        current.successCostCount += 1;
      }
    }
    if (Number.isFinite(Number(outcome.qualityScore))) {
      current.qualityScoreTotal += Number(outcome.qualityScore);
      current.qualityScoreCount += 1;
    }
    current.recent.push({
      at: new Date().toISOString(),
      generationFailed: Boolean(outcome.generationFailed),
      passed: Boolean(outcome.passed),
      throttled: Boolean(outcome.throttled),
      latencyMs: Number.isFinite(Number(outcome.latencyMs)) ? Number(outcome.latencyMs) : null,
      actualCostUsd: Number.isFinite(Number(outcome.actualCostUsd)) ? Number(outcome.actualCostUsd) : null,
      qualityScore: Number.isFinite(Number(outcome.qualityScore)) ? Number(outcome.qualityScore) : null,
      sceneClass: outcome.sceneClass || null,
    });
    current.recent = current.recent.slice(-100);
    current.updatedAt = new Date().toISOString();
    data[providerId] = current;

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2));
    return summarize(current, outcome.sceneClass);
  }

  async recordFeedback(providerId, {
    qualityScore = null,
    actualCostUsd = null,
    passed = true,
  } = {}) {
    const data = await this.readAll();
    const current = normalize(data[providerId]);

    if (Number.isFinite(Number(qualityScore))) {
      current.qualityScoreTotal += Number(qualityScore);
      current.qualityScoreCount += 1;
    }
    if (Number.isFinite(Number(actualCostUsd))) {
      current.actualCostUsdObserved += Math.max(0, Number(actualCostUsd));
      current.actualCostCount += 1;
      if (passed) {
        current.successCostUsdObserved += Math.max(0, Number(actualCostUsd));
        current.successCostCount += 1;
      }
    }

    current.updatedAt = new Date().toISOString();
    data[providerId] = current;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2));
    return summarize(current);
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
    actualCostUsdObserved: stats.actualCostUsdObserved || 0,
    actualCostCount: stats.actualCostCount || 0,
    averageObservedCostUsd: stats.actualCostCount
      ? stats.actualCostUsdObserved / stats.actualCostCount
      : null,
    costPerSuccessfulOutputUsd: stats.successCostCount
      ? stats.successCostUsdObserved / stats.successCostCount
      : null,
    averageQualityScore: stats.qualityScoreCount
      ? stats.qualityScoreTotal / stats.qualityScoreCount
      : null,
    throttleRate: stats.attempts ? stats.throttles / stats.attempts : null,
    averageLatencyMs: stats.latencyCount ? stats.latencyMsTotal / stats.latencyCount : null,
    maxLatencyMs: stats.maxLatencyMs || 0,
    recent: stats.recent || [],
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
    actualCostUsdObserved: Number(value.actualCostUsdObserved) || 0,
    actualCostCount: Number(value.actualCostCount) || 0,
    successCostUsdObserved: Number(value.successCostUsdObserved) || 0,
    successCostCount: Number(value.successCostCount) || 0,
    qualityScoreTotal: Number(value.qualityScoreTotal) || 0,
    qualityScoreCount: Number(value.qualityScoreCount) || 0,
    sceneClasses: value.sceneClasses && typeof value.sceneClasses === 'object'
      ? value.sceneClasses
      : {},
    throttles: Number(value.throttles) || 0,
    latencyMsTotal: Number(value.latencyMsTotal) || 0,
    latencyCount: Number(value.latencyCount) || 0,
    maxLatencyMs: Number(value.maxLatencyMs) || 0,
    recent: Array.isArray(value.recent) ? value.recent.slice(-100) : [],
    updatedAt: value.updatedAt || null,
  };
}
