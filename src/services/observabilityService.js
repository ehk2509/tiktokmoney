export class ObservabilityService {
  constructor({
    projectStore,
    dailyPlanStore,
    orchestrationStore,
    webhookStore,
    authService,
    publicationStore,
    now = () => new Date(),
    thresholds = {},
  } = {}) {
    this.projectStore = projectStore;
    this.dailyPlanStore = dailyPlanStore;
    this.orchestrationStore = orchestrationStore;
    this.webhookStore = webhookStore;
    this.authService = authService;
    this.publicationStore = publicationStore;
    this.now = now;
    this.thresholds = {
      orchestrationRetryWarn: number(thresholds.orchestrationRetryWarn, process.env.OBS_ORCHESTRATION_RETRY_WARN, 3),
      orchestrationFailedCritical: number(thresholds.orchestrationFailedCritical, process.env.OBS_ORCHESTRATION_FAILED_CRITICAL, 1),
      webhookRetryWarn: number(thresholds.webhookRetryWarn, process.env.OBS_WEBHOOK_RETRY_WARN, 3),
      webhookRetryAgeMinutes: number(thresholds.webhookRetryAgeMinutes, process.env.OBS_WEBHOOK_RETRY_AGE_MINUTES, 15),
      projectFailureRateWarn: number(thresholds.projectFailureRateWarn, process.env.OBS_PROJECT_FAILURE_RATE_WARN, 0.25),
      projectFailureRateCritical: number(thresholds.projectFailureRateCritical, process.env.OBS_PROJECT_FAILURE_RATE_CRITICAL, 0.5),
      incompleteCostRateWarn: number(thresholds.incompleteCostRateWarn, process.env.OBS_INCOMPLETE_COST_RATE_WARN, 0.35),
      dailyBudgetOverrunPctWarn: number(thresholds.dailyBudgetOverrunPctWarn, process.env.OBS_BUDGET_OVERRUN_PCT_WARN, 10),
      authExpiryWarnMinutes: number(thresholds.authExpiryWarnMinutes, process.env.OBS_AUTH_EXPIRY_WARN_MINUTES, 60),
    };
  }

  async snapshot() {
    const [projects, plans, orchestration, webhooks, auth, publications] = await Promise.all([
      this.projectStore?.listProjects?.({ limit: 500 }) || [],
      this.dailyPlanStore?.listPlans?.({ limit: 60 }) || [],
      this.orchestrationStore?.listJobs?.({ limit: 1000 }) || [],
      this.webhookStore?.listEvents?.({ limit: 1000 }) || [],
      this.authService?.status?.() || null,
      this.publicationStore?.listPublications?.({ limit: 500 }) || [],
    ]);

    const metrics = {
      projects: projectMetrics(projects),
      plans: planMetrics(plans),
      orchestration: orchestrationMetrics(orchestration, this.now()),
      webhooks: webhookMetrics(webhooks, this.now()),
      auth: authMetrics(auth, this.now()),
      publications: publicationMetrics(publications),
    };

    const incidents = detectIncidents(metrics, this.thresholds);
    const status = incidents.some((item) => item.severity === 'critical')
      ? 'critical'
      : incidents.some((item) => item.severity === 'warning')
        ? 'degraded'
        : 'healthy';

    return {
      status,
      generatedAt: this.now().toISOString(),
      incidents,
      metrics,
      thresholds: this.thresholds,
    };
  }
}

