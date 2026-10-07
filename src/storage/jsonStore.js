import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildProjectCostLedger } from '../services/costLedger.js';

export class JsonStore {
  constructor(rootDir = './data') {
    this.rootDir = rootDir;
  }

  async saveProject(project) {
    project.costLedger = buildProjectCostLedger(project);
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
