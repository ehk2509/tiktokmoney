import crypto from 'node:crypto';
import { ProductionScriptGenerator, productionScriptToStoryBible } from './productionScriptGenerator.js';
import { buildSubtitles } from './subtitleBuilder.js';
import { evaluateAudiovisualPublishability } from './publishabilityGate.js';

export class AudiovisualPipeline {
  constructor({
    llm,
    audiovisual,
    renderer,
    store,
    visual = null,
    realismQc = null,
    subtitleConfig = null,
  }) {
    this.productionScriptGenerator = new ProductionScriptGenerator({ llm });
    this.audiovisual = audiovisual;
    this.renderer = renderer;
    this.store = store;
    this.visual = visual;
    this.realismQc = realismQc;
    this.subtitleConfig = subtitleConfig || subtitleConfigFromEnv();
  }

  async generate({ topic, audience = 'curious adults', durationSeconds = 35, render = true }) {
    if (!topic?.trim()) throw new Error('topic is required');
    if (!this.audiovisual) throw new Error('audiovisual provider is required');

    const id = `vid_${crypto.randomUUID()}`;
    const productionScript = await this.productionScriptGenerator.generate({
      topic: topic.trim(),
      audience,
      durationSeconds,
    });

    let storyBible = productionScriptToStoryBible(productionScript);
    const project = {
      id,
      mode: 'audiovisual-director',
      status: 'SCRIPTED',
      topic: topic.trim(),
      audience,
      createdAt: new Date().toISOString(),
      productionScript,
      storyBible,
      scenes: [],
      subtitles: null,
      warnings: [],
      render: null,
    };

    if (typeof this.visual?.prepareStoryBible === 'function') {
      project.status = 'REFERENCES_PREPARING';
      try {
        storyBible = await this.visual.prepareStoryBible(storyBible, { projectId: id });
        project.storyBible = storyBible;
      } catch (error) {
        project.warnings.push({ stage: 'story-bible', message: error.message });
        project.storyBible = { ...storyBible, referenceStatus: 'degraded', referenceError: error.message };
      }
    }

    project.status = 'AUDIOVISUAL_GENERATING';
    let previousAsset = null;
    for (const segment of productionScript.segments) {
      const generated = await generateWithQc({
        provider: this.audiovisual,
        qc: this.realismQc,
        segment,
        productionScript,
        storyBible: project.storyBible,
        previousAsset,
        projectId: id,
      });

      project.scenes.push({
        index: segment.index,
        start: segment.start,
        duration: segment.durationSeconds,
        narration: segment.dialogue,
        purpose: segment.purpose,
        continuity: {
          characterIds: segment.characterIds,
          locationId: segment.locationId,
        },
        production: segment,
        asset: generated.asset,
        visualQcHistory: generated.qcHistory,
      });

      if (generated.failure) {
        project.status = 'AUDIOVISUAL_QC_FAILED';
        project.error = generated.failure;
        await this.store?.saveProject(project);
        return project;
      }

      previousAsset = generated.asset;
    }

    project.subtitles = buildSubtitles({
      voice: null,
      scenes: project.scenes,
      config: this.subtitleConfig,
    });

    project.publishability = evaluateAudiovisualPublishability({
      productionScript,
      scenes: project.scenes,
      subtitles: project.subtitles,
    });

    if (!project.publishability.passed) {
      project.status = 'PUBLISHABILITY_FAILED';
      await this.store?.saveProject(project);
      return project;
    }

    project.status = 'READY';
    if (render && this.renderer) {
      project.status = 'RENDERING';
      try {
        project.render = await this.renderer.render(project);
        project.publishability = evaluateAudiovisualPublishability({
          productionScript,
          scenes: project.scenes,
          subtitles: project.subtitles,
          render: project.render,
        });
        project.status = project.publishability.passed ? 'RENDERED' : 'PUBLISHABILITY_FAILED';
      } catch (error) {
        project.status = 'RENDER_FAILED';
        project.error = error.message;
      }
    }

    await this.store?.saveProject(project);
    return project;
  }
}

async function generateWithQc({
  provider,
  qc,
  segment,
  productionScript,
  storyBible,
  previousAsset,
  projectId,
}) {
  const qcHistory = [];
  let regeneration = null;
  const maxRegenerations = qc?.maxRegenerations || 0;

  for (let attempt = 0; attempt <= maxRegenerations; attempt += 1) {
    const asset = await provider.generateSegment({
      segment,
      productionScript,
      storyBible,
      previousAsset,
      regeneration,
      projectId,
    });

    if (!qc) return { asset, qcHistory, failure: null };

    const sceneLike = {
      index: segment.index,
      narration: segment.dialogue || segment.action,
      duration: segment.durationSeconds,
      continuity: {
        characterIds: segment.characterIds,
        locationId: segment.locationId,
      },
      realism: {
        motionPrompt: asset.prompt,
      },
    };

    const result = await qc.evaluateScene(sceneLike, asset, { previousAsset, storyBible });
    qcHistory.push({ attempt, generationId: asset.generationId, ...result });
    if (result.passed) {
      return {
        asset: { ...asset, qc: result, qcAttempts: attempt + 1 },
        qcHistory,
        failure: null,
      };
    }

    if (attempt < maxRegenerations) {
      regeneration = {
        attempt: attempt + 1,
        guidance: result.regenerationGuidance,
        issues: [...(result.issues || []), ...(result.temporalIssues || [])],
      };
      continue;
    }

    return {
      asset: null,
      qcHistory,
      failure: `Audiovisual act ${segment.index} failed realism QC after ${attempt + 1} attempt(s)`,
    };
  }

  return { asset: null, qcHistory, failure: 'audiovisual generation failed' };
}


function subtitleConfigFromEnv(env = process.env) {
  return {
    enabled: env.SUBTITLES_ENABLED == null
      ? true
      : ['1', 'true', 'yes', 'on'].includes(String(env.SUBTITLES_ENABLED).toLowerCase()),
    maxWordsPerCue: env.SUBTITLES_MAX_WORDS ? Number(env.SUBTITLES_MAX_WORDS) : undefined,
    maxCharsPerCue: env.SUBTITLES_MAX_CHARS ? Number(env.SUBTITLES_MAX_CHARS) : undefined,
    fontName: env.SUBTITLES_FONT || undefined,
    fontSize: env.SUBTITLES_FONT_SIZE ? Number(env.SUBTITLES_FONT_SIZE) : undefined,
    marginV: env.SUBTITLES_MARGIN_V ? Number(env.SUBTITLES_MARGIN_V) : undefined,
    maxWidthPx: env.SUBTITLES_MAX_WIDTH_PX ? Number(env.SUBTITLES_MAX_WIDTH_PX) : undefined,
    maxLines: env.SUBTITLES_MAX_LINES ? Number(env.SUBTITLES_MAX_LINES) : undefined,
  };
}
