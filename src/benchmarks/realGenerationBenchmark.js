import crypto from 'node:crypto';
import { copyFile, link, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export async function loadFrozenBenchmarkSuite(filePath) {
  const suite = JSON.parse(await readFile(filePath, 'utf8'));
  validateSuite(suite);
  const actualHash = computeSuiteHash(suite);
  if (suite.frozenHash !== actualHash) {
    throw new Error('benchmark suite hash mismatch: expected ' + suite.frozenHash
      + ', computed ' + actualHash
      + '; create a new suite version instead of mutating the frozen corpus');
  }
  return { ...suite, actualHash };
}

export function computeSuiteHash(suite) {
  const payload = {
    schemaVersion: suite.schemaVersion,
    name: suite.name,
    version: suite.version,
    description: suite.description,
    cases: suite.cases,
  };
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(
      (key) => JSON.stringify(key) + ':' + canonicalJson(value[key]),
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function buildBenchmarkPlan(suite, { limit = null, caseIds = [] } = {}) {
  const selected = selectCases(suite.cases, { limit, caseIds });
  const categoryCounts = {};
  for (const item of selected) {
    categoryCounts[item.category] = (categoryCounts[item.category] || 0) + 1;
  }
  return {
    suite: suite.name,
    suiteVersion: suite.version,
    suiteHash: suite.actualHash || computeSuiteHash(suite),
    caseCount: selected.length,
    pairCount: selected.length,
    baselineProviderGenerations: selected.length,
    fullStackRuns: selected.length,
    categoryCounts,
    caseIds: selected.map((item) => item.id),
    warning: 'Live mode spends provider credits. Full-stack runs can issue multiple paid tasks because of TTS, keyframes, segments and QC retries.',
  };
}

export async function runRealGenerationBenchmark({
  suitePath,
  outputDir = './outputs/benchmarks',
  app = null,
  confirmSpend = false,
  limit = null,
  caseIds = [],
  render = true,
  now = () => new Date(),
} = {}) {
  if (!suitePath) throw new Error('suitePath is required');
  const suite = await loadFrozenBenchmarkSuite(suitePath);
  const plan = buildBenchmarkPlan(suite, { limit, caseIds });
  if (!confirmSpend) return { mode: 'plan', plan };

  if (!app || app.mode !== 'audiovisual') {
    throw new Error('live benchmark requires VIDEO_PIPELINE_MODE=audiovisual');
  }
  if (!render) {
    throw new Error('live evidence benchmark requires final rendering; --no-render would rate only partial scene artifacts');
  }
  const provider = app.pipeline && app.pipeline.audiovisual;
  if (!provider || typeof provider.createTask !== 'function'
      || typeof provider.wait !== 'function' || typeof provider.download !== 'function') {
    throw new Error('live benchmark requires the Runway audiovisual provider');
  }

  const runId = 'realgen_' + timestampId(now());
  const runDir = path.join(outputDir, runId);
  const manifestPath = path.join(runDir, 'manifest.json');
  const summaryPath = path.join(runDir, 'summary.json');
  const blindRatingsPath = path.join(runDir, 'ratings-blind.json');
  const ratingKeyPath = path.join(runDir, 'rating-key.json');
  await mkdir(runDir, { recursive: true });

  const probe = instrumentProviderWait(provider, now);
  const run = {
    schemaVersion: 1,
    kind: 'real-generation-benchmark',
    runId,
    suite: { name: suite.name, version: suite.version, hash: suite.actualHash },
    startedAt: now().toISOString(),
    finishedAt: null,
    render,
    runtime: {
      packageVersion: process.env.npm_package_version || null,
      nodeVersion: process.version,
      pipelineMode: app.mode,
      audiovisualProvider: provider.constructor?.name || null,
      audiovisualModel: provider.model || null,
      audiovisualRatio: provider.ratio || null,
      dialogueMode: provider.dialogueMode || null,
      llmModel: process.env.LLM_MODEL || null,
      creativeJudgeModel: process.env.CREATIVE_JUDGE_MODEL || null,
      realismQcModel: process.env.REALISM_QC_MODEL || null,
      gitCommit: process.env.TIKTOKMONEY_COMMIT || process.env.GITHUB_SHA || null,
    },
    pairs: [],
  };

  try {
    const selectedCases = selectCases(suite.cases, { limit, caseIds });
    for (let caseIndex = 0; caseIndex < selectedCases.length; caseIndex += 1) {
      const benchmarkCase = selectedCases[caseIndex];
      const executionOrder = caseIndex % 2 === 0
        ? ['baseline', 'full']
        : ['full', 'baseline'];
      let baseline = null;
      let full = null;

      for (const arm of executionOrder) {
        probe.reset();
        if (arm === 'baseline') {
          baseline = await timedArm(async () => {
            const asset = await generatePlainBaseline(provider, benchmarkCase, runId);
            return {
              success: Boolean(asset.localPath),
              artifactPath: asset.localPath,
              generationId: asset.generationId,
              model: asset.model,
            };
          });
          baseline.spend = summarizeUsage(probe.snapshot(), {
            scope: 'audiovisual-provider',
            untrackedComponents: [],
          });
        } else {
          full = await timedArm(async () => {
            const project = await app.pipeline.generate({
              topic: benchmarkCase.topic,
              audience: benchmarkCase.audience || 'curious adults',
              durationSeconds: Number(benchmarkCase.durationSeconds) || 10,
              render,
              researchPacket: null,
            });
            const metrics = extractFullStackMetrics(project);
            return {
              success: metrics.finalSuccess,
              artifactPath: project.render && project.render.outputPath
                ? project.render.outputPath
                : firstScenePath(project.scenes),
              projectId: project.id || null,
              status: project.status || null,
              metrics,
            };
          });
          full.spend = summarizeUsage(probe.snapshot(), {
            scope: 'full-stack-provider-observation',
            untrackedComponents: detectUntrackedCostComponents(app.pipeline),
          });
        }
      }

      run.pairs.push({
        caseId: benchmarkCase.id,
        category: benchmarkCase.category,
        topic: benchmarkCase.topic,
        executionOrder,
        baseline,
        full,
      });
      await writeFile(manifestPath, JSON.stringify(run, null, 2));
    }
  } finally {
    probe.restore();
  }

  run.finishedAt = now().toISOString();
  const review = await createBlindedReviewPack({ run, runDir });
  run.review = {
    blindRatingsPath,
    ratingKeyPath,
    sampleCount: review.ratingSheet.samples.length,
  };
  run.summary = summarizeBenchmarkRun(run);
  await writeFile(manifestPath, JSON.stringify(run, null, 2));
  await writeFile(summaryPath, JSON.stringify(run.summary, null, 2));
  await writeFile(blindRatingsPath, JSON.stringify(review.ratingSheet, null, 2));
  await writeFile(ratingKeyPath, JSON.stringify(review.ratingKey, null, 2));
  return {
    mode: 'live',
    run,
    manifestPath,
    summaryPath,
    blindRatingsPath,
    ratingKeyPath,
  };
}

export async function summarizeBenchmarkFiles({
  runPath,
  ratingsPath = null,
  ratingKeyPath = null,
  outputPath = null,
} = {}) {
  if (!runPath) throw new Error('runPath is required');
  const run = JSON.parse(await readFile(runPath, 'utf8'));
  let ratings = [];
  if (ratingsPath) {
    const parsed = JSON.parse(await readFile(ratingsPath, 'utf8'));
    if (Array.isArray(parsed.ratings)) {
      ratings = parsed.ratings;
    } else if (Array.isArray(parsed.samples)) {
      const keyPath = ratingKeyPath || path.join(path.dirname(ratingsPath), 'rating-key.json');
      const key = JSON.parse(await readFile(keyPath, 'utf8'));
      validateBlindRatings({ run, ratingSheet: parsed, ratingKey: key });
      const keyBySample = new Map(
        (key.samples || []).map((item) => [String(item.sampleId), item]),
      );
      ratings = parsed.samples
        .map((sample) => {
          const identity = keyBySample.get(String(sample.sampleId));
          if (!identity) return null;
          return {
            caseId: identity.caseId,
            arm: identity.arm,
            publishable: sample.publishable,
            realismScore: sample.realismScore,
            identityConsistencyScore: sample.identityConsistencyScore,
            dialogueAccuracyScore: sample.dialogueAccuracyScore,
            motionFidelityScore: sample.motionFidelityScore,
            notes: sample.notes || '',
          };
        })
        .filter(Boolean);
    }
  }
  const summary = summarizeBenchmarkRun(run, { ratings });
  const destination = outputPath || path.join(path.dirname(runPath), 'summary.json');
  await writeFile(destination, JSON.stringify(summary, null, 2));
  return { summary, outputPath: destination };
}

export function summarizeBenchmarkRun(run, { ratings = [] } = {}) {
  validateNormalizedRatings(run, ratings);
  const completedRatings = ratings.filter(
    (rating) => rating && typeof rating.publishable === 'boolean',
  );
  const ratingMap = new Map(completedRatings.map((rating) => [
    String(rating.caseId) + ':' + String(rating.arm),
    rating,
  ]));
  const baseline = [];
  const full = [];
  for (const pair of run.pairs || []) {
    baseline.push({
      ...pair.baseline,
      rating: ratingMap.get(pair.caseId + ':baseline') || null,
    });
    full.push({
      ...pair.full,
      rating: ratingMap.get(pair.caseId + ':full') || null,
    });
  }
  const baselineSummary = aggregateArm(baseline, false);
  const fullSummary = aggregateArm(full, true);
  return {
    runId: run.runId || null,
    suite: run.suite || null,
    pairCount: (run.pairs || []).length,
    baseline: baselineSummary,
    full: fullSummary,
    comparison: {
      humanPublishableRateDelta: delta(
        fullSummary.humanPublishableRate,
        baselineSummary.humanPublishableRate,
      ),
      humanRealismScoreDelta: delta(
        fullSummary.humanRealismScore,
        baselineSummary.humanRealismScore,
      ),
      humanIdentityConsistencyScoreDelta: delta(
        fullSummary.humanIdentityConsistencyScore,
        baselineSummary.humanIdentityConsistencyScore,
      ),
      humanDialogueAccuracyScoreDelta: delta(
        fullSummary.humanDialogueAccuracyScore,
        baselineSummary.humanDialogueAccuracyScore,
      ),
      humanMotionFidelityScoreDelta: delta(
        fullSummary.humanMotionFidelityScore,
        baselineSummary.humanMotionFidelityScore,
      ),
    },
    ratings: {
      supplied: completedRatings.length,
      expected: countRateableArtifacts(run),
      complete: completedRatings.length > 0
        && completedRatings.length === countRateableArtifacts(run),
    },
    notes: [
      'Provider spend is treated as complete only when every observed provider task reports billing and no configured paid component is outside benchmark instrumentation.',
      'Human ratings stay separate from TikTokMoney internal QC to avoid self-grading bias.',
      'Only compare runs with the same frozen suite hash.',
    ],
  };
}

export function extractFullStackMetrics(project) {
  const scenes = Array.isArray(project && project.scenes) ? project.scenes : [];
  const histories = scenes.map((scene) => (
    Array.isArray(scene.visualQcHistory) ? scene.visualQcHistory : []
  ));
  const retryCount = histories.reduce(
    (sum, history) => sum + Math.max(0, history.length - 1),
    0,
  );
  const publishabilityPassed = project && project.publishability
    ? project.publishability.passed === true
    : null;
  const finalSuccess = ['READY', 'RENDERED'].includes(project && project.status)
    && publishabilityPassed !== false;
  const firstPassSuccess = scenes.length > 0
    && histories.every((history) => history.length === 0 || history[0].passed === true)
    && finalSuccess;
  return {
    firstPassSuccess,
    finalSuccess,
    publishabilityPassed,
    retryCount,
    sceneCount: scenes.length,
    dialogueWer: average(scenes.map((scene) => (
      scene.dialogueVerification && (
        scene.dialogueVerification.wer
        ?? scene.dialogueVerification.wordErrorRate
      )
    ))),
    lipSyncScore: average(scenes.map((scene) => (
      (scene.deepLipSyncQc && (scene.deepLipSyncQc.score ?? scene.deepLipSyncQc.confidence))
      ?? (scene.lipSyncQc && scene.lipSyncQc.score)
    ))),
    poseFidelity: average(scenes.map((scene) => (
      scene.poseMotionQc && scene.poseMotionQc.overallScore
    ))),
    realismScore: average(histories.flatMap((history) => history.map((entry) => (
      entry.realism && entry.realism.overallScore != null
        ? entry.realism.overallScore
        : entry.overallScore
    )))),
  };
}

export function extractProviderUsage(task) {
  if (!task || typeof task !== 'object') return null;
  const usage = task.usage && typeof task.usage === 'object' ? task.usage : {};
  const billing = task.billing && typeof task.billing === 'object' ? task.billing : {};
  const costUsd = firstFinite(
    task.costUsd, task.cost_usd, usage.costUsd, usage.cost_usd,
    billing.costUsd, billing.cost_usd,
  );
  const credits = firstFinite(
    task.credits, usage.credits, usage.creditCount, usage.credit_count, billing.credits,
  );
  return {
    taskId: task.id || null,
    status: task.status || null,
    model: task.model || task.modelId || task.model_id || null,
    costUsd,
    credits,
    providerReported: costUsd != null || credits != null,
  };
}

function validateSuite(suite) {
  if (!suite || suite.schemaVersion !== 1) throw new Error('benchmark suite schemaVersion must be 1');
  if (!suite.name || !suite.version || !suite.frozenHash) {
    throw new Error('benchmark suite requires name, version and frozenHash');
  }
  if (!Array.isArray(suite.cases) || !suite.cases.length) {
    throw new Error('benchmark suite requires at least one case');
  }
  const ids = new Set();
  for (const item of suite.cases) {
    if (!item.id || !item.category || !item.topic || !item.baselinePrompt) {
      throw new Error('every benchmark case requires id, category, topic and baselinePrompt');
    }
    if (ids.has(item.id)) throw new Error('duplicate benchmark case id: ' + item.id);
    ids.add(item.id);
    const duration = Number(item.durationSeconds);
    if (!Number.isFinite(duration) || duration < 4 || duration > 15) {
      throw new Error('benchmark case ' + item.id + ' durationSeconds must be between 4 and 15');
    }
  }
}

function selectCases(cases, { limit = null, caseIds = [] } = {}) {
  const requested = new Set((Array.isArray(caseIds) ? caseIds : [caseIds]).filter(Boolean));
  let selected = requested.size
    ? cases.filter((item) => requested.has(item.id))
    : [...cases];
  if (requested.size && selected.length !== requested.size) {
    const found = new Set(selected.map((item) => item.id));
    const missing = [...requested].filter((id) => !found.has(id));
    throw new Error('unknown benchmark case id(s): ' + missing.join(', '));
  }
  if (limit != null) {
    selected = selected.slice(0, Math.max(1, Math.floor(Number(limit) || 0)));
  }
  return selected;
}

async function generatePlainBaseline(provider, benchmarkCase, runId) {
  const duration = clamp(Math.round(Number(benchmarkCase.durationSeconds) || 10), 4, 15);
  const task = await provider.createTask('/text_to_video', {
    model: provider.model,
    promptText: benchmarkCase.baselinePrompt,
    audio: true,
    duration,
    ratio: provider.ratio,
  });
  const completed = await provider.wait(task.id);
  const sourceUrl = firstOutputUrl(completed);
  if (!sourceUrl) throw new Error('plain provider baseline completed without output');
  const assetDir = provider.assetDir || './outputs/assets';
  await mkdir(assetDir, { recursive: true });
  const localPath = path.join(
    assetDir,
    'benchmark-' + safe(runId) + '-' + safe(benchmarkCase.id) + '-' + safe(task.id) + '.mp4',
  );
  await provider.download(sourceUrl, localPath);
  return {
    localPath,
    generationId: task.id,
    model: provider.model,
  };
}

function instrumentProviderWait(provider, now) {
  const original = provider.wait.bind(provider);
  let events = [];
  provider.wait = async (...args) => {
    const startedAt = now();
    const task = await original(...args);
    const usage = extractProviderUsage(task) || {};
    events.push({
      ...usage,
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
    });
    return task;
  };
  return {
    reset() { events = []; },
    snapshot() { return events.map((event) => ({ ...event })); },
    restore() { provider.wait = original; },
  };
}

async function timedArm(fn) {
  const started = performance.now();
  try {
    const result = await fn();
    return { ...result, latencyMs: round(performance.now() - started, 1), error: null };
  } catch (error) {
    return {
      success: false,
      artifactPath: null,
      latencyMs: round(performance.now() - started, 1),
      error: error.message,
    };
  }
}

function summarizeUsage(events, {
  scope = 'provider',
  untrackedComponents = [],
} = {}) {
  const cost = events.map((event) => event.costUsd).filter(Number.isFinite);
  const credits = events.map((event) => event.credits).filter(Number.isFinite);
  const costUsdObserved = cost.length
    ? round(cost.reduce((sum, value) => sum + value, 0), 6)
    : null;
  const creditsObserved = credits.length
    ? round(credits.reduce((sum, value) => sum + value, 0), 6)
    : null;
  const costUsdComplete = events.length > 0
    && cost.length === events.length
    && untrackedComponents.length === 0;
  const creditsComplete = events.length > 0
    && credits.length === events.length
    && untrackedComponents.length === 0;
  return {
    scope,
    taskCount: events.length,
    providerReportedTaskCount: events.filter((event) => event.providerReported).length,
    usdReportedTaskCount: cost.length,
    creditReportedTaskCount: credits.length,
    costUsdObserved,
    costUsdComplete,
    costUsd: costUsdComplete ? costUsdObserved : null,
    creditsObserved,
    creditsComplete,
    credits: creditsComplete ? creditsObserved : null,
    untrackedComponents: [...untrackedComponents],
    source: costUsdComplete || creditsComplete
      ? 'provider-reported-complete'
      : cost.length || credits.length
        ? 'provider-reported-partial'
        : 'unavailable',
    events,
  };
}

function aggregateArm(rows, isFull) {
  const count = rows.length;
  const ratings = rows.map((row) => row.rating).filter(Boolean);
  const rateable = rows.filter((row) => row.success && row.artifactPath).length;
  const publishable = ratings.filter((rating) => rating.publishable === true).length;
  const completeCosts = rows
    .filter((row) => row.spend?.costUsdComplete === true)
    .map((row) => row.spend.costUsd)
    .filter(Number.isFinite);
  const observedCosts = rows
    .map((row) => row.spend?.costUsdObserved ?? row.spend?.costUsd)
    .filter(Number.isFinite);
  const totalCost = completeCosts.length === count && count
    ? round(completeCosts.reduce((sum, value) => sum + value, 0), 6)
    : null;
  const observedCost = observedCosts.length
    ? round(observedCosts.reduce((sum, value) => sum + value, 0), 6)
    : null;
  return {
    caseCount: count,
    generationSuccessRate: rate(rows.filter((row) => row.success).length, count),
    firstPassSuccessRate: isFull
      ? rate(rows.filter((row) => row.metrics && row.metrics.firstPassSuccess).length, count)
      : null,
    finalSuccessRate: isFull
      ? rate(rows.filter((row) => row.metrics && row.metrics.finalSuccess).length, count)
      : rate(rows.filter((row) => row.success).length, count),
    averageRetries: isFull ? average(rows.map((row) => row.metrics && row.metrics.retryCount)) : 0,
    averageLatencyMs: average(rows.map((row) => row.latencyMs)),
    totalProviderSpendUsd: totalCost,
    observedProviderSpendUsd: observedCost,
    spendCoverageRate: rate(completeCosts.length, count),
    observedSpendCoverageRate: rate(observedCosts.length, count),
    humanRatingCoverageRate: rate(ratings.length, rateable),
    humanPublishableRate: rate(publishable, count),
    humanRealismScore: average(ratings.map((rating) => rating.realismScore)),
    humanIdentityConsistencyScore: average(ratings.map((rating) => rating.identityConsistencyScore)),
    humanDialogueAccuracyScore: average(ratings.map((rating) => rating.dialogueAccuracyScore)),
    humanMotionFidelityScore: average(ratings.map((rating) => rating.motionFidelityScore)),
    costPerHumanPublishableVideoUsd: totalCost != null && ratings.length === rateable && publishable > 0
      ? round(totalCost / publishable, 6)
      : null,
  };
}

function firstScenePath(scenes) {
  for (const scene of scenes || []) {
    if (scene.asset && scene.asset.localPath) return scene.asset.localPath;
  }
  return null;
}

function firstOutputUrl(task) {
  if (Array.isArray(task && task.output)) {
    const first = task.output[0];
    if (typeof first === 'string') return first;
    return first && first.url ? first.url : null;
  }
  return task && task.output && task.output.url ? task.output.url : null;
}

function firstFinite(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

async function createBlindedReviewPack({ run, runDir }) {
  const candidates = [];
  for (const pair of run.pairs || []) {
    for (const arm of ['baseline', 'full']) {
      const result = pair[arm];
      if (!result?.success || !result.artifactPath) continue;
      candidates.push({
        caseId: pair.caseId,
        category: pair.category,
        topic: pair.topic,
        arm,
        artifactPath: result.artifactPath,
        sortKey: crypto.createHash('sha256')
          .update(String(run.runId) + ':' + pair.caseId + ':' + arm)
          .digest('hex'),
      });
    }
  }
  candidates.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  const reviewDir = path.join(runDir, 'review');
  await mkdir(reviewDir, { recursive: true });
  const samples = [];
  const keySamples = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const sampleId = 'sample_' + String(index + 1).padStart(3, '0');
    const extension = path.extname(candidate.artifactPath) || '.mp4';
    const reviewPath = path.join(reviewDir, sampleId + extension);
    try {
      await link(candidate.artifactPath, reviewPath);
    } catch {
      await copyFile(candidate.artifactPath, reviewPath);
    }
    samples.push({
      sampleId,
      category: candidate.category,
      topic: candidate.topic,
      artifactPath: reviewPath,
      publishable: null,
      realismScore: null,
      identityConsistencyScore: null,
      dialogueAccuracyScore: null,
      motionFidelityScore: null,
      notes: '',
    });
    keySamples.push({
      sampleId,
      caseId: candidate.caseId,
      arm: candidate.arm,
    });
  }

  return {
    ratingSheet: {
      schemaVersion: 1,
      runId: run.runId,
      blinded: true,
      scoreScale: '1-5; higher is better',
      instructions: [
        'Review each sample without opening rating-key.json.',
        'Set publishable to true or false.',
        'Score realism, identity consistency, dialogue accuracy and motion fidelity from 1 to 5.',
        'Use null when a dimension is genuinely not applicable.',
      ],
      samples,
    },
    ratingKey: {
      schemaVersion: 1,
      runId: run.runId,
      warning: 'Keep this file hidden from raters until scoring is complete.',
      samples: keySamples,
    },
  };
}

function detectUntrackedCostComponents(pipeline) {
  const components = [];
  const llm = pipeline?.productionScriptGenerator?.llm;
  if (llm && llm.constructor?.name !== 'TemplateLlmProvider') components.push('llm');
  if (pipeline?.realismQc) components.push('realism-qc');
  if (pipeline?.dialogueQc) components.push('dialogue-qc');
  if (pipeline?.lipSyncQc) components.push('lip-sync-qc');
  if (pipeline?.speakerTurnQc) components.push('speaker-turn-qc');
  return [...new Set(components)];
}

function validateBlindRatings({ run, ratingSheet, ratingKey }) {
  if (ratingSheet?.runId !== run?.runId) {
    throw new Error('ratings runId does not match benchmark manifest');
  }
  if (ratingKey?.runId !== run?.runId) {
    throw new Error('rating-key runId does not match benchmark manifest');
  }
  const samples = Array.isArray(ratingSheet?.samples) ? ratingSheet.samples : [];
  const keySamples = Array.isArray(ratingKey?.samples) ? ratingKey.samples : [];
  const keyBySample = new Map();
  for (const item of keySamples) {
    const sampleId = String(item?.sampleId || '');
    if (!sampleId) throw new Error('rating-key contains a sample without sampleId');
    if (keyBySample.has(sampleId)) throw new Error('duplicate rating-key sampleId: ' + sampleId);
    if (!['baseline', 'full'].includes(item.arm)) throw new Error('invalid rating-key arm: ' + item.arm);
    keyBySample.set(sampleId, item);
  }
  const seen = new Set();
  for (const sample of samples) {
    const sampleId = String(sample?.sampleId || '');
    if (!sampleId || !keyBySample.has(sampleId)) {
      throw new Error('unknown rating sampleId: ' + sampleId);
    }
    if (seen.has(sampleId)) throw new Error('duplicate rating sampleId: ' + sampleId);
    seen.add(sampleId);
    validateRatingValues(sample);
  }
}

function validateNormalizedRatings(run, ratings) {
  if (!Array.isArray(ratings)) throw new Error('ratings must be an array');
  const validPairs = new Set();
  for (const pair of run?.pairs || []) {
    if (pair.baseline?.success && pair.baseline?.artifactPath) validPairs.add(pair.caseId + ':baseline');
    if (pair.full?.success && pair.full?.artifactPath) validPairs.add(pair.caseId + ':full');
  }
  const seen = new Set();
  for (const rating of ratings) {
    if (!rating || typeof rating !== 'object') throw new Error('rating must be an object');
    if (!['baseline', 'full'].includes(rating.arm)) throw new Error('invalid rating arm: ' + rating.arm);
    const key = String(rating.caseId) + ':' + rating.arm;
    if (!validPairs.has(key)) throw new Error('rating does not match a rateable artifact: ' + key);
    if (seen.has(key)) throw new Error('duplicate rating for ' + key);
    seen.add(key);
    validateRatingValues(rating);
  }
}

function validateRatingValues(rating) {
  if (rating.publishable !== null && rating.publishable !== undefined
      && typeof rating.publishable !== 'boolean') {
    throw new Error('publishable must be boolean or null');
  }
  for (const field of [
    'realismScore',
    'identityConsistencyScore',
    'dialogueAccuracyScore',
    'motionFidelityScore',
  ]) {
    const value = rating[field];
    if (value == null) continue;
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new Error(field + ' must be an integer from 1 to 5 or null');
    }
  }
}

function countRateableArtifacts(run) {
  let count = 0;
  for (const pair of run.pairs || []) {
    if (pair.baseline?.success && pair.baseline?.artifactPath) count += 1;
    if (pair.full?.success && pair.full?.artifactPath) count += 1;
  }
  return count;
}

function average(values) {
  const finite = values
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map(Number)
    .filter(Number.isFinite);
  if (!finite.length) return null;
  return round(finite.reduce((sum, value) => sum + value, 0) / finite.length, 6);
}

function rate(numerator, denominator) {
  return denominator ? round(numerator / denominator, 6) : null;
}

function delta(a, b) {
  return a != null && b != null ? round(a - b, 6) : null;
}

function round(value, precision = 6) {
  const factor = 10 ** precision;
  return Math.round(Number(value) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safe(value) {
  return String(value || 'item').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 100);
}

function timestampId(date) {
  return date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}
