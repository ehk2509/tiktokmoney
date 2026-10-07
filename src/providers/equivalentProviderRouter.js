export class EquivalentProviderRouter {
  constructor({
    providers = [],
    statsStore,
    reliabilityService,
    capability = 'provider',
  } = {}) {
    this.providers = providers.filter((entry) => entry?.provider);
    if (!this.providers.length) throw new Error(`${capability} router requires at least one provider`);
    this.statsStore = statsStore;
    this.reliabilityService = reliabilityService;
    this.capability = capability;
    this.primary = this.providers[0].provider;
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
      candidates.push({ ...entry, reliability: state });
    }

    if (!candidates.length) {
      throw new Error(`all equivalent ${this.capability} providers are unavailable for ${method}`);
    }

    const failures = [];
    for (const candidate of candidates) {
      const startedAt = Date.now();
      try {
        const result = await candidate.provider[method](...args);
        await this.record(candidate.id, {
          generationFailed: false,
          passed: true,
          latencyMs: Date.now() - startedAt,
          throttled: false,
        });
        return annotate(result, candidate.id, this.capability);
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

  async reliabilitySnapshot() {
    const states = {};
    for (const entry of this.providers) {
      states[entry.id] = this.reliabilityService
        ? await this.reliabilityService.state(entry.id)
        : { providerId: entry.id, state: 'UNKNOWN', reasons: [] };
    }
    return states;
  }

  async record(id, outcome) {
    if (!this.statsStore?.record) return;
    await this.statsStore.record(id, outcome);
  }
}

function annotate(result, providerId, capability) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  return {
    ...result,
    providerRouting: {
      capability,
      providerId,
    },
  };
}

function isThrottleError(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  if (status === 429) return true;
  return /rate limit|too many requests|throttl|quota/i.test(String(error?.message || ''));
}
