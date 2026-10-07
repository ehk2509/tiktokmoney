export class EquivalentProviderRouter {
  constructor({
    providers = [],
    statsStore,
    reliabilityService,
    capability = 'provider',
    minRankingSamples = Number(process.env.PROVIDER_RANKING_MIN_SAMPLES || 3),
    successWeight = Number(process.env.PROVIDER_ROUTING_SUCCESS_WEIGHT || 0.45),
    qualityWeight = Number(process.env.PROVIDER_ROUTING_QUALITY_WEIGHT || 0.20),
    latencyWeight = Number(process.env.PROVIDER_ROUTING_LATENCY_WEIGHT || 0.15),
    costWeight = Number(process.env.PROVIDER_ROUTING_COST_WEIGHT || 0.20),
    explorationRate = Number(process.env.PROVIDER_ROUTING_EXPLORATION_RATE || 0.05),
    maxLatencyReferenceMs = Number(process.env.PROVIDER_ROUTING_LATENCY_REFERENCE_MS || 60000),
    maxCostReferenceUsd = Number(process.env.PROVIDER_ROUTING_COST_REFERENCE_USD || 1),
    random = Math.random,
  } = {}) {
    this.providers = providers.filter((entry) => entry?.provider);
    if (!this.providers.length) throw new Error(`${capability} router requires at least one provider`);
    this.statsStore = statsStore;
    this.reliabilityService = reliabilityService;
    this.capability = capability;
    this.primary = this.providers[0].provider;
    this.minRankingSamples = Math.max(1, Number(minRankingSamples) || 3);
    this.successWeight = Math.max(0, Number(successWeight) || 0);
    this.qualityWeight = Math.max(0, Number(qualityWeight) || 0);
    this.latencyWeight = Math.max(0, Number(latencyWeight) || 0);
    this.costWeight = Math.max(0, Number(costWeight) || 0);
    this.explorationRate = clamp01(explorationRate, 0.05);
    this.maxLatencyReferenceMs = Math.max(1000, Number(maxLatencyReferenceMs) || 60000);
    this.maxCostReferenceUsd = Math.max(0.000001, Number(maxCostReferenceUsd) || 1);
    this.random = random;
  }

  get model() { return this.primary?.model || null; }
  get judgeModel() { return this.primary?.judgeModel || this.model; }
  get threshold() { return this.primary?.threshold; }
  get temporalThreshold() { return this.primary?.temporalThreshold; }
  get temporalEnabled() { return this.primary?.temporalEnabled; }
  get failClosed() { return this.primary?.failClosed; }
  get maxRegenerations() { return this.primary?.maxRegenerations; }
  get minScore() { return this.primary?.minScore; }
  get voiceId() { return this.primary?.voiceId; }
  get modelId() { return this.primary?.modelId; }

  async generateStructuredScript(args) { return this.invoke('generateStructuredScript', [args]); }
  async generateCreativeCandidates(args) { return this.invoke('generateCreativeCandidates', [args]); }
  async judgeCreativeCandidates(args) { return this.invoke('judgeCreativeCandidates', [args]); }
  async generateProductionScript(args) { return this.invoke('generateProductionScript', [args]); }
  async reviewProductionPlan(args) { return this.invoke('reviewProductionPlan', [args]); }
  async generateStoryBible(args) { return this.invoke('generateStoryBible', [args]); }
  async generateJson(args) { return this.invoke('generateJson', [args]); }
  async evaluate(...args) { return this.invoke('evaluate', args); }
  async evaluateScene(...args) { return this.invoke('evaluateScene', args); }
  async synthesize(...args) { return this.invoke('synthesize', args); }

  async invoke(method, args) {
    const candidates = [];
    for (const entry of this.providers) {
      if (typeof entry.provider?.[method] !== 'function') continue;
      const state = this.reliabilityService
        ? await this.reliabilityService.state(entry.id)
        : null;
      if (state?.state === 'OPEN') continue;
      const stats = this.statsStore?.get ? await this.statsStore.get(entry.id) : null;
      candidates.push({
        ...entry,
        reliability: state,
        stats,
      });
    }

    if (!candidates.length) {
      throw new Error(`all equivalent ${this.capability} providers are unavailable for ${method}`);
    }

    const ranked = this.rankCandidates(candidates);
    const failures = [];
    for (const candidate of ranked) {
      const startedAt = Date.now();
      try {
        const result = await candidate.provider[method](...args);
        const actualCostUsd = extractObservedCostUsd(result);
        const qualityScore = extractQualityScore(result);
        await this.record(candidate.id, {
          generationFailed: false,
          passed: true,
          latencyMs: Date.now() - startedAt,
          throttled: false,
          actualCostUsd,
          qualityScore,
        });
        return annotate(result, candidate.id, this.capability, {
          score: candidate.routingScore,
          explored: Boolean(candidate.explored),
          evidence: candidate.routingEvidence,
        });
      } catch (error) {
        failures.push({ providerId: candidate.id, message: error.message });
        await this.record(candidate.id, {
          generationFailed: true,
          passed: false,
          latencyMs: Date.now() - startedAt,
          throttled: isThrottleError(error),
        });
      }
    }

    const detail = failures.map((item) => `${item.providerId}: ${item.message}`).join('; ');
    throw new Error(`all equivalent ${this.capability} providers failed${detail ? `: ${detail}` : ''}`);
  }

  rankCandidates(candidates) {
    const scored = candidates.map((candidate, index) => {
      const summary = summarizeStats(candidate.stats);
      const evidence = Math.max(
        Number(summary.attempts) || 0,
        Array.isArray(summary.recent) ? summary.recent.length : 0,
      );
      const hasEvidence = evidence >= this.minRankingSamples;
      const success = summary.passRate == null ? 0.5 : clamp01(summary.passRate, 0.5);
      const quality = summary.averageQualityScore == null
        ? 0.5
        : clamp01(summary.averageQualityScore / 100, 0.5);
      const latency = summary.averageLatencyMs == null
        ? 0.5
        : 1 - clamp01(summary.averageLatencyMs / this.maxLatencyReferenceMs, 0.5);
      const cost = summary.costPerSuccessfulOutputUsd == null
        ? 0.5
        : 1 - clamp01(summary.costPerSuccessfulOutputUsd / this.maxCostReferenceUsd, 0.5);

      const totalWeight = this.successWeight
        + this.qualityWeight
        + this.latencyWeight
        + this.costWeight || 1;
      const score = hasEvidence
        ? (
          success * this.successWeight
          + quality * this.qualityWeight
          + latency * this.latencyWeight
          + cost * this.costWeight
        ) / totalWeight
        : 0.5 - (index * 0.0001);

      return {
        ...candidate,
        routingScore: round(score, 6),
        routingEvidence: {
          attempts: summary.attempts || 0,
          success,
          quality,
          latency,
          cost,
          averageLatencyMs: summary.averageLatencyMs ?? null,
          costPerSuccessfulOutputUsd: summary.costPerSuccessfulOutputUsd ?? null,
          averageQualityScore: summary.averageQualityScore ?? null,
          hasEnoughSamples: hasEvidence,
        },
      };
    }).sort((a, b) => b.routingScore - a.routingScore);

    const evidenceReady = scored.length > 1
      && scored.every((candidate) => candidate.routingEvidence.hasEnoughSamples);
    if (evidenceReady && this.random() < this.explorationRate) {
      const exploreIndex = 1 + Math.floor(this.random() * (scored.length - 1));
      const [explored] = scored.splice(exploreIndex, 1);
      explored.explored = true;
      scored.unshift(explored);
    }

    return scored;
  }

  async recordOutcome(routedResult, {
    qualityScore = null,
    passed = true,
    actualCostUsd = null,
  } = {}) {
    const providerId = routedResult?.providerRouting?.providerId;
    if (!providerId) return null;
    const outcome = {
      generationFailed: false,
      passed: Boolean(passed),
      qualityScore: Number.isFinite(Number(qualityScore)) ? Number(qualityScore) : null,
      actualCostUsd: Number.isFinite(Number(actualCostUsd)) ? Number(actualCostUsd) : null,
    };
    if (this.statsStore?.recordFeedback) {
      return this.statsStore.recordFeedback(providerId, outcome);
    }
    return this.record(providerId, outcome);
  }

  async reliabilitySnapshot() {
    const candidates = [];
    for (const entry of this.providers) {
      const reliability = this.reliabilityService
        ? await this.reliabilityService.state(entry.id)
        : { providerId: entry.id, state: 'UNKNOWN', reasons: [] };
      const stats = this.statsStore?.get ? await this.statsStore.get(entry.id) : null;
      candidates.push({ ...entry, reliability, stats });
    }

    const rankedClosed = this.rankCandidates(
      candidates.filter((candidate) => candidate.reliability?.state !== 'OPEN'),
    );
    const scoreById = new Map(rankedClosed.map((candidate) => [candidate.id, candidate]));

    const states = {};
    for (const candidate of candidates) {
      const ranked = scoreById.get(candidate.id);
      states[candidate.id] = {
        ...candidate.reliability,
        routingScore: ranked?.routingScore ?? null,
        routingEvidence: ranked?.routingEvidence ?? null,
      };
    }
    return states;
  }

  async record(id, outcome) {
    if (!this.statsStore?.record) return;
    await this.statsStore.record(id, outcome);
  }
}

