import { summarizeProviderStats } from '../storage/providerStatsStore.js';

export class ProviderReliabilityService {
  constructor({
    statsStore,
    now = () => new Date(),
    minSamples = Number(process.env.PROVIDER_RELIABILITY_MIN_SAMPLES || 4),
    failureRateOpen = Number(process.env.PROVIDER_FAILURE_RATE_OPEN || 0.6),
    throttleRateOpen = Number(process.env.PROVIDER_THROTTLE_RATE_OPEN || 0.5),
    latencyOpenMs = Number(process.env.PROVIDER_LATENCY_OPEN_MS || 120000),
    cooldownMinutes = Number(process.env.PROVIDER_CIRCUIT_COOLDOWN_MINUTES || 20),
  } = {}) {
    if (!statsStore) throw new Error('provider reliability requires a stats store');
    this.statsStore = statsStore;
    this.now = now;
    this.minSamples = Math.max(1, Number(minSamples) || 4);
    this.failureRateOpen = clamp01(failureRateOpen, 0.6);
    this.throttleRateOpen = clamp01(throttleRateOpen, 0.5);
    this.latencyOpenMs = Math.max(1000, Number(latencyOpenMs) || 120000);
    this.cooldownMinutes = Math.max(1, Number(cooldownMinutes) || 20);
  }

  async state(providerId) {
    const raw = await this.statsStore.get(providerId);
    const stats = summarizeProviderStats(raw);
    const recent = Array.isArray(raw.recent) ? raw.recent.slice(-this.minSamples) : [];
    const recentFailures = recent.filter((item) => item.generationFailed).length;
    const recentThrottles = recent.filter((item) => item.throttled).length;
    const recentLatencies = recent
      .map((item) => Number(item.latencyMs))
      .filter(Number.isFinite);

    const enoughSamples = recent.length >= this.minSamples;
    const failureRate = recent.length ? recentFailures / recent.length : 0;
    const throttleRate = recent.length ? recentThrottles / recent.length : 0;
    const averageLatencyMs = recentLatencies.length
      ? recentLatencies.reduce((sum, value) => sum + value, 0) / recentLatencies.length
      : stats.averageLatencyMs;

    const reasons = [];
    if (enoughSamples && failureRate >= this.failureRateOpen) reasons.push('failure-rate');
    if (enoughSamples && throttleRate >= this.throttleRateOpen) reasons.push('throttle-rate');
    if (enoughSamples && Number.isFinite(averageLatencyMs) && averageLatencyMs >= this.latencyOpenMs) {
      reasons.push('latency');
    }

    const updatedAt = Date.parse(raw.updatedAt || '');
    const cooldownExpired = !Number.isFinite(updatedAt)
      || this.now().getTime() - updatedAt >= this.cooldownMinutes * 60000;

    return {
      providerId,
      state: reasons.length && !cooldownExpired ? 'OPEN' : 'CLOSED',
      reasons,
      samples: recent.length,
      recentFailureRate: round(failureRate, 4),
      recentThrottleRate: round(throttleRate, 4),
      recentAverageLatencyMs: Number.isFinite(averageLatencyMs) ? round(averageLatencyMs, 2) : null,
      cooldownExpired,
      updatedAt: raw.updatedAt || null,
    };
  }

  async isAvailable(providerId) {
    return (await this.state(providerId)).state !== 'OPEN';
  }

  async snapshot(providerIds = []) {
    const states = {};
    for (const providerId of providerIds) states[providerId] = await this.state(providerId);
    return states;
  }
}

function clamp01(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}
