// Saved rooms for videos that film one location from several camera angles. Each location gets
// one checked master image and one saved image per angle; people are composited over those
// images and pasted back onto them after animation, so the room is never redrawn.
import crypto from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const LOCATION_ANGLES = Object.freeze({
  front: '<sks> front view eye-level shot medium shot',
  '45left': '<sks> front-left quarter view eye-level shot medium shot',
});
// Wider moves invented furniture in testing, so only these two views are used.
const ANGLE_ROTATION = ['front', '45left'];
const PLATE_WIDTH = 704;
const PLATE_HEIGHT = 1280;
const MASTER_SIZE = { width: 1088, height: 1920 };

const DEFAULT_MODELS = {
  unet: 'qwen_image_edit_2511_fp8mixed.safetensors',
  lightning: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors',
  angles: 'qwen-image-edit-2511-multiple-angles-lora.safetensors',
  clip: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
  vae: 'qwen_image_vae.safetensors',
  matte: 'birefnet.safetensors',
};

// Doors are deliberately not named: mentioning one made the model frame shots through a doorway.
const MASTER_FOOTER = [
  'The camera stands well inside the place, in the open middle of the space, facing the far side. The walls, ground and furniture run all the way to every edge of the picture and nothing is close to the camera.',
  'Soft flat natural daylight, natural muted colors, slightly uneven white balance, mild phone camera noise, natural lens distortion, realistic soft shadows, ordinary unstaged place with small signs of everyday use.',
  'Not a magazine photo, not staged, not cinematic, no golden hour, no sun beams, no glossy surfaces, no people, no hands, no phone, no text, no watermark. Not a render.',
].join(' ');

export class LocationApprovalRequiredError extends Error {
  constructor(projectId, locationId, candidates) {
    const list = candidates.map((c) => `${c.number}: ${c.file}`).join('\n');
    super(`Location "${locationId}" needs your approval. Candidates:\n${list}\n` +
      `Approve one with: npm run approve-location -- --id ${projectId} --location ${locationId} --candidate <number>, then run resume.`);
    this.name = 'LocationApprovalRequiredError';
  }
}

// Locations filmed in at least two scenes with different shots get alternating camera angles.
// Returns Map(segment index -> { locationId, angle }); every other segment is left out.
export function planLocationAngles(productionScript) {
  const byLocation = new Map();
  for (const segment of productionScript?.segments || []) {
    if (!segment.locationId) continue;
    if (!byLocation.has(segment.locationId)) byLocation.set(segment.locationId, []);
    byLocation.get(segment.locationId).push(segment);
  }
  const plan = new Map();
  for (const [locationId, segments] of byLocation) {
    const shots = new Set(segments.map((s) => String(s.shotType || s.camera || '').trim().toLowerCase()).filter(Boolean));
    if (segments.length < 2 || shots.size < 2) continue;
    segments.forEach((segment, order) => {
      plan.set(segment.index, { locationId, angle: ANGLE_ROTATION[order % ANGLE_ROTATION.length] });
    });
  }
  return plan;
}

// In a conversation each person keeps one camera angle, so cuts read as shot and reverse shot.
export function conversationAngle(speakerIndex) {
  return ANGLE_ROTATION[speakerIndex % ANGLE_ROTATION.length];
}

export function buildLocationMasterPrompt(location) {
  const items = (location.fixedElements || []).filter(Boolean).join(', ');
  return [
    `One single ordinary vertical photo taken on a smartphone at this real place: ${[location.name, location.description].filter(Boolean).join('. ')}.`,
    items ? `Clearly visible: ${items}.` : '',
    location.lighting ? `Light: ${location.lighting}.` : '',
    MASTER_FOOTER,
  ].filter(Boolean).join(' ');
}

