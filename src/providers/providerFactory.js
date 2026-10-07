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
import { ProviderReliabilityService } from '../services/providerReliabilityService.js';
import { EquivalentProviderRouter } from './equivalentProviderRouter.js';
import { RunwayAudiovisualProvider } from './runwayAudiovisualProvider.js';
import { OpenAiTranscriptionProvider } from './openAiTranscriptionProvider.js';
import { OpenRouterLipSyncQcProvider } from './openRouterLipSyncQcProvider.js';
import { DeepLipSyncQcProvider } from './deepLipSyncQcProvider.js';
import { PhonemeVisemeQcProvider } from './phonemeVisemeQcProvider.js';
import { OpenRouterSpeakerTurnQcProvider } from './openRouterSpeakerTurnQcProvider.js';
import { PoseMotionQcProvider } from './poseMotionQcProvider.js';
import { OpenRouterTextArtifactQcProvider } from './openRouterTextArtifactQcProvider.js';
import { OpenRouterVisualFactualQcProvider } from './openRouterVisualFactualQcProvider.js';
import { OpenRouterEditorialVarietyQcProvider } from './openRouterEditorialVarietyQcProvider.js';
import { OpenRouterProductionIntegrityQcProvider } from './openRouterProductionIntegrityQcProvider.js';
import { PoseMotionExtractor } from '../services/poseMotionExtractor.js';
import { YouTubeTrendProvider } from './youtubeTrendProvider.js';
import { RedditTrendProvider } from './redditTrendProvider.js';
import { RssTrendProvider, parseFeeds } from './rssTrendProvider.js';
import { TrendIntelligence } from '../core/trendIntelligence.js';
import { TrendHistoryStore } from '../storage/trendHistoryStore.js';

