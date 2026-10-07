import crypto from 'node:crypto';
import { ScriptGenerator } from './scriptGenerator.js';
import { StoryBibleGenerator } from './storyBibleGenerator.js';
import { planScenes } from './scenePlanner.js';
import { evaluateProject } from './qualityGate.js';
import { buildSubtitles } from './subtitleBuilder.js';

export class VideoPipeline {
  constructor({
    llm,
    renderer,
    store,
    visual = null,
    stock = null,
    voice = null,
    realismQc = null,
    subtitleConfig = null,
  }) {
    this.scriptGenerator = new ScriptGenerator({ llm });
    this.storyBibleGenerator = new StoryBibleGenerator({ llm });
    this.renderer = renderer;
    this.store = store;
    this.visual = visual || stock;
    this.voice = voice;
    this.realismQc = realismQc;
    this.subtitleConfig = subtitleConfig || subtitleConfigFromEnv();
  }

  async generate({
    topic,
    audience = 'curious adults',
    durationSeconds = 35,
    render = true,
    experiment = null,
  }) {
    if (!topic?.trim()) throw new Error('topic is required');

    const id = `vid_${crypto.randomUUID()}`;
    const script = await this.scriptGenerator.generate({
      topic: topic.trim(),
      audience,
      durationSeconds,
    });
    let storyBible = await this.storyBibleGenerator.generate({ script });
    let scenes = planScenes(script, storyBible);
    const quality = evaluateProject({ script, scenes });

    const project = {
      id,
      status: quality.passed ? 'QC_PASSED' : 'QC_FAILED',
      topic: topic.trim(),
      audience,
      createdAt: new Date().toISOString(),
      planning: { experiment },
      script,
      storyBible,
      scenes,
      quality,
      voice: null,
      subtitles: null,
      visualStrategy: this.visual?.strategy || (this.visual ? 'custom' : 'fallback-card'),
      realismQc: {
        enabled: Boolean(this.realismQc),
        provider: this.realismQc ? 'openrouter' : null,
        model: this.realismQc?.model || null,
        threshold: this.realismQc?.threshold || null,
        temporalEnabled: this.realismQc?.temporalEnabled || false,
        temporalThreshold: this.realismQc?.temporalThreshold || null,
        maxRegenerations: this.realismQc?.maxRegenerations || 0,
      },
      warnings: [],
      render: null,
    };

    if (!quality.passed) {
      await this.store?.saveProject(project);
      return project;
    }

    if (typeof this.visual?.prepareStoryBible === 'function') {
      project.status = 'STORY_BIBLE_PREPARING';
      try {
        storyBible = await this.visual.prepareStoryBible(storyBible, { projectId: id });
        project.storyBible = storyBible;
      } catch (error) {
        project.warnings.push({
          stage: 'story-bible',
          message: error.message,
        });
        project.storyBible = {
          ...storyBible,
          referenceStatus: 'degraded',
          referenceError: error.message,
        };
      }
    }

    project.status = this.realismQc ? 'VISUALS_GENERATING_AND_QC' : 'VISUALS_GENERATING';
    const visualResult = await resolveVisuals({
      provider: this.visual,
      qc: this.realismQc,
      scenes,
      storyBible: project.storyBible,
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

    project.subtitles = buildSubtitles({
      voice: project.voice,
      scenes: project.scenes,
      config: this.subtitleConfig,
    });

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
  storyBible,
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
      storyBible,
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
  storyBible,
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
        storyBible,
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
      lastQc = await qc.evaluateScene(scene, lastAsset, {
        previousAsset,
        storyBible,
      });
      if (typeof provider.recordOutcome === 'function') {
        await provider.recordOutcome(scene, lastAsset, lastQc);
      }
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
        issues: [...(lastQc.issues || []), ...(lastQc.temporalIssues || [])],
        previousProviderId: lastAsset.routing?.providerId || lastAsset.providerModelId || null,
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


function subtitleConfigFromEnv(env = process.env) {
  return {
    enabled: env.SUBTITLES_ENABLED == null
      ? true
      : ['1', 'true', 'yes', 'on'].includes(String(env.SUBTITLES_ENABLED).toLowerCase()),
    maxWordsPerCue: env.SUBTITLES_MAX_WORDS
      ? Number(env.SUBTITLES_MAX_WORDS)
      : undefined,
    maxCharsPerCue: env.SUBTITLES_MAX_CHARS
      ? Number(env.SUBTITLES_MAX_CHARS)
      : undefined,
    fontName: env.SUBTITLES_FONT || undefined,
    fontSize: env.SUBTITLES_FONT_SIZE
      ? Number(env.SUBTITLES_FONT_SIZE)
      : undefined,
    marginV: env.SUBTITLES_MARGIN_V
      ? Number(env.SUBTITLES_MARGIN_V)
      : undefined,
    maxWidthPx: env.SUBTITLES_MAX_WIDTH_PX
      ? Number(env.SUBTITLES_MAX_WIDTH_PX)
      : undefined,
    maxLines: env.SUBTITLES_MAX_LINES
      ? Number(env.SUBTITLES_MAX_LINES)
      : undefined,
  };
}
