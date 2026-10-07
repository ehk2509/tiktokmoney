export class PerformanceLearningService {
  constructor({ store, projectStore, minSamples = Number(process.env.PERFORMANCE_LEARNING_MIN_SAMPLES || 2) } = {}) {
    if (!store) throw new Error('performance learning requires a store');
    if (!projectStore) throw new Error('performance learning requires a project store');
    this.store = store;
    this.projectStore = projectStore;
    this.minSamples = Math.max(1, Number(minSamples) || 2);
  }

  async recordPublication(publication) {
    const snapshot = publication?.metricsSnapshots?.at(-1);
    if (!snapshot?.videos?.length) return null;
    const project = await this.projectStore.getProject(publication.projectId);
    if (!project) return null;

    const metrics = aggregateVideos(snapshot.videos);
    const creative = project.creativeBrief || project.creativeTournament?.winner || {};
    const ledger = project.costLedger || {};
    const outcome = {
      id: `outcome_${publication.id}_${snapshot.capturedAt}`,
      publicationId: publication.id,
      projectId: project.id,
      postIds: publication.postIds || [],
      capturedAt: snapshot.capturedAt,
      topic: project.topic || null,
      audience: project.audience || null,
      creative: {
        candidateId: creative.id || null,
        format: clean(creative.format),
        emotionalDriver: clean(creative.emotionalDriver),
        angle: clean(creative.angle),
        hook: clean(creative.hook),
        retentionDevice: clean(creative.retentionDevice),
      },
      metrics,
      cost: {
        actualCostUsd: ledger.costUsdComplete ? numberOrNull(ledger.costUsd) : null,
        observedCostUsd: numberOrNull(ledger.costUsdObserved),
        complete: ledger.costUsdComplete === true,
        costPerThousandViewsUsd: ledger.costUsdComplete && metrics.viewCount > 0
          ? round((Number(ledger.costUsd) / metrics.viewCount) * 1000, 6)
          : null,
      },
      evidence: {
        metricsSource: 'tiktok-api',
        costSource: ledger.source || 'unavailable',
      },
    };
    await this.store.saveOutcome(outcome);
    return outcome;
  }

  async contextFor({ topic = null, audience = null } = {}) {
    const outcomes = await this.store.listOutcomes({ limit: 2000 });
    const relevant = outcomes.filter((item) => (
      (!audience || !item.audience || item.audience === audience)
      && item.metrics?.viewCount != null
    ));

    return {
      sampleCount: relevant.length,
      minimumSamples: this.minSamples,
      format: aggregateDimension(relevant, 'format', this.minSamples),
      emotionalDriver: aggregateDimension(relevant, 'emotionalDriver', this.minSamples),
      topic,
      audience,
    };
  }
}

function aggregateVideos(videos) {
  const viewCount = sum(videos, 'viewCount');
  const likeCount = sum(videos, 'likeCount');
  const commentCount = sum(videos, 'commentCount');
  const shareCount = sum(videos, 'shareCount');
  const engagementCount = likeCount + commentCount + shareCount;
  return {
    viewCount,
    likeCount,
    commentCount,
    shareCount,
    engagementCount,
    engagementRate: viewCount > 0 ? round(engagementCount / viewCount, 6) : null,
  };
}

function aggregateDimension(outcomes, key, minSamples) {
  const groups = new Map();
  for (const outcome of outcomes) {
    const value = clean(outcome.creative?.[key]);
    if (!value) continue;
    const current = groups.get(value) || [];
    current.push(outcome);
    groups.set(value, current);
  }

  return Object.fromEntries([...groups.entries()].map(([value, rows]) => {
    const views = rows.map((row) => Number(row.metrics?.viewCount) || 0);
    const engagements = rows
      .map((row) => row.metrics?.engagementRate)
      .filter(Number.isFinite);
    return [value, {
      samples: rows.length,
      eligible: rows.length >= minSamples,
      averageViews: round(average(views), 2),
      averageEngagementRate: engagements.length ? round(average(engagements), 6) : null,
      score: rows.length >= minSamples
        ? round(performanceScore(views, engagements), 4)
        : null,
    }];
  }));
}

function performanceScore(views, engagements) {
  const avgViews = average(views);
  const avgEngagement = engagements.length ? average(engagements) : 0;
  return Math.log10(1 + avgViews) + Math.min(0.25, avgEngagement) * 8;
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (Number(row?.[key]) || 0), 0);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function clean(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}