export function createLlmProvider(env = process.env) {
  const provider = (env.LLM_PROVIDER || 'template').toLowerCase();

  if (provider === 'template') return new TemplateLlmProvider();
  if (provider === 'openai-compatible' || provider === 'openai') {
    const models = unique([
      env.LLM_MODEL,
      ...csv(env.LLM_FALLBACK_MODELS),
    ].filter(Boolean));
    const entries = models.map((model, index) => ({
      id: `llm:${model}`,
      provider: new OpenAICompatibleLlmProvider({
        apiKey: env.OPENAI_API_KEY,
        baseUrl: env.LLM_BASE_URL,
        model,
        judgeModel: index === 0 ? env.CREATIVE_JUDGE_MODEL : model,
      }),
    }));
    return wrapEquivalent(entries, {
      capability: 'llm',
      env,
    });
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

export function createTrendIntelligence(env = process.env) {
  const providers = [];

  if (env.YOUTUBE_API_KEY) {
    providers.push(new YouTubeTrendProvider({
      apiKey: env.YOUTUBE_API_KEY,
      baseUrl: env.YOUTUBE_API_BASE_URL,
      regionCode: env.TREND_REGION,
      maxResults: env.YOUTUBE_TREND_MAX_RESULTS
        ? Number(env.YOUTUBE_TREND_MAX_RESULTS)
        : undefined,
      lookbackHours: env.TREND_LOOKBACK_HOURS
        ? Number(env.TREND_LOOKBACK_HOURS)
        : undefined,
    }));
  }

  if (env.REDDIT_ACCESS_TOKEN) {
    providers.push(new RedditTrendProvider({
      accessToken: env.REDDIT_ACCESS_TOKEN,
      baseUrl: env.REDDIT_API_BASE_URL,
      userAgent: env.REDDIT_USER_AGENT,
      subreddit: env.REDDIT_TREND_SUBREDDIT,
      maxResults: env.REDDIT_TREND_MAX_RESULTS
        ? Number(env.REDDIT_TREND_MAX_RESULTS)
        : undefined,
    }));
  }

  const feeds = parseFeeds(env.TREND_RSS_FEEDS);
  if (feeds.length) {
    providers.push(new RssTrendProvider({
      feeds,
      maxItemsPerFeed: env.RSS_TREND_MAX_ITEMS
        ? Number(env.RSS_TREND_MAX_ITEMS)
        : undefined,
    }));
  }

  if (!providers.length) return null;

  return new TrendIntelligence({
    providers,
    historyStore: new TrendHistoryStore(env.TREND_HISTORY_PATH),
    clusterThreshold: env.TREND_CLUSTER_THRESHOLD
      ? Number(env.TREND_CLUSTER_THRESHOLD)
      : undefined,
    maxSignals: env.TREND_MAX_SIGNALS
      ? Number(env.TREND_MAX_SIGNALS)
      : undefined,
  });
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
    const statsStore = new ProviderStatsStore(env.PROVIDER_STATS_PATH);
    const reliabilityService = new ProviderReliabilityService({
      statsStore,
      minSamples: env.PROVIDER_RELIABILITY_MIN_SAMPLES
        ? Number(env.PROVIDER_RELIABILITY_MIN_SAMPLES)
        : undefined,
      failureRateOpen: env.PROVIDER_FAILURE_RATE_OPEN
        ? Number(env.PROVIDER_FAILURE_RATE_OPEN)
        : undefined,
      throttleRateOpen: env.PROVIDER_THROTTLE_RATE_OPEN
        ? Number(env.PROVIDER_THROTTLE_RATE_OPEN)
        : undefined,
      latencyOpenMs: env.PROVIDER_LATENCY_OPEN_MS
        ? Number(env.PROVIDER_LATENCY_OPEN_MS)
        : undefined,
      cooldownMinutes: env.PROVIDER_CIRCUIT_COOLDOWN_MINUTES
        ? Number(env.PROVIDER_CIRCUIT_COOLDOWN_MINUTES)
        : undefined,
    });
    return new VideoModelRouter({
      providers,
      referenceProvider: providers.find((provider) => provider instanceof LumaAgentsVideoProvider)
        || providers[0],
      statsStore,
      reliabilityService,
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

  const models = unique([
    env.REALISM_QC_MODEL,
    ...csv(env.REALISM_QC_FALLBACK_MODELS),
  ].filter(Boolean));
  const entries = models.map((model) => ({
    id: `qc:realism:${model}`,
    provider: new OpenRouterRealismQcProvider({
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: env.OPENROUTER_BASE_URL,
      model,
      threshold: env.REALISM_QC_THRESHOLD ? Number(env.REALISM_QC_THRESHOLD) : undefined,
      temporalThreshold: env.REALISM_QC_TEMPORAL_THRESHOLD
        ? Number(env.REALISM_QC_TEMPORAL_THRESHOLD)
        : undefined,
      continuityThreshold: env.REALISM_QC_CONTINUITY_THRESHOLD
        ? Number(env.REALISM_QC_CONTINUITY_THRESHOLD)
        : undefined,
      keyframeThreshold: env.REALISM_QC_KEYFRAME_THRESHOLD
        ? Number(env.REALISM_QC_KEYFRAME_THRESHOLD)
        : undefined,
      motionRegionThreshold: env.REALISM_QC_MOTION_REGION_THRESHOLD
        ? Number(env.REALISM_QC_MOTION_REGION_THRESHOLD)
        : undefined,
      motionGuideThreshold: env.REALISM_QC_MOTION_GUIDE_THRESHOLD
        ? Number(env.REALISM_QC_MOTION_GUIDE_THRESHOLD)
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
    }),
  }));
  return wrapEquivalent(entries, {
    capability: 'qc:realism',
    env,
  });
}

export function createPoseMotionQcProvider(env = process.env) {
  const extractor = new PoseMotionExtractor({
    command: env.POSE_EXTRACTOR_COMMAND,
    args: env.POSE_EXTRACTOR_ARGS ? JSON.parse(env.POSE_EXTRACTOR_ARGS) : undefined,
    sampleFps: env.POSE_EXTRACTOR_FPS ? Number(env.POSE_EXTRACTOR_FPS) : undefined,
    timeoutMs: env.POSE_EXTRACTOR_TIMEOUT_MS
      ? Number(env.POSE_EXTRACTOR_TIMEOUT_MS)
      : undefined,
    cacheDir: env.POSE_CACHE_DIR,
    modelPath: env.POSE_MODEL_PATH,
  });
  const enabled = env.POSE_MOTION_QC_ENABLED == null
    ? extractor.available
    : isEnabled(env.POSE_MOTION_QC_ENABLED);
  if (!enabled) return null;
  if (!extractor.available) {
    throw new Error(
      'Pose motion QC is enabled but no extractor is available. Run npm run setup:pose or set POSE_EXTRACTOR_COMMAND.',
    );
  }

  return new PoseMotionQcProvider({
    extractor,
    threshold: env.POSE_MOTION_QC_THRESHOLD
      ? Number(env.POSE_MOTION_QC_THRESHOLD)
      : undefined,
    minCoverage: env.POSE_MOTION_QC_MIN_COVERAGE
      ? Number(env.POSE_MOTION_QC_MIN_COVERAGE)
      : undefined,
    maxRegenerations: env.POSE_MOTION_QC_MAX_REGENERATIONS
      ? Number(env.POSE_MOTION_QC_MAX_REGENERATIONS)
      : undefined,
    failClosed: env.POSE_MOTION_QC_FAIL_CLOSED == null
      ? undefined
      : isEnabled(env.POSE_MOTION_QC_FAIL_CLOSED),
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
    imageModel: env.RUNWAY_IMAGE_MODEL || 'gen4_image',
    keyframeImageRatio: env.KEYFRAME_IMAGE_RATIO || '720:1280',
    keyframeVideoRatio: env.KEYFRAME_VIDEO_RATIO || 'auto_720p',
    keyframeFailOpen: env.KEYFRAME_FAIL_OPEN == null
      ? undefined
      : isEnabled(env.KEYFRAME_FAIL_OPEN),
    motionGuideFailOpen: env.MOTION_GUIDE_FAIL_OPEN == null
      ? undefined
      : isEnabled(env.MOTION_GUIDE_FAIL_OPEN),
    poseExtractor: new PoseMotionExtractor({
      command: env.POSE_EXTRACTOR_COMMAND,
      args: env.POSE_EXTRACTOR_ARGS ? JSON.parse(env.POSE_EXTRACTOR_ARGS) : undefined,
      sampleFps: env.POSE_EXTRACTOR_FPS ? Number(env.POSE_EXTRACTOR_FPS) : undefined,
      timeoutMs: env.POSE_EXTRACTOR_TIMEOUT_MS
        ? Number(env.POSE_EXTRACTOR_TIMEOUT_MS)
        : undefined,
      cacheDir: env.POSE_CACHE_DIR,
      modelPath: env.POSE_MODEL_PATH,
    }),
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

  const models = unique([
    env.TRANSCRIPTION_MODEL,
    ...csv(env.TRANSCRIPTION_FALLBACK_MODELS),
  ].filter(Boolean));
  const entries = models.map((model) => ({
    id: `qc:transcription:${model}`,
    provider: new OpenAiTranscriptionProvider({
      apiKey,
      baseUrl: env.TRANSCRIPTION_BASE_URL,
      model,
      maxWer: env.DIALOGUE_QC_MAX_WER ? Number(env.DIALOGUE_QC_MAX_WER) : undefined,
      maxWordCountDelta: env.DIALOGUE_QC_MAX_WORD_COUNT_DELTA
        ? Number(env.DIALOGUE_QC_MAX_WORD_COUNT_DELTA)
        : undefined,
      maxRegenerations: env.DIALOGUE_QC_MAX_REGENERATIONS
        ? Number(env.DIALOGUE_QC_MAX_REGENERATIONS)
        : undefined,
    }),
  }));
  return wrapEquivalent(entries, {
    capability: 'qc:transcription',
    env,
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

export function createDeepLipSyncQcProvider(env = process.env) {
  const enabled = env.DEEP_LIPSYNC_ENABLED == null
    ? Boolean(env.DEEP_LIPSYNC_COMMAND)
    : isEnabled(env.DEEP_LIPSYNC_ENABLED);

  if (!enabled) return null;
  if (!env.DEEP_LIPSYNC_COMMAND) {
    throw new Error('DEEP_LIPSYNC_COMMAND is required when DEEP_LIPSYNC_ENABLED=true');
  }

  return new DeepLipSyncQcProvider({
    command: env.DEEP_LIPSYNC_COMMAND,
    args: env.DEEP_LIPSYNC_ARGS ? JSON.parse(env.DEEP_LIPSYNC_ARGS) : undefined,
    maxOffsetMs: env.DEEP_LIPSYNC_MAX_OFFSET_MS
      ? Number(env.DEEP_LIPSYNC_MAX_OFFSET_MS)
      : undefined,
    minConfidence: env.DEEP_LIPSYNC_MIN_CONFIDENCE
      ? Number(env.DEEP_LIPSYNC_MIN_CONFIDENCE)
      : undefined,
    minSegmentPassRate: env.DEEP_LIPSYNC_MIN_SEGMENT_PASS_RATE
      ? Number(env.DEEP_LIPSYNC_MIN_SEGMENT_PASS_RATE)
      : undefined,
    minPhonemeAlignment: env.DEEP_LIPSYNC_MIN_PHONEME_ALIGNMENT
      ? Number(env.DEEP_LIPSYNC_MIN_PHONEME_ALIGNMENT)
      : undefined,
    minVisemeAlignment: env.DEEP_LIPSYNC_MIN_VISEME_ALIGNMENT
      ? Number(env.DEEP_LIPSYNC_MIN_VISEME_ALIGNMENT)
      : undefined,
    maxRegenerations: env.DEEP_LIPSYNC_MAX_REGENERATIONS
      ? Number(env.DEEP_LIPSYNC_MAX_REGENERATIONS)
      : undefined,
    timeoutMs: env.DEEP_LIPSYNC_TIMEOUT_MS
      ? Number(env.DEEP_LIPSYNC_TIMEOUT_MS)
      : undefined,
  });
}

export function createPhonemeVisemeQcProvider(env = process.env) {
  const enabled = env.PHONEME_VISEME_ENABLED == null
    ? false
    : isEnabled(env.PHONEME_VISEME_ENABLED);

  if (!enabled) return null;

  return new PhonemeVisemeQcProvider({
    command: env.PHONEME_VISEME_COMMAND || 'python3',
    args: env.PHONEME_VISEME_ARGS ? JSON.parse(env.PHONEME_VISEME_ARGS) : undefined,
    minPhonemeAlignment: env.PHONEME_VISEME_MIN_PHONEME_ALIGNMENT
      ? Number(env.PHONEME_VISEME_MIN_PHONEME_ALIGNMENT)
      : undefined,
    minVisemeAlignment: env.PHONEME_VISEME_MIN_VISEME_ALIGNMENT
      ? Number(env.PHONEME_VISEME_MIN_VISEME_ALIGNMENT)
      : undefined,
    minCoverage: env.PHONEME_VISEME_MIN_COVERAGE
      ? Number(env.PHONEME_VISEME_MIN_COVERAGE)
      : undefined,
    maxRegenerations: env.PHONEME_VISEME_MAX_REGENERATIONS
      ? Number(env.PHONEME_VISEME_MAX_REGENERATIONS)
      : undefined,
    timeoutMs: env.PHONEME_VISEME_TIMEOUT_MS
      ? Number(env.PHONEME_VISEME_TIMEOUT_MS)
      : undefined,
  });
}

export function createSpeakerTurnQcProvider(env = process.env) {
  const enabled = env.SPEAKER_TURN_QC_ENABLED == null
    ? env.VIDEO_PIPELINE_MODE === 'audiovisual'
      && Boolean(env.OPENROUTER_API_KEY)
      && Boolean(env.SPEAKER_TURN_QC_MODEL || env.REALISM_QC_MODEL)
    : isEnabled(env.SPEAKER_TURN_QC_ENABLED);

  if (!enabled) return null;
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required when SPEAKER_TURN_QC_ENABLED=true');
  }
  if (!env.SPEAKER_TURN_QC_MODEL && !env.REALISM_QC_MODEL) {
    throw new Error('SPEAKER_TURN_QC_MODEL or REALISM_QC_MODEL is required when SPEAKER_TURN_QC_ENABLED=true');
  }

  return new OpenRouterSpeakerTurnQcProvider({
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.SPEAKER_TURN_QC_MODEL || env.REALISM_QC_MODEL,
    threshold: env.SPEAKER_TURN_QC_THRESHOLD
      ? Number(env.SPEAKER_TURN_QC_THRESHOLD)
      : undefined,
    frameWidth: env.SPEAKER_TURN_QC_FRAME_WIDTH
      ? Number(env.SPEAKER_TURN_QC_FRAME_WIDTH)
      : undefined,
    maxRegenerations: env.SPEAKER_TURN_QC_MAX_REGENERATIONS
      ? Number(env.SPEAKER_TURN_QC_MAX_REGENERATIONS)
      : undefined,
  });
}

export function createVoiceProvider(env = process.env) {
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) {
    return new NullVoiceProvider();
  }

  const models = unique([
    env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
    ...csv(env.ELEVENLABS_FALLBACK_MODELS),
  ]);
  const entries = models.map((modelId) => ({
    id: `voice:elevenlabs:${modelId}`,
    provider: new ElevenLabsVoiceProvider({
      apiKey: env.ELEVENLABS_API_KEY,
      voiceId: env.ELEVENLABS_VOICE_ID,
      modelId,
      outputDir: env.OUTPUT_DIR,
    }),
  }));
  return wrapEquivalent(entries, {
    capability: 'voice',
    env,
  });
}

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function isEnabledDefaultTrue(value) {
  if (value == null || value === '') return true;
  return isEnabled(value);
}

export function createEditorialVarietyQcProvider(env = process.env) {
  const enabled = env.EDITORIAL_VARIETY_QC_ENABLED == null
    ? env.VIDEO_PIPELINE_MODE === 'audiovisual'
      && Boolean(env.OPENROUTER_API_KEY)
      && Boolean(env.EDITORIAL_VARIETY_QC_MODEL || env.REALISM_QC_MODEL)
    : isEnabled(env.EDITORIAL_VARIETY_QC_ENABLED);

  if (!enabled) return null;
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required when EDITORIAL_VARIETY_QC_ENABLED=true');
  }
  if (!env.EDITORIAL_VARIETY_QC_MODEL && !env.REALISM_QC_MODEL) {
    throw new Error('EDITORIAL_VARIETY_QC_MODEL or REALISM_QC_MODEL is required when EDITORIAL_VARIETY_QC_ENABLED=true');
  }

  return new OpenRouterEditorialVarietyQcProvider({
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.EDITORIAL_VARIETY_QC_MODEL || env.REALISM_QC_MODEL,
    threshold: env.EDITORIAL_VARIETY_QC_THRESHOLD
      ? Number(env.EDITORIAL_VARIETY_QC_THRESHOLD)
      : undefined,
    frames: env.EDITORIAL_VARIETY_QC_FRAMES
      ? Number(env.EDITORIAL_VARIETY_QC_FRAMES)
      : undefined,
    frameWidth: env.EDITORIAL_VARIETY_QC_FRAME_WIDTH
      ? Number(env.EDITORIAL_VARIETY_QC_FRAME_WIDTH)
      : undefined,
    maxRegenerations: env.EDITORIAL_VARIETY_QC_MAX_REGENERATIONS
      ? Number(env.EDITORIAL_VARIETY_QC_MAX_REGENERATIONS)
      : undefined,
  });
}

export function createProductionIntegrityQcProvider(env = process.env) {
  const enabled = env.PRODUCTION_INTEGRITY_QC_ENABLED == null
    ? env.VIDEO_PIPELINE_MODE === 'audiovisual'
      && Boolean(env.OPENROUTER_API_KEY)
      && Boolean(env.PRODUCTION_INTEGRITY_QC_MODEL || env.REALISM_QC_MODEL)
    : isEnabled(env.PRODUCTION_INTEGRITY_QC_ENABLED);

  if (!enabled) return null;
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required when PRODUCTION_INTEGRITY_QC_ENABLED=true');
  }
  if (!env.PRODUCTION_INTEGRITY_QC_MODEL && !env.REALISM_QC_MODEL) {
    throw new Error('PRODUCTION_INTEGRITY_QC_MODEL or REALISM_QC_MODEL is required when PRODUCTION_INTEGRITY_QC_ENABLED=true');
  }

  return new OpenRouterProductionIntegrityQcProvider({
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.PRODUCTION_INTEGRITY_QC_MODEL || env.REALISM_QC_MODEL,
    threshold: env.PRODUCTION_INTEGRITY_QC_THRESHOLD
      ? Number(env.PRODUCTION_INTEGRITY_QC_THRESHOLD)
      : undefined,
    minBlockingConfidence: env.PRODUCTION_INTEGRITY_QC_MIN_BLOCKING_CONFIDENCE
      ? Number(env.PRODUCTION_INTEGRITY_QC_MIN_BLOCKING_CONFIDENCE)
      : undefined,
    frames: env.PRODUCTION_INTEGRITY_QC_FRAMES
      ? Number(env.PRODUCTION_INTEGRITY_QC_FRAMES)
      : undefined,
    frameWidth: env.PRODUCTION_INTEGRITY_QC_FRAME_WIDTH
      ? Number(env.PRODUCTION_INTEGRITY_QC_FRAME_WIDTH)
      : undefined,
    maxRegenerations: env.PRODUCTION_INTEGRITY_QC_MAX_REGENERATIONS
      ? Number(env.PRODUCTION_INTEGRITY_QC_MAX_REGENERATIONS)
      : undefined,
  });
}

export function createVisualFactualQcProvider(env = process.env) {
  const enabled = env.VISUAL_FACT_QC_ENABLED == null
    ? env.VIDEO_PIPELINE_MODE === 'audiovisual'
      && Boolean(env.OPENROUTER_API_KEY)
      && Boolean(env.VISUAL_FACT_QC_MODEL || env.REALISM_QC_MODEL)
    : isEnabled(env.VISUAL_FACT_QC_ENABLED);

  if (!enabled) return null;
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required when VISUAL_FACT_QC_ENABLED=true');
  }
  if (!env.VISUAL_FACT_QC_MODEL && !env.REALISM_QC_MODEL) {
    throw new Error('VISUAL_FACT_QC_MODEL or REALISM_QC_MODEL is required when VISUAL_FACT_QC_ENABLED=true');
  }

  return new OpenRouterVisualFactualQcProvider({
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.VISUAL_FACT_QC_MODEL || env.REALISM_QC_MODEL,
    threshold: env.VISUAL_FACT_QC_THRESHOLD
      ? Number(env.VISUAL_FACT_QC_THRESHOLD)
      : undefined,
    minBlockingConfidence: env.VISUAL_FACT_QC_MIN_BLOCKING_CONFIDENCE
      ? Number(env.VISUAL_FACT_QC_MIN_BLOCKING_CONFIDENCE)
      : undefined,
    frames: env.VISUAL_FACT_QC_FRAMES ? Number(env.VISUAL_FACT_QC_FRAMES) : undefined,
    frameWidth: env.VISUAL_FACT_QC_FRAME_WIDTH
      ? Number(env.VISUAL_FACT_QC_FRAME_WIDTH)
      : undefined,
    maxRegenerations: env.VISUAL_FACT_QC_MAX_REGENERATIONS
      ? Number(env.VISUAL_FACT_QC_MAX_REGENERATIONS)
      : undefined,
  });
}

export function createTextArtifactQcProvider(env = process.env) {
  const enabled = env.TEXT_ARTIFACT_QC_ENABLED == null
    ? env.VIDEO_PIPELINE_MODE === 'audiovisual'
      && Boolean(env.OPENROUTER_API_KEY)
      && Boolean(env.TEXT_ARTIFACT_QC_MODEL || env.REALISM_QC_MODEL)
    : isEnabled(env.TEXT_ARTIFACT_QC_ENABLED);

  if (!enabled) return null;
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required when TEXT_ARTIFACT_QC_ENABLED=true');
  }
  if (!env.TEXT_ARTIFACT_QC_MODEL && !env.REALISM_QC_MODEL) {
    throw new Error('TEXT_ARTIFACT_QC_MODEL or REALISM_QC_MODEL is required when TEXT_ARTIFACT_QC_ENABLED=true');
  }

  return new OpenRouterTextArtifactQcProvider({
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.TEXT_ARTIFACT_QC_MODEL || env.REALISM_QC_MODEL,
    frames: env.TEXT_ARTIFACT_QC_FRAMES ? Number(env.TEXT_ARTIFACT_QC_FRAMES) : undefined,
    frameWidth: env.TEXT_ARTIFACT_QC_FRAME_WIDTH ? Number(env.TEXT_ARTIFACT_QC_FRAME_WIDTH) : undefined,
    maxRegenerations: env.TEXT_ARTIFACT_QC_MAX_REGENERATIONS
      ? Number(env.TEXT_ARTIFACT_QC_MAX_REGENERATIONS)
      : undefined,
  });
}


function wrapEquivalent(entries, { capability, env }) {
  if (entries.length === 1) return entries[0].provider;
  const statsStore = new ProviderStatsStore(env.PROVIDER_STATS_PATH);
  const reliabilityService = new ProviderReliabilityService({
    statsStore,
    minSamples: env.PROVIDER_RELIABILITY_MIN_SAMPLES
      ? Number(env.PROVIDER_RELIABILITY_MIN_SAMPLES)
      : undefined,
    failureRateOpen: env.PROVIDER_FAILURE_RATE_OPEN
      ? Number(env.PROVIDER_FAILURE_RATE_OPEN)
      : undefined,
    throttleRateOpen: env.PROVIDER_THROTTLE_RATE_OPEN
      ? Number(env.PROVIDER_THROTTLE_RATE_OPEN)
      : undefined,
    latencyOpenMs: env.PROVIDER_LATENCY_OPEN_MS
      ? Number(env.PROVIDER_LATENCY_OPEN_MS)
      : undefined,
    cooldownMinutes: env.PROVIDER_CIRCUIT_COOLDOWN_MINUTES
      ? Number(env.PROVIDER_CIRCUIT_COOLDOWN_MINUTES)
      : undefined,
  });
  return new EquivalentProviderRouter({
    providers: entries,
    statsStore,
    reliabilityService,
    capability,
  });
}

function csv(value) {
  if (!value) return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
}
