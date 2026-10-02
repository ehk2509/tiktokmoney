#!/usr/bin/env node
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
      '  opportunities',
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
