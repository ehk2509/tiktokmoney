import crypto from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://api.dev.runwayml.com/v1';

export class RunwayAudiovisualProvider {
  constructor({
    apiKey = process.env.RUNWAYML_API_SECRET,
    baseUrl = process.env.RUNWAY_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.AUDIOVISUAL_VIDEO_MODEL || 'wan3',
    ratio = process.env.AUDIOVISUAL_VIDEO_RATIO || '720:1280',
    dialogueMode = process.env.AUDIOVISUAL_DIALOGUE_MODE || 'locked',
    ttsModel = process.env.AUDIOVISUAL_TTS_MODEL || 'eleven_v3',
    defaultVoice = process.env.AUDIOVISUAL_DEFAULT_VOICE || 'Bernard',
    assetDir = process.env.ASSET_DIR || './outputs/assets',
    pollIntervalMs = Number(process.env.RUNWAY_POLL_INTERVAL_MS || 2500),
    maxPolls = Number(process.env.RUNWAY_MAX_POLLS || 120),
    fetchImpl = globalThis.fetch,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    if (!apiKey) throw new Error('RUNWAYML_API_SECRET is required for audiovisual generation');
    if (!fetchImpl) throw new Error('fetch is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.ratio = ratio;
    this.dialogueMode = dialogueMode;
    this.ttsModel = ttsModel;
    this.defaultVoice = defaultVoice;
    this.assetDir = assetDir;
    this.pollIntervalMs = pollIntervalMs;
    this.maxPolls = maxPolls;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
  }

  async generateSegment({
    segment,
    productionScript,
    storyBible = null,
    previousAsset = null,
    regeneration = null,
    projectId,
  }) {
    const character = productionScript.characters.find((item) => item.id === segment.speakerCharacterId)
      || productionScript.characters[0];
    const references = collectImageReferences(segment, storyBible, previousAsset);
    const referenceAudio = [];

    let dialogueTrack = null;
    if (this.dialogueMode === 'locked' && segment.dialogue) {
      dialogueTrack = await this.generateDialogueTrack({
        text: segment.dialogue,
        character,
      });
      referenceAudio.push({ type: 'audio', uri: dialogueTrack.url });
    }

    const promptText = buildAudiovisualPrompt({
      segment,
      productionScript,
      character,
      dialogueTrack,
      regeneration,
      previousAsset,
    });

    const task = await this.createTask('/text_to_video', {
      model: this.model,
      promptText,
      audio: true,
      duration: clamp(Math.round(segment.durationSeconds), 4, 15),
      ratio: this.ratio,
      ...(references.length ? { references } : {}),
      ...(referenceAudio.length ? { referenceAudio } : {}),
    });
    const completed = await this.wait(task.id);
    const sourceUrl = firstOutputUrl(completed);
    if (!sourceUrl) throw new Error('Runway audiovisual task completed without output');

    await mkdir(this.assetDir, { recursive: true });
    const localPath = path.join(
      this.assetDir,
      `av-${projectId || 'project'}-${segment.index}-${task.id}-${fingerprint(sourceUrl)}.mp4`,
    );
    if (!(await fileExists(localPath))) await this.download(sourceUrl, localPath);

    return {
      provider: 'runway',
      providerModelId: `runway-${this.model}-audiovisual`,
      type: 'ai-video',
      audioMode: this.dialogueMode === 'locked' ? 'locked-dialogue-native-mix' : 'native',
      model: this.model,
      localPath,
      sourceUrl,
      generationId: task.id,
      generatedDuration: `${segment.durationSeconds}s`,
      aspectRatio: '9:16',
      prompt: promptText,
      dialogueTrack,
      referenceImageCount: references.length,
      previousGenerationId: previousAsset?.generationId || null,
    };
  }

  async generateDialogueTrack({ text, character }) {
    const task = await this.createTask('/text_to_speech', {
      model: this.ttsModel,
      promptText: text,
      voice: {
        type: 'runway-preset',
        presetId: character?.voice?.presetId || this.defaultVoice,
      },
      languageCode: character?.voice?.languageCode || 'en',
      stability: 0.55,
      similarityBoost: 0.8,
      style: 0.35,
      speed: 1,
      useSpeakerBoost: true,
    });
    const completed = await this.wait(task.id);
    const url = firstOutputUrl(completed);
    if (!url) throw new Error('Runway text-to-speech task completed without output');

    return {
      provider: 'runway',
      model: this.ttsModel,
      generationId: task.id,
      url,
      voicePresetId: character?.voice?.presetId || this.defaultVoice,
      exactText: text,
    };
  }

  async createTask(endpoint, body) {
    return this.request(endpoint, { method: 'POST', body });
  }

  async wait(id) {
    if (!id) throw new Error('Runway task did not return an id');

    for (let attempt = 0; attempt < this.maxPolls; attempt += 1) {
      const task = await this.request(`/tasks/${encodeURIComponent(id)}`);
      if (task.status === 'SUCCEEDED') return task;
      if (task.status === 'FAILED' || task.status === 'CANCELED') {
        throw new Error(`Runway task ${String(task.status).toLowerCase()}: ${task.failure || task.failureCode || 'unknown'}`);
      }
      if (attempt < this.maxPolls - 1) await this.sleep(this.pollIntervalMs);
    }

    throw new Error(`Runway task timed out after ${this.maxPolls} polls`);
  }

  async request(endpoint, { method = 'GET', body = null } = {}) {
    const response = await this.fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'x-runway-version': '2024-11-06',
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Runway returned a non-JSON response');
    }

    if (!response.ok) {
      const detail = payload?.error || payload?.message || response.statusText || 'request failed';
      throw new Error(`Runway request failed (${response.status}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }
    return payload;
  }

  async download(url, destination) {
    const response = await this.fetch(url);
    if (!response.ok) throw new Error(`Runway audiovisual download failed (${response.status})`);
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  }
}

function buildAudiovisualPrompt({
  segment,
  productionScript,
  character,
  dialogueTrack,
  regeneration,
  previousAsset,
}) {
  const location = productionScript.locations.find((item) => item.id === segment.locationId);
  return [
    'Create a single continuous photorealistic vertical short-form video act with synchronized audiovisual output.',
    `ACT PURPOSE: ${segment.purpose}.`,
    character ? `CHARACTER: ${character.name}. ${character.description}. Physical traits: ${character.physicalTraits}. Exact wardrobe: ${character.wardrobe}.` : '',
    location ? `LOCATION: ${location.name}. ${location.description}. Lighting: ${location.lighting}. Fixed elements: ${location.fixedElements.join(', ')}.` : '',
    `ACTION: ${segment.action}.`,
    `CAMERA: ${segment.camera}.`,
    `EXACT SPOKEN DIALOGUE: "${segment.dialogue}"`,
    dialogueTrack
      ? 'The supplied audio reference contains the exact spoken dialogue performance. Preserve those words verbatim and synchronize the visible speaker naturally to that performance.'
      : 'Generate natural synchronized speech using the exact dialogue above. Do not paraphrase, omit, summarize, or add words.',
    `AMBIENCE: ${segment.ambience}.`,
    segment.soundEffects.length ? `SOUND EFFECTS: ${segment.soundEffects.join('; ')}.` : '',
    segment.music ? `MUSIC: ${segment.music}. Keep it below dialogue.` : '',
    `GLOBAL VISUAL STYLE: ${productionScript.visualStyle.description}. ${productionScript.visualStyle.cameraRules}. ${productionScript.visualStyle.lightingRules}.`,
    `AUDIO MIX: ${productionScript.audioDirection.mix}. ${productionScript.audioDirection.musicPolicy}.`,
    previousAsset ? 'Maintain continuity with the previous accepted act: same identity, wardrobe, environment and visual language.' : '',
    regeneration?.guidance ? `QC CORRECTION: ${regeneration.guidance}` : '',
    'No on-screen text, captions, logos, watermarks, CGI look, anatomy errors, face morphing, flicker, or unexplained cuts.',
  ].filter(Boolean).join(' ');
}

function collectImageReferences(segment, storyBible, previousAsset) {
  const refs = [];
  for (const characterId of segment.characterIds || []) {
    for (const image of storyBible?.references?.characters?.[characterId]?.images || []) {
      if (image.url) refs.push({ uri: image.url });
    }
  }
  const location = storyBible?.references?.locations?.[segment.locationId];
  if (location?.url) refs.push({ uri: location.url });
  if (previousAsset?.referenceImageUrl) refs.push({ uri: previousAsset.referenceImageUrl });
  return uniqueByUri(refs).slice(0, 10);
}

function uniqueByUri(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item.uri || seen.has(item.uri)) return false;
    seen.add(item.uri);
    return true;
  });
}

function firstOutputUrl(task) {
  if (Array.isArray(task?.output)) {
    const first = task.output[0];
    if (typeof first === 'string') return first;
    return first?.url || null;
  }
  return task?.output?.url || null;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function fileExists(file) {
  try { await stat(file); return true; } catch { return false; }
}
