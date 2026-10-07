import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { buildProjectCostLedger } from '../services/costLedger.js';
import { ProviderBillingStore } from './providerBillingStore.js';

export class JsonStore {
  constructor(rootDir = './data', {
    billingStore = new ProviderBillingStore(process.env.PROVIDER_BILLING_PATH || './data/provider-billing.json'),
  } = {}) {
    this.rootDir = rootDir;
    this.billingStore = billingStore;
  }

  async saveProject(project) {
    const billingRecords = this.billingStore ? await this.billingStore.list() : [];
    project.costLedger = buildProjectCostLedger(project, { billingRecords });
    await mkdir(this.rootDir, { recursive: true });
    const file = path.join(this.rootDir, `${project.id}.json`);
    await writeFile(file, JSON.stringify(project, null, 2));
    return file;
  }

  async getProject(id) {
    const file = path.join(this.rootDir, `${id}.json`);
    return JSON.parse(await readFile(file, 'utf8'));
  }

  async listProjects({ limit = 200 } = {}) {
    let names = [];
    try {
      names = await readdir(this.rootDir);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }

    const projects = [];
    for (const name of names.filter((item) => /^vid_.*\.json$/.test(item))) {
      try {
        const project = JSON.parse(await readFile(path.join(this.rootDir, name), 'utf8'));
        projects.push(project);
      } catch {
        // Ignore malformed project artifacts in observability listings.
      }
    }

    return projects
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, Math.max(1, Math.min(5000, Number(limit) || 200)));
  }
}
