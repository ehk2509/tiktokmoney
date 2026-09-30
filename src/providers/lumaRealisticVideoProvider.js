import crypto from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://api.lumalabs.ai/dream-machine/v1';

export class LumaRealisticVideoProvider {
  constructor({
    apiKey = process.env.LUMA_API_KEY,
    baseUrl = process.env.LUMA_BASE_URL || DEFAULT_BASE_URL,
    videoModel = process.env.LUMA_VIDEO_MODEL || 'ray-2',
    imageModel = process.env.LUMA_IMAGE_MODEL || 'photon-flash-1',
    resolution = process.env.LUMA_VIDEO_RESOLUTION || '720p',
    generationDuration = process.env.LUMA_VIDEO_DURATION || '5s',
    assetDir = process.env.ASSET_DIR || './outputs/assets',
    pollIntervalMs = Number(process.env.LUMA_POLL_INTERVAL_MS || 3000),
    maxPolls = Number(process.env.LUMA_MAX_POLLS || 120),
    continuityWeight = Number(process.env.LUMA_CONTINUITY_WEIGHT || 0.72),
    fetchImpl = globalThis.fetch,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    if (!apiKey) throw new Error('LUMA_API_KEY is required for Luma realistic video');
    if (!fetchImpl) throw new Error('fetch is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.videoModel = videoModel;
    this.imageModel = imageModel;
    this.resolution = resolution;
    this.generationDuration = generationDuration;
    this.assetDir = assetDir;
    this.pollIntervalMs = pollIntervalMs;
    this.maxPolls = maxPolls;
    this.continuityWeight = continuityWeight;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
  }

  async resolveScene(scene, { projectId, previousAsset = null } = {}) {
    const realism = scene.realism;
    if (!realism?.referencePrompt || !realism?.motionPrompt) {
      throw new Error('scene is missing realism prompts');
    }

    const reference = await this.createReferenceImage({
      prompt: realism.referencePrompt,
      previousReferenceUrl: previousAsset?.referenceImageUrl || null,
    });

    const video = await this.createVideo({
      prompt: realism.motionPrompt,
      referenceImageUrl: reference.url,
    });

    await mkdir(this.assetDir, { recursive: true });
    const localPath = path.join(
      this.assetDir,
      `luma-${projectId || 'project'}-${scene.index}-${fingerprint(video.url)}.mp4`,
    );

    if (!(await fileExists(localPath))) {
      await this.download(video.url, localPath);
    }

    return {
      provider: 'luma',
      type: 'ai-video',
      localPath,
      sourceUrl: video.url,
      generationId: video.id,
      referenceGenerationId: reference.id,
      referenceImageUrl: reference.url,
      model: this.videoModel,
      imageModel: this.imageModel,
      resolution: this.resolution,
      generatedDuration: this.generationDuration,
      aspectRatio: '9:16',
      prompt: realism.motionPrompt,
      referencePrompt: realism.referencePrompt,
      continuityFrom: previousAsset?.referenceGenerationId || null,
      continuityReferenceUrl: previousAsset?.referenceImageUrl || null,
      projectId,
    };
  }

  async createReferenceImage({ prompt, previousReferenceUrl = null }) {
    const body = {
      prompt,
      aspect_ratio: '9:16',
      model: this.imageModel,
    };

    if (previousReferenceUrl) {
      body.image_ref = [{
        url: previousReferenceUrl,
        weight: this.continuityWeight,
      }];
    }

    const generation = await this.request('/generations/image', {
      method: 'POST',
      body,
    });
    const completed = await this.waitForGeneration(generation.id);
    const url = completed?.assets?.image;
    if (!url) throw new Error('Luma completed image generation without an image asset');

    return { id: completed.id, url };
  }

  async createVideo({ prompt, referenceImageUrl }) {
    const body = {
      model: this.videoModel,
      prompt,
      aspect_ratio: '9:16',
      resolution: this.resolution,
      duration: this.generationDuration,
      loop: false,
      keyframes: {
        frame0: {
          type: 'image',
          url: referenceImageUrl,
        },
      },
    };

    const generation = await this.request('/generations/video', {
      method: 'POST',
      body,
    });
    const completed = await this.waitForGeneration(generation.id);
    const url = completed?.assets?.video;
    if (!url) throw new Error('Luma completed video generation without a video asset');

    return { id: completed.id, url };
  }

  async waitForGeneration(id) {
    if (!id) throw new Error('Luma generation did not return an id');

    for (let attempt = 0; attempt < this.maxPolls; attempt += 1) {
      const generation = await this.request(`/generations/${encodeURIComponent(id)}`);
      if (generation.state === 'completed') return generation;
      if (generation.state === 'failed') {
        throw new Error(`Luma generation failed: ${generation.failure_reason || 'unknown reason'}`);
      }
      if (attempt < this.maxPolls - 1) await this.sleep(this.pollIntervalMs);
    }

    throw new Error(`Luma generation timed out after ${this.maxPolls} polls`);
  }

  async download(url, destination) {
    const response = await this.fetch(url);
    if (!response.ok) {
      throw new Error(`Luma asset download failed (${response.status})`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(destination, bytes);
  }

  async request(endpoint, { method = 'GET', body = null } = {}) {
    const response = await this.fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Luma returned a non-JSON response');
    }

    if (!response.ok) {
      const detail = payload?.detail || payload?.message || response.statusText || 'request failed';
      throw new Error(`Luma request failed (${response.status}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }

    return payload;
  }
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

async function fileExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
