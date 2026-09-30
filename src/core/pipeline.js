import crypto from 'node:crypto';
import { ScriptGenerator } from './scriptGenerator.js';
import { planScenes } from './scenePlanner.js';
import { evaluateProject } from './qualityGate.js';

export class VideoPipeline {
  constructor({ llm, renderer, store, stock = null, voice = null }) {
    this.scriptGenerator = new ScriptGenerator({ llm });
    this.renderer = renderer;
    this.store = store;
    this.stock = stock;
    this.voice = voice;
  }

  async generate({ topic, audience = 'curious adults', durationSeconds = 35, render = true }) {
    if (!topic?.trim()) throw new Error('topic is required');

    const id = `vid_${crypto.randomUUID()}`;
    const script = await this.scriptGenerator.generate({
      topic: topic.trim(),
      audience,
      durationSeconds,
    });
    let scenes = planScenes(script);
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
      voice: null,
      warnings: [],
      render: null,
    };

    if (!quality.passed) {
      await this.store?.saveProject(project);
      return project;
    }

    project.status = 'ASSETS_RESOLVING';
    project.scenes = await resolveAssets({
      provider: this.stock,
      scenes,
      projectId: id,
      warnings: project.warnings,
    });

    if (this.voice) {
      project.status = 'VOICE_GENERATING';
      try {
        project.voice = await this.voice.synthesize({
          text: narrationText(script),
          projectId: id,
        });
      } catch (error) {
        project.status = 'VOICE_FAILED';
        project.error = error.message;
        await this.store?.saveProject(project);
        return project;
      }

      if (project.voice?.durationSeconds > 0) {
        scenes = retimeScenes(project.scenes, project.voice.durationSeconds);
        project.scenes = scenes;
      }
    }

    project.status = 'READY';

    if (render && this.renderer) {
      project.status = 'RENDERING';
      try {
        project.render = await this.renderer.render(project);
        project.status = 'RENDERED';
      } catch (error) {
        project.status = 'RENDER_FAILED';
        project.error = error.message;
      }
    }

    await this.store?.saveProject(project);
    return project;
  }
}

async function resolveAssets({ provider, scenes, projectId, warnings }) {
  if (!provider) return scenes;

  const resolved = [];
  for (const scene of scenes) {
    try {
      const asset = await provider.resolveScene(scene, { projectId });
      resolved.push({ ...scene, asset });
    } catch (error) {
      warnings.push({
        stage: 'assets',
        scene: scene.index,
        message: error.message,
      });
      resolved.push({ ...scene, asset: null });
    }
  }
  return resolved;
}

function narrationText(script) {
  return [script.hook, ...script.body, script.payoff, script.cta]
    .filter(Boolean)
    .join(' ');
}

function retimeScenes(scenes, totalDuration) {
  const originalDuration = scenes.reduce((sum, scene) => sum + scene.duration, 0) || 1;
  const scale = totalDuration / originalDuration;
  let cursor = 0;

  return scenes.map((scene, index) => {
    const isLast = index === scenes.length - 1;
    const duration = isLast
      ? Math.max(0.5, totalDuration - cursor)
      : Math.max(0.5, scene.duration * scale);
    const retimed = {
      ...scene,
      start: round(cursor),
      duration: round(duration),
    };
    cursor += duration;
    return retimed;
  });
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
