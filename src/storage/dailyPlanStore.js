import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class DailyPlanStore {
  constructor(filePath = process.env.DAILY_PLAN_PATH || './data/daily-plans.json') {
    this.filePath = filePath;
  }

  async savePlan(plan) {
    const state = await this.load();
    const index = state.plans.findIndex((item) => item.id === plan.id);
    if (index >= 0) state.plans[index] = plan;
    else state.plans.push(plan);

    state.plans = state.plans
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 180);

    await this.save(state);
    return plan;
  }

  async getPlan(id) {
    const state = await this.load();
    return state.plans.find((plan) => plan.id === id) || null;
  }

  async listPlans({ limit = 30 } = {}) {
    const state = await this.load();
    return state.plans.slice(0, Math.max(1, Math.min(180, Number(limit) || 30)));
  }

  async recentTopics({ days = 7, now = new Date() } = {}) {
    const state = await this.load();
    const cutoff = now.getTime() - Math.max(1, Number(days) || 7) * 24 * 3600 * 1000;
    const seen = new Map();

    for (const plan of state.plans) {
      const planTime = Date.parse(plan.createdAt || plan.date);
      if (!Number.isFinite(planTime) || planTime < cutoff) continue;
      for (const job of plan.jobs || []) {
        if (!job.topic) continue;
        if (job.status === 'SKIPPED') continue;
        const key = normalize(job.topic);
        if (!seen.has(key)) {
          seen.set(key, {
            topic: job.topic,
            opportunityId: job.opportunityId || null,
            planId: plan.id,
            status: job.status,
            createdAt: plan.createdAt,
          });
        }
      }
    }

    return [...seen.values()];
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      return {
        version: 1,
        plans: Array.isArray(parsed?.plans) ? parsed.plans : [],
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, plans: [] };
      throw error;
    }
  }

  async save(state) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2));
  }
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
