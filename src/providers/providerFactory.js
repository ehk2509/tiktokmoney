import { TemplateLlmProvider } from '../providers.js';
import { OpenAICompatibleLlmProvider } from './openaiCompatibleLlmProvider.js';
import { PexelsStockProvider, NullStockProvider } from './pexelsStockProvider.js';
import { ElevenLabsVoiceProvider, NullVoiceProvider } from './elevenLabsVoiceProvider.js';
import { LumaRealisticVideoProvider } from './lumaRealisticVideoProvider.js';
import { LumaAgentsVideoProvider } from './lumaAgentsVideoProvider.js';
import { RunwayVideoProvider } from './runwayVideoProvider.js';
import { VideoModelRouter } from './videoModelRouter.js';
import { AiFirstVisualProvider } from './visualRouter.js';
import { OpenRouterRealismQcProvider } from './openRouterRealismQcProvider.js';
import { ProviderStatsStore } from '../storage/providerStatsStore.js';
import { RunwayAudiovisualProvider } from './runwayAudiovisualProvider.js';
import { OpenAiTranscriptionProvider } from './openAiTranscriptionProvider.js';
import { OpenRouterLipSyncQcProvider } from './openRouterLipSyncQcProvider.js';

export function createLlmProvider(env = process.env) {
  const provider = (env.LLM_PROVIDER || 'template').toLowerCase();

  if (provider === 'template') return new TemplateLlmProvider();
  if (provider === 'openai-compatible' || provider === 'openai') {
    return new OpenAICompatibleLlmProvider({
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.LLM_BASE_URL,
      model: env.LLM_MODEL,
    });
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

export function createStockProvider(env = process.env) {
  if (!env.PEXELS_API_KEY) return new NullStockProvider();
  return new PexelsStockProvider({
    apiKey: env.PEXELS_API_KEY,
    assetDir: env.ASSET_DIR,
  });
}

export function createAiVideoProvider(env = process.env) {
  const providers = [];

  if (env.LUMA_AGENTS_API_KEY) {
    providers.push(new LumaAgentsVideoProvider({
      apiKey: env.LUMA_AGENTS_API_KEY,
      baseUrl: env.LUMA_AGENTS_BASE_URL,
      videoModel: env.LUMA_AGENTS_VIDEO_MODEL,
      imageModel: env.LUMA_AGENTS_IMAGE_MODEL,
      resolution: env.LUMA_AGENTS_VIDEO_RESOLUTION,
      duration: env.LUMA_AGENTS_VIDEO_DURATION,
      assetDir: env.ASSET_DIR,
      pollIntervalMs: env.LUMA_AGENTS_POLL_INTERVAL_MS
        ? Number(env.LUMA_AGENTS_POLL_INTERVAL_MS)
        : undefined,
      maxPolls: env.LUMA_AGENTS_MAX_POLLS ? Number(env.LUMA_AGENTS_MAX_POLLS) : undefined,
    }));
  }

  if (env.RUNWAYML_API_SECRET) {
    providers.push(new RunwayVideoProvider({
      apiKey: env.RUNWAYML_API_SECRET,
      baseUrl: env.RUNWAY_BASE_URL,
      model: env.RUNWAY_PRIMARY_MODEL || 'gen4.5',
      imageModel: env.RUNWAY_IMAGE_MODEL,
      ratio: env.RUNWAY_VIDEO_RATIO,
      duration: env.RUNWAY_VIDEO_DURATION ? Number(env.RUNWAY_VIDEO_DURATION) : undefined,
      assetDir: env.ASSET_DIR,
      pollIntervalMs: env.RUNWAY_POLL_INTERVAL_MS ? Number(env.RUNWAY_POLL_INTERVAL_MS) : undefined,
      maxPolls: env.RUNWAY_MAX_POLLS ? Number(env.RUNWAY_MAX_POLLS) : undefined,
    }));

    if (isEnabledDefaultTrue(env.RUNWAY_ENABLE_TURBO)) {
      providers.push(new RunwayVideoProvider({
        apiKey: env.RUNWAYML_API_SECRET,
        baseUrl: env.RUNWAY_BASE_URL,
        model: 'gen4_turbo',
        imageModel: env.RUNWAY_IMAGE_MODEL,
        ratio: env.RUNWAY_VIDEO_RATIO,
        duration: env.RUNWAY_VIDEO_DURATION ? Number(env.RUNWAY_VIDEO_DURATION) : undefined,
        assetDir: env.ASSET_DIR,
        pollIntervalMs: env.RUNWAY_POLL_INTERVAL_MS ? Number(env.RUNWAY_POLL_INTERVAL_MS) : undefined,
        maxPolls: env.RUNWAY_MAX_POLLS ? Number(env.RUNWAY_MAX_POLLS) : undefined,
      }));
    }
  }

  if (providers.length) {
    return new VideoModelRouter({
      providers,
      referenceProvider: providers.find((provider) => provider instanceof LumaAgentsVideoProvider)
        || providers[0],
      statsStore: new ProviderStatsStore(env.PROVIDER_STATS_PATH),
      costWeight: env.VIDEO_ROUTER_COST_WEIGHT ? Number(env.VIDEO_ROUTER_COST_WEIGHT) : undefined,
      historyWeight: env.VIDEO_ROUTER_HISTORY_WEIGHT ? Number(env.VIDEO_ROUTER_HISTORY_WEIGHT) : undefined,
      switchOnQcFailure: env.VIDEO_ROUTER_SWITCH_ON_QC_FAILURE == null
        ? undefined
        : isEnabled(env.VIDEO_ROUTER_SWITCH_ON_QC_FAILURE),
    });
  }

  // Backwards-compatible legacy Dream Machine path.
  if (env.LUMA_API_KEY) {
    return new LumaRealisticVideoProvider({
      apiKey: env.LUMA_API_KEY,
      baseUrl: env.LUMA_BASE_URL,
      videoModel: env.LUMA_VIDEO_MODEL,
      imageModel: env.LUMA_IMAGE_MODEL,
      resolution: env.LUMA_VIDEO_RESOLUTION,
      generationDuration: env.LUMA_VIDEO_DURATION,
      assetDir: env.ASSET_DIR,
      pollIntervalMs: env.LUMA_POLL_INTERVAL_MS ? Number(env.LUMA_POLL_INTERVAL_MS) : undefined,
      maxPolls: env.LUMA_MAX_POLLS ? Number(env.LUMA_MAX_POLLS) : undefined,
      continuityWeight: env.LUMA_CONTINUITY_WEIGHT ? Number(env.LUMA_CONTINUITY_WEIGHT) : undefined,
      locationReferenceWeight: env.LUMA_LOCATION_REFERENCE_WEIGHT
        ? Number(env.LUMA_LOCATION_REFERENCE_WEIGHT)
        : undefined,
      characterReferenceCount: env.LUMA_CHARACTER_REFERENCE_COUNT
        ? Number(env.LUMA_CHARACTER_REFERENCE_COUNT)
        : undefined,
    });
  }

  return null;
}

export function createVisualProvider(env = process.env) {
  const ai = createAiVideoProvider(env);
  const stock = env.PEXELS_API_KEY ? createStockProvider(env) : null;
  if (!ai && !stock) return null;
  return new AiFirstVisualProvider({ ai, stock });
}

export function createRealismQcProvider(env = process.env) {
  if (!isEnabled(env.REALISM_QC_ENABLED)) return null;

  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required when REALISM_QC_ENABLED=true');
  }
  if (!env.REALISM_QC_MODEL) {
    throw new Error('REALISM_QC_MODEL is required when REALISM_QC_ENABLED=true');
  }

  return new OpenRouterRealismQcProvider({
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.REALISM_QC_MODEL,
    threshold: env.REALISM_QC_THRESHOLD ? Number(env.REALISM_QC_THRESHOLD) : undefined,
    temporalThreshold: env.REALISM_QC_TEMPORAL_THRESHOLD
      ? Number(env.REALISM_QC_TEMPORAL_THRESHOLD)
      : undefined,
    continuityThreshold: env.REALISM_QC_CONTINUITY_THRESHOLD
      ? Number(env.REALISM_QC_CONTINUITY_THRESHOLD)
      : undefined,
    temporalEnabled: env.REALISM_QC_TEMPORAL_ENABLED == null
      ? undefined
      : isEnabled(env.REALISM_QC_TEMPORAL_ENABLED),
    maxRegenerations: env.REALISM_MAX_REGENERATIONS
      ? Number(env.REALISM_MAX_REGENERATIONS)
      : undefined,
    failClosed: env.REALISM_QC_FAIL_CLOSED == null
      ? undefined
      : isEnabled(env.REALISM_QC_FAIL_CLOSED),
  });
}

export function createAudiovisualProvider(env = process.env) {
  if (!env.RUNWAYML_API_SECRET) return null;

  return new RunwayAudiovisualProvider({
    apiKey: env.RUNWAYML_API_SECRET,
    baseUrl: env.RUNWAY_BASE_URL,
    model: env.AUDIOVISUAL_VIDEO_MODEL || 'wan3',
    ratio: env.AUDIOVISUAL_VIDEO_RATIO || '720:1280',
    dialogueMode: env.AUDIOVISUAL_DIALOGUE_MODE || 'locked',
    ttsModel: env.AUDIOVISUAL_TTS_MODEL || 'eleven_v3',
    defaultVoice: env.AUDIOVISUAL_DEFAULT_VOICE || 'Bernard',
    assetDir: env.ASSET_DIR,
    pollIntervalMs: env.RUNWAY_POLL_INTERVAL_MS ? Number(env.RUNWAY_POLL_INTERVAL_MS) : undefined,
    maxPolls: env.RUNWAY_MAX_POLLS ? Number(env.RUNWAY_MAX_POLLS) : undefined,
  });
}

export function createDialogueQcProvider(env = process.env) {
  const enabled = env.DIALOGUE_QC_ENABLED == null
    ? env.VIDEO_PIPELINE_MODE === 'audiovisual'
      && Boolean(env.TRANSCRIPTION_API_KEY || env.OPENAI_API_KEY)
    : isEnabled(env.DIALOGUE_QC_ENABLED);

  if (!enabled) return null;

  const apiKey = env.TRANSCRIPTION_API_KEY || env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('TRANSCRIPTION_API_KEY or OPENAI_API_KEY is required when DIALOGUE_QC_ENABLED=true');
  }

  return new OpenAiTranscriptionProvider({
    apiKey,
    baseUrl: env.TRANSCRIPTION_BASE_URL,
    model: env.TRANSCRIPTION_MODEL,
    maxWer: env.DIALOGUE_QC_MAX_WER ? Number(env.DIALOGUE_QC_MAX_WER) : undefined,
    maxWordCountDelta: env.DIALOGUE_QC_MAX_WORD_COUNT_DELTA
      ? Number(env.DIALOGUE_QC_MAX_WORD_COUNT_DELTA)
      : undefined,
    maxRegenerations: env.DIALOGUE_QC_MAX_REGENERATIONS
      ? Number(env.DIALOGUE_QC_MAX_REGENERATIONS)
      : undefined,
  });
}

