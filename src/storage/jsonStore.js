import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
}
