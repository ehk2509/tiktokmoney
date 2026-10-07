import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class OpenAiVoiceProvider {
  constructor({
    apiKey = process.env.OPENAI_API_KEY,
    baseUrl = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1',
    modelId = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
    voice = process.env.OPENAI_TTS_VOICE || 'alloy',
    outputDir = process.env.OUTPUT_DIR || './outputs',
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for OpenAI TTS');
    if (!fetchImpl) throw new Error('fetch is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.modelId = modelId;
    this.voiceId = voice;
    this.outputDir = outputDir;
    this.fetch = fetchImpl;
  }

  async synthesize({ text, projectId }) {
    const response = await this.fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.modelId,
        voice: this.voiceId,
        input: text,
        response_format: 'mp3',
      }),
    });

    if (!response.ok) {
      let detail = response.statusText || 'request failed';
      try {
        const payload = await response.json();
        detail = payload?.error?.message || payload?.message || detail;
      } catch {
        // Binary/non-JSON error bodies are represented by the HTTP status.
      }
      const error = new Error(`OpenAI TTS request failed (${response.status}): ${detail}`);
      error.status = response.status;
      throw error;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error('OpenAI TTS returned empty audio');

    await mkdir(this.outputDir, { recursive: true });
    const audioPath = path.join(this.outputDir, `${projectId}.voice.openai.mp3`);
    await writeFile(audioPath, bytes);

    return {
      provider: 'openai',
      model: this.modelId,
      voiceId: this.voiceId,
      localPath: audioPath,
      durationSeconds: null,
      wordTimings: [],
      timingSource: 'unavailable',
    };
  }
}
