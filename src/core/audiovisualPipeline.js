import crypto from 'node:crypto';
import { access } from 'node:fs/promises';
import { ProductionScriptGenerator, productionScriptToStoryBible } from './productionScriptGenerator.js';
import { buildSubtitles, punctuateWordsFromScript } from './subtitleBuilder.js';
import { evaluateAudiovisualPublishability } from './publishabilityGate.js';
import { CreativeTournament } from './creativeTournament.js';
import { RealismDirector } from './realismDirector.js';
import { KeyframeDirector } from './keyframeDirector.js';
import { MotionRegionDirector } from './motionRegionDirector.js';
import { MotionGuideDirector } from './motionGuideDirector.js';
import { MotionReferenceStore } from '../storage/motionReferenceStore.js';
import { ReferenceStore } from '../services/referenceStore.js';
import { resolveQcApplicability } from './qcApplicability.js';
import { PreGenerationQualityGate } from './preGenerationQualityGate.js';

export class AudiovisualPipeline {
  constructor({
    llm,
    audiovisual,
    renderer,
    store,
    visual = null,
    realismQc = null,
    dialogueQc = null,
    lipSyncQc = null,
    deepLipSyncQc = null,
    phonemeVisemeQc = null,
    speakerTurnQc = null,
    textArtifactQc = null,
    visualFactualQc = null,
    editorialVarietyQc = null,
    productionIntegrityQc = null,
    poseMotionQc = null,
    subtitleConfig = null,
    referenceStore = null,
    creativeTournament = null,
    learningService = null,
    trendIntelligence = null,
    realismDirector = null,
    keyframeDirector = null,
    motionRegionDirector = null,
    motionGuideDirector = null,
    preGenerationQualityGate = null,
    preGenerationMaxRewrites = Number(process.env.PRE_GENERATION_QC_MAX_REWRITES || 1),
  }) {
    this.productionScriptGenerator = new ProductionScriptGenerator({ llm });
    this.creativeTournament = creativeTournament || new CreativeTournament({ llm, learningService });
    this.trendIntelligence = trendIntelligence;
    this.realismDirector = realismDirector || new RealismDirector();
    this.keyframeDirector = keyframeDirector || new KeyframeDirector();
    this.motionRegionDirector = motionRegionDirector || new MotionRegionDirector();
    this.motionGuideDirector = motionGuideDirector || new MotionGuideDirector({
      store: new MotionReferenceStore(),
    });
    this.audiovisual = audiovisual;
    this.renderer = renderer;
    this.store = store;
    this.visual = visual;
    this.realismQc = retryMalformedReplies(realismQc);
    this.dialogueQc = retryMalformedReplies(dialogueQc);
    this.lipSyncQc = retryMalformedReplies(lipSyncQc);
    this.deepLipSyncQc = retryMalformedReplies(deepLipSyncQc);
    this.phonemeVisemeQc = retryMalformedReplies(phonemeVisemeQc);
    this.speakerTurnQc = retryMalformedReplies(speakerTurnQc);
    this.textArtifactQc = retryMalformedReplies(textArtifactQc);
    this.visualFactualQc = retryMalformedReplies(visualFactualQc);
    this.editorialVarietyQc = retryMalformedReplies(editorialVarietyQc);
    this.productionIntegrityQc = retryMalformedReplies(productionIntegrityQc);
    this.poseMotionQc = retryMalformedReplies(poseMotionQc);
    this.subtitleConfig = subtitleConfig || subtitleConfigFromEnv();
    this.referenceStore = referenceStore || new ReferenceStore();
    this.preGenerationQualityGate = preGenerationQualityGate || new PreGenerationQualityGate({
      llm,
      subtitleConfig: this.subtitleConfig,
    });
    this.preGenerationMaxRewrites = Math.max(
      0,
      Math.min(3, Number(preGenerationMaxRewrites) || 0),
    );
  }

