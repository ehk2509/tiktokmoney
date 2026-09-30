import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class ElevenLabsVoiceProvider {
  constructor({
    apiKey = process.env.ELEVENLABS_API_KEY,
    voiceId = process.env.ELEVENLABS_VOICE_ID,
    modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
    outputDir = process.env.OUTPUT_DIR || './outputs',
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY is required for ElevenLabs TTS');
    if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID is required for ElevenLabs TTS');
    if (!fetchImpl) throw new Error('fetch is required');
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.modelId = modelId;
    this.outputDir = outputDir;
    this.fetch = fetchImpl;
  }

  async synthesize({ text, projectId }) {
    const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/with-timestamps?output_format=mp3_44100_128`;
    const response = await this.fetch(endpoint, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: this.modelId,
      }),
    });

    const payload = await readJsonResponse(response, 'ElevenLabs');
    if (!payload.audio_base64) throw new Error('ElevenLabs response did not contain audio');

    await mkdir(this.outputDir, { recursive: true });
    const audioPath = path.join(this.outputDir, `${projectId}.voice.mp3`);
    await writeFile(audioPath, Buffer.from(payload.audio_base64, 'base64'));

    const alignment = payload.normalized_alignment || payload.alignment || null;
    const wordTimings = alignmentToWords(alignment);
    const durationSeconds = alignment?.character_end_times_seconds?.at(-1)
      || wordTimings.at(-1)?.end
      || null;

    return {
      provider: 'elevenlabs',
      model: this.modelId,
      voiceId: this.voiceId,
      audioPath,
      durationSeconds,
      wordTimings,
    };
  }
}

export class NullVoiceProvider {
  async synthesize() {
    return null;
  }
}

export function alignmentToWords(alignment) {
  if (!alignment?.characters?.length) return [];
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds || [];
  const ends = alignment.character_end_times_seconds || [];
  const words = [];
  let text = '';
  let start = null;
  let end = null;

  const flush = () => {
    if (!text) return;
    words.push({ word: text, start: start ?? 0, end: end ?? start ?? 0 });
    text = '';
    start = null;
    end = null;
  };

  chars.forEach((char, index) => {
    if (/\s/.test(char)) {
      flush();
      return;
    }

    if (start == null) start = Number(starts[index] ?? 0);
    end = Number(ends[index] ?? start);
    text += char;
  });
  flush();

  return words;
}

async function readJsonResponse(response, label) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${label} returned a non-JSON response`);
  }

  if (!response.ok) {
    const detail = payload?.detail?.message || payload?.detail || payload?.message || response.statusText || 'request failed';
    throw new Error(`${label} request failed (${response.status}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }

  return payload;
}
