import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class ProviderBillingStore {
  constructor(filePath = process.env.PROVIDER_BILLING_PATH || './data/provider-billing.json') {
    this.filePath = filePath;
  }

  async importRecords(records, {
    source = 'manual-import',
    importedAt = new Date().toISOString(),
  } = {}) {
    const state = await this.load();
    let added = 0;
    let updated = 0;

    for (const input of records || []) {
      const record = normalizeRecord(input, { source, importedAt });
      const key = recordKey(record);
      const index = state.records.findIndex((item) => recordKey(item) === key);
      if (index >= 0) {
        state.records[index] = {
          ...state.records[index],
          ...record,
        };
        updated += 1;
      } else {
        state.records.push(record);
        added += 1;
      }
    }

    state.records.sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
    await this.save(state);
    return { added, updated, total: state.records.length };
  }

  async list() {
    return (await this.load()).records;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      return {
        version: 1,
        records: Array.isArray(parsed?.records) ? parsed.records : [],
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, records: [] };
      throw error;
    }
  }

  async save(state) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2));
  }
}

export function normalizeRecord(input, { source, importedAt } = {}) {
  if (!input || typeof input !== 'object') throw new Error('billing record must be an object');
  const provider = String(input.provider || '').trim().toLowerCase();
  const taskId = String(input.taskId || input.task_id || input.generationId || input.generation_id || '').trim();
  const costUsd = Number(input.costUsd ?? input.cost_usd ?? input.cost);
  if (!provider) throw new Error('billing record provider is required');
  if (!taskId) throw new Error('billing record taskId/generationId is required');
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new Error('billing record costUsd must be a non-negative number');
  }

  return {
    provider,
    taskId,
    costUsd,
    currency: String(input.currency || 'USD').toUpperCase(),
    model: input.model ? String(input.model) : null,
    operation: input.operation ? String(input.operation) : null,
    occurredAt: input.occurredAt || input.occurred_at || null,
    source: input.source || source || 'manual-import',
    importedAt: input.importedAt || importedAt || new Date().toISOString(),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : null,
  };
}

function recordKey(record) {
  return [record.provider, record.taskId].join(':');
}
