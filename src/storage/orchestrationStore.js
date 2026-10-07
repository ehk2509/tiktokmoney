import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class OrchestrationStore {
  constructor(filePath = process.env.ORCHESTRATION_STORE_PATH || './data/orchestration.json') {
    this.filePath = filePath;
  }

  async saveJob(job) {
    const state = await this.load();
    const index = state.jobs.findIndex((item) => item.id === job.id);
    if (index >= 0) state.jobs[index] = job;
    else state.jobs.push(job);
    state.jobs = state.jobs
      .sort((a, b) => String(a.runAt).localeCompare(String(b.runAt)))
      .slice(0, 5000);
    await this.save(state);
    return job;
  }

  async getJob(id) {
    const state = await this.load();
    return state.jobs.find((item) => item.id === id) || null;
  }

  async listJobs({ limit = 200, status = null } = {}) {
    const state = await this.load();
    const rows = status
      ? state.jobs.filter((item) => item.status === status)
      : state.jobs;
    return rows.slice(0, Math.max(1, Math.min(5000, Number(limit) || 200)));
  }

  async dueJobs(now = new Date()) {
    const state = await this.load();
    const nowMs = now.getTime();
    return state.jobs
      .filter((job) => ['QUEUED', 'RETRY'].includes(job.status))
      .filter((job) => {
        const runAt = Date.parse(job.runAt || '');
        return Number.isFinite(runAt) && runAt <= nowMs;
      })
      .sort((a, b) => String(a.runAt).localeCompare(String(b.runAt)));
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      return {
        version: 1,
        jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : [],
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, jobs: [] };
      throw error;
    }
  }

  async save(state) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2));
  }
}
