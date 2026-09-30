import crypto from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://agents.lumalabs.ai/v1';

export class LumaAgentsVideoProvider {
  constructor({
    apiKey = process.env.LUMA_AGENTS_API_KEY,
    baseUrl = process.env.LUMA_AGENTS_BASE_URL || DEFAULT_BASE_URL,
    videoModel = process.env.LUMA_AGENTS_VIDEO_MODEL || 'ray-3.2',
    imageModel = process.env.LUMA_AGENTS_IMAGE_MODEL || 'uni-1',
    resolution = process.env.LUMA_AGENTS_VIDEO_RESOLUTION || '720p',
    duration = process.env.LUMA_AGENTS_VIDEO_DURATION || '5s',
    assetDir = process.env.ASSET_DIR || './outputs/assets',
    pollIntervalMs = Number(process.env.LUMA_AGENTS_POLL_INTERVAL_MS || 2500),
    maxPolls = Number(process.env.LUMA_AGENTS_MAX_POLLS || 120),
    fetchImpl = globalThis.fetch,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    if (!apiKey) throw new Error('LUMA_AGENTS_API_KEY is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.videoModel = videoModel;
    this.imageModel = imageModel;
    this.resolution = resolution;
    this.duration = duration;
    this.assetDir = assetDir;
    this.pollIntervalMs = pollIntervalMs;
    this.maxPolls = maxPolls;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.id = `luma-${videoModel}`;
    this.profile = {
      id: this.id,
      vendor: 'luma',
      model: videoModel,
      estimatedCostUsd5s: resolution === '1080p' ? 1.2 : resolution === '540p' ? 0.15 : 0.3,
      strengths: {
        human: 0.91,
        action: 0.95,
        environment: 0.95,
        object: 0.90,
        general: 0.93,
        continuity: 0.94,
        temporal: 0.94,
      },
    };
  }

  estimateCostUsd() {
    if (this.duration === '10s') {
      if (this.resolution === '1080p') return 3.6;
      if (this.resolution === '540p') return 0.45;
      return 0.9;
    }
    return this.profile.estimatedCostUsd5s;
  }

  async prepareStoryBible(storyBible, { projectId } = {}) {
    if (!storyBible) return storyBible;
    const prepared = structuredClone(storyBible);
    prepared.references = {
      provider: this.id,
      projectId,
      characters: {},
      locations: {},
    };

    for (const character of prepared.characters || []) {
      const images = [];
      for (const [index, view] of ['portrait', 'three-quarter'].entries()) {
        const image = await this.createImage({
          prompt: characterPrompt(character, prepared.visualStyle, view),
        });
        images.push({ generationId: image.id, url: image.url, view });
      }
      prepared.references.characters[character.id] = { images };
    }

    for (const location of prepared.locations || []) {
      const image = await this.createImage({
        prompt: locationPrompt(location, prepared.visualStyle),
      });
      prepared.references.locations[location.id] = {
        generationId: image.id,
        url: image.url,
      };
    }

    prepared.referenceStatus = 'ready';
    return prepared;
  }

  async prepareSceneReference(scene, { storyBible = null, previousAsset = null, regeneration = null } = {}) {
    const refs = collectSceneReferences(scene, storyBible, previousAsset);
    const prompt = [
      scene.realism?.referencePrompt || scene.visualPrompt || scene.narration,
      continuityPrompt(scene, storyBible),
      regeneration?.guidance ? `Correct prior QC defects: ${regeneration.guidance}` : '',
      'Preserve the recurring subject identities, wardrobe, environment geometry and lighting from all references.',
      'Photorealistic real-camera frame. No text, watermark, logo, CGI look or stylization.',
    ].filter(Boolean).join(' ');

    const image = await this.createImage({ prompt, refs });
    return {
      id: image.id,
      url: image.url,
      prompt,
      providerId: this.id,
    };
  }

  async animateReference(scene, reference, { regeneration = null } = {}) {
    const prompt = [
      scene.realism?.motionPrompt || scene.narration,
      regeneration?.guidance ? `Correct prior QC defects: ${regeneration.guidance}` : '',
      'Maintain exact subject identity, clothing, environment geometry, lighting and camera language from the first frame.',
      'Natural physically plausible motion. No morphing, flicker, teleportation or unexplained cuts.',
    ].filter(Boolean).join(' ');

    const generation = await this.createGeneration({
      model: this.videoModel,
      type: 'video',
      prompt,
      aspect_ratio: '9:16',
      video: {
        resolution: this.resolution,
        duration: this.duration,
        start_frame: { url: reference.url },
      },
    });

    const completed = await this.wait(generation.id);
    const output = completed.output?.find((item) => item.type === 'video') || completed.output?.[0];
    if (!output?.url) throw new Error('Luma Agents completed without a video URL');

    await mkdir(this.assetDir, { recursive: true });
    const localPath = path.join(this.assetDir, `luma-agents-${generation.id}-${fingerprint(output.url)}.mp4`);
    if (!(await fileExists(localPath))) await this.download(output.url, localPath);

    return {
      provider: 'luma-agents',
      providerModelId: this.id,
      type: 'ai-video',
      model: this.videoModel,
      localPath,
      sourceUrl: output.url,
      generationId: generation.id,
      referenceGenerationId: reference.id,
      referenceImageUrl: reference.url,
      prompt,
      generatedDuration: this.duration,
      aspectRatio: '9:16',
    };
  }

  async resolveScene(scene, context = {}) {
    const reference = await this.prepareSceneReference(scene, context);
    return this.animateReference(scene, reference, context);
  }

  async createImage({ prompt, refs = [] }) {
    const generation = await this.createGeneration({
      model: this.imageModel,
      type: 'image',
      prompt,
      aspect_ratio: '9:16',
      ...(refs.length ? { image_ref: refs.slice(0, 9).map((url) => ({ url })) } : {}),
    });
    const completed = await this.wait(generation.id);
    const output = completed.output?.find((item) => item.type === 'image') || completed.output?.[0];
    if (!output?.url) throw new Error('Luma Agents completed without an image URL');
    return { id: generation.id, url: output.url };
  }

  async createGeneration(body) {
    return this.request('/generations', { method: 'POST', body });
  }

  async wait(id) {
    for (let attempt = 0; attempt < this.maxPolls; attempt += 1) {
      const generation = await this.request(`/generations/${encodeURIComponent(id)}`);
      if (generation.state === 'completed') return generation;
      if (generation.state === 'failed') {
        throw new Error(`Luma Agents generation failed: ${generation.failure_reason || generation.failure_code || 'unknown'}`);
      }
      if (attempt < this.maxPolls - 1) await this.sleep(this.pollIntervalMs);
    }
    throw new Error(`Luma Agents generation timed out after ${this.maxPolls} polls`);
  }

  async request(endpoint, { method = 'GET', body = null } = {}) {
    const response = await this.fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`Luma Agents request failed (${response.status}): ${payload?.detail || payload?.message || response.statusText || 'request failed'}`);
    }
    return payload;
  }

