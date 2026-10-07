import { SampleTrendProvider } from './providers.js';
import { rankOpportunities } from './core/opportunityScorer.js';
import { FfmpegRenderer } from './renderers/ffmpegRenderer.js';
import { AudiovisualRenderer } from './renderers/audiovisualRenderer.js';
import { JsonStore } from './storage/jsonStore.js';
import { DailyPlanStore } from './storage/dailyPlanStore.js';
import { PublicationStore } from './storage/publicationStore.js';
import { DailyContentPlanner } from './core/dailyContentPlanner.js';
import { MotionReferenceStore } from './storage/motionReferenceStore.js';
import { MotionLibraryBuilder } from './services/motionLibraryBuilder.js';
import { PoseMotionExtractor } from './services/poseMotionExtractor.js';
import { PublishingService } from './services/publishingService.js';
import { TikTokPublisher } from './providers/tiktokPublisher.js';
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
  createVisualFactualQcProvider,
  createEditorialVarietyQcProvider,
  createProductionIntegrityQcProvider,
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
  const publicationStore = overrides.publicationStore || new PublicationStore(
    process.env.PUBLICATION_STORE_PATH || './data/publications.json',
  );
  const tiktokPublisher = overrides.tiktokPublisher || new TikTokPublisher();
  const publishingService = overrides.publishingService || new PublishingService({
    projectStore: store,
    publicationStore,
    publisher: tiktokPublisher,
  });
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
    publishing: {
      tiktokConfigured: tiktokPublisher.configured,
      explicitConfirmationRequired: true,
      publicationStorePath: publicationStore.filePath,
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
    const visualFactualQc = Object.prototype.hasOwnProperty.call(overrides, 'visualFactualQc')
      ? overrides.visualFactualQc
      : createVisualFactualQcProvider();
    const editorialVarietyQc = Object.prototype.hasOwnProperty.call(overrides, 'editorialVarietyQc')
      ? overrides.editorialVarietyQc
      : createEditorialVarietyQcProvider();
    const productionIntegrityQc = Object.prototype.hasOwnProperty.call(overrides, 'productionIntegrityQc')
      ? overrides.productionIntegrityQc
      : createProductionIntegrityQcProvider();
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
      visualFactualQc,
      editorialVarietyQc,
      productionIntegrityQc,
      subtitleConfig: overrides.subtitleConfig,
      creativeTournament: overrides.creativeTournament,
      trendIntelligence,
      keyframeDirector: overrides.keyframeDirector,
      motionRegionDirector: overrides.motionRegionDirector,
      motionGuideDirector: overrides.motionGuideDirector,
      preGenerationQualityGate: overrides.preGenerationQualityGate,
      preGenerationMaxRewrites: overrides.preGenerationMaxRewrites,
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
    publishingService,
    billingStore: store.billingStore || null,
    async importProviderBilling(records, options = {}) {
      if (!store.billingStore) throw new Error('provider billing store is not configured');
      return store.billingStore.importRecords(records, options);
    },
    async reconcileProjectBilling(projectId) {
      const project = await store.getProject(projectId);
      await store.saveProject(project);
      return store.getProject(projectId);
    },
    async publishProject(projectId, options = {}) {
      return publishingService.publishProject(projectId, options);
    },
    async refreshPublication(publicationId) {
      return publishingService.refreshStatus(publicationId);
    },
    async refreshPublicationMetrics(publicationId) {
      return publishingService.refreshMetrics(publicationId);
    },
    async getPublication(publicationId) {
      return publishingService.getPublication(publicationId);
    },
    async listPublications(options = {}) {
      return publishingService.listPublications(options);
    },
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
