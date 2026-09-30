import { TemplateLlmProvider } from '../providers.js';
import { OpenAICompatibleLlmProvider } from './openaiCompatibleLlmProvider.js';
import { PexelsStockProvider, NullStockProvider } from './pexelsStockProvider.js';
import { ElevenLabsVoiceProvider, NullVoiceProvider } from './elevenLabsVoiceProvider.js';

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
