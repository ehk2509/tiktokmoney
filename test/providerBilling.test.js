import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ProviderBillingStore } from '../src/storage/providerBillingStore.js';
import { buildProjectCostLedger } from '../src/services/costLedger.js';
import { matchBillingRecords } from '../src/services/billingReconciliation.js';

test('billing store imports and updates provider task records idempotently', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-billing-'));
  try {
    const store = new ProviderBillingStore(path.join(dir, 'billing.json'));
    const first = await store.importRecords([
      { provider: 'luma', generationId: 'gen-1', costUsd: 1.2 },
      { provider: 'elevenlabs', taskId: 'req-1', costUsd: 0.08 },
    ], { source: 'provider-export' });

    assert.deepEqual(first, { added: 2, updated: 0, total: 2 });

    const second = await store.importRecords([
      { provider: 'luma', generationId: 'gen-1', costUsd: 1.35 },
    ], { source: 'corrected-export' });

    assert.deepEqual(second, { added: 0, updated: 1, total: 2 });
    const records = await store.list();
    assert.equal(records.find((item) => item.taskId === 'gen-1').costUsd, 1.35);
    assert.equal(records.find((item) => item.taskId === 'gen-1').source, 'corrected-export');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('external billing matches generation provenance and closes missing cost coverage', () => {
  const project = {
    id: 'vid-1',
    scenes: [{
      asset: {
        provider: 'luma',
        model: 'ray-3',
        generationId: 'gen-video',
        referenceGenerationId: 'gen-image',
        imageModel: 'photon',
      },
    }],
  };

  const billing = [
    { provider: 'luma', taskId: 'gen-video', costUsd: 1.5, source: 'provider-export' },
    { provider: 'luma', taskId: 'gen-image', costUsd: 0.2, source: 'provider-export' },
  ];

  const matches = matchBillingRecords(project, billing);
  assert.equal(matches.length, 2);

  const ledger = buildProjectCostLedger(project, { billingRecords: billing });
  assert.equal(ledger.taskCount, 2);
  assert.equal(ledger.costUsdComplete, true);
  assert.equal(ledger.costUsd, 1.7);
  assert.ok(ledger.events.every((event) => event.reconciliationSource === 'provider-export'));
});

test('external billing does not attach unrelated provider tasks', () => {
  const project = {
    id: 'vid-2',
    scenes: [{
      asset: { provider: 'luma', generationId: 'gen-a' },
    }],
  };

  const ledger = buildProjectCostLedger(project, {
    billingRecords: [
      { provider: 'luma', taskId: 'gen-b', costUsd: 2 },
      { provider: 'runway', taskId: 'gen-a', costUsd: 3 },
    ],
  });

  assert.equal(ledger.taskCount, 0);
  assert.equal(ledger.costUsd, null);
  assert.equal(ledger.costUsdComplete, false);
});
