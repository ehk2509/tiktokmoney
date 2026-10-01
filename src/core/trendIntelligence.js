import crypto from 'node:crypto';
import { rankOpportunities } from './opportunityScorer.js';
import { buildResearchPacket } from './researchPacketBuilder.js';

export class TrendIntelligence {
  constructor({
    providers = [],
    historyStore = null,
    clusterThreshold = Number(process.env.TREND_CLUSTER_THRESHOLD || 0.52),
    maxSignals = Number(process.env.TREND_MAX_SIGNALS || 120),
  } = {}) {
    this.providers = providers.filter(Boolean);
    this.historyStore = historyStore;
    this.clusterThreshold = clampRatio(clusterThreshold, 0.52);
    this.maxSignals = Math.max(10, Math.min(500, Number(maxSignals) || 120));
    this.lastOpportunities = [];
  }

  async list() {
    const settled = await Promise.allSettled(
      this.providers.map((provider) => provider.list()),
    );
    const signals = settled
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .filter(validSignal)
      .slice(0, this.maxSignals);

    const providerErrors = settled
      .map((result, index) => result.status === 'rejected'
        ? {
          provider: this.providers[index]?.id || this.providers[index]?.constructor?.name || `provider-${index}`,
          message: result.reason?.message || String(result.reason),
        }
        : null)
      .filter(Boolean);

    const clusters = clusterTrendSignals(signals, {
      threshold: this.clusterThreshold,
    });
    const historical = this.historyStore
      ? await this.historyStore.enrich(clusters)
      : clusters.map((cluster) => ({ ...cluster, velocity: cluster.strength, acceleration: 50 }));

    const opportunities = rankOpportunities(
      historical.map((cluster) => clusterToOpportunity(cluster)),
    ).map((opportunity) => ({
      ...opportunity,
      researchPacket: buildResearchPacket({
        topic: opportunity.topic,
        cluster: opportunity,
      }),
      providerErrors,
    }));

    this.lastOpportunities = opportunities;
    return opportunities;
  }

  async research(topic) {
    const normalizedTopic = normalizeText(topic);
    let signals = [];

    const searched = await Promise.allSettled(
      this.providers.map(async (provider) => {
        if (typeof provider.search === 'function') return provider.search(topic);
        const listed = await provider.list();
        return listed.filter((signal) => similarity(normalizedTopic, normalizeText(signal.topic)) >= 0.2);
      }),
    );
    signals = searched
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .filter(validSignal)
      .slice(0, 40);

    if (!signals.length && this.lastOpportunities.length) {
      const best = this.lastOpportunities
        .map((item) => ({ item, score: similarity(normalizedTopic, normalizeText(item.topic)) }))
        .sort((a, b) => b.score - a.score)[0];
      if (best?.score >= 0.2) return best.item.researchPacket;
    }

    const clusters = clusterTrendSignals(signals, {
      threshold: Math.max(0.35, this.clusterThreshold - 0.12),
    });
    const bestCluster = clusters
      .map((cluster) => ({
        cluster,
        score: Math.max(
          similarity(normalizedTopic, normalizeText(cluster.topic)),
          ...cluster.signals.map((signal) => similarity(normalizedTopic, normalizeText(signal.topic))),
        ),
      }))
      .sort((a, b) => b.score - a.score)[0]?.cluster || null;

    return buildResearchPacket({
      topic,
      cluster: bestCluster,
      signals,
    });
  }
}

export function clusterTrendSignals(signals, { threshold = 0.52 } = {}) {
  const sorted = [...signals]
    .filter(validSignal)
    .sort((a, b) => Number(b.strength || 0) - Number(a.strength || 0));
  const clusters = [];

  for (const signal of sorted) {
    const text = normalizeText(signal.topic || signal.title);
    let best = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      const score = Math.max(
        similarity(text, cluster.normalizedTopic),
        ...cluster.signals.map((item) => similarity(text, normalizeText(item.topic || item.title))),
      );
      if (score > bestScore) {
        best = cluster;
        bestScore = score;
      }
    }

    if (best && bestScore >= threshold) {
      best.signals.push(signal);
      best.sourceNames.add(signal.source);
      best.strength = clusterStrength(best.signals);
      if (Number(signal.strength) > Number(best.lead.strength)) {
        best.lead = signal;
        best.topic = cleanTopic(signal.topic || signal.title);
        best.normalizedTopic = normalizeText(best.topic);
      }
    } else {
      const topic = cleanTopic(signal.topic || signal.title);
      clusters.push({
        clusterKey: stableKey(topic),
        topic,
        normalizedTopic: normalizeText(topic),
        lead: signal,
        signals: [signal],
        sourceNames: new Set([signal.source]),
        strength: clamp(signal.strength),
      });
    }
  }

  return clusters.map((cluster) => ({
    clusterKey: cluster.clusterKey,
    topic: cluster.topic,
    strength: round(clusterStrength(cluster.signals)),
    sourceCount: cluster.sourceNames.size,
    sourceNames: [...cluster.sourceNames],
    signals: cluster.signals,
    firstPublishedAt: minDate(cluster.signals.map((item) => item.publishedAt)),
    latestPublishedAt: maxDate(cluster.signals.map((item) => item.publishedAt)),
  }));
}

