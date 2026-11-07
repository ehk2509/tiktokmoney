import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { assertLocalEndpoint } from './localEndpoints.js';

// For self-hosted OpenAI-compatible TTS services (e.g. Kokoro-FastAPI).
// Deliberately not an OpenAI cloud connector.
export class LocalSpeechProvider {
  constructor({
    baseUrl = process.env.LOCAL_TTS_BASE_URL,
    model = process.env.LOCAL_TTS_MODEL || 'kokoro',
    voice = process.env.LOCAL_TTS_VOICE || 'af_heart',
    responseFormat = process.env.LOCAL_TTS_FORMAT || 'wav',
    assetDir = process.env.ASSET_DIR || './data/assets',
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!baseUrl) throw new Error('LOCAL_TTS_BASE_URL is required for local TTS');
    this.baseUrl = assertLocalEndpoint(baseUrl, 'LOCAL_TTS_BASE_URL');
    if (!fetchImpl) throw new Error('fetch is required');
    if (!['wav', 'mp3', 'flac', 'opus', 'aac'].includes(responseFormat)) {
      throw new Error('LOCAL_TTS_FORMAT must be wav, mp3, flac, opus or aac');
    }
    this.model = model;
    this.voice = voice;
    this.responseFormat = responseFormat;
    this.assetDir = assetDir;
    this.fetch = fetchImpl;
  }

  async synthesize({ text, projectId = 'project', segmentIndex = 0 } = {}) {
    if (!String(text || '').trim()) {
      throw new Error('Local TTS needs non-empty dialogue text');
    }
    const response = await this.fetch(this.baseUrl + '/audio/speech', {
      method: 'POST',
      headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model, voice: this.voice,
        input: String(text).trim(), response_format: this.responseFormat,
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error('Local TTS failed (' + response.status + '): ' + detail.slice(0, 400));
    }
    await mkdir(this.assetDir, { recursive: true });
    const name = String(projectId).replace(/[^a-z0-9_-]/gi, '-').slice(0, 80);
    const filePath = path.join(this.assetDir, 'local-tts-' + name + '-' +
      String(segmentIndex) + '-' + crypto.randomUUID() + '.' + this.responseFormat);
    await pipeline(response.body, createWriteStream(filePath));
    return { provider: 'local-tts', model: this.model, localPath: filePath, text: String(text).trim() };
  }
}