function projectMetrics(projects) {
  const terminal = projects.filter((project) => isTerminalProject(project.status));
  const failed = terminal.filter((project) => isFailedProject(project.status));
  const qcFailed = terminal.filter((project) => /QC_FAILED|PRE_GENERATION_QC_FAILED|VISUAL_QC_FAILED/.test(project.status || ''));
  const interrupted = projects.filter((project) => /INTERRUPTED|FAILED/.test(project.status || ''));
  const incompleteCost = projects.filter((project) => project.costLedger && project.costLedger.costUsdComplete !== true);
  const observedCostUsd = projects.reduce((sum, project) => sum + finite(project.costLedger?.costUsdObserved), 0);
  const actualCostUsd = projects.reduce((sum, project) => sum + finite(project.costLedger?.costUsd), 0);

  return {
    total: projects.length,
    terminal: terminal.length,
    failed: failed.length,
    qcFailed: qcFailed.length,
    interrupted: interrupted.length,
    failureRate: terminal.length ? round(failed.length / terminal.length, 4) : 0,
    incompleteCost: incompleteCost.length,
    incompleteCostRate: projects.length ? round(incompleteCost.length / projects.length, 4) : 0,
    observedCostUsd: round(observedCostUsd, 4),
    actualCostUsd: round(actualCostUsd, 4),
    recentFailures: failed.slice(0, 10).map((project) => ({
      projectId: project.id,
      status: project.status,
      topic: project.topic || null,
      error: project.error || null,
      createdAt: project.createdAt || null,
    })),
  };
}

function planMetrics(plans) {
  const jobs = plans.flatMap((plan) => plan.jobs || []);
  const failedJobs = jobs.filter((job) => ['FAILED', 'REJECTED'].includes(job.status));
  const overBudget = plans.filter((plan) => {
    const limit = Number(plan.budget?.limitUsd);
    const actual = Number(plan.budget?.actualUsd ?? plan.budget?.observedUsd);
    return Number.isFinite(limit) && limit > 0 && Number.isFinite(actual) && actual > limit;
  });
  return {
    totalPlans: plans.length,
    totalJobs: jobs.length,
    failedJobs: failedJobs.length,
    failedJobRate: jobs.length ? round(failedJobs.length / jobs.length, 4) : 0,
    overBudgetPlans: overBudget.length,
    maxBudgetOverrunPct: round(Math.max(0, ...overBudget.map((plan) => {
      const limit = Number(plan.budget?.limitUsd);
      const actual = Number(plan.budget?.actualUsd ?? plan.budget?.observedUsd);
      return limit > 0 ? ((actual - limit) / limit) * 100 : 0;
    })), 2),
  };
}

function orchestrationMetrics(jobs, now) {
  const retries = jobs.filter((job) => job.status === 'RETRY');
  const failed = jobs.filter((job) => job.status === 'FAILED');
  const stuck = jobs.filter((job) => {
    if (!['QUEUED', 'RETRY', 'RUNNING'].includes(job.status)) return false;
    const runAt = Date.parse(job.runAt || '');
    return Number.isFinite(runAt) && now.getTime() - runAt > 30 * 60 * 1000;
  });
  return {
    total: jobs.length,
    queued: jobs.filter((job) => job.status === 'QUEUED').length,
    retries: retries.length,
    failed: failed.length,
    stuck: stuck.length,
    oldestRetryMinutes: oldestAgeMinutes(retries, 'updatedAt', now),
    recentFailures: failed.slice(-10).map(compactJob),
  };
}

function webhookMetrics(events, now) {
  const retries = events.filter((event) => event.status === 'RETRY');
  const received = events.filter((event) => event.status === 'RECEIVED');
  return {
    total: events.length,
    received: received.length,
    retries: retries.length,
    processed: events.filter((event) => event.status === 'PROCESSED').length,
    oldestRetryMinutes: oldestAgeMinutes(retries, 'receivedAt', now),
    oldestReceivedMinutes: oldestAgeMinutes(received, 'receivedAt', now),
    recentErrors: retries.slice(0, 10).map((event) => ({
      eventId: event.id,
      event: event.event,
      attempts: event.attempts,
      error: event.lastError || null,
      receivedAt: event.receivedAt,
    })),
  };
}

function authMetrics(auth, now) {
  if (!auth) return { configured: false, authorized: false, needsReauthorization: false };
  return {
    ...auth,
    accessTokenExpiresInMinutes: minutesUntil(auth.accessTokenExpiresAt, now),
    refreshTokenExpiresInMinutes: minutesUntil(auth.refreshTokenExpiresAt, now),
  };
}

function publicationMetrics(publications) {
  return {
    total: publications.length,
    failed: publications.filter((item) => item.status === 'FAILED' || item.failure).length,
    processing: publications.filter((item) => /PROCESSING|UPLOAD/.test(item.status || '')).length,
  };
}

