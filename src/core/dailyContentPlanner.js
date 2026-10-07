import crypto from 'node:crypto';
import { similarity } from './trendIntelligence.js';
import { reconcileEstimatedCost } from '../services/costLedger.js';

export class DailyContentPlanner {
  constructor({
    opportunitySource,
    store,
    dailyBudgetUsd = Number(process.env.DAILY_CONTENT_BUDGET_USD || 6),
    maxVideos = Number(process.env.DAILY_CONTENT_MAX_VIDEOS || 3),
    minOpportunityScore = Number(process.env.DAILY_CONTENT_MIN_OPPORTUNITY_SCORE || 52),
    minEvidenceCount = Number(process.env.DAILY_CONTENT_MIN_EVIDENCE || 1),
    estimatedVideoCostUsd = Number(process.env.DAILY_CONTENT_ESTIMATED_VIDEO_COST_USD || 1.5),
    recentTopicDays = Number(process.env.DAILY_CONTENT_TOPIC_COOLDOWN_DAYS || 7),
    topicSimilarityThreshold = Number(process.env.DAILY_CONTENT_TOPIC_SIMILARITY || 0.52),
    highConvictionScore = Number(process.env.DAILY_CONTENT_HIGH_CONVICTION_SCORE || 78),
    highConvictionAcceleration = Number(process.env.DAILY_CONTENT_HIGH_CONVICTION_ACCELERATION || 62),
    maxVideosPerOpportunity = Number(process.env.DAILY_CONTENT_MAX_VIDEOS_PER_OPPORTUNITY || 2),
  } = {}) {
    if (!opportunitySource?.list && typeof opportunitySource !== 'function') {
      throw new Error('daily content planner requires an opportunity source');
    }
    if (!store) throw new Error('daily content planner requires a store');

    this.opportunitySource = opportunitySource;
    this.store = store;
    this.dailyBudgetUsd = positive(dailyBudgetUsd, 6);
    this.maxVideos = clampInt(maxVideos, 1, 20, 3);
    this.minOpportunityScore = clampScore(minOpportunityScore, 52);
    this.minEvidenceCount = clampInt(minEvidenceCount, 0, 20, 1);
    this.estimatedVideoCostUsd = positive(estimatedVideoCostUsd, 1.5);
    this.recentTopicDays = clampInt(recentTopicDays, 1, 90, 7);
    this.topicSimilarityThreshold = clampRatio(topicSimilarityThreshold, 0.52);
    this.highConvictionScore = clampScore(highConvictionScore, 78);
    this.highConvictionAcceleration = clampScore(highConvictionAcceleration, 62);
    this.maxVideosPerOpportunity = clampInt(maxVideosPerOpportunity, 1, 4, 2);
  }