function annotate(result, providerId, capability, routing = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  return {
    ...result,
    providerRouting: {
      capability,
      providerId,
      ...routing,
    },
  };
}

function isThrottleError(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  if (status === 429) return true;
  return /rate limit|too many requests|throttl|quota/i.test(String(error?.message || ''));
}


function summarizeStats(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const attempts = Number(raw.attempts) || 0;
  const passes = Number(raw.passes) || 0;
  const latencyCount = Number(raw.latencyCount) || 0;
  const actualCostCount = Number(raw.actualCostCount) || 0;
  const successCostCount = Number(raw.successCostCount) || 0;
  const qualityScoreCount = Number(raw.qualityScoreCount) || 0;

  return {
    attempts,
    passRate: attempts ? passes / attempts : null,
    averageLatencyMs: latencyCount ? Number(raw.latencyMsTotal || 0) / latencyCount : null,
    costPerSuccessfulOutputUsd: successCostCount
      ? Number(raw.successCostUsdObserved || 0) / successCostCount
      : null,
    averageQualityScore: qualityScoreCount
      ? Number(raw.qualityScoreTotal || 0) / qualityScoreCount
      : null,
    recent: Array.isArray(raw.recent) ? raw.recent : [],
    actualCostCount,
  };
}

function extractObservedCostUsd(result) {
  const usage = result?.providerUsage;
  const value = Number(usage?.costUsd);
  return Number.isFinite(value) ? value : null;
}

function extractQualityScore(result) {
  const value = Number(
    result?.providerQualityScore
      ?? result?.providerRoutingQualityScore,
  );
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

function clamp01(value, fallback = 0.5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}
