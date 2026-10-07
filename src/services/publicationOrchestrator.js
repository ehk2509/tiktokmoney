import crypto from 'node:crypto';

export class PublicationOrchestrator {
  constructor({
    store,
    publishingService,
    projectStore,
    experimentService = null,
    now = () => new Date(),
    defaultMetricsDelayHours = Number(process.env.PUBLICATION_METRICS_DELAY_HOURS || 24),
    retryDelayMinutes = Number(process.env.PUBLICATION_RETRY_DELAY_MINUTES || 15),
    maxAttempts = Number(process.env.PUBLICATION_ORCHESTRATION_MAX_ATTEMPTS || 12),
  } = {}) {
    if (!store) throw new Error('publication orchestrator requires a store');
    if (!publishingService) throw new Error('publication orchestrator requires publishing service');
    if (!projectStore) throw new Error('publication orchestrator requires project store');

    this.store = store;
    this.publishingService = publishingService;
    this.projectStore = projectStore;
    this.experimentService = experimentService;
    this.now = now;
    this.defaultMetricsDelayHours = positive(defaultMetricsDelayHours, 24);
    this.retryDelayMinutes = positive(retryDelayMinutes, 15);
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 12);
  }

  async schedulePublish(projectId, {
    runAt,
    confirmPublish = false,
    privacyLevel,
    title = null,
    disableComment = false,
    disableDuet = false,
    disableStitch = false,
    videoCoverTimestampMs = 1000,
  } = {}) {
    if (confirmPublish !== true) {
      throw new Error('scheduled publishing requires explicit confirmPublish=true');
    }
    if (!privacyLevel) throw new Error('privacyLevel is required for scheduled publishing');

    const project = await this.projectStore.getProject(projectId);
    if (!project) throw new Error(`project ${projectId} was not found`);
    if (project.status !== 'RENDERED' || !project.render?.outputPath) {
      throw new Error(`project ${projectId} must be rendered before scheduling`);
    }

    const scheduledAt = parseFuture(runAt, this.now());
    const job = {
      id: `orq_${crypto.randomUUID()}`,
      type: 'publish',
      status: 'QUEUED',
      projectId,
      publicationId: null,
      experimentId: project.planning?.experiment?.id || null,
      runAt: scheduledAt.toISOString(),
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      attempts: 0,
      lastError: null,
      payload: {
        confirmPublish: true,
        privacyLevel,
        title,
        disableComment: Boolean(disableComment),
        disableDuet: Boolean(disableDuet),
        disableStitch: Boolean(disableStitch),
        videoCoverTimestampMs: Number(videoCoverTimestampMs) || 1000,
      },
    };
    await this.store.saveJob(job);
    return job;
  }

  async runDue({ limit = 50 } = {}) {
    const jobs = (await this.store.dueJobs(this.now())).slice(0, Math.max(1, Number(limit) || 50));
    const results = [];
    for (const job of jobs) {
      results.push(await this.runJob(job));
    }
    return results;
  }

  async runJob(jobOrId) {
    const job = typeof jobOrId === 'string' ? await this.store.getJob(jobOrId) : jobOrId;
    if (!job) throw new Error('orchestration job was not found');
    if (!['QUEUED', 'RETRY'].includes(job.status)) return job;

    job.status = 'RUNNING';
    job.attempts = (Number(job.attempts) || 0) + 1;
    job.updatedAt = this.now().toISOString();
    await this.store.saveJob(job);

    try {
      if (job.type === 'publish') await this.executePublish(job);
      else if (job.type === 'metrics-refresh') await this.executeMetricsRefresh(job);
      else throw new Error(`unsupported orchestration job type: ${job.type}`);
      job.status = 'COMPLETED';
      job.completedAt = this.now().toISOString();
      job.lastError = null;
    } catch (error) {
      job.lastError = error?.message || String(error);
      if (job.attempts >= this.maxAttempts) {
        job.status = 'FAILED';
        job.completedAt = this.now().toISOString();
      } else {
        job.status = 'RETRY';
        job.runAt = new Date(this.now().getTime() + this.retryDelayMinutes * 60000).toISOString();
      }
    }

    job.updatedAt = this.now().toISOString();
    await this.store.saveJob(job);
    return job;
  }

  async executePublish(job) {
    const publication = await this.publishingService.publishProject(job.projectId, job.payload || {});
    job.publicationId = publication.id;

    const project = await this.projectStore.getProject(job.projectId);
    const experiment = project?.planning?.experiment || null;
    const delayHours = positive(
      experiment?.observationWindowHours,
      this.defaultMetricsDelayHours,
    );
    const metricsJob = {
      id: `orq_${crypto.randomUUID()}`,
      type: 'metrics-refresh',
      status: 'QUEUED',
      projectId: job.projectId,
      publicationId: publication.id,
      experimentId: experiment?.id || null,
      runAt: new Date(this.now().getTime() + delayHours * 3600000).toISOString(),
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      attempts: 0,
      lastError: null,
      payload: {
        targetObservationHours: delayHours,
      },
    };
    await this.store.saveJob(metricsJob);
    job.followUpJobId = metricsJob.id;
  }

  async executeMetricsRefresh(job) {
    const publication = await this.publishingService.refreshMetrics(job.publicationId);
    const snapshot = publication.metricsSnapshots?.at(-1);
    if (!publication.postIds?.length || !snapshot?.videos?.length) {
      throw new Error('TikTok metrics are not available yet');
    }

    job.metricsCapturedAt = snapshot.capturedAt;
    job.latestOutcomeId = publication.latestOutcome?.id || null;
    if (job.experimentId && this.experimentService?.evaluate) {
      job.experimentResult = await this.experimentService.evaluate(job.experimentId);
      if (job.experimentResult?.status === 'PENDING') {
        throw new Error(`experiment still pending: ${job.experimentResult.reason}`);
      }
    }
  }
}

function parseFuture(value, now) {
  const date = value ? new Date(value) : now;
  if (Number.isNaN(date.getTime())) throw new Error('runAt must be a valid date/time');
  if (date.getTime() < now.getTime()) throw new Error('runAt cannot be in the past');
  return date;
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
