export class VideoModelRouter {
  constructor({
    providers = [],
    referenceProvider = null,
    statsStore = null,
    reliabilityService = null,
    costWeight = Number(process.env.VIDEO_ROUTER_COST_WEIGHT || 16),
    historyWeight = Number(process.env.VIDEO_ROUTER_HISTORY_WEIGHT || 22),
    switchOnQcFailure = parseBoolean(process.env.VIDEO_ROUTER_SWITCH_ON_QC_FAILURE, true),
  } = {}) {
    this.providers = providers.filter(Boolean);
    this.referenceProvider = referenceProvider || this.providers.find((provider) => provider.prepareSceneReference);
    this.statsStore = statsStore;
    this.reliabilityService = reliabilityService;
    this.costWeight = Number(costWeight) || 0;
    this.historyWeight = Number(historyWeight) || 0;
    this.switchOnQcFailure = Boolean(switchOnQcFailure);
    this.strategy = this.providers.length > 1 ? 'multi-model-ai-router' : 'ai-first';
  }

  async prepareStoryBible(storyBible, context = {}) {
    if (!this.referenceProvider?.prepareStoryBible) return storyBible;
    return this.referenceProvider.prepareStoryBible(storyBible, context);
  }

  async resolveScene(scene, context = {}) {
    if (!this.providers.length) return null;

    const sceneClass = classifyScene(scene);
    const ranked = await this.rank(scene, sceneClass, context);
    const errors = [];

    let reference = null;
    if (this.referenceProvider?.prepareSceneReference) {
      reference = await this.referenceProvider.prepareSceneReference(scene, context);
    }

    for (const candidate of ranked) {
      const startedAt = Date.now();
      try {
        let asset;
        if (reference && candidate.provider.animateReference) {
          asset = await candidate.provider.animateReference(scene, reference, context);
        } else {
          asset = await candidate.provider.resolveScene(scene, context);
        }

        if (!asset) continue;

        return {
          ...asset,
          sceneClass,
          estimatedCostUsd: candidate.estimatedCostUsd,
          routing: {
            selected: 'ai-video',
            providerId: candidate.id,
            score: round(candidate.score),
            sceneClass,
            estimatedCostUsd: candidate.estimatedCostUsd,
            latencyMs: Date.now() - startedAt,
            candidates: ranked.map((item) => ({
              providerId: item.id,
              score: round(item.score),
              estimatedCostUsd: item.estimatedCostUsd,
            })),
          },
        };
      } catch (error) {
        errors.push({ providerId: candidate.id, message: error.message });
        await this.recordGenerationFailure(candidate, sceneClass, {
          latencyMs: Date.now() - startedAt,
          throttled: isThrottleError(error),
        });
      }
    }

    const detail = errors.map((error) => `${error.providerId}: ${error.message}`).join('; ');
    throw new Error(`all AI video providers failed${detail ? `: ${detail}` : ''}`);
  }

  async resolveFallbackScene() {
    return null;
  }

  async recordOutcome(scene, asset, qc) {
    const providerId = asset?.routing?.providerId || asset?.providerModelId;
    if (!providerId || !this.statsStore) return;

    await this.statsStore.record(providerId, {
      sceneClass: asset.sceneClass || classifyScene(scene),
      passed: Boolean(qc?.passed),
      overallScore: qc?.overallScore,
      temporalScore: qc?.temporalScore,
      estimatedCostUsd: asset.estimatedCostUsd,
      latencyMs: asset?.routing?.latencyMs,
      generationFailed: false,
    });
  }

