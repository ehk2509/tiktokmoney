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
    continuityWeight = Number(process.env.LUMA_CONTINUITY_WEIGHT || 0.62),
    locationReferenceWeight = Number(process.env.LUMA_LOCATION_REFERENCE_WEIGHT || 0.82),
    characterReferenceCount = Number(process.env.LUMA_CHARACTER_REFERENCE_COUNT || 2),
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
    this.locationReferenceWeight = locationReferenceWeight;
    this.characterReferenceCount = Math.max(1, Math.min(4, Number(characterReferenceCount) || 2));
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
  }

  async prepareStoryBible(storyBible, { projectId } = {}) {
    if (!storyBible) return null;

    const prepared = structuredClone(storyBible);
    prepared.references = {
      provider: 'luma',
      projectId,
      characters: {},
      locations: {},
    };

    for (const character of prepared.characters || []) {
      const images = [];
      for (let index = 0; index < this.characterReferenceCount; index += 1) {
        const reference = await this.createReferenceImage({
          prompt: buildCharacterReferencePrompt(character, prepared.visualStyle, index),
        });
        images.push({
          generationId: reference.id,
          url: reference.url,
          view: index === 0 ? 'portrait' : 'three-quarter',
        });
      }

      prepared.references.characters[character.id] = {
        images,
      };
    }

    for (const location of prepared.locations || []) {
      const reference = await this.createReferenceImage({
        prompt: buildLocationReferencePrompt(location, prepared.visualStyle),
      });

      prepared.references.locations[location.id] = {
        generationId: reference.id,
        url: reference.url,
      };
    }

    prepared.referenceStatus = 'ready';
    return prepared;
  }

  async resolveScene(scene, {
    projectId,
    previousAsset = null,
    regeneration = null,
    storyBible = null,
  } = {}) {
    const realism = scene.realism;
    if (!realism?.referencePrompt || !realism?.motionPrompt) {
      throw new Error('scene is missing realism prompts');
    }

    const continuityContext = buildContinuityContext(scene, storyBible);
    const referencePrompt = applyRegenerationGuidance(
      enrichScenePrompt(realism.referencePrompt, continuityContext),
      regeneration,
    );
    const motionPrompt = applyRegenerationGuidance(
      enrichScenePrompt(realism.motionPrompt, continuityContext),
      regeneration,
    );

    const imageRefs = buildImageReferences({
      scene,
      storyBible,
      previousAsset,
      locationReferenceWeight: this.locationReferenceWeight,
      continuityWeight: this.continuityWeight,
    });
    const characterRef = buildCharacterReferences(scene, storyBible);

    const reference = await this.createReferenceImage({
      prompt: referencePrompt,
      imageRefs,
      characterRef,
    });

    const video = await this.createVideo({
      prompt: motionPrompt,
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
      prompt: motionPrompt,
      referencePrompt,
      regenerationAttempt: regeneration?.attempt || 0,
      qcFeedbackApplied: regeneration?.guidance || null,
      continuityFrom: previousAsset?.referenceGenerationId || null,
      continuityReferenceUrl: previousAsset?.referenceImageUrl || null,
      bibleBinding: scene.continuity || null,
      canonicalCharacterRefs: Object.keys(characterRef || {}).length,
      canonicalImageRefs: imageRefs.length,
      projectId,
    };
  }

  async createReferenceImage({
    prompt,
    imageRefs = [],
    characterRef = null,
  }) {
    const body = {
      prompt,
      aspect_ratio: '9:16',
      model: this.imageModel,
    };

    if (imageRefs.length) {
      body.image_ref = imageRefs.slice(0, 4);
    }

    if (characterRef && Object.keys(characterRef).length) {
      body.character_ref = characterRef;
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

function buildContinuityContext(scene, storyBible) {
  if (!storyBible) return '';

  const binding = scene.continuity || {};
  const characters = (storyBible.characters || [])
    .filter((character) => (binding.characterIds || []).includes(character.id));
  const location = (storyBible.locations || [])
    .find((item) => item.id === binding.locationId);
  const style = storyBible.visualStyle || {};

  return [
    style.description ? `Global visual style: ${style.description}` : '',
    style.cameraRules ? `Camera continuity: ${style.cameraRules}` : '',
    style.lightingRules ? `Lighting continuity: ${style.lightingRules}` : '',
    ...characters.map((character) => [
      `Recurring character ${character.name}: ${character.description}`,
      character.physicalTraits ? `Physical traits: ${character.physicalTraits}` : '',
      character.wardrobe ? `Wardrobe must remain unchanged: ${character.wardrobe}` : '',
    ].filter(Boolean).join('. ')),
    location
      ? [
        `Recurring location ${location.name}: ${location.description}`,
        location.lighting ? `Location lighting: ${location.lighting}` : '',
        location.fixedElements?.length
          ? `Fixed elements that must remain stable: ${location.fixedElements.join(', ')}`
          : '',
      ].filter(Boolean).join('. ')
      : '',
    'Match the canonical references exactly where provided.',
  ].filter(Boolean).join(' ');
}

function enrichScenePrompt(prompt, continuityContext) {
  return continuityContext ? `${prompt} ${continuityContext}` : prompt;
}

function buildImageReferences({
  scene,
  storyBible,
  previousAsset,
  locationReferenceWeight,
  continuityWeight,
}) {
  const refs = [];
  const locationId = scene.continuity?.locationId;
  const location = storyBible?.references?.locations?.[locationId];

  if (location?.url) {
    refs.push({
      url: location.url,
      weight: locationReferenceWeight,
    });
  }

  if (previousAsset?.referenceImageUrl) {
    refs.push({
      url: previousAsset.referenceImageUrl,
      weight: continuityWeight,
    });
  }

  return refs.slice(0, 4);
}

function buildCharacterReferences(scene, storyBible) {
  const ids = scene.continuity?.characterIds || [];
  if (!ids.length) return null;

  const characterRef = {};
  ids.slice(0, 2).forEach((characterId, index) => {
    const entry = storyBible?.references?.characters?.[characterId];
    const images = entry?.images?.map((image) => image.url).filter(Boolean).slice(0, 4) || [];
    if (images.length) {
      characterRef[`identity${index}`] = { images };
    }
  });

  return Object.keys(characterRef).length ? characterRef : null;
}

function buildCharacterReferencePrompt(character, visualStyle, index) {
  const framing = index === 0
    ? 'clean documentary portrait, chest-up, neutral expression, eye-level camera'
    : 'three-quarter full-body documentary reference, neutral standing pose, eye-level camera';

  return [
    'Photorealistic canonical character reference for continuity across multiple video scenes.',
    framing + '.',
    `Character: ${character.name}. ${character.description}`,
    character.physicalTraits ? `Physical traits: ${character.physicalTraits}` : '',
    character.wardrobe ? `Exact recurring wardrobe: ${character.wardrobe}` : '',
    visualStyle?.description ? `Visual style: ${visualStyle.description}` : '',
    visualStyle?.lightingRules ? `Lighting: ${visualStyle.lightingRules}` : '',
    'Plain believable environment, no text, no watermark, no logo, no stylization.',
    'Identity, age, facial geometry, hair, skin texture, body proportions and wardrobe must be clear and realistic.',
  ].filter(Boolean).join(' ');
}

function buildLocationReferencePrompt(location, visualStyle) {
  return [
    'Photorealistic canonical location reference for continuity across multiple video scenes.',
    `Location: ${location.name}. ${location.description}`,
    location.lighting ? `Exact recurring lighting: ${location.lighting}` : '',
    location.fixedElements?.length
      ? `Fixed architectural/object anchors: ${location.fixedElements.join(', ')}`
      : '',
    visualStyle?.description ? `Visual style: ${visualStyle.description}` : '',
    visualStyle?.cameraRules ? `Camera language: ${visualStyle.cameraRules}` : '',
    'Wide clean establishing frame. Real-world geometry and materials. No people unless unavoidable.',
    'No text, logos, watermark, CGI look or impossible architecture.',
  ].filter(Boolean).join(' ');
}

function applyRegenerationGuidance(prompt, regeneration) {
  const guidance = regeneration?.guidance?.trim();
  if (!guidance) return prompt;

  return [
    prompt,
    'This is a regeneration after strict visual QC rejected a previous attempt.',
    `Correct the observed defects: ${guidance}`,
    'Do not introduce new subjects, locations, text, logos or camera cuts.',
    'Preserve the canonical character, location and style references exactly.',
    'Preserve the intended scene while making the result look like authentic camera footage.',
  ].join(' ');
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