  async createPlan({
    date = new Date().toISOString().slice(0, 10),
    budgetUsd = this.dailyBudgetUsd,
    maxVideos = this.maxVideos,
    audience = 'curious adults',
    durationSeconds = 35,
    render = true,
  } = {}) {
    const budget = positive(budgetUsd, this.dailyBudgetUsd);
    const videoLimit = clampInt(maxVideos, 1, 20, this.maxVideos);
    const opportunities = await this.loadOpportunities();
    const recentTopics = await this.store.recentTopics({
      days: this.recentTopicDays,
      now: new Date(`${date}T23:59:59.999Z`),
    });

    const considered = opportunities.map((opportunity) => {
      const evidenceCount = opportunity.researchPacket?.evidence?.length
        ?? opportunity.signals?.length
        ?? 0;
      const recentMatch = closestRecentTopic(opportunity.topic, recentTopics);
      const repeated = recentMatch && recentMatch.similarity >= this.topicSimilarityThreshold;
      const eligible = Number(opportunity.opportunityScore) >= this.minOpportunityScore
        && evidenceCount >= this.minEvidenceCount
        && !repeated;

      return {
        opportunity,
        evidenceCount,
        repeated,
        recentMatch,
        eligible,
        rejectionReasons: [
          Number(opportunity.opportunityScore) < this.minOpportunityScore
            ? `score below ${this.minOpportunityScore}`
            : null,
          evidenceCount < this.minEvidenceCount
            ? `evidence below ${this.minEvidenceCount}`
            : null,
          repeated
            ? `recent-topic similarity ${round(recentMatch.similarity)} >= ${this.topicSimilarityThreshold}`
            : null,
        ].filter(Boolean),
      };
    });

    const jobs = [];
    let committed = 0;

    for (const item of considered.filter((entry) => entry.eligible)) {
      if (jobs.length >= videoLimit) break;

      const opportunity = item.opportunity;
      const plannedCostUsd = estimateCost(opportunity, this.estimatedVideoCostUsd);
      const remainingSlots = videoLimit - jobs.length;
      const remainingBudget = budget - committed;
      const affordableSlots = Math.floor((remainingBudget + 1e-9) / plannedCostUsd);
      if (affordableSlots <= 0) continue;

      const conviction = isHighConviction(opportunity, {
        score: this.highConvictionScore,
        acceleration: this.highConvictionAcceleration,
      });
      const desiredVideos = conviction ? this.maxVideosPerOpportunity : 1;
      const allocatedVideos = Math.min(desiredVideos, remainingSlots, affordableSlots);

      for (let variantIndex = 0; variantIndex < allocatedVideos; variantIndex += 1) {
        const creativeCandidateCount = chooseCreativeCandidateCount(opportunity, conviction);
        jobs.push({
          id: `job_${crypto.randomUUID()}`,
          status: 'QUEUED',
          opportunityId: opportunity.id || null,
          clusterKey: opportunity.clusterKey || null,
          topic: opportunity.topic,
          audience,
          durationSeconds: Number(durationSeconds) || 35,
          render: Boolean(render),
          variantIndex,
          variantCount: allocatedVideos,
          creativeCandidateCount,
          opportunityScore: round(opportunity.opportunityScore),
          velocity: round(opportunity.velocity),
          acceleration: round(opportunity.acceleration),
          sourceCount: Number(opportunity.sourceCount) || 0,
          evidenceCount: item.evidenceCount,
          estimatedCostUsd: round(plannedCostUsd),
          researchPacket: opportunity.researchPacket || null,
          projectId: null,
          resultStatus: null,
          error: null,
        });
        committed += plannedCostUsd;
      }
    }

    const plan = {
      id: `plan_${date.replace(/[^0-9]/g, '')}_${crypto.randomUUID()}`,
      date,
      createdAt: new Date().toISOString(),
      status: jobs.length ? 'PLANNED' : 'EMPTY',
      policy: {
        dailyBudgetUsd: round(budget),
        maxVideos: videoLimit,
        minOpportunityScore: this.minOpportunityScore,
        minEvidenceCount: this.minEvidenceCount,
        estimatedVideoCostUsd: this.estimatedVideoCostUsd,
        recentTopicDays: this.recentTopicDays,
        topicSimilarityThreshold: this.topicSimilarityThreshold,
        highConvictionScore: this.highConvictionScore,
        highConvictionAcceleration: this.highConvictionAcceleration,
        maxVideosPerOpportunity: this.maxVideosPerOpportunity,
      },
      budget: {
        limitUsd: round(budget),
        committedUsd: round(committed),
        remainingUsd: round(Math.max(0, budget - committed)),
      },
      opportunitiesSeen: opportunities.length,
      eligibleOpportunities: considered.filter((item) => item.eligible).length,
      skipped: considered
        .filter((item) => !item.eligible)
        .slice(0, 50)
        .map((item) => ({
          opportunityId: item.opportunity.id || null,
          topic: item.opportunity.topic,
          opportunityScore: round(item.opportunity.opportunityScore),
          reasons: item.rejectionReasons,
          recentMatch: item.recentMatch
            ? {
              topic: item.recentMatch.topic,
              similarity: round(item.recentMatch.similarity),
              planId: item.recentMatch.planId,
            }
            : null,
        })),
      jobs,
    };

    await this.store.savePlan(plan);
    return plan;
  }