function qwenBase(models, { angles = false } = {}) {
  const w = {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: models.unet, weight_dtype: 'default' } },
    light: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['unet', 0], lora_name: models.lightning, strength_model: 1 } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: models.clip, type: 'qwen_image', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
    latent: { class_type: 'EmptySD3LatentImage', inputs: { width: PLATE_WIDTH, height: PLATE_HEIGHT, batch_size: 1 } },
  };
  if (angles) w.angle = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['light', 0], lora_name: models.angles, strength_model: 0.9 } };
  w.shift = { class_type: 'ModelSamplingAuraFlow', inputs: { model: [angles ? 'angle' : 'light', 0], shift: 3.1 } };
  w.norm = { class_type: 'CFGNorm', inputs: { model: ['shift', 0], strength: 1 } };
  return w;
}

function qwenSample(w, { images, prompt, seed }) {
  const refs = {};
  images.forEach((image, i) => {
    w['img' + i] = { class_type: 'LoadImage', inputs: { image } };
    refs['image' + (i + 1)] = ['img' + i, 0];
  });
  w.pos = { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['clip', 0], vae: ['vae', 0], prompt, ...refs } };
  w.neg = { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['clip', 0], vae: ['vae', 0], prompt: '', ...refs } };
  w.sample = { class_type: 'KSampler', inputs: { seed, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['norm', 0], positive: ['pos', 0], negative: ['neg', 0], latent_image: ['latent', 0] } };
  w.decode = { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } };
  return w;
}

export function buildFrontPlateWorkflow({ master }) {
  return {
    img: { class_type: 'LoadImage', inputs: { image: master } },
    scale: { class_type: 'ImageScale', inputs: { image: ['img', 0], upscale_method: 'lanczos', width: PLATE_WIDTH, height: PLATE_HEIGHT, crop: 'center' } },
    save: { class_type: 'SaveImage', inputs: { images: ['scale', 0], filename_prefix: 'tiktokmoney/location-plate' } },
  };
}

export function buildAngleWorkflow({ master, angle, seed, models = DEFAULT_MODELS }) {
  const w = qwenSample(qwenBase(models, { angles: true }), { images: [master], prompt: LOCATION_ANGLES[angle], seed });
  w.save = { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'tiktokmoney/location-plate' } };
  return w;
}

export function buildPlacementWorkflow({ portrait, plate, seed, gaze = null, models = DEFAULT_MODELS }) {
  const looking = gaze
    ? `The person looks slightly to the ${gaze} of the camera, at someone standing just beside the camera, not into the lens`
    : 'The person looks straight at the viewer';
  const w = qwenSample(qwenBase(models), {
    images: [portrait, plate], seed,
    prompt: 'Place the person from image 1 in front of the place shown in image 2. Medium close-up filmed from about one and a half meters away: framed from the middle of the chest upward, with clear space around the head and shoulders and plenty of the place visible on both sides. The head takes up only about one fifth of the picture height. Hands are out of frame. ' + looking + ', relaxed, lips gently closed, about to speak. Keep the face, hair and clothing identical to image 1. Candid natural photo, natural skin, soft daylight on the face, not glossy. Single frame, no text.',
  });
  Object.assign(w, {
    bgmodel: { class_type: 'LoadBackgroundRemovalModel', inputs: { bg_removal_name: models.matte } },
    matte: { class_type: 'RemoveBackground', inputs: { bg_removal_model: ['bgmodel', 0], image: ['decode', 0] } },
    comp: { class_type: 'ImageCompositeMasked', inputs: { destination: ['img1', 0], source: ['decode', 0], x: 0, y: 0, resize_source: false, mask: ['matte', 0] } },
    maskimg: { class_type: 'MaskToImage', inputs: { mask: ['matte', 0] } },
    saveStart: { class_type: 'SaveImage', inputs: { images: ['comp', 0], filename_prefix: 'tiktokmoney/location-start' } },
    saveMask: { class_type: 'SaveImage', inputs: { images: ['maskimg', 0], filename_prefix: 'tiktokmoney/location-mask' } },
  });
  return w;
}