  async generate({
    topic,
    audience = 'curious adults',
    durationSeconds = 35,
    render = true,
    researchPacket: providedResearchPacket = null,
    creativeCandidateCount = null,
    productionVariantIndex = 0,
    experiment = null,
  }) {
    if (!topic?.trim()) throw new Error('topic is required');
    if (!this.audiovisual) throw new Error('audiovisual provider is required');

    const id = `vid_${crypto.randomUUID()}`;
    const normalizedTopic = topic.trim();
    let researchPacket = providedResearchPacket;
    if (!researchPacket && this.trendIntelligence?.research) {
      try {
        researchPacket = await this.trendIntelligence.research(normalizedTopic);
      } catch {
        researchPacket = null;
      }
    }
    const tournament = await this.creativeTournament.run({
      topic: normalizedTopic,
      audience,
      durationSeconds,
      researchPacket,
      candidateCount: creativeCandidateCount,
      variantIndex: productionVariantIndex,
    });

    const project = {
      id,
      mode: 'audiovisual-director',
      status: 'CREATIVE_SELECTED',
      topic: normalizedTopic,
      audience,
      createdAt: new Date().toISOString(),
      researchPacket,
      planning: {
        productionVariantIndex: Number(productionVariantIndex) || 0,
        creativeCandidateCount: creativeCandidateCount == null
          ? null
          : Number(creativeCandidateCount),
        experiment,
      },
      creativeTournament: tournament,
      creativeBrief: tournament.winner || null,
      productionScript: null,
      storyBible: null,
      scenes: [],
      subtitles: null,
      warnings: [],
      render: null,
    };

    if (tournament.enabled && !tournament.accepted) {
      project.status = 'CREATIVE_REJECTED';
      project.error = `No creative candidate met the minimum score of ${tournament.minimumWinnerScore}; best score was ${tournament.winnerScore}.`;
      await this.store?.saveProject(project);
      return project;
    }

    let productionScript = null;
    let preGenerationQc = null;
    let preGenerationFeedback = '';

    for (let planAttempt = 0; planAttempt <= this.preGenerationMaxRewrites; planAttempt += 1) {
      const rawProductionScript = await this.productionScriptGenerator.generate({
        topic: normalizedTopic,
        audience,
        durationSeconds,
        creativeBrief: tournament.winner || null,
        researchPacket,
        preflightFeedback: preGenerationFeedback,
      });
      const realismDirectedScript = this.realismDirector.direct(rawProductionScript);
      const keyframeDirectedScript = this.keyframeDirector.direct(realismDirectedScript);
      const motionRegionDirectedScript = this.motionRegionDirector.direct(keyframeDirectedScript);
      productionScript = await this.motionGuideDirector.direct(motionRegionDirectedScript);

      preGenerationQc = await this.preGenerationQualityGate.evaluate(productionScript, {
        topic: normalizedTopic,
        audience,
        creativeBrief: tournament.winner || null,
      });
      preGenerationQc.attempt = planAttempt + 1;

      if (preGenerationQc.passed) break;
      preGenerationFeedback = preGenerationQc.feedback;

      if (planAttempt >= this.preGenerationMaxRewrites) {
        project.productionScript = productionScript;
        project.preGenerationQc = preGenerationQc;
        project.planning.preGenerationAttempts = planAttempt + 1;
        project.status = 'PRE_GENERATION_QC_FAILED';
        project.error = `Production plan failed pre-generation QC before any video generation: ${preGenerationFeedback}`;
        await this.store?.saveProject(project);
        return project;
      }
    }

    let storyBible = productionScriptToStoryBible(productionScript);
    project.productionScript = productionScript;
    project.preGenerationQc = preGenerationQc;
    project.planning.preGenerationAttempts = preGenerationQc?.attempt || 1;
    project.realismDirection = productionScript.realismDirection || null;
    project.keyframeDirection = productionScript.keyframeDirection || null;
    project.motionRegionDirection = productionScript.motionRegionDirection || null;
    project.motionGuideDirection = productionScript.motionGuideDirection || null;
    project.storyBible = storyBible;
    project.status = 'SCRIPTED';

    if (typeof this.visual?.prepareStoryBible === 'function') {
      project.status = 'REFERENCES_PREPARING';
      try {
        storyBible = await this.visual.prepareStoryBible(storyBible, { projectId: id });
        await this.referenceStore.persist(storyBible, { projectId: id });
        project.storyBible = storyBible;
      } catch (error) {
        project.warnings.push({ stage: 'story-bible', message: error.message });
        project.storyBible = { ...storyBible, referenceStatus: 'degraded', referenceError: error.message };
      }
    }

    return this.produce(project, { render });
  }

