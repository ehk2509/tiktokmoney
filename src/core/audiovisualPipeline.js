import crypto from 'node:crypto';
import { ProductionScriptGenerator, productionScriptToStoryBible } from './productionScriptGenerator.js';
import { buildSubtitles } from './subtitleBuilder.js';
import { evaluateAudiovisualPublishability } from './publishabilityGate.js';
import { CreativeTournament } from './creativeTournament.js';

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
    subtitleConfig = null,
    creativeTournament = null,
    trendIntelligence = null,
  }) {
    this.productionScriptGenerator = new ProductionScriptGenerator({ llm });
    this.creativeTournament = creativeTournament || new CreativeTournament({ llm });
    this.trendIntelligence = trendIntelligence;
    this.audiovisual = audiovisual;
    this.renderer = renderer;
    this.store = store;
    this.visual = visual;
    this.realismQc = realismQc;
    this.dialogueQc = dialogueQc;
    this.lipSyncQc = lipSyncQc;
    this.deepLipSyncQc = deepLipSyncQc;
    this.phonemeVisemeQc = phonemeVisemeQc;
    this.speakerTurnQc = speakerTurnQc;
    this.subtitleConfig = subtitleConfig || subtitleConfigFromEnv();
  }

  async generate({
    topic,
    audience = 'curious adults',
    durationSeconds = 35,
    render = true,
    researchPacket: providedResearchPacket = null,
    creativeCandidateCount = null,
    productionVariantIndex = 0,
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

    const productionScript = await this.productionScriptGenerator.generate({
      topic: normalizedTopic,
      audience,
      durationSeconds,
      creativeBrief: tournament.winner || null,
      researchPacket,
    });
    let storyBible = productionScriptToStoryBible(productionScript);
    project.productionScript = productionScript;
    project.storyBible = storyBible;
    project.status = 'SCRIPTED';

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
        realismQc: this.realismQc,
        dialogueQc: this.dialogueQc,
        lipSyncQc: this.lipSyncQc,
        deepLipSyncQc: this.deepLipSyncQc,
        phonemeVisemeQc: this.phonemeVisemeQc,
        speakerTurnQc: this.speakerTurnQc,
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
        dialogueVerification: generated.dialogueVerification,
        lipSyncQc: generated.lipSyncQc,
        deepLipSyncQc: generated.deepLipSyncQc,
        phonemeVisemeQc: generated.phonemeVisemeQc,
        speakerTurnQc: generated.speakerTurnQc,
      });

      if (generated.failure) {
        project.status = generated.failureStatus || 'AUDIOVISUAL_QC_FAILED';
        project.error = generated.failure;
        await this.store?.saveProject(project);
        return project;
      }

      previousAsset = generated.asset;
    }

    const verifiedWordTimings = collectVerifiedWordTimings(project.scenes);
    project.subtitles = buildSubtitles({
      voice: verifiedWordTimings.length ? { wordTimings: verifiedWordTimings } : null,
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
  realismQc,
  dialogueQc,
  lipSyncQc,
  deepLipSyncQc,
  phonemeVisemeQc,
  speakerTurnQc,
  segment,
  productionScript,
  storyBible,
  previousAsset,
  projectId,
}) {
  const qcHistory = [];
  let regeneration = null;
  const maxRegenerations = Math.max(
    realismQc?.maxRegenerations || 0,
    dialogueQc?.maxRegenerations || 0,
    lipSyncQc?.maxRegenerations || 0,
    deepLipSyncQc?.maxRegenerations || 0,
    phonemeVisemeQc?.maxRegenerations || 0,
    speakerTurnQc?.maxRegenerations || 0,
  );
  const hasQc = Boolean(
    realismQc || dialogueQc || lipSyncQc || deepLipSyncQc || phonemeVisemeQc || speakerTurnQc,
  );

  for (let attempt = 0; attempt <= maxRegenerations; attempt += 1) {
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
    };

    const realism = realismQc
      ? await realismQc.evaluateScene(sceneLike, asset, { previousAsset, storyBible })
      : null;

    const speaker = productionScript.characters.find(
      (character) => character.id === segment.speakerCharacterId,
    ) || null;

    const dialogue = dialogueQc
      ? await dialogueQc.evaluate(asset, {
        expectedText: segment.dialogue,
        language: speaker?.voice?.languageCode || null,
      })
      : null;

    const lipSync = lipSyncQc
      ? dialogue?.transcription
        ? await lipSyncQc.evaluate(asset, {
          transcription: dialogue.transcription,
          expectedText: segment.dialogue,
          speakerDescription: speaker
            ? [speaker.name, speaker.description, speaker.physicalTraits].filter(Boolean).join('. ')
            : '',
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

    const deepLipSync = deepLipSyncQc
      ? await deepLipSyncQc.evaluate(asset, {
        transcription: dialogue?.transcription || null,
        expectedText: segment.dialogue,
      })
      : null;

    const speakerTurns = Array.isArray(asset.dialogueTrack?.turns)
      ? asset.dialogueTrack.turns
      : [];
    const speakerTurn = speakerTurnQc && new Set(
      speakerTurns.map((turn) => turn.speakerCharacterId),
    ).size > 1
      ? await speakerTurnQc.evaluate(asset, {
        dialogueTurns: speakerTurns,
        characters: productionScript.characters,
      })
      : null;

    const phonemeViseme = phonemeVisemeQc
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

    const passed = [realism, dialogue, lipSync, deepLipSync, phonemeViseme, speakerTurn]
      .filter(Boolean)
      .every((result) => result.passed);

    const issues = [
      ...prefixIssues(realism?.issues, 'realism'),
      ...prefixIssues(realism?.temporalIssues, 'temporal'),
      ...prefixIssues(dialogue?.issues, 'dialogue'),
      ...prefixIssues(lipSync?.issues, 'lip-sync'),
      ...prefixIssues(deepLipSync?.issues, 'deep-lip-sync'),
      ...prefixIssues(phonemeViseme?.issues, 'phoneme-viseme'),
      ...prefixIssues(speakerTurn?.issues, 'speaker-turn'),
    ];
    const regenerationGuidance = [
      realism && !realism.passed ? realism.regenerationGuidance : '',
      dialogue && !dialogue.passed ? dialogue.regenerationGuidance : '',
      lipSync && !lipSync.passed ? lipSync.regenerationGuidance : '',
      deepLipSync && !deepLipSync.passed ? deepLipSync.regenerationGuidance : '',
      phonemeViseme && !phonemeViseme.passed ? phonemeViseme.regenerationGuidance : '',
      speakerTurn && !speakerTurn.passed ? speakerTurn.regenerationGuidance : '',
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
      issues,
      regenerationGuidance,
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
        },
        qcHistory,
        dialogueVerification: dialogue,
        lipSyncQc: lipSync,
        deepLipSyncQc: deepLipSync,
        phonemeVisemeQc: phonemeViseme,
        speakerTurnQc: speakerTurn,
        failure: null,
        failureStatus: null,
      };
    }

    if (attempt < maxRegenerations) {
      regeneration = {
        attempt: attempt + 1,
        guidance: regenerationGuidance,
        issues,
      };
      continue;
    }

    const failureStatus = dialogue && !dialogue.passed
      ? 'DIALOGUE_QC_FAILED'
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

    return verification.transcription.words.map((word) => ({
      word: word.word,
      start: roundTime((Number(scene.start) || 0) + (Number(word.start) || 0)),
      end: roundTime((Number(scene.start) || 0) + (Number(word.end) || 0)),
    }));
  });
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
