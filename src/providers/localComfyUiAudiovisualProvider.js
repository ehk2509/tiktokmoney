import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { assertLocalEndpoint } from './localEndpoints.js';
import { DialogueAudioComposer } from '../services/dialogueAudioComposer.js';

// Accepts a ComfyUI workflow exported in API format. Add {{PROMPT}}, {{SEED}},
// {{FRAMES}} etc. as input values in that workflow; no node IDs are assumed.
export class LocalComfyUiAudiovisualProvider {
  constructor({
    baseUrl = process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188',
    workflowPath = process.env.COMFYUI_WORKFLOW_PATH,
    firstFrameWorkflowPath = process.env.COMFYUI_FIRST_FRAME_WORKFLOW_PATH,
    initialImagePath = process.env.COMFYUI_INITIAL_IMAGE_PATH,
    assetDir = process.env.ASSET_DIR || './data/assets',
    fps = Number(process.env.COMFYUI_FPS || 24),
    width = Number(process.env.COMFYUI_WIDTH || 720),
    height = Number(process.env.COMFYUI_HEIGHT || 1280),
    maxSegmentSeconds = Number(process.env.COMFYUI_MAX_SEGMENT_SECONDS || 15),
    pollIntervalMs = Number(process.env.COMFYUI_POLL_INTERVAL_MS || 2000),
    timeoutMs = Number(process.env.COMFYUI_TIMEOUT_MS || 900000),
    requireAudio = process.env.COMFYUI_REQUIRE_AUDIO !== 'false',
    localTts = null,
    dialogueComposer = null,
    fetchImpl = globalThis.fetch,
    runCommand = run,
  } = {}) {
    this.baseUrl = assertLocalEndpoint(baseUrl, 'COMFYUI_BASE_URL');
    if (!workflowPath) throw new Error('COMFYUI_WORKFLOW_PATH is required for local audiovisual generation');
    if (!fetchImpl) throw new Error('fetch is required');
    this.workflowPath = workflowPath;
    this.firstFrameWorkflowPath = firstFrameWorkflowPath;
    this.initialImagePath = initialImagePath;
    this.assetDir = assetDir;
    this.fps = positiveInteger(fps, 'COMFYUI_FPS');
    this.width = positiveInteger(width, 'COMFYUI_WIDTH');
    this.height = positiveInteger(height, 'COMFYUI_HEIGHT');
    this.maxSegmentSeconds = positiveInteger(maxSegmentSeconds, 'COMFYUI_MAX_SEGMENT_SECONDS');
    this.pollIntervalMs = positiveInteger(pollIntervalMs, 'COMFYUI_POLL_INTERVAL_MS');
    this.timeoutMs = positiveInteger(timeoutMs, 'COMFYUI_TIMEOUT_MS');
    this.requireAudio = requireAudio;
    this.localTts = localTts;
    this.dialogueComposer = dialogueComposer || new DialogueAudioComposer({ assetDir });
    this.fetch = fetchImpl;
    this.runCommand = runCommand;
  }

