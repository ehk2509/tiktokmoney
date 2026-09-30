import crypto from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://api.dev.runwayml.com/v1';

export class RunwayVideoProvider {
  constructor({
    apiKey = process.env.RUNWAYML_API_SECRET,
    baseUrl = process.env.RUNWAY_BASE_URL || DEFAULT_BASE_URL,
    model = 'gen4.5',
    imageModel = process.env.RUNWAY_IMAGE_MODEL || 'gen4_image',
    ratio = process.env.RUNWAY_VIDEO_RATIO || '720:1280',
    duration = Number(process.env.RUNWAY_VIDEO_DURATION || 5),
    assetDir = process.env.ASSET_DIR || './outputs/assets',
    pollIntervalMs = Number(process.env.RUNWAY_POLL_INTERVAL_MS || 2500),
    maxPolls = Number(process.env.RUNWAY_MAX_POLLS || 120),
    fetchImpl = globalThis.fetch,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    if (!apiKey) throw new Error('RUNWAYML_API_SECRET is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.imageModel = imageModel;
    this.ratio = ratio;
    this.duration = duration;
    this.assetDir = assetDir;
    this.pollIntervalMs = pollIntervalMs;
    this.maxPolls = maxPolls;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.id = `runway-${model}`;

    const turbo = model === 'gen4_turbo';
    this.profile = {
      id: this.id,
      vendor: 'runway',
      model,
      estimatedCostUsd5s: turbo ? 0.25 : 0.60,
      strengths: turbo ? {
        human: 0.86, action: 0.85, environment: 0.88, object: 0.87,
        general: 0.87, continuity: 0.84, temporal: 0.87,
      } : {
        human: 0.95, action: 0.94, environment: 0.93, object: 0.92,
        general: 0.94, continuity: 0.92, temporal: 0.96,
      },
    };
  }

  estimateCostUsd() {
    const creditsPerSecond = this.model === 'gen4_turbo' ? 5 : 12;
    return this.duration * creditsPerSecond * 0.01;
  }

  async prepareStoryBible(storyBible, { projectId } = {}) {
    if (!storyBible) return storyBible;
    const prepared = structuredClone(storyBible);
    prepared.references = { provider: this.id, projectId, characters: {}, locations: {} };

    for (const character of prepared.characters || []) {
      const images = [];
      for (const [index, view] of ['portrait', 'three-quarter'].entries()) {
        const image = await this.createImage(characterPrompt(character, prepared.visualStyle, view));
        images.push({ generationId: image.id, url: image.url, view });
      }
      prepared.references.characters[character.id] = { images };
    }

    for (const location of prepared.locations || []) {
      const image = await this.createImage(locationPrompt(location, prepared.visualStyle));
      prepared.references.locations[location.id] = { generationId: image.id, url: image.url };
    }

    prepared.referenceStatus = 'ready';
    return prepared;
  }

  async prepareSceneReference(scene, { storyBible = null, previousAsset = null, regeneration = null } = {}) {
    const references = buildReferenceImages(scene, storyBible, previousAsset);
    const prompt = [
      scene.realism?.referencePrompt || scene.visualPrompt || scene.narration,
      continuityPrompt(scene, storyBible, references),
      regeneration?.guidance ? `Correct prior QC defects: ${regeneration.guidance}` : '',
      'Create one photorealistic vertical first frame that looks captured by a real camera.',
      'Preserve referenced identities, wardrobe, environment geometry and lighting exactly.',
      'No text, logo, watermark, CGI look or stylization.',
    ].filter(Boolean).join(' ');

    const task = await this.createTask('/text_to_image', {
      model: this.imageModel,
      promptText: prompt,
      ratio: process.env.RUNWAY_IMAGE_RATIO || '720:1280',
      ...(references.length ? { referenceImages: references } : {}),
    });
    const completed = await this.wait(task.id);
    const url = completed.output?.[0];
    if (!url) throw new Error('Runway image task completed without output');
    return { id: task.id, url, prompt, providerId: this.id };
  }

  async animateReference(scene, reference, { regeneration = null } = {}) {
    const prompt = [
      scene.realism?.motionPrompt || scene.narration,
      regeneration?.guidance ? `Correct prior QC defects: ${regeneration.guidance}` : '',
      'Preserve exact first-frame identity and environment.',
      'Natural physically plausible motion, stable anatomy and geometry, smooth camera motion, no morphing or flicker.',
    ].filter(Boolean).join(' ');

    const task = await this.createTask('/image_to_video', {
      model: this.model,
      promptImage: reference.url,
      promptText: prompt,
      ratio: this.ratio,
      duration: this.duration,
    });
    const completed = await this.wait(task.id);
    const url = completed.output?.[0];
    if (!url) throw new Error('Runway video task completed without output');

    await mkdir(this.assetDir, { recursive: true });
    const localPath = path.join(this.assetDir, `runway-${this.model}-${task.id}-${fingerprint(url)}.mp4`);
    if (!(await fileExists(localPath))) await this.download(url, localPath);

    return {
      provider: 'runway',
      providerModelId: this.id,
      type: 'ai-video',
      model: this.model,
      localPath,
      sourceUrl: url,
      generationId: task.id,
      referenceGenerationId: reference.id,
      referenceImageUrl: reference.url,
      prompt,
      generatedDuration: `${this.duration}s`,
      aspectRatio: '9:16',
    };
  }

  async resolveScene(scene, context = {}) {
    const reference = await this.prepareSceneReference(scene, context);
    return this.animateReference(scene, reference, context);
  }

  async createImage(prompt) {
    const task = await this.createTask('/text_to_image', {
      model: this.imageModel,
      promptText: prompt,
      ratio: process.env.RUNWAY_IMAGE_RATIO || '720:1280',
    });
    const completed = await this.wait(task.id);
    const url = completed.output?.[0];
    if (!url) throw new Error('Runway image task completed without output');
    return { id: task.id, url };
  }

  async createTask(endpoint, body) {
    return this.request(endpoint, { method: 'POST', body });
  }

  async wait(id) {
    for (let attempt = 0; attempt < this.maxPolls; attempt += 1) {
      const task = await this.request(`/tasks/${encodeURIComponent(id)}`);
      if (task.status === 'SUCCEEDED') return task;
      if (task.status === 'FAILED' || task.status === 'CANCELED') {
        throw new Error(`Runway task ${task.status.toLowerCase()}: ${task.failure || task.failureCode || 'unknown'}`);
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

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`Runway request failed (${response.status}): ${payload?.error || payload?.message || response.statusText || 'request failed'}`);
    }
    return payload;
  }

  async download(url, destination) {
    const response = await this.fetch(url);
    if (!response.ok) throw new Error(`Runway asset download failed (${response.status})`);
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  }
}

function buildReferenceImages(scene, bible, previousAsset) {
  const refs = [];
  let index = 0;
  for (const characterId of scene.continuity?.characterIds || []) {
    for (const image of bible?.references?.characters?.[characterId]?.images || []) {
      if (image.url) refs.push({ uri: image.url, tag: `character${index++}` });
    }
  }
  const location = bible?.references?.locations?.[scene.continuity?.locationId];
  if (location?.url) refs.push({ uri: location.url, tag: 'location' });
  if (previousAsset?.referenceImageUrl) refs.push({ uri: previousAsset.referenceImageUrl, tag: 'previous' });
  return refs.slice(0, 6);
}

function continuityPrompt(scene, bible, refs) {
  const tags = refs.map((ref) => `@${ref.tag}`).join(', ');
  const chars = (bible?.characters || []).filter((item) => scene.continuity?.characterIds?.includes(item.id));
  const location = (bible?.locations || []).find((item) => item.id === scene.continuity?.locationId);
  return [
    tags ? `Use these references exactly: ${tags}.` : '',
    ...chars.map((item) => `${item.name}: ${item.description}; ${item.physicalTraits}; wardrobe ${item.wardrobe}.`),
    location ? `${location.name}: ${location.description}; fixed elements ${(location.fixedElements || []).join(', ')}; lighting ${location.lighting}.` : '',
    bible?.visualStyle?.cameraRules,
    bible?.visualStyle?.lightingRules,
  ].filter(Boolean).join(' ');
}

function characterPrompt(character, style, view) {
  return [
    `Photorealistic canonical ${view} reference of ${character.name}.`,
    character.description, character.physicalTraits, `Exact wardrobe: ${character.wardrobe}.`,
    style?.description, style?.lightingRules,
    'Real-camera portrait, neutral pose, no text, logo, watermark or stylization.',
  ].filter(Boolean).join(' ');
}

function locationPrompt(location, style) {
  return [
    `Photorealistic canonical location reference: ${location.name}.`,
    location.description, `Lighting: ${location.lighting}.`,
    `Fixed elements: ${(location.fixedElements || []).join(', ')}.`,
    style?.description, style?.cameraRules,
    'Real-camera establishing shot, stable geometry, no people, text, logo or watermark.',
  ].filter(Boolean).join(' ');
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

async function fileExists(file) {
  try { await stat(file); return true; } catch { return false; }
}
