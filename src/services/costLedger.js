import { normalizeProviderUsage, summarizeProviderUsage } from '../core/providerUsage.js';

export function buildProjectCostLedger(project) {
  const events = [];
  const seen = new Set();

  walk(project, (value, valuePath) => {
    if (!value || typeof value !== 'object') return;

    const usage = value.providerUsage;
    if (usage && typeof usage === 'object') {
      const key = [
        usage.provider || '',
        usage.taskId || '',
        usage.operation || '',
        usage.model || '',
      ].join(':');
      if (!seen.has(key)) {
        seen.add(key);
        events.push({ ...usage });
      }
    }

    if (value.rawUsage && typeof value.rawUsage === 'object') {
      const normalized = normalizeProviderUsage(
        { usage: value.rawUsage },
        {
          provider: value.provider || inferProvider(valuePath),
          operation: inferOperation(valuePath),
          model: value.model || null,
        },
      );
      if (normalized) {
        const key = `raw:${valuePath}`;
        if (!seen.has(key)) {
          seen.add(key);
          events.push(normalized);
        }
      }
    }
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

function walk(value, visit, valuePath = 'project') {
  if (!value || typeof value !== 'object') return;
  visit(value, valuePath);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      walk(value[index], visit, `${valuePath}[${index}]`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    walk(child, visit, `${valuePath}.${key}`);
  }
}

function inferProvider(valuePath) {
  return /realism|lipSync|speakerTurn|textArtifact|visualFactual|editorialVariety|productionIntegrity/i.test(valuePath)
    ? 'openrouter'
    : null;
}

function inferOperation(valuePath) {
  const pairs = [
    ['realism', 'realism-qc'],
    ['lipSync', 'lip-sync-qc'],
    ['speakerTurn', 'speaker-turn-qc'],
    ['textArtifact', 'text-artifact-qc'],
    ['visualFactual', 'visual-factual-qc'],
    ['editorialVariety', 'editorial-variety-qc'],
    ['productionIntegrity', 'production-integrity-qc'],
  ];
  const found = pairs.find(([needle]) => valuePath.includes(needle));
  return found ? found[1] : 'provider-call';
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}
