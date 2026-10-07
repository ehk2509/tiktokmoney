export function normalizeProviderUsage(task, {
  provider = null,
  operation = null,
  model = null,
} = {}) {
  if (!task || typeof task !== 'object') return null;
  const usage = task.usage && typeof task.usage === 'object' ? task.usage : {};
  const billing = task.billing && typeof task.billing === 'object' ? task.billing : {};
  const costUsd = firstFinite(
    task.costUsd,
    task.cost_usd,
    usage.costUsd,
    usage.cost_usd,
    usage.cost,
    billing.costUsd,
    billing.cost_usd,
    billing.cost,
  );
  const credits = firstFinite(
    task.credits,
    usage.credits,
    usage.creditCount,
    usage.credit_count,
    billing.credits,
  );

  return {
    provider,
    operation,
    taskId: task.id || task.request_id || null,
    status: task.status || null,
    model: task.model || task.modelId || task.model_id || model || null,
    costUsd,
    credits,
    promptTokens: firstFinite(
      task.promptTokens,
      task.prompt_tokens,
      usage.promptTokens,
      usage.prompt_tokens,
      usage.input_tokens,
    ),
    completionTokens: firstFinite(
      task.completionTokens,
      task.completion_tokens,
      usage.completionTokens,
      usage.completion_tokens,
      usage.output_tokens,
    ),
    totalTokens: firstFinite(
      task.totalTokens,
      task.total_tokens,
      usage.totalTokens,
      usage.total_tokens,
    ),
    providerReported: costUsd != null || credits != null,
  };
}

export function summarizeProviderUsage(events = []) {
  const normalized = (events || []).filter(Boolean);
  const reportedCosts = normalized.map((event) => event.costUsd).filter(Number.isFinite);
  const reportedCredits = normalized.map((event) => event.credits).filter(Number.isFinite);
  const providerReportedTaskCount = normalized.filter((event) => event.providerReported).length;
  const usdReportedTaskCount = reportedCosts.length;
  const creditReportedTaskCount = reportedCredits.length;

  const costUsdObserved = reportedCosts.length
    ? round(reportedCosts.reduce((sum, value) => sum + value, 0), 6)
    : null;
  const creditsObserved = reportedCredits.length
    ? round(reportedCredits.reduce((sum, value) => sum + value, 0), 6)
    : null;
  const costUsdComplete = normalized.length > 0 && usdReportedTaskCount === normalized.length;
  const creditsComplete = normalized.length > 0 && creditReportedTaskCount === normalized.length;

  return {
    taskCount: normalized.length,
    providerReportedTaskCount,
    usdReportedTaskCount,
    creditReportedTaskCount,
    costUsdObserved,
    costUsdComplete,
    costUsd: costUsdComplete ? costUsdObserved : null,
    creditsObserved,
    creditsComplete,
    credits: creditsComplete ? creditsObserved : null,
    source: costUsdComplete || creditsComplete
      ? 'provider-reported-complete'
      : reportedCosts.length || reportedCredits.length
        ? 'provider-reported-partial'
        : 'unavailable',
  };
}

function firstFinite(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}