function detectIncidents(metrics, thresholds) {
  const incidents = [];
  push(incidents, metrics.auth.configured && !metrics.auth.authorized, 'critical', 'tiktok_auth_missing', 'TikTok OAuth is configured but no authorized account is available.');
  push(incidents, metrics.auth.needsReauthorization, 'critical', 'tiktok_reauthorization_required', 'TikTok refresh authorization has expired or was revoked.');
  push(
    incidents,
    Number.isFinite(metrics.auth.accessTokenExpiresInMinutes)
      && metrics.auth.accessTokenExpiresInMinutes <= thresholds.authExpiryWarnMinutes,
    'warning',
    'tiktok_access_token_expiring',
    `TikTok access token expires within ${thresholds.authExpiryWarnMinutes} minutes.`,
  );
  push(incidents, metrics.orchestration.failed >= thresholds.orchestrationFailedCritical, 'critical', 'orchestration_failed_jobs', `${metrics.orchestration.failed} orchestration job(s) are permanently failed.`);
  push(incidents, metrics.orchestration.retries >= thresholds.orchestrationRetryWarn, 'warning', 'orchestration_retry_backlog', `${metrics.orchestration.retries} orchestration job(s) are retrying.`);
  push(incidents, metrics.orchestration.stuck > 0, 'warning', 'orchestration_stuck_jobs', `${metrics.orchestration.stuck} orchestration job(s) appear stuck.`);
  push(
    incidents,
    metrics.webhooks.retries >= thresholds.webhookRetryWarn
      || metrics.webhooks.oldestRetryMinutes >= thresholds.webhookRetryAgeMinutes,
    'warning',
    'webhook_retry_backlog',
    `TikTok webhook retries are backlogged (count=${metrics.webhooks.retries}, oldest=${metrics.webhooks.oldestRetryMinutes}m).`,
  );
  push(incidents, metrics.projects.failureRate >= thresholds.projectFailureRateCritical, 'critical', 'project_failure_rate_high', `Project failure rate is ${pct(metrics.projects.failureRate)}.`);
  push(
    incidents,
    metrics.projects.failureRate >= thresholds.projectFailureRateWarn
      && metrics.projects.failureRate < thresholds.projectFailureRateCritical,
    'warning',
    'project_failure_rate_elevated',
    `Project failure rate is ${pct(metrics.projects.failureRate)}.`,
  );
  push(incidents, metrics.projects.incompleteCostRate >= thresholds.incompleteCostRateWarn, 'warning', 'cost_coverage_incomplete', `Cost coverage is incomplete for ${pct(metrics.projects.incompleteCostRate)} of recent projects.`);
  push(incidents, metrics.plans.maxBudgetOverrunPct >= thresholds.dailyBudgetOverrunPctWarn, 'warning', 'daily_budget_overrun', `Observed daily budget overrun reached ${metrics.plans.maxBudgetOverrunPct}%.`);
  return incidents;
}

function compactJob(job) {
  return {
    id: job.id,
    type: job.type,
    attempts: job.attempts,
    error: job.lastError || null,
    runAt: job.runAt,
  };
}

function oldestAgeMinutes(items, field, now) {
  const ages = items
    .map((item) => Date.parse(item[field] || ''))
    .filter(Number.isFinite)
    .map((time) => Math.max(0, now.getTime() - time) / 60000);
  return ages.length ? round(Math.max(...ages), 2) : 0;
}

function minutesUntil(value, now) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? round((time - now.getTime()) / 60000, 2) : null;
}

function isTerminalProject(status) {
  return /RENDERED|FAILED|REJECTED|QC_FAILED|INTERRUPTED/.test(status || '');
}

function isFailedProject(status) {
  return /FAILED|REJECTED|INTERRUPTED/.test(status || '');
}

function push(items, condition, severity, code, message) {
  if (condition) items.push({ severity, code, message });
}

function number(explicit, envValue, fallback) {
  const value = explicit ?? envValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function pct(value) {
  return `${round(Number(value) * 100, 1)}%`;
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}