function clusterToOpportunity(cluster) {
  const sourceDiversity = Math.min(100, cluster.sourceCount * 24);
  const evidenceCount = cluster.signals.length;
  const freshness = freshnessScore(cluster.latestPublishedAt);
  const averageStrength = average(cluster.signals.map((item) => item.strength));
  const saturation = clamp(Math.min(90, evidenceCount * 7 + Math.max(0, averageStrength - 75)));
  const novelty = clamp(88 - Math.min(55, saturation * 0.45) + sourceDiversity * 0.15);
  const contentPotential = clamp(50 + freshness * 0.2 + sourceDiversity * 0.18 + averageStrength * 0.2);
  const feasibility = clamp(88 - (String(cluster.topic).length > 120 ? 10 : 0));

  return {
    id: `trend-${cluster.clusterKey}`,
    clusterKey: cluster.clusterKey,
    topic: cluster.topic,
    source: cluster.sourceNames.join('+'),
    sourceNames: cluster.sourceNames,
    sourceCount: cluster.sourceCount,
    signals: cluster.signals,
    strength: cluster.strength,
    velocity: cluster.velocity,
    acceleration: cluster.acceleration,
    history: cluster.history,
    audienceFit: 72,
    novelty,
    contentPotential,
    monetization: 65,
    feasibility,
    saturation,
    copyrightRisk: 12,
    misinformationRisk: cluster.sourceCount >= 2 ? 12 : 24,
  };
}

function validSignal(signal) {
  return Boolean(signal && signal.source && (signal.topic || signal.title));
}

function clusterStrength(signals) {
  if (!signals.length) return 0;
  const strengths = signals.map((item) => clamp(item.strength)).sort((a, b) => b - a);
  const max = strengths[0] || 0;
  const mean = average(strengths);
  const diversity = new Set(signals.map((item) => item.source)).size;
  return clamp(max * 0.65 + mean * 0.25 + Math.min(10, (diversity - 1) * 4));
}

export function similarity(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = new Set([...left, ...right]).size;
  const jaccard = intersection / union;
  const containment = intersection / Math.min(left.size, right.size);
  return Math.max(jaccard, containment * 0.85);
}

function tokenSet(value) {
  return new Set(
    normalizeText(value)
      .split(' ')
      .filter((token) => token.length > 2 && !STOPWORDS.has(token)),
  );
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTopic(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function stableKey(value) {
  return crypto.createHash('sha1').update(normalizeText(value)).digest('hex').slice(0, 14);
}

function freshnessScore(value) {
  const timestamp = Date.parse(value);
  if (!timestamp) return 50;
  const hours = Math.max(0, (Date.now() - timestamp) / 3600000);
  return clamp(100 - hours * 2.5);
}

function minDate(values) {
  const valid = values.map(Date.parse).filter(Number.isFinite);
  return valid.length ? new Date(Math.min(...valid)).toISOString() : null;
}

function maxDate(values) {
  const valid = values.map(Date.parse).filter(Number.isFinite);
  return valid.length ? new Date(Math.max(...valid)).toISOString() : null;
}

function average(values) {
  const valid = values.map(Number).filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function clamp(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function clampRatio(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

const STOPWORDS = new Set([
  'the','and','for','with','from','that','this','are','was','were','has','have','had',
  'into','about','after','before','over','under','why','how','what','when','where','who',
  'les','des','une','dans','pour','avec','sur','est','sont','qui','que','aux','du','de',
]);