  async rank(scene, sceneClass, context) {
    const results = [];

    for (const provider of this.providers) {
      const profile = provider.profile || {};
      const id = profile.id || provider.id || provider.constructor.name;
      const reliability = this.reliabilityService
        ? await this.reliabilityService.state(id)
        : null;
      if (reliability?.state === 'OPEN') continue;
      const estimatedCostUsd = estimateCost(provider, scene);
      const history = this.statsStore ? await this.statsStore.get(id) : null;
      const bucket = history ? summarize(history, sceneClass) : null;

      let score = capabilityScore(profile, sceneClass);
      score += historyScore(bucket) * this.historyWeight;
      score -= estimatedCostUsd * this.costWeight;

      if (
        this.switchOnQcFailure
        && context.regeneration?.previousProviderId
        && context.regeneration.previousProviderId === id
      ) {
        score -= 28;
      }

      if (context.regeneration?.issues?.some((issue) => issue.code?.includes('face'))
        && profile.strengths?.human != null) {
        score += Number(profile.strengths.human) * 8;
      }

      results.push({
        provider,
        id,
        score,
        estimatedCostUsd,
        history: bucket,
        reliability,
      });
    }

    return results.sort((a, b) => b.score - a.score);
  }

  async recordGenerationFailure(candidate, sceneClass, {
    latencyMs = null,
    throttled = false,
  } = {}) {
    if (!this.statsStore) return;
    await this.statsStore.record(candidate.id, {
      sceneClass,
      passed: false,
      generationFailed: true,
      throttled,
      latencyMs,
      estimatedCostUsd: 0,
    });
  }
}

export function classifyScene(scene) {
  const text = `${scene.narration || ''} ${scene.realism?.motionPrompt || ''}`.toLowerCase();
  const hasCharacters = Boolean(scene.continuity?.characterIds?.length);

  if (hasCharacters || /person|people|human|face|pilot|woman|man|child|creator|speaker|worker/.test(text)) {
    if (/run|running|fight|jump|dance|sport|chase|fast|explosion|crash|drive|driving/.test(text)) {
      return 'human-action';
    }
    return 'human';
  }

  if (/product|phone|bottle|device|shoe|watch|car|object|machine/.test(text)) return 'object';
  if (/run|moving|motion|fly|flying|drive|driving|water|fire|storm|explosion/.test(text)) return 'action';
  if (/landscape|city|street|room|office|cockpit|building|nature|mountain|ocean|environment/.test(text)) return 'environment';
  return 'general';
}

function capabilityScore(profile, sceneClass) {
  const strengths = profile.strengths || {};
  const mapping = {
    human: 'human',
    'human-action': 'action',
    action: 'action',
    environment: 'environment',
    object: 'object',
    general: 'general',
  };
  const key = mapping[sceneClass] || 'general';
  const primary = Number(strengths[key] ?? strengths.general ?? 0.75);
  const continuity = Number(strengths.continuity ?? 0.75);
  const temporal = Number(strengths.temporal ?? 0.75);
  return (primary * 55) + (continuity * 22) + (temporal * 23);
}

function historyScore(stats) {
  if (!stats || !stats.attempts) return 0;
  const pass = stats.passRate == null ? 0.5 : stats.passRate;
  const staticScore = (stats.averageStaticScore ?? 75) / 100;
  const temporalScore = (stats.averageTemporalScore ?? 75) / 100;
  const failurePenalty = stats.generationFailureRate ?? 0;
  return ((pass * 0.5) + (staticScore * 0.22) + (temporalScore * 0.28)) - (failurePenalty * 0.5);
}

function estimateCost(provider, scene) {
  if (typeof provider.estimateCostUsd === 'function') {
    return Math.max(0, Number(provider.estimateCostUsd(scene)) || 0);
  }
  return Math.max(0, Number(provider.profile?.estimatedCostUsd5s) || 0);
}

function summarize(raw, sceneClass) {
  const bucket = raw.sceneClasses?.[sceneClass];
  const source = bucket || raw;
  return {
    attempts: source.attempts || 0,
    passRate: source.attempts ? (source.passes || 0) / source.attempts : null,
    averageStaticScore: source.staticScoreCount
      ? source.staticScoreTotal / source.staticScoreCount
      : null,
    averageTemporalScore: source.temporalScoreCount
      ? source.temporalScoreTotal / source.temporalScoreCount
      : null,
    generationFailureRate: raw.attempts ? (raw.generationFailures || 0) / raw.attempts : null,
  };
}

function parseBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}


function isThrottleError(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  if (status === 429) return true;
  return /rate limit|too many requests|throttl|quota/i.test(String(error?.message || ''));
}
