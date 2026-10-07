export function matchBillingRecords(project, billingRecords = []) {
  const identities = collectProviderIdentities(project);
  const matches = [];

  for (const record of billingRecords || []) {
    const key = identityKey(record.provider, record.taskId);
    const identity = identities.get(key);
    if (!identity) continue;

    matches.push({
      provider: record.provider,
      operation: record.operation || identity.operation || 'external-billing',
      taskId: record.taskId,
      status: identity.status || null,
      model: record.model || identity.model || null,
      costUsd: Number(record.costUsd),
      credits: null,
      providerReported: true,
      reconciliationSource: record.source || 'external-billing',
      reconciledAt: record.importedAt || null,
    });
  }

  return matches;
}

export function collectProviderIdentities(project) {
  const identities = new Map();

  walk(project, (value, valuePath) => {
    if (!value || typeof value !== 'object') return;

    if (value.providerUsage?.taskId) {
      identities.set(
        identityKey(value.providerUsage.provider, value.providerUsage.taskId),
        {
          provider: value.providerUsage.provider || null,
          taskId: value.providerUsage.taskId,
          model: value.providerUsage.model || value.model || null,
          operation: value.providerUsage.operation || inferOperation(valuePath),
          status: value.providerUsage.status || null,
        },
      );
    }

    const provider = String(value.provider || inferProvider(valuePath) || '').toLowerCase();
    const taskId = value.generationId || value.taskId || value.requestId || null;
    if (provider && taskId) {
      identities.set(identityKey(provider, taskId), {
        provider,
        taskId: String(taskId),
        model: value.model || value.providerModelId || null,
        operation: inferOperation(valuePath),
        status: value.status || null,
      });
    }

    if (value.referenceGenerationId && provider) {
      identities.set(identityKey(provider, value.referenceGenerationId), {
        provider,
        taskId: String(value.referenceGenerationId),
        model: value.imageModel || value.model || null,
        operation: 'reference-image',
        status: value.status || null,
      });
    }
  });

  return identities;
}

function identityKey(provider, taskId) {
  return [String(provider || '').toLowerCase(), String(taskId || '')].join(':');
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
  if (/luma/i.test(valuePath)) return 'luma';
  if (/eleven/i.test(valuePath) || /voice/i.test(valuePath)) return 'elevenlabs';
  return null;
}

function inferOperation(valuePath) {
  if (/keyframe|reference/i.test(valuePath)) return 'reference-image';
  if (/voice|dialogue|tts/i.test(valuePath)) return 'text-to-speech';
  if (/scene|asset|video/i.test(valuePath)) return 'video-generation';
  return 'provider-call';
}