export function buildMatteVideoWorkflow({ video, fps = 25, models = DEFAULT_MODELS }) {
  return {
    video: { class_type: 'LoadVideo', inputs: { file: video } },
    frames: { class_type: 'GetVideoComponents', inputs: { video: ['video', 0] } },
    bgmodel: { class_type: 'LoadBackgroundRemovalModel', inputs: { bg_removal_name: models.matte } },
    matte: { class_type: 'RemoveBackground', inputs: { bg_removal_model: ['bgmodel', 0], image: ['frames', 0] } },
    maskimg: { class_type: 'MaskToImage', inputs: { mask: ['matte', 0] } },
    create: { class_type: 'CreateVideo', inputs: { images: ['maskimg', 0], fps } },
    save: { class_type: 'SaveVideo', inputs: { video: ['create', 0], filename_prefix: 'tiktokmoney/location-matte', format: 'auto', codec: 'auto' } },
  };
}

export function listMasterProblems(report) {
  const problems = [];
  if (report.person_or_hand_visible) problems.push('person or hand visible');
  if (report.frame_intruding_at_edge) problems.push('door or window frame at the edge');
  if (report.object_blocking_foreground) problems.push('object blocking the foreground');
  if (report.text_or_watermark_visible) problems.push('text or watermark');
  if (report.duplicated_main_object) problems.push('main object duplicated');
  if (report.unnatural_animal_or_object) problems.push('unnatural animal or object');
  if (report.looks_like_real_photo === false) problems.push('does not look like a real photo');
  for (const item of report.required_items_missing || []) problems.push('missing: ' + item);
  return problems;
}

export async function approveLocationCandidate({ dir, projectId, locationId, candidate }) {
  const file = statePath(dir, projectId, locationId);
  const state = JSON.parse(await readFile(file, 'utf8'));
  const chosen = (state.candidates || []).find((c) => c.number === Number(candidate));
  if (!chosen) throw new Error(`Candidate ${candidate} not found for location ${locationId}`);
  await writeFile(file, JSON.stringify({ ...state, master: chosen.image, approved: true }, null, 2));
  return chosen;
}

function statePath(dir, projectId, locationId) {
  return path.join(dir, safe(projectId), safe(locationId) + '.json');
}

