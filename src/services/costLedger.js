import { summarizeProviderUsage } from '../core/providerUsage.js';

export function buildProjectCostLedger(project) {
  const events = [];
  const seen = new Set();

  walk(project, (value) => {
    if (!value || typeof value !== 'object') return;
    const usage = value.providerUsage;
    if (!usage || typeof usage !== 'object') return;
    const key = [
      usage.provider || '',
      usage.taskId || '',
      usage.operation || '',
      usage.model || '',
    ].join(':');
    if (seen.has(key)) return;
    seen.add(key);
    events.push({ ...usage });
  });

  const summary = summarizeProviderUsage(events);
  return {
    schemaVersion: 1,
    projectId: project?.id || null,
    generatedAt: new Date().toISOString(),
    ...summary,
    events,
  };
}

export function reconcileEstimatedCost({
  estimatedCostUsd,
  ledger,
} = {}) {
  const estimated = finiteOrNull(estimatedCostUsd);
  const actual = ledger?.costUsdComplete === true
    ? finiteOrNull(ledger.costUsd)
    : null;
  const observed = finiteOrNull(ledger?.costUsdObserved);

  return {
    estimatedCostUsd: estimated,
    actualCostUsd: actual,
    observedCostUsd: observed,
    actualComplete: actual != null,
    varianceUsd: estimated != null && actual != null ? round(actual - estimated, 6) : null,
    variancePct: estimated > 0 && actual != null
      ? round(((actual - estimated) / estimated) * 100, 2)
      : null,
    coverage: ledger?.taskCount
      ? round((ledger.usdReportedTaskCount || 0) / ledger.taskCount, 4)
      : 0,
  };
}

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  for (const child of Object.values(value)) walk(child, visit);
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}
