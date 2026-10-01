#!/usr/bin/env node
import { createApp } from './app.js';

const [command = 'help', ...args] = process.argv.slice(2);
const options = parseArgs(args);
const app = createApp();

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
  } else {
    console.log('TikTokMoney prototype\n\nCommands:\n  generate --topic "..." [--duration 35]\n  opportunities\n  research --topic "..."\n  plan [--budget 6] [--max-videos 3]\n  run-plan --id "plan_..."\n  plans');
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
