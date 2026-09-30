import { TemplateLlmProvider } from '../providers.js';
import { OpenAICompatibleLlmProvider } from './openaiCompatibleLlmProvider.js';
import { PexelsStockProvider, NullStockProvider } from './pexelsStockProvider.js';
import { ElevenLabsVoiceProvider, NullVoiceProvider } from './elevenLabsVoiceProvider.js';
import { LumaRealisticVideoProvider } from './lumaRealisticVideoProvider.js';
import { AiFirstVisualProvider, NullVisualProvider } from './visualRouter.js';

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
  if (!env.LUMA_API_KEY) return null;
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
  });
}

export function createVisualProvider(env = process.env) {
  const ai = createAiVideoProvider(env);
  const stock = env.PEXELS_API_KEY ? createStockProvider(env) : null;
  if (!ai && !stock) return new NullVisualProvider();
  return new AiFirstVisualProvider({ ai, stock });
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