function safe(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

export class LocalLocationSet {
  constructor({
    comfy,
    dir = process.env.COMFYUI_LOCATION_DIR || './data/locations',
    visionBaseUrl = process.env.LOCAL_VISION_BASE_URL || process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434/v1',
    visionModel = process.env.LOCAL_VISION_MODEL,
    candidates = Number(process.env.COMFYUI_LOCATION_CANDIDATES || 4),
    maxRounds = Number(process.env.COMFYUI_LOCATION_MAX_ROUNDS || 2),
    requireApproval = process.env.COMFYUI_LOCATION_REQUIRE_APPROVAL === 'true',
    models = DEFAULT_MODELS,
    fetchImpl = globalThis.fetch,
  }) {
    this.comfy = comfy;
    this.dir = dir;
    this.visionBaseUrl = String(visionBaseUrl).replace(/\/+$/, '');
    this.visionModel = visionModel;
    this.candidates = Math.max(1, candidates);
    this.maxRounds = Math.max(1, maxRounds);
    this.requireApproval = requireApproval;
    this.models = models;
    this.fetch = fetchImpl;
  }

  async readState(projectId, locationId) {
    try {
      return JSON.parse(await readFile(statePath(this.dir, projectId, locationId), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { views: {}, placements: {} };
    }
  }

  async saveState(projectId, locationId, state) {
    const file = statePath(this.dir, projectId, locationId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state, null, 2));
  }

  async inspectMaster(file, location) {
    if (!this.visionModel) throw new Error('LOCAL_VISION_MODEL is required to check location images');
    const required = (location.fixedElements || []).join(', ') || 'none listed';
    const prompt = [
      'You are checking a photo before it is approved as a video location. Answer only with JSON using exactly these keys:',
      '{"person_or_hand_visible":bool,"frame_intruding_at_edge":bool,"object_blocking_foreground":bool,"text_or_watermark_visible":bool,"duplicated_main_object":bool,"unnatural_animal_or_object":bool,"looks_like_real_photo":bool,"required_items_missing":[string],"problems":string}',
      `Required items: ${required}. Be strict and look carefully at all four edges of the image.`,
    ].join('\n');
    const bytes = await readFile(file);
    const response = await this.fetch(this.visionBaseUrl + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.visionModel, temperature: 0, response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + bytes.toString('base64') } },
        ] }],
      }),
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok) throw new Error('Location check failed (' + response.status + ')');
    return JSON.parse((await response.json()).choices[0].message.content);
  }

  async ensureMaster(projectId, location) {
    const state = await this.readState(projectId, location.id);
    if (state.master && (state.approved || !this.requireApproval)) return state;
    if (state.candidates?.length) throw new LocationApprovalRequiredError(projectId, location.id, state.candidates);

    const folder = path.dirname(statePath(this.dir, projectId, location.id));
    await mkdir(folder, { recursive: true });
    const prompt = buildLocationMasterPrompt(location);
    const passed = [];
    const rejected = [];
    let number = 0;
    search: for (let round = 0; round < this.maxRounds; round += 1) {
      for (let i = 0; i < this.candidates; i += 1) {
        number += 1;
        const image = await this.comfy.generateFirstFrame(prompt, '', MASTER_SIZE);
        const file = path.join(folder, `${safe(location.id)}-candidate-${number}.png`);
        await this.comfy.downloadInputFile(image, file);
        const problems = listMasterProblems(await this.inspectMaster(file, location));
        if (problems.length) {
          rejected.push({ number, file, problems });
          continue;
        }
        passed.push({ number, image, file });
        if (!this.requireApproval) break search;
      }
      if (passed.length) break;
    }
    state.rejected = rejected;
    if (!passed.length) {
      await this.saveState(projectId, location.id, state);
      throw new Error(`No master image for location "${location.id}" passed the check after ${number} tries: ` +
        rejected.map((r) => r.problems.join(', ')).join(' | '));
    }
    if (this.requireApproval) {
      state.candidates = passed;
      await this.saveState(projectId, location.id, state);
      throw new LocationApprovalRequiredError(projectId, location.id, passed);
    }
    state.master = passed[0].image;
    await this.saveState(projectId, location.id, state);
    return state;
  }

  async savedImage(workflow, prefix = 'location-plate') {
    const outputs = await this.comfy.runWorkflow(workflow);
    const media = Object.values(outputs).flatMap((o) => o.images || []).find((f) => f.filename.includes(prefix));
    if (!media) throw new Error('ComfyUI did not save ' + prefix);
    return this.comfy.importOutputImage(media);
  }

  async ensureView(projectId, location, angle) {
    const state = await this.ensureMaster(projectId, location);
    state.views ||= {};
    if (state.views[angle]) return state.views[angle];
    let image;
    if (angle === 'front') {
      image = await this.savedImage(buildFrontPlateWorkflow({ master: state.master }));
    } else {
      try {
        image = await this.savedImage(buildAngleWorkflow({ master: state.master, angle, seed: crypto.randomInt(1, 2147483647), models: this.models }));
      } catch (error) {
        // One saved view is better than losing the clip; both scenes then share the front angle.
        console.warn(`Camera angle ${angle} failed for location ${location.id}: ${error.message}`);
        image = await this.ensureView(projectId, location, 'front');
        const refreshed = await this.readState(projectId, location.id);
        refreshed.views[angle] = image;
        refreshed.angleFallbacks = { ...refreshed.angleFallbacks, [angle]: error.message };
        await this.saveState(projectId, location.id, refreshed);
        return image;
      }
    }
    state.views[angle] = image;
    await this.saveState(projectId, location.id, state);
    return image;
  }

  // Start frame for one person at one angle, reused by every scene that shares them.
  async placeCharacter({ projectId, location, angle, characterId, portrait, regeneration = null, gaze = null }) {
    const plate = await this.ensureView(projectId, location, angle);
    const state = await this.readState(projectId, location.id);
    state.placements ||= {};
    const key = [characterId, angle, gaze].filter(Boolean).join('::');
    if (state.placements[key] && !regeneration) return state.placements[key];
    const outputs = await this.comfy.runWorkflow(buildPlacementWorkflow({ portrait, plate, seed: crypto.randomInt(1, 2147483647), gaze, models: this.models }));
    const images = Object.values(outputs).flatMap((o) => o.images || []);
    const start = images.find((f) => f.filename.includes('location-start'));
    const mask = images.find((f) => f.filename.includes('location-mask'));
    if (!start || !mask) throw new Error('ComfyUI did not save the placed person and mask');
    state.placements[key] = { image: await this.comfy.importOutputImage(start), mask: await this.comfy.importOutputImage(mask), plate, angle };
    await this.saveState(projectId, location.id, state);
    return state.placements[key];
  }

  // Keeps only the animated person and puts the untouched saved room behind them.
  async lockRoom({ clipPath, placement, seconds, fps = 25 }) {
    const base = clipPath.replace(/\.mp4$/i, '');
    const matte = base + '-matte.mp4';
    const plate = base + '-plate.png';
    const mask = base + '-startmask.png';
    const locked = base + '-locked.mp4';
    const { comfy } = this;
    try {
      const video = await comfy.uploadImage(await readFile(clipPath), path.basename(clipPath));
      const outputs = await comfy.runWorkflow(buildMatteVideoWorkflow({ video, fps, models: this.models }));
      const media = Object.values(outputs).flatMap((o) => o.images || o.videos || []).find((f) => /location-matte.*\.(mp4|webm|mov)$/i.test(f.filename));
      if (!media) throw new Error('ComfyUI did not save the person matte');
      await comfy.downloadMedia(media, matte);
      await comfy.downloadInputFile(placement.plate, plate);
      await comfy.downloadInputFile(placement.mask, mask);
      const seconds_ = String(seconds);
      const fpsArg = String(fps);
      await comfy.runCommand('ffmpeg', ['-y', '-i', clipPath, '-i', matte,
        '-framerate', fpsArg, '-loop', '1', '-t', seconds_, '-i', plate,
        '-framerate', fpsArg, '-loop', '1', '-t', seconds_, '-i', mask,
        '-filter_complex', roomLockFilter(),
        '-map', '[v]', '-map', '0:a', '-t', seconds_, '-c:v', 'libx264', '-preset', 'medium', '-crf', '15', '-c:a', 'copy', locked]);
      return locked;
    } finally {
      for (const file of [matte, plate, mask]) await unlink(file).catch(() => {});
    }
  }
}

// The per-frame matte finds the moving person; the grown start mask stops a false match in the
// room from pulling redrawn pixels through.
export function roomLockFilter() {
  const dilate = Array(20).fill('dilation').join(',');
  return [
    "[1:v]format=gray,lut=y='clip((val-40)*255/175\\,0\\,255)'[m]",
    `[3:v]format=gray,scale=270:480,lut=y='if(gt(val\\,30)\\,255\\,0)',${dilate},gblur=sigma=3,scale=1080:1920[g]`,
    '[m][g]blend=all_mode=darken:shortest=1[a]',
    '[0:v]format=yuv420p[fg0]',
    '[fg0][a]alphamerge[fg]',
    '[2:v]scale=1080:1920:flags=lanczos,unsharp=5:5:0.45:5:5:0,format=yuv420p[bg]',
    '[bg][fg]overlay=shortest=1:format=auto,format=yuv420p[v]',
  ].join(';');
}