  async generateSegment({ segment, productionScript, storyBible = null,
    previousAsset = null, regeneration = null, projectId }) {
    const seconds = Number(segment?.durationSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > this.maxSegmentSeconds) {
      throw new Error('ComfyUI segment duration must be between 0 and ' +
        this.maxSegmentSeconds + 's (got ' + seconds + 's)');
    }
    const raw = JSON.parse(await readFile(this.workflowPath, 'utf8'));
    const template = raw.workflow || raw.prompt || raw;
    if (!hasPlaceholder(template, 'PROMPT')) {
      throw new Error('ComfyUI API workflow must contain a {{PROMPT}} placeholder in an input');
    }

    const prompt = buildLocalVideoPrompt({ segment, productionScript, storyBible, regeneration });
    const seed = crypto.randomInt(1, 2147483647);
    const frames = Math.max(9, Math.round((seconds * this.fps - 1) / 8) * 8 + 1);
    let firstFrame = '';
    if (hasPlaceholder(template, 'FIRST_FRAME')) {
      if (previousAsset?.localPath) {
        firstFrame = await this.uploadLastFrame(previousAsset.localPath, projectId);
      } else if (this.initialImagePath) {
        firstFrame = await this.uploadImage(
          await readFile(this.initialImagePath), path.basename(this.initialImagePath),
        );
      } else if (this.firstFrameWorkflowPath) {
        firstFrame = await this.generateFirstFrame(prompt);
      } else {
        throw new Error('Workflow uses {{FIRST_FRAME}} but no initial image is available. Set COMFYUI_FIRST_FRAME_WORKFLOW_PATH for automatic local image generation, COMFYUI_INITIAL_IMAGE_PATH for a prepared image, or use a text-to-video workflow.');
      }
    }
    const replacements = {
      PROMPT: prompt,
      NEGATIVE_PROMPT: 'CGI, cartoon, plastic skin, warped faces, deformed fingers, text artifacts, flicker, jump cuts',
      SEED: seed,
      FRAMES: frames,
      FPS: this.fps,
      WIDTH: this.width,
      HEIGHT: this.height,
      DURATION_SECONDS: seconds,
      FIRST_FRAME: firstFrame,
      DIALOGUE: String(segment.dialogue || ''),
    };
    const workflow = bindWorkflow(template, replacements);
    const queued = await this.requestJson('/prompt', {
      method: 'POST',
      body: { prompt: workflow, client_id: crypto.randomUUID() },
    });
    const promptId = queued.prompt_id;
    if (!promptId) throw new Error('ComfyUI did not return prompt_id: ' + JSON.stringify(queued));
    const history = await this.waitForHistory(promptId);
    const media = selectVideoOutput(history.outputs);
    if (!media) {
      throw new Error('ComfyUI completed but did not produce an MP4/WebM video. Ensure the workflow includes a SaveVideo/Video Combine output.');
    }

    await mkdir(this.assetDir, { recursive: true });
    const extension = path.extname(media.filename).toLowerCase();
    const localPath = path.join(this.assetDir, safeName(projectId || 'project') +
      '-act-' + String(segment.index ?? 0) + '-' + promptId.slice(0, 12) + extension);
    const params = new URLSearchParams({
      filename: media.filename,
      subfolder: media.subfolder || '',
      type: media.type || 'output',
    });
    const res = await this.fetch(this.baseUrl + '/view?' + params, {
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok || !res.body) {
      throw new Error('ComfyUI video download failed (' + res.status + ')');
    }
    let finalPath = localPath;
    let dialogueTrack = null;
    let audioMode = this.requireAudio ? 'native' : 'unknown';
    try {
      await pipeline(res.body, createWriteStream(localPath));
      if (this.requireAudio && !(await probeAudio(localPath, this.runCommand))) {
        if (!this.localTts) {
          throw new Error('Generated video has no audio. Use an LTX audiovisual workflow with native audio, configure LOCAL_TTS_BASE_URL for post-mixed narration, or set COMFYUI_REQUIRE_AUDIO=false for video-only testing.');
        }
        const spokenText = segment.dialogueTurns?.length
          ? segment.dialogueTurns.map(turn => turn.text).filter(Boolean).join(' ')
          : String(segment.dialogue || '');
        if (!spokenText.trim()) {
          throw new Error('Silent video needs spoken dialogue for local TTS. Use a native audiovisual workflow for non-dialogue scenes.');
        }
        const speech = await this.localTts.synthesize({
          text: spokenText, projectId, segmentIndex: segment.index,
        });
        finalPath = await this.dialogueComposer.mixVoiceover({
          videoPath: localPath, voicePath: speech.localPath,
          projectId, segmentIndex: segment.index, generationId: promptId, ambienceGain: 0,
        });
        dialogueTrack = {
          localPath: speech.localPath, turns: segment.dialogueTurns || [],
          provider: 'local-tts', model: speech.model,
        };
        audioMode = 'voiceover-post-mix';
      }
    } catch (error) {
      await unlink(localPath).catch(() => {});
      throw error;
    }

    return {
      provider: 'comfyui-local',
      providerModelId: 'comfyui-local-audiovisual',
      type: 'ai-video',
      model: 'comfyui-workflow',
      audioMode,
      localPath: finalPath,
      rawLocalPath: localPath,
      generationId: promptId,
      generatedDuration: seconds + 's',
      durationSeconds: seconds,
      aspectRatio: this.width + ':' + this.height,
      prompt,
      dialogueTrack,
      dialogueTurns: segment.dialogueTurns || [],
      speakerCharacterIds: [...new Set((segment.dialogueTurns || []).map(t => t.speakerCharacterId).filter(Boolean))],
      referenceImageCount: firstFrame ? 1 : 0,
      referenceVideoCount: 0,
      referenceAudioCount: 0,
      previousGenerationId: previousAsset?.generationId || null,
      keyframeMode: firstFrame ? 'first' : 'off',
      motionControlMode: 'semantic-prompt',
      nativeMotionMask: false,
      sourceUrl: null,
      providerUsage: { provider: 'comfyui-local', operation: 'video-generation',
        model: 'local-workflow', costUsd: 0 },
    };
  }

  async uploadLastFrame(videoPath, projectId) {
    const png = path.join(this.assetDir, safeName(projectId || 'project') +
      '-last-frame-' + crypto.randomUUID() + '.png');
    await mkdir(this.assetDir, { recursive: true });
    try {
      await this.runCommand('ffmpeg', ['-y', '-sseof', '-0.15', '-i', videoPath,
        '-frames:v', '1', png]);
      return await this.uploadImage(await readFile(png), path.basename(png));
    } finally {
      await unlink(png).catch(() => {});
    }
  }

  async uploadImage(bytes, filename) {
    const ext = path.extname(filename).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.webp' ? 'image/webp' : 'image/png';
    const form = new FormData();
    form.append('image', new Blob([bytes], { type: mime }), filename);
    form.append('overwrite', 'false');
    const response = await this.fetch(this.baseUrl + '/upload/image', {
      method: 'POST', body: form, signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error('ComfyUI image upload failed (' + response.status + ')');
    const result = await response.json();
    if (!result.name) throw new Error('ComfyUI image upload did not return a name');
    return result.subfolder ? result.subfolder + '/' + result.name : result.name;
  }

  async generateFirstFrame(prompt) {
    const raw = JSON.parse(await readFile(this.firstFrameWorkflowPath, 'utf8'));
    const template = raw.workflow || raw.prompt || raw;
    if (!hasPlaceholder(template, 'PROMPT')) {
      throw new Error('COMFYUI_FIRST_FRAME_WORKFLOW_PATH must include {{PROMPT}}');
    }
    const workflow = bindWorkflow(template, {
      PROMPT: prompt, NEGATIVE_PROMPT: 'bad anatomy, deformed objects, fake skin, text artifacts',
      SEED: crypto.randomInt(1, 2147483647), WIDTH: this.width, HEIGHT: this.height,
      FPS: this.fps, FRAMES: 1, DURATION_SECONDS: 0, FIRST_FRAME: '', DIALOGUE: '',
    });
    const queued = await this.requestJson('/prompt', {
      method: 'POST', body: { prompt: workflow, client_id: crypto.randomUUID() },
    });
    if (!queued.prompt_id) throw new Error('ComfyUI image workflow did not return prompt_id');
    const history = await this.waitForHistory(queued.prompt_id);
    const media = selectImageOutput(history.outputs);
    if (!media) throw new Error('ComfyUI first-frame image workflow did not emit a PNG/JPEG/WebP image');
    const params = new URLSearchParams({
      filename: media.filename, subfolder: media.subfolder || '',
      type: media.type || 'output',
    });
    const response = await this.fetch(this.baseUrl + '/view?' + params, {
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error('Failed to download first-frame image (' + response.status + ')');
    return this.uploadImage(new Uint8Array(await response.arrayBuffer()), path.basename(media.filename));
  }

  async waitForHistory(promptId) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const response = await this.requestJson('/history/' + encodeURIComponent(promptId));
      const entry = response[promptId] || response;
      if (entry?.status?.status_str === 'error') {
        throw new Error('ComfyUI execution failed: ' + JSON.stringify(entry.status?.messages || []));
      }
      if (entry?.outputs) return entry;
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
    }
    throw new Error('ComfyUI generation timed out after ' + this.timeoutMs + 'ms (prompt ' + promptId + ')');
  }

  async requestJson(endpoint, { method = 'GET', body } = {}) {
    const response = await this.fetch(this.baseUrl + endpoint, {
      method,
      ...(body ? { headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json) {
      throw new Error('ComfyUI ' + endpoint + ' failed (' + response.status + '): ' + JSON.stringify(json));
    }
    if (Array.isArray(json.node_errors) && json.node_errors.length) {
      throw new Error('ComfyUI workflow rejected: ' + JSON.stringify(json.node_errors));
    }
    return json;
  }
}

export function bindWorkflow(value, inputs) {
  if (Array.isArray(value)) return value.map(item => bindWorkflow(item, inputs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bindWorkflow(item, inputs)]));
  }
  if (typeof value !== 'string') return value;
  const exact = /^\{\{([A-Z_]+)\}\}$/.exec(value);
  if (exact) {
    if (!Object.hasOwn(inputs, exact[1])) throw new Error('Unknown ComfyUI workflow variable: ' + exact[1]);
    return inputs[exact[1]];
  }
  return value.replace(/\{\{([A-Z_]+)\}\}/g, (_, name) => {
    if (!Object.hasOwn(inputs, name)) throw new Error('Unknown ComfyUI workflow variable: ' + name);
    return String(inputs[name]);
  });
}

export function hasPlaceholder(value, name) {
  if (typeof value === 'string') return value.includes('{{' + name + '}}');
  if (Array.isArray(value)) return value.some(item => hasPlaceholder(item, name));
  if (value && typeof value === 'object') return Object.values(value).some(item => hasPlaceholder(item, name));
  return false;
}

export function selectVideoOutput(outputs = {}) {
  const files = Object.values(outputs || {}).flatMap(result =>
    ['videos', 'video', 'gifs', 'files', 'images'].flatMap(key => Array.isArray(result?.[key]) ? result[key] : []));
  return files.find(file => /\.(mp4|webm|mov)$/i.test(file?.filename || '')) || null;
}

export function selectImageOutput(outputs = {}) {
  const files = Object.values(outputs || {}).flatMap(result =>
    ['images', 'files'].flatMap(key => Array.isArray(result?.[key]) ? result[key] : []));
  return files.find(file => /\.(png|jpe?g|webp)$/i.test(file?.filename || '')) || null;
}

export function buildLocalVideoPrompt({ segment, productionScript, storyBible, regeneration }) {
  const characters = (segment.characterIds || []).map(id =>
    (storyBible?.characters || productionScript?.characters || []).find(c => c.id === id))
    .filter(Boolean).map(c => [c.name, c.description, c.physicalTraits, c.wardrobe].filter(Boolean).join(', '));
  const location = (storyBible?.locations || productionScript?.locations || [])
    .find(l => l.id === segment.locationId);
  const turns = segment.dialogueTurns?.length
    ? segment.dialogueTurns.map(t => t.text).filter(Boolean).join(' ')
    : segment.dialogue;
  return [
    'Generate one continuous photorealistic cinematic vertical video with synchronized natural audio.',
    'Scene: ' + (segment.action || ''),
    'Camera: ' + (segment.camera || ''),
    'Location: ' + [location?.description, location?.lighting].filter(Boolean).join('. '),
    'Characters: ' + characters.join(' | '),
    'Exact spoken dialogue: ' + (turns || 'None'),
    'Audio ambience: ' + (segment.ambience || ''),
    'Sound effects: ' + (segment.soundEffects || []).join(', '),
    'Continuity: match the supplied opening frame if present. Keep faces, clothing, environment and lighting consistent.',
    'No captions, logos, artificial looking skin or extra dialogue.',
    regeneration?.guidance ? 'Fix previous generation errors: ' + regeneration.guidance : '',
  ].filter(Boolean).join('\n').slice(0, 2800);
}

async function probeAudio(file, runCommand) {
  const result = await runCommand('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], true);
  return result.trim().includes('audio');
}

function run(command, args, captureStdout = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(captureStdout ? stdout : '')
      : reject(new Error(command + ' failed (' + code + '): ' + stderr.slice(-2000))));
  });
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(name + ' must be a positive integer');
  return value;
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}
