import { SampleTrendProvider } from './providers.js';
import { rankOpportunities } from './core/opportunityScorer.js';
import { FfmpegRenderer } from './renderers/ffmpegRenderer.js';
import { AudiovisualRenderer } from './renderers/audiovisualRenderer.js';
import { JsonStore } from './storage/jsonStore.js';
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
} from './providers/providerFactory.js';

export function createApp(overrides = {}) {
  const llm = overrides.llm || createLlmProvider();
  const trends = overrides.trends || new SampleTrendProvider();
  const visual = overrides.visual || createVisualProvider();
  const realismQc = overrides.realismQc || createRealismQcProvider();
  const store = overrides.store || new JsonStore(process.env.DATA_DIR || './data');
  const mode = overrides.mode || process.env.VIDEO_PIPELINE_MODE || 'scene-composer';

  let pipeline;
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
      subtitleConfig: overrides.subtitleConfig,
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

  return {
    mode,
    pipeline,
    async opportunities() {
      return rankOpportunities(await trends.list());
    },
  };
}