  /**
   * Continue a saved project from its first missing act. Accepted acts whose
   * clips still exist on disk are kept, so a QC failure, provider error or
   * exhausted credits never forces paying for earlier acts again.
   */
  async resume(projectId, { render = true } = {}) {
    if (!this.store?.getProject) throw new Error('a project store is required to resume');
    if (!this.audiovisual) throw new Error('audiovisual provider is required');
    const project = await this.store.getProject(projectId);
    if (project.mode !== 'audiovisual-director' || !project.productionScript?.segments?.length) {
      throw new Error(`project ${projectId} has no audiovisual production script to resume`);
    }

    const accepted = [];
    for (const scene of project.scenes || []) {
      if (!scene.asset?.localPath || !(await fileExists(scene.asset.localPath))) break;
      accepted.push(scene);
    }
    project.scenes = accepted;
    project.resumedAt = [...(project.resumedAt || []), new Date().toISOString()];
    project.resumedFromAct = accepted.length;
    delete project.error;
    delete project.interruptedAct;
    project.render = null;
    return this.produce(project, { render });
  }

  async produce(project, { render = true } = {}) {
    const { productionScript } = project;
    project.status = 'AUDIOVISUAL_GENERATING';
    let previousAsset = project.scenes.at(-1)?.asset || null;
    let timelineCursor = project.scenes.reduce((sum, scene) => sum + (Number(scene.duration) || 0), 0);
    for (const segment of productionScript.segments.slice(project.scenes.length)) {
      let generated;
      try {
        const storyBible = await this.referenceStore.withFreshReferences(project.storyBible);
        generated = await generateWithQc({
          provider: this.audiovisual,
          realismQc: this.realismQc,
          dialogueQc: this.dialogueQc,
          lipSyncQc: this.lipSyncQc,
          deepLipSyncQc: this.deepLipSyncQc,
          phonemeVisemeQc: this.phonemeVisemeQc,
          speakerTurnQc: this.speakerTurnQc,
          poseMotionQc: this.poseMotionQc,
          textArtifactQc: this.textArtifactQc,
          visualFactualQc: this.visualFactualQc,
          editorialVarietyQc: this.editorialVarietyQc,
          productionIntegrityQc: this.productionIntegrityQc,
          segment,
          productionScript,
          storyBible,
          previousAsset,
          projectId: project.id,
        });
      } catch (error) {
        // Keep accepted acts so `resume` can continue after provider errors.
        project.status = 'GENERATION_INTERRUPTED';
        project.error = error.message;
        project.interruptedAct = { index: segment.index, attempts: error.qcHistory || [] };
        await this.store?.saveProject(project);
        throw error;
      }

      // Acts may run longer than planned when their dialogue needs more time.
      const sceneDuration = Number(generated.asset?.durationSeconds) || segment.durationSeconds;
      project.scenes.push({
        index: segment.index,
        start: timelineCursor,
        duration: sceneDuration,
        narration: segment.dialogue,
        purpose: segment.purpose,
        continuity: {
          characterIds: segment.characterIds,
          locationId: segment.locationId,
        },
        production: segment,
        asset: generated.asset,
        visualQcHistory: generated.qcHistory,
        dialogueVerification: generated.dialogueVerification,
        lipSyncQc: generated.lipSyncQc,
        deepLipSyncQc: generated.deepLipSyncQc,
        phonemeVisemeQc: generated.phonemeVisemeQc,
        speakerTurnQc: generated.speakerTurnQc,
        poseMotionQc: generated.poseMotionQc,
        textArtifactQc: generated.textArtifactQc,
        visualFactualQc: generated.visualFactualQc,
        editorialVarietyQc: generated.editorialVarietyQc,
        productionIntegrityQc: generated.productionIntegrityQc,
        qcApplicability: generated.qcApplicability || null,
      });

      if (generated.failure) {
        project.status = generated.failureStatus || 'AUDIOVISUAL_QC_FAILED';
        project.error = generated.failure;
        await this.store?.saveProject(project);
        return project;
      }

      previousAsset = generated.asset;
      timelineCursor += sceneDuration;
      await this.store?.saveProject(project);
    }

    const verifiedWordTimings = collectVerifiedWordTimings(project.scenes);
    project.subtitles = buildSubtitles({
      voice: verifiedWordTimings.length ? { wordTimings: verifiedWordTimings } : null,
      scenes: project.scenes,
      config: this.subtitleConfig,
    });
    project.subtitles.labels = collectSceneLabels(project.scenes);

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

async function generateWithQc(options) {
  const qcHistory = [];
  try {
    return await runQcAttempts({ ...options, qcHistory });
  } catch (error) {
    error.qcHistory = qcHistory;
    throw error;
  }
}

async function runQcAttempts({
  qcHistory,
  provider,
  realismQc,
  dialogueQc,
  lipSyncQc,
  deepLipSyncQc,
  phonemeVisemeQc,
  speakerTurnQc,
  poseMotionQc,
  textArtifactQc,
  visualFactualQc,
  editorialVarietyQc,
  productionIntegrityQc,
  segment,
  productionScript,
  storyBible,
  previousAsset,
  projectId,
}) {
  let regeneration = null;
  const retryUsage = {
    realism: 0,
    dialogue: 0,
    lipSync: 0,
    deepLipSync: 0,
    phonemeViseme: 0,
    speakerTurn: 0,
    poseMotion: 0,
    textArtifact: 0,
    visualFactual: 0,
    editorialVariety: 0,
    productionIntegrity: 0,
  };
  const maxTotalRegenerations = [
    realismQc,
    dialogueQc,
    lipSyncQc,
    deepLipSyncQc,
    phonemeVisemeQc,
    speakerTurnQc,
    poseMotionQc,
    textArtifactQc,
    visualFactualQc,
    editorialVarietyQc,
    productionIntegrityQc,
  ].reduce((sum, qc) => sum + Math.max(0, Number(qc?.maxRegenerations) || 0), 0);
  const hasQc = Boolean(
    realismQc || dialogueQc || lipSyncQc || deepLipSyncQc || phonemeVisemeQc || speakerTurnQc || poseMotionQc
      || textArtifactQc || visualFactualQc || editorialVarietyQc || productionIntegrityQc,
  );

  for (let attempt = 0; attempt <= maxTotalRegenerations; attempt += 1) {
    const asset = await provider.generateSegment({
      segment,
      productionScript,
      storyBible,
      previousAsset,
      regeneration,
      projectId,
    });

    if (!hasQc) {
      return {
        asset,
        qcHistory,
        dialogueVerification: null,
        lipSyncQc: null,
        deepLipSyncQc: null,
        phonemeVisemeQc: null,
        speakerTurnQc: null,
        poseMotionQc: null,
        textArtifactQc: null,
        visualFactualQc: null,
        editorialVarietyQc: null,
        productionIntegrityQc: null,
        failure: null,
        failureStatus: null,
      };
    }

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
      realismDirection: segment.realismDirection || null,
      motionRegionDirection: segment.motionRegionDirection || null,
    };

    const applicability = resolveQcApplicability({ segment, productionScript, asset });

    const realism = realismQc && applicability.realism.applicable
      ? await realismQc.evaluateScene(sceneLike, asset, { previousAsset, storyBible })
      : null;

    const speaker = productionScript.characters.find(
      (character) => character.id === segment.speakerCharacterId,
    ) || null;

    const dialogue = dialogueQc && applicability.dialogue.applicable
      ? await dialogueQc.evaluate(asset, {
        expectedText: segment.dialogue,
        language: speaker?.voice?.languageCode || null,
      })
      : null;

    const lipSync = lipSyncQc && applicability.lipSync.applicable
      ? dialogue?.transcription
        ? await lipSyncQc.evaluate(asset, {
          transcription: dialogue.transcription,
          expectedText: segment.dialogue,
          speakerDescription: speaker
            ? [speaker.name, speaker.description, speaker.physicalTraits].filter(Boolean).join('. ')
            : '',
          // Multi-speaker acts: each line is judged against its own speaker.
          turns: asset.dialogueTrack?.turns?.length ? asset.dialogueTrack.turns : segment.dialogueTurns,
          characters: productionScript.characters,
        })
        : {
          passed: false,
          score: 0,
          issues: [{
            code: 'lip-sync-transcription-missing',
            severity: 'high',
            evidence: 'Lip-sync QC requires an independent transcript with word timestamps.',
          }],
          regenerationGuidance: 'Regenerate with clearly audible synchronized dialogue.',
        }
      : null;

    const deepLipSync = deepLipSyncQc && applicability.deepLipSync.applicable
      ? await deepLipSyncQc.evaluate(asset, {
        transcription: dialogue?.transcription || null,
        expectedText: segment.dialogue,
      })
      : null;

    const speakerTurns = Array.isArray(asset.dialogueTrack?.turns)
      ? asset.dialogueTrack.turns
      : [];
    const speakerTurn = speakerTurnQc && applicability.speakerTurn.applicable
      ? await speakerTurnQc.evaluate(asset, {
        dialogueTurns: speakerTurns,
        characters: productionScript.characters,
      })
      : null;

    const poseMotion = poseMotionQc && applicability.poseMotion.applicable
      ? await poseMotionQc.evaluate(asset, { segment })
      : null;

    const textArtifact = textArtifactQc && applicability.textArtifact.applicable
      ? await textArtifactQc.evaluate(asset, { durationSeconds: segment.durationSeconds })
      : null;

    const visualFactual = visualFactualQc && applicability.visualFactual.applicable
      ? await visualFactualQc.evaluate(asset, {
        narration: segment.dialogue,
        action: segment.action,
        purpose: segment.purpose,
        onScreenLabels: segment.onScreenLabels,
        durationSeconds: segment.durationSeconds,
      })
      : null;

    const previousSegment = productionScript.segments?.[segment.index - 1] || null;
    const editorialVariety = editorialVarietyQc
      ? await editorialVarietyQc.evaluate(asset, {
        segment,
        previousAsset,
        previousSegment,
      })
      : null;

    const productionIntegrity = productionIntegrityQc
      ? await productionIntegrityQc.evaluate(asset, {
        segment,
        productionScript,
      })
      : null;

    const phonemeViseme = phonemeVisemeQc && applicability.phonemeViseme.applicable
      ? dialogue?.transcription
        ? await phonemeVisemeQc.evaluate(asset, {
          transcription: dialogue.transcription,
          expectedText: segment.dialogue,
        })
        : {
          passed: false,
          phonemeAlignmentScore: 0,
          visemeAlignmentScore: 0,
          coverage: 0,
          issues: [{
            code: 'phoneme-viseme-transcription-missing',
            severity: 'high',
            evidence: 'Phoneme/viseme QC requires independent word timestamps.',
          }],
          regenerationGuidance: 'Regenerate with clearly audible speech and an unobstructed visible mouth.',
        }
      : null;

    const checks = [
      ['realism', realism, realismQc],
      ['dialogue', dialogue, dialogueQc],
      ['lipSync', lipSync, lipSyncQc],
      ['deepLipSync', deepLipSync, deepLipSyncQc],
      ['phonemeViseme', phonemeViseme, phonemeVisemeQc],
      ['speakerTurn', speakerTurn, speakerTurnQc],
      ['poseMotion', poseMotion, poseMotionQc],
      ['textArtifact', textArtifact, textArtifactQc],
      ['visualFactual', visualFactual, visualFactualQc],
      ['editorialVariety', editorialVariety, editorialVarietyQc],
      ['productionIntegrity', productionIntegrity, productionIntegrityQc],
    ];
    const passed = checks
      .map(([, result]) => result)
      .filter(Boolean)
      .every((result) => result.passed);
    const failedChecks = checks.filter(([, result]) => result && !result.passed);
    const retryableChecks = failedChecks.filter(([name, , qc]) => (
      retryUsage[name] < Math.max(0, Number(qc?.maxRegenerations) || 0)
    ));
    const retryBudget = retryableChecks.length
      ? Math.max(...retryableChecks.map(([name, , qc]) => (
        Math.max(0, Number(qc?.maxRegenerations) || 0) - retryUsage[name]
      )))
      : 0;

    const issues = [
      ...prefixIssues(realism?.issues, 'realism'),
      ...prefixIssues(realism?.temporalIssues, 'temporal'),
      ...prefixIssues(dialogue?.issues, 'dialogue'),
      ...prefixIssues(lipSync?.issues, 'lip-sync'),
      ...prefixIssues(deepLipSync?.issues, 'deep-lip-sync'),
      ...prefixIssues(phonemeViseme?.issues, 'phoneme-viseme'),
      ...prefixIssues(speakerTurn?.issues, 'speaker-turn'),
      ...prefixIssues(
        poseMotion?.issues?.map((issue) => ({
          code: String(issue).replace(/\s+/g, '-'),
          severity: 'high',
          evidence: String(issue),
        })),
        'pose-motion',
      ),
      ...prefixIssues(textArtifact?.issues, 'text-artifact'),
      ...prefixIssues(visualFactual?.issues, 'visual-factual'),
      ...prefixIssues(editorialVariety?.issues, 'editorial-variety'),
      ...prefixIssues(productionIntegrity?.issues, 'production-integrity'),
    ];
    const regenerationGuidance = [
      realism && !realism.passed ? realism.regenerationGuidance : '',
      dialogue && !dialogue.passed ? dialogue.regenerationGuidance : '',
      lipSync && !lipSync.passed ? lipSync.regenerationGuidance : '',
      deepLipSync && !deepLipSync.passed ? deepLipSync.regenerationGuidance : '',
      phonemeViseme && !phonemeViseme.passed ? phonemeViseme.regenerationGuidance : '',
      speakerTurn && !speakerTurn.passed ? speakerTurn.regenerationGuidance : '',
      poseMotion && !poseMotion.passed ? poseMotion.regenerationGuidance : '',
      textArtifact && !textArtifact.passed ? textArtifact.regenerationGuidance : '',
      visualFactual && !visualFactual.passed ? visualFactual.regenerationGuidance : '',
      editorialVariety && !editorialVariety.passed ? editorialVariety.regenerationGuidance : '',
      productionIntegrity && !productionIntegrity.passed ? productionIntegrity.regenerationGuidance : '',
    ].filter(Boolean).join(' ');

    const historyEntry = {
      attempt,
      generationId: asset.generationId,
      ...(realism || {}),
      passed,
      realism,
      dialogue,
      lipSync,
      deepLipSync,
      phonemeViseme,
      speakerTurn,
      poseMotion,
      textArtifact,
      visualFactual,
      editorialVariety,
      productionIntegrity,
      issues,
      regenerationGuidance,
      applicability,
      retryBudget,
      retryUsage: { ...retryUsage },
    };
    qcHistory.push(historyEntry);

    if (passed) {
      return {
        asset: {
          ...asset,
          qc: historyEntry,
          qcAttempts: attempt + 1,
          dialogueVerification: dialogue,
          lipSyncQc: lipSync,
          deepLipSyncQc: deepLipSync,
          phonemeVisemeQc: phonemeViseme,
          speakerTurnQc: speakerTurn,
          poseMotionQc: poseMotion,
          textArtifactQc: textArtifact,
          visualFactualQc: visualFactual,
          editorialVarietyQc: editorialVariety,
          productionIntegrityQc: productionIntegrity,
          qcApplicability: applicability,
        },
        qcHistory,
        dialogueVerification: dialogue,
        lipSyncQc: lipSync,
        deepLipSyncQc: deepLipSync,
        phonemeVisemeQc: phonemeViseme,
        speakerTurnQc: speakerTurn,
        poseMotionQc: poseMotion,
        textArtifactQc: textArtifact,
        visualFactualQc: visualFactual,
        editorialVarietyQc: editorialVariety,
        productionIntegrityQc: productionIntegrity,
        qcApplicability: applicability,
        failure: null,
        failureStatus: null,
      };
    }

    if (retryableChecks.length) {
      for (const [name] of retryableChecks) retryUsage[name] += 1;
      regeneration = {
        attempt: attempt + 1,
        guidance: regenerationGuidance,
        issues,
        triggeredBy: retryableChecks.map(([name]) => name),
        retryUsage: { ...retryUsage },
      };
      continue;
    }

    const failureStatus = dialogue && !dialogue.passed
      ? 'DIALOGUE_QC_FAILED'
      : textArtifact && !textArtifact.passed
        ? 'TEXT_ARTIFACT_QC_FAILED'
      : visualFactual && !visualFactual.passed
        ? 'VISUAL_FACT_QC_FAILED'
      : editorialVariety && !editorialVariety.passed
        ? 'EDITORIAL_VARIETY_QC_FAILED'
      : productionIntegrity && !productionIntegrity.passed
        ? 'PRODUCTION_INTEGRITY_QC_FAILED'
      : poseMotion && !poseMotion.passed
        ? 'POSE_MOTION_QC_FAILED'
      : speakerTurn && !speakerTurn.passed
        ? 'SPEAKER_TURN_QC_FAILED'
        : phonemeViseme && !phonemeViseme.passed
          ? 'PHONEME_VISEME_QC_FAILED'
        : deepLipSync && !deepLipSync.passed
          ? 'DEEP_LIPSYNC_QC_FAILED'
          : lipSync && !lipSync.passed
            ? 'LIPSYNC_QC_FAILED'
            : 'AUDIOVISUAL_QC_FAILED';

    return {
      asset: null,
      qcHistory,
      dialogueVerification: dialogue,
      lipSyncQc: lipSync,
      deepLipSyncQc: deepLipSync,
      phonemeVisemeQc: phonemeViseme,
      speakerTurnQc: speakerTurn,
      poseMotionQc: poseMotion,
      textArtifactQc: textArtifact,
      visualFactualQc: visualFactual,
      editorialVarietyQc: editorialVariety,
      productionIntegrityQc: productionIntegrity,
      qcApplicability: applicability,
      failure: `Audiovisual act ${segment.index} failed QC after ${attempt + 1} attempt(s)`,
      failureStatus,
    };
  }

  return {
    asset: null,
    qcHistory,
    dialogueVerification: null,
    lipSyncQc: null,
    deepLipSyncQc: null,
    phonemeVisemeQc: null,
    speakerTurnQc: null,
    poseMotionQc: null,
    textArtifactQc: null,
    visualFactualQc: null,
    editorialVarietyQc: null,
    productionIntegrityQc: null,
    failure: 'audiovisual generation failed',
    failureStatus: 'AUDIOVISUAL_QC_FAILED',
  };
}

function prefixIssues(issues, stage) {
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => ({
    ...issue,
    code: `${stage}:${issue.code || 'unspecified'}`,
    stage,
  }));
}