export function createLipSyncQcProvider(env = process.env) {
  const enabled = env.LIPSYNC_QC_ENABLED == null
    ? env.VIDEO_PIPELINE_MODE === 'audiovisual'
      && Boolean(env.OPENROUTER_API_KEY)
      && Boolean(env.LIPSYNC_QC_MODEL || env.REALISM_QC_MODEL)
    : isEnabled(env.LIPSYNC_QC_ENABLED);

  if (!enabled) return null;

  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required when LIPSYNC_QC_ENABLED=true');
  }
  if (!env.LIPSYNC_QC_MODEL && !env.REALISM_QC_MODEL) {
    throw new Error('LIPSYNC_QC_MODEL or REALISM_QC_MODEL is required when LIPSYNC_QC_ENABLED=true');
  }

  return new OpenRouterLipSyncQcProvider({
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.LIPSYNC_QC_MODEL || env.REALISM_QC_MODEL,
    threshold: env.LIPSYNC_QC_THRESHOLD ? Number(env.LIPSYNC_QC_THRESHOLD) : undefined,
    maxFrames: env.LIPSYNC_QC_FRAMES ? Number(env.LIPSYNC_QC_FRAMES) : undefined,
    frameWidth: env.LIPSYNC_QC_FRAME_WIDTH ? Number(env.LIPSYNC_QC_FRAME_WIDTH) : undefined,
    maxRegenerations: env.LIPSYNC_QC_MAX_REGENERATIONS
      ? Number(env.LIPSYNC_QC_MAX_REGENERATIONS)
      : undefined,
  });
}

export function createVoiceProvider(env = process.env) {
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) {
    return new NullVoiceProvider();
  }

  return new ElevenLabsVoiceProvider({
    apiKey: env.ELEVENLABS_API_KEY,
    voiceId: env.ELEVENLABS_VOICE_ID,
    modelId: env.ELEVENLABS_MODEL_ID,
    outputDir: env.OUTPUT_DIR,
  });
}

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function isEnabledDefaultTrue(value) {
  if (value == null || value === '') return true;
  return isEnabled(value);
}