  async download(url, destination) {
    const response = await this.fetch(url);
    if (!response.ok) throw new Error(`Luma Agents asset download failed (${response.status})`);
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  }
}

function collectSceneReferences(scene, bible, previousAsset) {
  const refs = [];
  for (const characterId of scene.continuity?.characterIds || []) {
    for (const image of bible?.references?.characters?.[characterId]?.images || []) {
      if (image.url) refs.push(image.url);
    }
  }
  const location = bible?.references?.locations?.[scene.continuity?.locationId];
  if (location?.url) refs.push(location.url);
  if (previousAsset?.referenceImageUrl) refs.push(previousAsset.referenceImageUrl);
  return [...new Set(refs)].slice(0, 9);
}

function continuityPrompt(scene, bible) {
  const chars = (bible?.characters || []).filter((item) => scene.continuity?.characterIds?.includes(item.id));
  const location = (bible?.locations || []).find((item) => item.id === scene.continuity?.locationId);
  return [
    ...chars.map((item) => `${item.name}: ${item.description}. ${item.physicalTraits}. Exact wardrobe: ${item.wardrobe}.`),
    location ? `${location.name}: ${location.description}. Fixed elements: ${(location.fixedElements || []).join(', ')}. Lighting: ${location.lighting}.` : '',
    bible?.visualStyle?.cameraRules || '',
    bible?.visualStyle?.lightingRules || '',
  ].filter(Boolean).join(' ');
}

function characterPrompt(character, style, view) {
  return [
    `Photorealistic canonical ${view} identity reference for a recurring video character.`,
    `${character.name}: ${character.description}.`,
    character.physicalTraits,
    `Exact wardrobe: ${character.wardrobe}.`,
    style?.description,
    style?.lightingRules,
    'Neutral pose, clear face and proportions, no text, logos or stylization.',
  ].filter(Boolean).join(' ');
}

function locationPrompt(location, style) {
  return [
    'Photorealistic canonical establishing reference for a recurring real-world location.',
    `${location.name}: ${location.description}.`,
    `Lighting: ${location.lighting}.`,
    `Fixed elements: ${(location.fixedElements || []).join(', ')}.`,
    style?.description,
    style?.cameraRules,
    'Stable realistic geometry and materials. No people, text, logos or stylization.',
  ].filter(Boolean).join(' ');
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

async function fileExists(file) {
  try { await stat(file); return true; } catch { return false; }
}