  async executePlan(planId, {
    pipeline,
    render = null,
    stopOnFailure = false,
  } = {}) {
    if (!pipeline?.generate) throw new Error('executePlan requires a generation pipeline');
    const plan = await this.store.getPlan(planId);
    if (!plan) throw new Error(`daily plan not found: ${planId}`);

    plan.status = 'RUNNING';
    plan.startedAt = plan.startedAt || new Date().toISOString();
    await this.store.savePlan(plan);

    for (const job of plan.jobs) {
      if (!['QUEUED', 'RETRY'].includes(job.status)) continue;

      job.status = 'RUNNING';
      job.startedAt = new Date().toISOString();
      await this.store.savePlan(plan);

      try {
        const project = await pipeline.generate({
          topic: job.topic,
          audience: job.audience,
          durationSeconds: job.durationSeconds,
          render: render == null ? job.render : Boolean(render),
          researchPacket: job.researchPacket,
          creativeCandidateCount: job.creativeCandidateCount,
          productionVariantIndex: job.variantIndex,
        });

        job.projectId = project.id || null;
        job.resultStatus = project.status || null;
        job.cost = reconcileEstimatedCost({
          estimatedCostUsd: job.estimatedCostUsd,
          ledger: project.costLedger,
        });
        job.completedAt = new Date().toISOString();
        job.status = successfulProjectStatus(project.status) ? 'COMPLETED' : 'REJECTED';
        job.error = project.error || null;

        if (stopOnFailure && job.status !== 'COMPLETED') break;
      } catch (error) {
        job.status = 'FAILED';
        job.completedAt = new Date().toISOString();
        job.error = error?.message || String(error);
        if (stopOnFailure) break;
      }

      await this.store.savePlan(plan);
    }

    const statuses = plan.jobs.map((job) => job.status);
    plan.status = statuses.every((status) => status === 'COMPLETED')
      ? 'COMPLETED'
      : statuses.some((status) => status === 'RUNNING' || status === 'QUEUED')
        ? 'PARTIAL'
        : statuses.some((status) => status === 'COMPLETED')
          ? 'PARTIAL'
          : 'FAILED';
    plan.completedAt = new Date().toISOString();
    plan.budget.reconciled = reconcilePlanBudget(plan);
    await this.store.savePlan(plan);
    return plan;
  }

  async loadOpportunities() {
    const value = typeof this.opportunitySource === 'function'
      ? await this.opportunitySource()
      : await this.opportunitySource.list();
    return Array.isArray(value) ? value : [];
  }
}

export function closestRecentTopic(topic, recentTopics) {
  let best = null;
  for (const recent of recentTopics || []) {
    const score = similarity(topic, recent.topic);
    if (!best || score > best.similarity) {
      best = { ...recent, similarity: score };
    }
  }
  return best;
}

export function chooseCreativeCandidateCount(opportunity, highConviction = false) {
  const score = Number(opportunity?.opportunityScore) || 0;
  const acceleration = Number(opportunity?.acceleration) || 0;
  if (highConviction && score >= 85 && acceleration >= 75) return 8;
  if (highConviction) return 7;
  if (score >= 70) return 6;
  return 5;
}

function isHighConviction(opportunity, thresholds) {
  return Number(opportunity.opportunityScore) >= thresholds.score
    && Number(opportunity.acceleration) >= thresholds.acceleration
    && Number(opportunity.sourceCount || 0) >= 2;
}

function estimateCost(opportunity, fallback) {
  const explicit = Number(
    opportunity?.estimatedProductionCostUsd
    ?? opportunity?.estimatedCostUsd,
  );
  return positive(explicit, fallback);
}

function successfulProjectStatus(status) {
  return ['READY', 'RENDERED', 'PUBLISHABLE', 'COMPLETED'].includes(String(status || ''));
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function clampScore(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, number));
}

function clampRatio(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}


export function reconcilePlanBudget(plan) {
  const jobs = Array.isArray(plan?.jobs) ? plan.jobs : [];
  const estimates = jobs
    .map((job) => Number(job?.estimatedCostUsd))
    .filter(Number.isFinite);
  const actuals = jobs
    .map((job) => job?.cost?.actualComplete ? Number(job.cost.actualCostUsd) : null)
    .filter(Number.isFinite);
  const observed = jobs
    .map((job) => Number(job?.cost?.observedCostUsd))
    .filter(Number.isFinite);
  const completeJobs = jobs.filter((job) => job?.cost?.actualComplete).length;

  const estimatedUsd = round(estimates.reduce((sum, value) => sum + value, 0));
  const actualUsd = completeJobs === jobs.length && jobs.length
    ? round(actuals.reduce((sum, value) => sum + value, 0))
    : null;
  const observedUsd = observed.length
    ? round(observed.reduce((sum, value) => sum + value, 0))
    : null;

  return {
    estimatedUsd,
    actualUsd,
    observedUsd,
    completeJobs,
    totalJobs: jobs.length,
    coverage: jobs.length ? round(completeJobs / jobs.length) : 0,
    varianceUsd: actualUsd != null ? round(actualUsd - estimatedUsd) : null,
    variancePct: actualUsd != null && estimatedUsd > 0
      ? round(((actualUsd - estimatedUsd) / estimatedUsd) * 100)
      : null,
  };
}