function collectVerifiedWordTimings(scenes) {
  return scenes.flatMap((scene) => {
    const verification = scene.dialogueVerification;
    if (!verification?.passed || !Array.isArray(verification.transcription?.words)) return [];

    const words = punctuateWordsFromScript(
      verification.transcription.words,
      verification.expectedText || scene.narration,
    );
    return words.map((word, index) => ({
      word: word.word,
      start: roundTime((Number(scene.start) || 0) + (Number(word.start) || 0)),
      end: roundTime((Number(scene.start) || 0) + (Number(word.end) || 0)),
      // Never let a caption run across a cut.
      boundary: index === words.length - 1,
    }));
  });
}

export function collectSceneLabels(scenes) {
  return scenes.flatMap((scene) => {
    const start = Number(scene.start) || 0;
    const sceneEnd = start + (Number(scene.duration) || 0);
    return (scene.production?.onScreenLabels || []).map((label) => ({
      text: label.text,
      start: roundTime(start + label.atSeconds),
      end: roundTime(Math.min(sceneEnd, start + label.atSeconds + label.durationSeconds)),
    })).filter((label) => label.end > label.start);
  });
}

/**
 * Vision reviewers occasionally return malformed JSON. Retry that one call
 * instead of letting a parsing error abort the whole generation.
 */
function retryMalformedReplies(qc) {
  if (!qc) return qc;
  const malformed = (error) => error instanceof SyntaxError
    || /invalid JSON|empty content|non-JSON/i.test(String(error?.message));
  return new Proxy(qc, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function') return value;
      if (property !== 'evaluate' && property !== 'evaluateScene') return value.bind(target);
      return async (...args) => {
        try {
          return await value.apply(target, args);
        } catch (error) {
          if (!malformed(error)) throw error;
          return value.apply(target, args);
        }
      };
    },
  });
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function roundTime(value) {
  return Math.round(Number(value) * 1000) / 1000;
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
