import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildBenchmarkPlan,
  computeSuiteHash,
  extractFullStackMetrics,
  extractProviderUsage,
  loadFrozenBenchmarkSuite,
  runRealGenerationBenchmark,
  summarizeBenchmarkRun,
} from '../src/benchmarks/realGenerationBenchmark.js';

const suitePath = path.resolve('data/benchmarks/real-generation-v1.json');

test('real-generation v1 corpus is frozen at 30 balanced cases', async () => {
  const suite = await loadFrozenBenchmarkSuite(suitePath);
  assert.equal(suite.actualHash, suite.frozenHash);
  assert.equal(suite.cases.length, 30);

  const counts = Object.groupBy
    ? Object.fromEntries(
      Object.entries(Object.groupBy(suite.cases, (item) => item.category))
        .map(([category, items]) => [category, items.length]),
    )
    : suite.cases.reduce((acc, item) => {
      acc[item.category] = (acc[item.category] || 0) + 1;
      return acc;
    }, {});

  assert.equal(Object.keys(counts).length, 10);
  assert.ok(Object.values(counts).every((count) => count === 3));
});

test('frozen benchmark rejects silent corpus mutation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-benchmark-'));
  try {
    const suite = JSON.parse(await readFile(suitePath, 'utf8'));
    suite.cases[0].topic += ' mutated';
    const mutatedPath = path.join(dir, 'mutated.json');
    await writeFile(mutatedPath, JSON.stringify(suite, null, 2));

    await assert.rejects(
      loadFrozenBenchmarkSuite(mutatedPath),
      /benchmark suite hash mismatch/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('benchmark plan is safe by default and can select a subset', async () => {
  const result = await runRealGenerationBenchmark({
    suitePath,
    confirmSpend: false,
    caseIds: ['talking-head-01', 'static-01'],
  });

  assert.equal(result.mode, 'plan');
  assert.equal(result.plan.caseCount, 2);
  assert.equal(result.plan.baselineProviderGenerations, 2);
  assert.equal(result.plan.fullStackRuns, 2);
  assert.deepEqual(result.plan.caseIds, ['talking-head-01', 'static-01']);
});

test('provider usage never invents zero spend when billing is absent', () => {
  assert.deepEqual(extractProviderUsage({ id: 'task-1', status: 'SUCCEEDED' }), {
    taskId: 'task-1',
    status: 'SUCCEEDED',
    model: null,
    costUsd: null,
    credits: null,
    providerReported: false,
  });

  assert.deepEqual(
    extractProviderUsage({
      id: 'task-2',
      status: 'SUCCEEDED',
      model: 'wan3',
      usage: { costUsd: 1.25, credits: 18 },
    }),
    {
      taskId: 'task-2',
      status: 'SUCCEEDED',
      model: 'wan3',
      costUsd: 1.25,
      credits: 18,
      providerReported: true,
    },
  );
});

test('full-stack metric extraction records retries and independent QC signals', () => {
  const metrics = extractFullStackMetrics({
    status: 'RENDERED',
    publishability: { passed: true },
    scenes: [
      {
        visualQcHistory: [
          { passed: false, realism: { overallScore: 70 } },
          { passed: true, realism: { overallScore: 91 } },
        ],
        dialogueVerification: { wordErrorRate: 0.05 },
        deepLipSyncQc: { confidence: 0.9 },
        poseMotionQc: { overallScore: 88 },
      },
      {
        visualQcHistory: [{ passed: true, overallScore: 94 }],
        dialogueVerification: { wer: 0.1 },
        lipSyncQc: { score: 0.82 },
        poseMotionQc: { overallScore: 92 },
      },
    ],
  });

  assert.equal(metrics.firstPassSuccess, false);
  assert.equal(metrics.finalSuccess, true);
  assert.equal(metrics.retryCount, 1);
  assert.equal(metrics.sceneCount, 2);
  assert.equal(metrics.dialogueWer, 0.075);
  assert.equal(metrics.lipSyncScore, 0.86);
  assert.equal(metrics.poseFidelity, 90);
  assert.equal(metrics.realismScore, 85);
});

test('benchmark metrics ignore missing values instead of coercing null to zero', () => {
  const metrics = extractFullStackMetrics({
    status: 'RENDERED',
    publishability: { passed: true },
    scenes: [
      {
        visualQcHistory: [{ passed: true, realism: { overallScore: 90 } }],
        dialogueVerification: null,
        deepLipSyncQc: null,
        lipSyncQc: null,
        poseMotionQc: null,
      },
      {
        visualQcHistory: [{ passed: true, realism: { overallScore: 94 } }],
        dialogueVerification: { wer: 0.1 },
        deepLipSyncQc: null,
        lipSyncQc: { score: 0.8 },
        poseMotionQc: { overallScore: 88 },
      },
    ],
  });

  assert.equal(metrics.dialogueWer, 0.1);
  assert.equal(metrics.lipSyncScore, 0.8);
  assert.equal(metrics.poseFidelity, 88);
  assert.equal(metrics.realismScore, 92);
});

test('benchmark summary combines failures, human ratings and actual spend conservatively', () => {
  const run = {
    runId: 'test-run',
    suite: { name: 'real-generation-v1', version: '1.0.0', hash: 'hash' },
    pairs: [
      {
        caseId: 'a',
        baseline: {
          success: true,
          artifactPath: 'a-baseline.mp4',
          latencyMs: 100,
          spend: { costUsd: 1, costUsdObserved: 1, costUsdComplete: true },
        },
        full: {
          success: true,
          artifactPath: 'a-full.mp4',
          latencyMs: 200,
          spend: { costUsd: 2, costUsdObserved: 2, costUsdComplete: true },
          metrics: { firstPassSuccess: true, finalSuccess: true, retryCount: 0 },
        },
      },
      {
        caseId: 'b',
        baseline: {
          success: false,
          artifactPath: null,
          latencyMs: 120,
          spend: { costUsd: 1, costUsdObserved: 1, costUsdComplete: true },
        },
        full: {
          success: true,
          artifactPath: 'b-full.mp4',
          latencyMs: 250,
          spend: { costUsd: 2, costUsdObserved: 2, costUsdComplete: true },
          metrics: { firstPassSuccess: false, finalSuccess: true, retryCount: 1 },
        },
      },
    ],
  };
  const ratings = [
    {
      caseId: 'a', arm: 'baseline', publishable: true,
      realismScore: 3, identityConsistencyScore: 3,
      dialogueAccuracyScore: 4, motionFidelityScore: 3,
    },
    {
      caseId: 'a', arm: 'full', publishable: true,
      realismScore: 5, identityConsistencyScore: 5,
      dialogueAccuracyScore: 5, motionFidelityScore: 5,
    },
    {
      caseId: 'b', arm: 'full', publishable: true,
      realismScore: 4, identityConsistencyScore: 4,
      dialogueAccuracyScore: 4, motionFidelityScore: 4,
    },
  ];

  const summary = summarizeBenchmarkRun(run, { ratings });
  assert.equal(summary.baseline.generationSuccessRate, 0.5);
  assert.equal(summary.baseline.humanPublishableRate, 0.5);
  assert.equal(summary.baseline.humanRatingCoverageRate, 1);
  assert.equal(summary.full.finalSuccessRate, 1);
  assert.equal(summary.full.firstPassSuccessRate, 0.5);
  assert.equal(summary.full.averageRetries, 0.5);
  assert.equal(summary.full.humanPublishableRate, 1);
  assert.equal(summary.comparison.humanPublishableRateDelta, 0.5);
  assert.equal(summary.full.totalProviderSpendUsd, 4);
  assert.equal(summary.full.costPerHumanPublishableVideoUsd, 2);
  assert.equal(summary.ratings.expected, 3);
  assert.equal(summary.ratings.complete, true);
});

test('benchmark summary rejects invalid or duplicate human ratings', () => {
  const run = {
    runId: 'rating-validation',
    pairs: [{
      caseId: 'a',
      baseline: { success: true, artifactPath: 'a-baseline.mp4', latencyMs: 10 },
      full: {
        success: true,
        artifactPath: 'a-full.mp4',
        latencyMs: 10,
        metrics: { firstPassSuccess: true, finalSuccess: true, retryCount: 0 },
      },
    }],
  };

  assert.throws(
    () => summarizeBenchmarkRun(run, {
      ratings: [{
        caseId: 'a',
        arm: 'baseline',
        publishable: true,
        realismScore: 99,
        identityConsistencyScore: null,
        dialogueAccuracyScore: 4,
        motionFidelityScore: 3,
      }],
    }),
    /realismScore must be an integer from 1 to 5 or null/,
  );

  const duplicate = {
    caseId: 'a',
    arm: 'baseline',
    publishable: true,
    realismScore: 4,
    identityConsistencyScore: null,
    dialogueAccuracyScore: 4,
    motionFidelityScore: 3,
  };
  assert.throws(
    () => summarizeBenchmarkRun(run, { ratings: [duplicate, { ...duplicate }] }),
    /duplicate rating/,
  );
});

test('benchmark summary keeps genuinely inapplicable human dimensions null', () => {
  const run = {
    runId: 'null-human-score',
    pairs: [{
      caseId: 'a',
      baseline: { success: true, artifactPath: 'a-baseline.mp4', latencyMs: 10 },
      full: {
        success: true,
        artifactPath: 'a-full.mp4',
        latencyMs: 10,
        metrics: { firstPassSuccess: true, finalSuccess: true, retryCount: 0 },
      },
    }],
  };
  const summary = summarizeBenchmarkRun(run, {
    ratings: [{
      caseId: 'a',
      arm: 'full',
      publishable: true,
      realismScore: 5,
      identityConsistencyScore: null,
      dialogueAccuracyScore: 5,
      motionFidelityScore: null,
    }],
  });

  assert.equal(summary.full.humanRealismScore, 5);
  assert.equal(summary.full.humanIdentityConsistencyScore, null);
  assert.equal(summary.full.humanMotionFidelityScore, null);
});

test('live evidence benchmark refuses partial-scene no-render review artifacts', async () => {
  await assert.rejects(
    runRealGenerationBenchmark({
      suitePath,
      app: { mode: 'audiovisual' },
      confirmSpend: true,
      render: false,
      limit: 1,
    }),
    /requires final rendering/,
  );
});

test('live benchmark emits blinded review aliases and keeps arm identity in a separate key', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-live-benchmark-'));
  try {
    const suite = {
      schemaVersion: 1,
      name: 'test-suite',
      version: '1.0.0',
      description: 'one-case live harness test',
      cases: [
        {
          id: 'case-01',
          category: 'static-camera',
          topic: 'A test topic',
          audience: 'testers',
          durationSeconds: 4,
          baselinePrompt: 'A plain photorealistic test video.',
        },
        {
          id: 'case-02',
          category: 'walking',
          topic: 'A second test topic',
          audience: 'testers',
          durationSeconds: 4,
          baselinePrompt: 'A second plain photorealistic test video.',
        },
      ],
    };
    suite.frozenHash = computeSuiteHash(suite);
    const localSuitePath = path.join(dir, 'suite.json');
    await writeFile(localSuitePath, JSON.stringify(suite, null, 2));

    let taskCounter = 0;
    const provider = {
      model: 'wan3',
      ratio: '720:1280',
      assetDir: path.join(dir, 'assets'),
      async createTask() {
        taskCounter += 1;
        return { id: 'task-' + taskCounter };
      },
      async wait(id) {
        return {
          id,
          status: 'SUCCEEDED',
          output: ['https://example.invalid/' + id + '.mp4'],
          ...(String(id).includes('unbilled') ? {} : { usage: { costUsd: 0.5 } }),
        };
      },
      async download(_url, destination) {
        await writeFile(destination, 'baseline');
      },
    };

    const fullArtifact = path.join(dir, 'full.mp4');
    const app = {
      mode: 'audiovisual',
      pipeline: {
        audiovisual: provider,
        async generate() {
          await provider.wait('full-task');
          await provider.wait('full-unbilled-task');
          await writeFile(fullArtifact, 'full');
          return {
            id: 'vid-test',
            status: 'RENDERED',
            publishability: { passed: true },
            scenes: [{
              visualQcHistory: [{ passed: true, overallScore: 90 }],
              asset: { localPath: fullArtifact },
            }],
            render: { outputPath: fullArtifact },
          };
        },
      },
    };

    const result = await runRealGenerationBenchmark({
      suitePath: localSuitePath,
      outputDir: path.join(dir, 'benchmarks'),
      app,
      confirmSpend: true,
      render: true,
      now: () => new Date('2026-10-02T09:00:00.000Z'),
    });

    assert.equal(result.mode, 'live');
    const blind = JSON.parse(await readFile(result.blindRatingsPath, 'utf8'));
    const key = JSON.parse(await readFile(result.ratingKeyPath, 'utf8'));
    assert.equal(blind.blinded, true);
    assert.equal(blind.samples.length, 4);
    assert.equal(key.samples.length, 4);
    assert.deepEqual(result.run.pairs[0].executionOrder, ['baseline', 'full']);
    assert.deepEqual(result.run.pairs[1].executionOrder, ['full', 'baseline']);
    assert.ok(blind.samples.every((sample) => !Object.hasOwn(sample, 'arm')));
    assert.deepEqual(new Set(key.samples.map((item) => item.arm)), new Set(['baseline', 'full']));
    assert.ok(blind.samples.every((sample) => path.basename(sample.artifactPath).startsWith('sample_')));
    assert.equal(result.run.pairs[0].baseline.spend.costUsdComplete, true);
    assert.equal(result.run.pairs[0].full.spend.costUsdComplete, false);
    assert.equal(result.run.pairs[0].full.spend.costUsd, null);
    assert.equal(result.run.pairs[0].full.spend.costUsdObserved, 0.5);
    assert.equal(result.run.summary.full.totalProviderSpendUsd, null);
    assert.ok(result.run.summary.full.observedProviderSpendUsd > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
