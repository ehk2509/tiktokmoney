import crypto from 'node:crypto';
import { ScriptGenerator } from './scriptGenerator.js';
import { planScenes } from './scenePlanner.js';
import { evaluateProject } from './qualityGate.js';

export class VideoPipeline {
  constructor({ llm, renderer, store }) {
    this.scriptGenerator = new ScriptGenerator({ llm });
    this.renderer = renderer;
    this.store = store;
  }

  async generate({ topic, audience = 'curious adults', durationSeconds = 35, render = true }) {
    if (!topic?.trim()) throw new Error('topic is required');

    const id = `vid_${crypto.randomUUID()}`;
    const script = await this.scriptGenerator.generate({ topic: topic.trim(), audience, durationSeconds });
    const scenes = planScenes(script);
    const quality = evaluateProject({ script, scenes });

    const project = {
      id,
      status: quality.passed ? 'QC_PASSED' : 'QC_FAILED',
      topic: topic.trim(),
      audience,
      createdAt: new Date().toISOString(),
      script,
      scenes,
      quality,
      render: null,
    };

    if (!quality.passed) {
      await this.store?.saveProject(project);
      return project;
    }

    if (render && this.renderer) {
      project.status = 'RENDERING';
      project.render = await this.renderer.render(project);
      project.status = 'RENDERED';
    }

    await this.store?.saveProject(project);
    return project;
  }
}
