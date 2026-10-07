#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import {
  runRealGenerationBenchmark,
  summarizeBenchmarkFiles,
} from './benchmarks/realGenerationBenchmark.js';

const [command = 'help', ...args] = process.argv.slice(2);
const options = parseArgs(args);
const liveBenchmark = command === 'benchmark-real' && options['confirm-spend'] === true;
const app = command === 'benchmark-summary' || (command === 'benchmark-real' && !liveBenchmark)
  ? null
  : command === 'benchmark-real'
    ? createApp({ trendIntelligence: null })
    : createApp();

try {
  if (command === 'generate') {
    const topic = options.topic || options.t;
    if (!topic) throw new Error('Usage: npm run generate -- --topic "Your topic"');
    const project = await app.pipeline.generate({
      topic,
      audience: options.audience || 'curious adults',
      durationSeconds: Number(options.duration || 35),
      render: options['no-render'] !== true,
    });
    console.log(JSON.stringify(project, null, 2));
  } else if (command === 'resume') {
    const id = options.id || options.project;
    if (!id) throw new Error('Usage: npm run resume -- --id vid_...');
    if (typeof app.pipeline.resume !== 'function') {
      throw new Error('resume requires VIDEO_PIPELINE_MODE=audiovisual');
    }
    const project = await app.pipeline.resume(id, { render: options['no-render'] !== true });
    console.log(JSON.stringify(project, null, 2));
  } else if (command === 'tiktok-auth-url') {
    console.log(JSON.stringify(await app.beginTikTokAuthorization(), null, 2));
  } else if (command === 'tiktok-auth-status') {
    console.log(JSON.stringify(await app.tiktokAuthorizationStatus(), null, 2));
  } else if (command === 'tiktok-auth-refresh') {
    await app.refreshTikTokAuthorization();
    console.log(JSON.stringify(await app.tiktokAuthorizationStatus(), null, 2));
  } else if (command === 'tiktok-webhooks') {
    console.log(JSON.stringify(await app.listTikTokWebhooks({
      limit: options.limit ? Number(options.limit) : undefined,
      status: options.status || null,
    }), null, 2));
  } else if (command === 'tiktok-webhooks-process') {
    console.log(JSON.stringify(await app.processPendingTikTokWebhooks({
      limit: options.limit ? Number(options.limit) : undefined,
    }), null, 2));
  } else if (command === 'health') {
    console.log(JSON.stringify(await app.observabilitySnapshot(), null, 2));
  } else if (command === 'billing-import') {
    const file = options.file || options.input;
    if (!file) throw new Error('Usage: node src/cli.js billing-import --file ./billing.json [--source provider-export]');
    const payload = JSON.parse(await readFile(file, 'utf8'));
    const records = Array.isArray(payload) ? payload : payload.records;
    if (!Array.isArray(records)) throw new Error('billing import file must contain an array or { records: [] }');
    console.log(JSON.stringify(await app.importProviderBilling(records, {
      source: options.source || 'manual-import',
    }), null, 2));
  } else if (command === 'billing-reconcile') {
    const id = options.id || options.project;
    if (!id) throw new Error('Usage: node src/cli.js billing-reconcile --id vid_...');
    console.log(JSON.stringify(await app.reconcileProjectBilling(id), null, 2));
  } else if (command === 'publish') {
    const id = options.id || options.project;
    if (!id) throw new Error('Usage: node src/cli.js publish --id vid_... --privacy SELF_ONLY --confirm-publish');
    if (options['confirm-publish'] !== true) {
      throw new Error('--confirm-publish is required before sending a video to TikTok');
    }
    if (!options.privacy) {
      throw new Error('--privacy is required and must match TikTok creator privacy options');
    }
    const publication = await app.publishProject(id, {
      confirmPublish: true,
      title: options.title || null,
      privacyLevel: options.privacy,
      disableComment: options['disable-comment'] === true,
      disableDuet: options['disable-duet'] === true,
      disableStitch: options['disable-stitch'] === true,
      videoCoverTimestampMs: options['cover-ms'] ? Number(options['cover-ms']) : 1000,
    });
    console.log(JSON.stringify(publication, null, 2));
  } else if (command === 'publish-schedule') {
    const id = options.id || options.project;
    if (!id) throw new Error('Usage: node src/cli.js publish-schedule --id vid_... --at 2026-10-08T12:00:00Z --privacy SELF_ONLY --confirm-publish');
    if (options['confirm-publish'] !== true) {
      throw new Error('--confirm-publish is required before scheduling a TikTok publication');
    }
    if (!options.privacy) throw new Error('--privacy is required');
    console.log(JSON.stringify(await app.schedulePublication(id, {
      runAt: options.at || options['run-at'],
      confirmPublish: true,
      privacyLevel: options.privacy,
      title: options.title || null,
      disableComment: options['disable-comment'] === true,
      disableDuet: options['disable-duet'] === true,
      disableStitch: options['disable-stitch'] === true,
      videoCoverTimestampMs: options['cover-ms'] ? Number(options['cover-ms']) : 1000,
    }), null, 2));
  } else if (command === 'orchestration-run') {
    console.log(JSON.stringify(await app.runPublicationOrchestration({
      limit: options.limit ? Number(options.limit) : undefined,
    }), null, 2));
  } else if (command === 'orchestration-jobs') {
    console.log(JSON.stringify(await app.listOrchestrationJobs({
      limit: options.limit ? Number(options.limit) : undefined,
      status: options.status || null,
    }), null, 2));
  } else if (command === 'publication-refresh') {
    const id = options.id || options.publication;
    if (!id) throw new Error('Usage: node src/cli.js publication-refresh --id pub_...');
    console.log(JSON.stringify(await app.refreshPublication(id), null, 2));
  } else if (command === 'publication-metrics') {
    const id = options.id || options.publication;
    if (!id) throw new Error('Usage: node src/cli.js publication-metrics --id pub_...');
    console.log(JSON.stringify(await app.refreshPublicationMetrics(id), null, 2));
  } else if (command === 'publications') {
    console.log(JSON.stringify(await app.listPublications({
      limit: options.limit ? Number(options.limit) : undefined,
    }), null, 2));
  } else if (command === 'performance-outcomes') {
    console.log(JSON.stringify(await app.listPerformanceOutcomes({
      limit: options.limit ? Number(options.limit) : undefined,
    }), null, 2));
  } else if (command === 'learning-context') {
    console.log(JSON.stringify(await app.performanceLearningContext({
      topic: options.topic || null,
      audience: options.audience || null,
    }), null, 2));
  } else if (command === 'experiments') {
    console.log(JSON.stringify(await app.listExperiments(), null, 2));
  } else if (command === 'experiment-evaluate') {
    const id = options.id || options.experiment;
    if (!id) throw new Error('Usage: node src/cli.js experiment-evaluate --id exp_...');
    console.log(JSON.stringify(await app.evaluateExperiment(id), null, 2));
  } else if (command === 'opportunities') {
    console.log(JSON.stringify(await app.opportunities(), null, 2));
  } else if (command === 'research') {
    const topic = options.topic || options.t;
    if (!topic) throw new Error('Usage: node src/cli.js research --topic "Your topic"');
    const packet = await app.research(topic);
    if (!packet) throw new Error('Live trend intelligence is not configured');
    console.log(JSON.stringify(packet, null, 2));
  } else if (command === 'plan') {
    const plan = await app.planDay({
      date: options.date,
      budgetUsd: options.budget ? Number(options.budget) : undefined,
      maxVideos: options['max-videos'] ? Number(options['max-videos']) : undefined,
      audience: options.audience || 'curious adults',
      durationSeconds: Number(options.duration || 35),
      render: options['no-render'] !== true,
    });
    console.log(JSON.stringify(plan, null, 2));
  } else if (command === 'run-plan') {
    const planId = options.id || options.plan;
    if (!planId) throw new Error('Usage: node src/cli.js run-plan --id "plan_..."');
    const plan = await app.runPlan(planId, {
      render: options['no-render'] ? false : null,
      stopOnFailure: options['stop-on-failure'] === true,
    });
    console.log(JSON.stringify(plan, null, 2));
  } else if (command === 'plans') {
    console.log(JSON.stringify(await app.listPlans({
      limit: options.limit ? Number(options.limit) : undefined,
    }), null, 2));
  } else if (command === 'benchmark-real') {
    const result = await runRealGenerationBenchmark({
      suitePath: options.suite || './data/benchmarks/real-generation-v1.json',
      outputDir: options.output || './outputs/benchmarks',
      app,
      confirmSpend: options['confirm-spend'] === true,
      limit: options.limit ? Number(options.limit) : null,
      caseIds: csv(options.case || options.cases),
      render: options['no-render'] !== true,
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'benchmark-summary') {
    const runPath = options.run || options.manifest;
    if (!runPath) {
      throw new Error(
        'Usage: node src/cli.js benchmark-summary --run ./outputs/benchmarks/<run>/manifest.json [--ratings ./ratings-blind.json]',
      );
    }
    const result = await summarizeBenchmarkFiles({
      runPath,
      ratingsPath: options.ratings || null,
      ratingKeyPath: options['rating-key'] || null,
      outputPath: options.output || null,
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'motion-library-build') {
    const input = options.input || options.file;
    const directory = options.dir || options.directory;
    if (!input && !directory) {
      throw new Error(
        'Usage: node src/cli.js motion-library-build --input ./clip.mp4 --license "owned footage" --rights-confirmed',
      );
    }
    if (options['rights-confirmed'] !== true) {
      throw new Error('--rights-confirmed is required for motion-library ingestion');
    }
    const report = await app.buildMotionLibrary({
      clips: input ? [{ localPath: input }] : [],
      directory,
      source: options.source || '',
      license: options.license || '',
      rightsConfirmed: true,
      actionHint: options.action || null,
      cameraMode: options.camera || 'any',
      people: options.people ? Number(options.people) : 1,
    });
    console.log(JSON.stringify(report, null, 2));
  } else if (command === 'motion-library') {
    console.log(JSON.stringify(await app.listMotionLibrary(), null, 2));
  } else {
    console.log([
      'TikTokMoney prototype',
      '',
      'Commands:',
      '  generate --topic "..." [--duration 35]',
      '  resume --id "vid_..." [--no-render]   continue a saved video from its first missing act',
      '  opportunities',
      '  tiktok-auth-url',
      '  tiktok-auth-status',
      '  tiktok-auth-refresh',
      '  tiktok-webhooks [--status RECEIVED]',
      '  tiktok-webhooks-process [--limit 100]',
      '  health',
      '  billing-import --file ./billing.json [--source provider-export]',
      '  billing-reconcile --id "vid_..."',
      '  publish --id "vid_..." --privacy SELF_ONLY --confirm-publish',
      '  publish-schedule --id "vid_..." --at "2026-10-08T12:00:00Z" --privacy SELF_ONLY --confirm-publish',
      '  orchestration-run [--limit 50]',
      '  orchestration-jobs [--status QUEUED]',
      '  publication-refresh --id "pub_..."',
      '  publication-metrics --id "pub_..."',
      '  publications [--limit 50]',
      '  performance-outcomes [--limit 100]',
      '  learning-context [--topic "..."] [--audience "..."]',
      '  experiments',
      '  experiment-evaluate --id "exp_..."',
      '  research --topic "..."',
      '  plan [--budget 6] [--max-videos 3]',
      '  run-plan --id "plan_..."',
      '  plans',
      '  benchmark-real [--case talking-head-01] [--limit 3]',
      '  benchmark-real --confirm-spend [--case talking-head-01]',
      '  benchmark-summary --run ./outputs/benchmarks/<run>/manifest.json [--ratings ./ratings-blind.json]',
      '  motion-library-build --input ./clip.mp4 --license "owned footage" --rights-confirmed [--action squat]',
      '  motion-library',
      '',
      'benchmark-real is dry-run by default. --confirm-spend is required before paid provider calls.',
      'publish is disabled by default. --confirm-publish and an explicit TikTok privacy level are required.',
    ].join('\n'));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function parseArgs(values) {
  const result = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = values[i + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else {
      result[key] = next;
      i += 1;
    }
  }
  return result;
}

function csv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
