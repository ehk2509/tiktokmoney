import crypto from 'node:crypto';
import { ScriptGenerator } from './scriptGenerator.js';
import { planScenes } from './scenePlanner.js';
import { evaluateProject } from './qualityGate.js';

export class VideoPipeline {
  constructor({
    llm,
    renderer,
    store,
    visual = null,
    stock = null,
    voice = null,
    realismQc = null,
  }) {
    this.scriptGenerator = new ScriptGenerator({ llm });
    this.renderer = renderer;
    this.store = store;
    this.visual = visual || stock;
    this.voice = voice;
    this.realismQc = realismQc;
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
      visualStrategy: this.visual?.strategy || (this.visual ? 'custom' : 'fallback-card'),
      realismQc: {
        enabled: Boolean(this.realismQc),
        provider: this.realismQc ? 'openrouter' : null,
        model: this.realismQc?.model || null,
        threshold: this.realismQc?.threshold || null,
        maxRegenerations: this.realismQc?.maxRegenerations || 0,
      },
      warnings: [],
      render: null,
    };

    if (!quality.passed) {
      await this.store?.saveProject(project);
      return project;
    }

    project.status = this.realismQc ? 'VISUALS_GENERATING_AND_QC' : 'VISUALS_GENERATING';
    const visualResult = await resolveVisuals({
      provider: this.visual,
      qc: this.realismQc,
      scenes,
      projectId: id,
      warnings: project.warnings,
    });
    project.scenes = visualResult.scenes;

    if (visualResult.fatalQcFailures.length) {
      project.status = 'VISUAL_QC_FAILED';
      project.visualQcFailures = visualResult.fatalQcFailures;
      await this.store?.saveProject(project);
      return project;
    }

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

async function resolveVisuals({
  provider,
  qc,
  scenes,
  projectId,
  warnings,
}) {
  if (!provider) {
    return { scenes, fatalQcFailures: [] };
  }

  const resolved = [];
  const fatalQcFailures = [];
  let previousContinuityAsset = null;

  for (const scene of scenes) {
    const result = await resolveOneScene({
      provider,
      qc,
      scene,
      projectId,
      previousAsset: previousContinuityAsset,
      warnings,
    });

    resolved.push({
      ...scene,
      asset: result.asset,
      visualQcHistory: result.qcHistory,
    });

    if (result.fatalQcFailure) {
      fatalQcFailures.push(result.fatalQcFailure);
    }

    if (result.asset?.referenceImageUrl) {
      previousContinuityAsset = result.asset;
    }
  }

  return { scenes: resolved, fatalQcFailures };
}

async function resolveOneScene({
  provider,
  qc,
  scene,
  projectId,
  previousAsset,
  warnings,
}) {
  const maxRegenerations = qc?.maxRegenerations || 0;
  const qcHistory = [];
  let regeneration = null;
  let lastAsset = null;
  let lastQc = null;

  for (let attempt = 0; attempt <= maxRegenerations; attempt += 1) {
    try {
      lastAsset = await provider.resolveScene(scene, {
        projectId,
        previousAsset,
        regeneration,
      });
    } catch (error) {
      warnings.push({
        stage: 'visuals',
        scene: scene.index,
        attempt,
        message: error.message,
      });

      return {
        asset: null,
        qcHistory,
        fatalQcFailure: null,
      };
    }

    if (!lastAsset || !qc || lastAsset.type !== 'ai-video') {
      return {
        asset: lastAsset,
        qcHistory,
        fatalQcFailure: null,
      };
    }

    try {
      lastQc = await qc.evaluateScene(scene, lastAsset, { previousAsset });
      qcHistory.push({
        attempt,
        generationId: lastAsset.generationId || null,
        ...lastQc,
      });
    } catch (error) {
      warnings.push({
        stage: 'visual-qc',
        scene: scene.index,
        attempt,
        message: error.message,
      });

      const fallback = await tryRealFootageFallback({
        provider,
        scene,
        projectId,
        previousAsset,
        lastQc: { overallScore: null },
        warnings,
        reason: 'realism-qc-evaluator-error',
      });

      if (fallback) {
        return {
          asset: {
            ...fallback,
            qc: {
              status: 'error',
              message: error.message,
            },
          },
          qcHistory,
          fatalQcFailure: null,
        };
      }

      if (qc.failClosed !== false) {
        return {
          asset: null,
          qcHistory,
          fatalQcFailure: {
            scene: scene.index,
            score: null,
            issues: [],
            reason: `Realism QC failed to evaluate the scene: ${error.message}`,
          },
        };
      }

      return {
        asset: {
          ...lastAsset,
          qc: {
            status: 'error',
            message: error.message,
          },
        },
        qcHistory,
        fatalQcFailure: null,
      };
    }

    if (lastQc.passed) {
      return {
        asset: {
          ...lastAsset,
          qc: lastQc,
          qcAttempts: attempt + 1,
        },
        qcHistory,
        fatalQcFailure: null,
      };
    }

    if (attempt < maxRegenerations) {
      warnings.push({
        stage: 'visual-qc-regeneration',
        scene: scene.index,
        attempt,
        message: `Rejected AI scene with score ${lastQc.overallScore}; regenerating`,
      });

      regeneration = {
        attempt: attempt + 1,
        guidance: lastQc.regenerationGuidance,
        issues: lastQc.issues,
      };
      continue;
    }
  }

  const fallback = await tryRealFootageFallback({
    provider,
    scene,
    projectId,
    previousAsset,
    lastQc,
    warnings,
  });

  if (fallback) {
    return {
      asset: {
        ...fallback,
        rejectedAiQc: lastQc,
        qcAttempts: qcHistory.length,
      },
      qcHistory,
      fatalQcFailure: null,
    };
  }

  return {
    asset: null,
    qcHistory,
    fatalQcFailure: {
      scene: scene.index,
      score: lastQc?.overallScore ?? null,
      issues: lastQc?.issues || [],
      reason: 'AI scene failed realism QC and no real-footage fallback was available',
    },
  };
}

async function tryRealFootageFallback({
  provider,
  scene,
  projectId,
  previousAsset,
  lastQc,
  warnings,
  reason = null,
}) {
  if (typeof provider.resolveFallbackScene !== 'function') return null;

  try {
    return await provider.resolveFallbackScene(scene, {
      projectId,
      previousAsset,
      reason: reason || `realism-qc-rejected-score-${lastQc?.overallScore ?? 'unknown'}`,
    });
  } catch (error) {
    warnings.push({
      stage: 'visual-qc-fallback',
      scene: scene.index,
      message: error.message,
    });
    return null;
  }
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
