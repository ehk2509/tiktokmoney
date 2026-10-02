import { SampleTrendProvider } from './providers.js';
import { rankOpportunities } from './core/opportunityScorer.js';
import { FfmpegRenderer } from './renderers/ffmpegRenderer.js';
import { AudiovisualRenderer } from './renderers/audiovisualRenderer.js';
import { JsonStore } from './storage/jsonStore.js';
import { DailyPlanStore } from './storage/dailyPlanStore.js';
import { DailyContentPlanner } from './core/dailyContentPlanner.js';
import { MotionReferenceStore } from './storage/motionReferenceStore.js';
import { MotionLibraryBuilder } from './services/motionLibraryBuilder.js';
import { PoseMotionExtractor } from './services/poseMotionExtractor.js';
import { VideoPipeline } from './core/pipeline.js';
import { AudiovisualPipeline } from './core/audiovisualPipeline.js';
import {
  createLlmProvider,
  createVisualProvider,
  createVoiceProvider,
  createRealismQcProvider,
  createAudiovisualProvider,
  createDialogueQcProvider,
  createLipSyncQcProvider,
  createDeepLipSyncQcProvider,
  createPhonemeVisemeQcProvider,
  createSpeakerTurnQcProvider,
  createPoseMotionQcProvider,
  createTextArtifactQcProvider,
  createTrendIntelligence,
} from './providers/providerFactory.js';

export function createApp(overrides = {}) {
  const llm = overrides.llm || createLlmProvider();
  const trendIntelligence = Object.prototype.hasOwnProperty.call(overrides, 'trendIntelligence')
    ? overrides.trendIntelligence
    : createTrendIntelligence();
  const trends = overrides.trends || trendIntelligence || new SampleTrendProvider();
  const visual = overrides.visual || createVisualProvider();
  const realismQc = overrides.realismQc || createRealismQcProvider();
  const store = overrides.store || new JsonStore(process.env.DATA_DIR || './data');
  const dailyPlanStore = overrides.dailyPlanStore || new DailyPlanStore(
    process.env.DAILY_PLAN_PATH || './data/daily-plans.json',
  );
  const mode = overrides.mode || process.env.VIDEO_PIPELINE_MODE || 'scene-composer';
  const motionReferenceStore = overrides.motionReferenceStore || new MotionReferenceStore(
    process.env.MOTION_REFERENCE_LIBRARY_PATH || './data/motion-references.json',
  );
  const motionLibraryBuilder = overrides.motionLibraryBuilder || new MotionLibraryBuilder({
    store: motionReferenceStore,
    extractor: overrides.motionLibraryPoseExtractor || new PoseMotionExtractor(),
  });

  let pipeline;
  const capabilities = {
    poseMotion: {
      enabled: false,
      extractorAvailable: false,
      extractorKind: null,
      bundled: false,
    },
    motionLibrary: {
      builderAvailable: Boolean(motionLibraryBuilder.extractor?.available),
      libraryPath: motionReferenceStore.filePath,
    },
  };
  if (mode === 'audiovisual') {
    const audiovisual = overrides.audiovisual || createAudiovisualProvider();
    const renderer = overrides.renderer || new AudiovisualRenderer();
    const dialogueQc = Object.prototype.hasOwnProperty.call(overrides, 'dialogueQc')
      ? overrides.dialogueQc
      : createDialogueQcProvider();
    const lipSyncQc = Object.prototype.hasOwnProperty.call(overrides, 'lipSyncQc')
      ? overrides.lipSyncQc
      : dialogueQc
        ? createLipSyncQcProvider()
        : null;
    const deepLipSyncQc = Object.prototype.hasOwnProperty.call(overrides, 'deepLipSyncQc')
      ? overrides.deepLipSyncQc
      : createDeepLipSyncQcProvider();
    const phonemeVisemeQc = Object.prototype.hasOwnProperty.call(overrides, 'phonemeVisemeQc')
      ? overrides.phonemeVisemeQc
      : dialogueQc
        ? createPhonemeVisemeQcProvider()
        : null;
    const speakerTurnQc = Object.prototype.hasOwnProperty.call(overrides, 'speakerTurnQc')
      ? overrides.speakerTurnQc
      : createSpeakerTurnQcProvider();
    const poseMotionQc = Object.prototype.hasOwnProperty.call(overrides, 'poseMotionQc')
      ? overrides.poseMotionQc
      : createPoseMotionQcProvider();
    const textArtifactQc = Object.prototype.hasOwnProperty.call(overrides, 'textArtifactQc')
      ? overrides.textArtifactQc
      : createTextArtifactQcProvider();
    capabilities.poseMotion = {
      enabled: Boolean(poseMotionQc),
      extractorAvailable: Boolean(poseMotionQc?.extractor?.available),
      extractorKind: poseMotionQc?.extractor?.kind || null,
      bundled: Boolean(poseMotionQc?.extractor?.bundled),
    };

    pipeline = new AudiovisualPipeline({
      llm,
      audiovisual,
      renderer,
      store,
      visual,
      realismQc,
      dialogueQc,
      lipSyncQc,
      deepLipSyncQc,
      phonemeVisemeQc,
      speakerTurnQc,
      poseMotionQc,
      textArtifactQc,
      subtitleConfig: overrides.subtitleConfig,
      creativeTournament: overrides.creativeTournament,
      trendIntelligence,
      keyframeDirector: overrides.keyframeDirector,
      motionRegionDirector: overrides.motionRegionDirector,
      motionGuideDirector: overrides.motionGuideDirector,
    });
  } else {
    const voice = overrides.voice || createVoiceProvider();
    const renderer = overrides.renderer || new FfmpegRenderer();
    pipeline = new VideoPipeline({
      llm,
      renderer,
      store,
      visual,
      voice,
      realismQc,
      subtitleConfig: overrides.subtitleConfig,
    });
  }

  const dailyPlanner = overrides.dailyPlanner || new DailyContentPlanner({
    opportunitySource: { list: async () => {
      const items = await trends.list();
      return trendIntelligence ? items : rankOpportunities(items);
    } },
    store: dailyPlanStore,
  });

  return {
    mode,
    pipeline,
    dailyPlanner,
    capabilities,
    motionReferenceStore,
    motionLibraryBuilder,
    async opportunities() {
      const items = await trends.list();
      return trendIntelligence ? items : rankOpportunities(items);
    },
    async research(topic) {
      if (!trendIntelligence) return null;
      return trendIntelligence.research(topic);
    },
    async planDay(options = {}) {
      return dailyPlanner.createPlan(options);
    },
    async runPlan(planId, options = {}) {
      return dailyPlanner.executePlan(planId, {
        pipeline,
        ...options,
      });
    },
    async getPlan(planId) {
      return dailyPlanStore.getPlan(planId);
    },
    async listPlans(options = {}) {
      return dailyPlanStore.listPlans(options);
    },
    async listMotionLibrary() {
      return motionReferenceStore.list();
    },
    async buildMotionLibrary(options = {}) {
      return motionLibraryBuilder.build(options);
    },
  };
}
