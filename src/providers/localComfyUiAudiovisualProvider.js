import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { assertLocalEndpoint } from './localEndpoints.js';
import { DialogueAudioComposer } from '../services/dialogueAudioComposer.js';
import {
  buildInfiniteTalkWorkflow, buildInfiniteTalkPrompt, infiniteTalkPassCount,
  infiniteTalkFrameCount, INFINITETALK_FPS,
} from './localInfiniteTalk.js';
import { LocalLocationSet, conversationAngle, planLocationAngles } from './localLocationSet.js';

// Accepts a ComfyUI workflow exported in API format. Add {{PROMPT}}, {{SEED}},
// {{FRAMES}} etc. as input values in that workflow; no node IDs are assumed.
export class LocalComfyUiAudiovisualProvider {
  constructor({
    baseUrl = process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188',
    workflowPath = process.env.COMFYUI_WORKFLOW_PATH,
    firstFrameWorkflowPath = process.env.COMFYUI_FIRST_FRAME_WORKFLOW_PATH,
    initialImagePath = process.env.COMFYUI_INITIAL_IMAGE_PATH,
    // Image already in ComfyUI's input folder used when a {{CHARACTER_REFERENCE}} slot has
    // no reference yet (e.g. a tiny placeholder that the workflow treats as "no reference").
    emptyReferenceImage = process.env.COMFYUI_EMPTY_REFERENCE_IMAGE || '',
    // Speaking acts whose generated voice starts later than this are re-rendered, because the
    // model animates the lips from frame 0 and the gap reads as silent mouthing / dropped sound.
    maxSpeechOnsetSeconds = Number(process.env.COMFYUI_MAX_SPEECH_ONSET_SECONDS ?? 0.6),
    speechOnsetRetries = Number(process.env.COMFYUI_SPEECH_ONSET_RETRIES ?? 1),
    // Optional lip-sync pass with Wan 2.1 InfiniteTalk for on-camera speech.
    infiniteTalk = process.env.COMFYUI_INFINITETALK_ENABLED === 'true' ? {
      width: Number(process.env.COMFYUI_INFINITETALK_WIDTH || 480),
      height: Number(process.env.COMFYUI_INFINITETALK_HEIGHT || 832),
      steps: Number(process.env.COMFYUI_INFINITETALK_STEPS || 6),
      models: {
        unet: process.env.COMFYUI_INFINITETALK_UNET || 'wan2.1_i2v_480p_14B_fp8_scaled.safetensors',
        lora: process.env.COMFYUI_INFINITETALK_LORA || 'lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors',
        textEncoder: process.env.COMFYUI_INFINITETALK_TEXT_ENCODER || 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
        vae: process.env.COMFYUI_INFINITETALK_VAE || 'wan_2.1_vae.safetensors',
        patch: process.env.COMFYUI_INFINITETALK_PATCH || 'wan2.1_infiniteTalk_single_fp16.safetensors',
        audioEncoder: process.env.COMFYUI_INFINITETALK_AUDIO_ENCODER || 'wav2vec2-chinese-base_fp16.safetensors',
      },
    } : null,
    assetDir = process.env.ASSET_DIR || './data/assets',
    fps = Number(process.env.COMFYUI_FPS || 24),
    width = Number(process.env.COMFYUI_WIDTH || 720),
    height = Number(process.env.COMFYUI_HEIGHT || 1280),
    maxSegmentSeconds = Number(process.env.COMFYUI_MAX_SEGMENT_SECONDS || 15),
    pollIntervalMs = Number(process.env.COMFYUI_POLL_INTERVAL_MS || 2000),
    timeoutMs = Number(process.env.COMFYUI_TIMEOUT_MS || 900000),
    requireAudio = process.env.COMFYUI_REQUIRE_AUDIO !== 'false',
    localTts = null,
    consistentCast = process.env.COMFYUI_CONSISTENT_CAST === 'true',
    // Saved room images per camera angle for scenes that revisit a location with different shots.
    locationAngles = process.env.COMFYUI_LOCATION_ANGLES === 'true',
    voicePools = {
      female: (process.env.CAST_FEMALE_VOICES || 'af_heart,af_bella,af_nicole,af_sarah,bf_emma').split(','),
      male: (process.env.CAST_MALE_VOICES || 'am_michael,am_adam,am_eric,am_liam,bm_george').split(','),
    },
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
    this.emptyReferenceImage = emptyReferenceImage;
    this.maxSpeechOnsetSeconds = Math.max(0, Number(maxSpeechOnsetSeconds) || 0);
    this.speechOnsetRetries = Math.max(0, Math.min(3, Math.floor(Number(speechOnsetRetries) || 0)));
    this.infiniteTalk = infiniteTalk;
    // One reference portrait and one fixed TTS voice per character for the whole video.
    this.consistentCast = consistentCast;
    this.castPortraits = new Map();
    this.locationStills = new Map();
    this.castVoices = new Map();
    this.voicePools = voicePools;
    this.characterReferences = new Map();
    this.assetDir = assetDir;
    this.fps = positiveInteger(fps, 'COMFYUI_FPS');
    this.width = positiveInteger(width, 'COMFYUI_WIDTH');
    this.height = positiveInteger(height, 'COMFYUI_HEIGHT');
    this.maxSegmentSeconds = positiveInteger(maxSegmentSeconds, 'COMFYUI_MAX_SEGMENT_SECONDS');
    this.pollIntervalMs = positiveInteger(pollIntervalMs, 'COMFYUI_POLL_INTERVAL_MS');
    this.timeoutMs = positiveInteger(timeoutMs, 'COMFYUI_TIMEOUT_MS');
    this.requireAudio = requireAudio;
    this.localTts = localTts;
    this.locationSet = locationAngles && firstFrameWorkflowPath ? new LocalLocationSet({ comfy: this }) : null;
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

    const castSpeaker = this.consistentCast && this.infiniteTalk && this.localTts
      && this.firstFrameWorkflowPath && hasVisibleSpeech({ segment, productionScript, storyBible })
      ? primarySpeaker({ segment, productionScript, storyBible }) : null;
    if (castSpeaker) {
      const conversation = conversationTurns({ segment, productionScript, storyBible });
      if (conversation) {
        return this.generateCastConversationAct({ segment, productionScript, storyBible, projectId, conversation, seconds, previousAsset, regeneration });
      }
      return this.generateCastSpeakingAct({ segment, productionScript, storyBible, projectId, speaker: castSpeaker, seconds, previousAsset, regeneration });
    }

    const prompt = buildLocalVideoPrompt({ segment, productionScript, storyBible, regeneration });
    const seed = crypto.randomInt(1, 2147483647);
    const frames = Math.max(9, Math.round((seconds * this.fps - 1) / 8) * 8 + 1);
    let firstFrame = '';
    if (hasPlaceholder(template, 'FIRST_FRAME')) {
      const previousSegment = (productionScript?.segments || [])
        .find((item) => item.index === Number(segment.index) - 1);
      // Chaining the previous last frame would keep the old setting, so a new location
      // gets a fresh opening still (anchored to the first act's people when possible).
      const locationChanged = Boolean(previousAsset?.localPath && previousSegment
        && segment.locationId && previousSegment.locationId
        && segment.locationId !== previousSegment.locationId);
      const castMember = this.consistentCast && this.firstFrameWorkflowPath
        ? visibleCharacters({ segment, productionScript, storyBible })[0] : null;
      const reference = castMember
        ? await this.castPortrait(projectId, castMember)
        : this.characterReferences.get(projectId) || '';
      const shot = this.locationShot({ segment, productionScript, storyBible });
      if (shot && castMember) {
        firstFrame = (await this.locationSet.placeCharacter({ projectId, location: shot.location, angle: shot.angle, characterId: castMember.id, portrait: reference, regeneration })).image;
      } else if (shot) {
        firstFrame = await this.locationSet.ensureView(projectId, shot.location, shot.angle);
      } else if (castMember) {
        firstFrame = await this.locationStill({ segment, productionScript, storyBible, projectId, character: castMember, reference, regeneration });
      } else if (previousAsset?.localPath && !(locationChanged && this.firstFrameWorkflowPath)) {
        firstFrame = await this.uploadLastFrame(previousAsset.sourceVideoPath || previousAsset.localPath, projectId);
      } else if (this.initialImagePath && !previousAsset?.localPath) {
        firstFrame = await this.uploadImage(
          await readFile(this.initialImagePath), path.basename(this.initialImagePath),
        );
        this.characterReferences.set(projectId, firstFrame);
      } else if (this.firstFrameWorkflowPath) {
        firstFrame = await this.generateFirstFrame(
          buildLocalFirstFramePrompt({ segment, productionScript, storyBible }),
          locationChanged ? reference : '');
        if (!locationChanged) this.characterReferences.set(projectId, firstFrame);
      } else {
        throw new Error('Workflow uses {{FIRST_FRAME}} but no initial image is available. Set COMFYUI_FIRST_FRAME_WORKFLOW_PATH for automatic local image generation, COMFYUI_INITIAL_IMAGE_PATH for a prepared image, or use a text-to-video workflow.');
      }
    }
    const speaking = hasVisibleSpeech({ segment, productionScript, storyBible });
    const negativePrompt = [
      'CGI, cartoon, plastic skin, warped faces, deformed fingers, text artifacts, flicker, jump cuts, video game, ugly, split screen, collage, multiple panels, picture-in-picture, borders',
      speaking ? 'camera zoom out, camera pulling back, dolly out, wide shot, tiny distant face, talking without sound, lips moving in silence, exaggerated mouth, shouting, changing clothes' : '',
    ].filter(Boolean).join(', ');
    const checkOnset = speaking && this.maxSpeechOnsetSeconds > 0;
    let best = null;
    for (let attempt = 0; attempt <= (checkOnset ? this.speechOnsetRetries : 0); attempt += 1) {
    const replacements = {
      PROMPT: prompt,
      NEGATIVE_PROMPT: negativePrompt,
      SEED: attempt === 0 ? seed : crypto.randomInt(1, 2147483647),
      FRAMES: frames,
      FPS: this.fps,
      WIDTH: this.width,
      HEIGHT: this.height,
      DURATION_SECONDS: seconds,
      FIRST_FRAME: firstFrame,
      CHARACTER_REFERENCE: this.characterReferences.get(projectId) || this.emptyReferenceImage,
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
    const gaps = checkOnset
      ? await measureSilenceGaps(finalPath, this.runCommand, seconds).catch(() => ({ leading: 0, trailing: 0 }))
      : { leading: 0, trailing: 0 };
    const candidate = {
      promptId, localPath, finalPath, dialogueTrack, audioMode, attempt,
      speechOnsetSeconds: gaps.leading,
      trailingSilenceSeconds: gaps.trailing,
      // Dead air at either end shows up as silent lip movement or a sound drop-out.
      deadAir: gaps.leading + Math.max(0, gaps.trailing - 1),
    };
    if (!best || candidate.deadAir < best.deadAir) {
      if (best) await discardRender(best);
      best = candidate;
    } else {
      await discardRender(candidate);
    }
    if (best.speechOnsetSeconds <= this.maxSpeechOnsetSeconds && best.trailingSilenceSeconds <= 1.5) break;
    }
    const { promptId, localPath, dialogueTrack, audioMode } = best;
    let { finalPath } = best;
    let lipSync = null;
    if (this.infiniteTalk && speaking) {
      try {
        const synced = await this.applyInfiniteTalk({
          videoPath: finalPath, seconds, segment, productionScript, storyBible, projectId, promptId,
        });
        lipSync = { provider: 'comfyui-infinitetalk', passed: true, sourceVideoPath: finalPath };
        finalPath = synced;
      } catch (error) {
        // Keep the video model's own clip; QC still judges it.
        lipSync = { provider: 'comfyui-infinitetalk', passed: false, error: error.message };
      }
    }

    return {
      provider: 'comfyui-local',
      providerModelId: 'comfyui-local-audiovisual',
      type: 'ai-video',
      model: 'comfyui-workflow',
      audioMode,
      localPath: finalPath,
      rawLocalPath: localPath,
      sourceVideoPath: lipSync?.passed ? lipSync.sourceVideoPath : null,
      lipSyncPass: lipSync,
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
      speechOnsetSeconds: checkOnset ? best.speechOnsetSeconds : null,
      trailingSilenceSeconds: checkOnset ? best.trailingSilenceSeconds : null,
      speechOnsetAttempts: best.attempt + 1,
      sourceUrl: null,
      providerUsage: { provider: 'comfyui-local', operation: 'video-generation',
        model: 'local-workflow', costUsd: 0 },
    };
  }

  // videoPath: lip-sync an existing clip (its first frame + its audio).
  // startImageName + audioPath: animate a still already in ComfyUI with a given voice track.
  async applyInfiniteTalk({ videoPath = null, startImageName = null, audioPath = null, seconds, segment,
    productionScript, storyBible, projectId, promptId }) {
    const cfg = this.infiniteTalk;
    const passes = infiniteTalkPassCount(seconds);
    const coveredSeconds = infiniteTalkFrameCount(passes) / INFINITETALK_FPS;
    const base = path.join(this.assetDir, safeName(projectId || 'project') + '-act-' +
      String(segment.index ?? 0) + '-' + String(promptId).slice(0, 12) + '-it');
    const still = base + '-start.png';
    const voice = base + '-voice.wav';
    const padded = base + '-voice-padded.wav';
    const out = base + '.mp4';
    const raw = base + '-raw.mp4';
    try {
      if (!startImageName) await this.runCommand('ffmpeg', ['-y', '-i', videoPath, '-frames:v', '1', still]);
      await this.runCommand('ffmpeg', ['-y', '-i', audioPath || videoPath, '-vn', '-ac', '1', '-ar', '16000', voice]);
      // InfiniteTalk reads audio per generated frame, so cover every frame of the last chunk.
      await this.runCommand('ffmpeg', ['-y', '-i', voice, '-af', 'apad', '-t', String(coveredSeconds + 0.5), padded]);
      const [startImage, drivingAudio, outputAudio] = [
        startImageName || await this.uploadImage(await readFile(still), path.basename(still)),
        await this.uploadImage(await readFile(padded), path.basename(padded)),
        await this.uploadImage(await readFile(voice), path.basename(voice)),
      ];
      const workflow = buildInfiniteTalkWorkflow({
        startImage, drivingAudio, outputAudio,
        prompt: buildInfiniteTalkPrompt({ segment, productionScript, storyBible }),
        seed: crypto.randomInt(1, 2147483647), passes,
        width: cfg.width, height: cfg.height, steps: cfg.steps, models: cfg.models,
      });
      const queued = await this.requestJson('/prompt', { method: 'POST', body: { prompt: workflow, client_id: crypto.randomUUID() } });
      if (!queued.prompt_id) throw new Error('ComfyUI did not return prompt_id for InfiniteTalk');
      const history = await this.waitForHistory(queued.prompt_id);
      const media = selectVideoOutput(history.outputs);
      if (!media) throw new Error('InfiniteTalk workflow produced no video');
      const res = await this.fetch(this.baseUrl + '/view?' + new URLSearchParams({
        filename: media.filename, subfolder: media.subfolder || '', type: media.type || 'output',
      }), { signal: AbortSignal.timeout(120000) });
      if (!res.ok || !res.body) throw new Error('InfiniteTalk video download failed (' + res.status + ')');
      await pipeline(res.body, createWriteStream(raw));
      // Lip-synced picture + the video model's full original audio (voice, ambience, effects).
      await this.runCommand('ffmpeg', ['-y', '-i', raw, '-i', audioPath || videoPath, '-map', '0:v:0', '-map', '1:a:0?',
        // Sharp upscale + light grain: hides the smooth, waxy look of upscaled diffusion video.
        '-vf', 'scale=1080:1920:flags=lanczos,unsharp=5:5:0.45:5:5:0,noise=alls=5:allf=t+u',
        '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', out]);
      return out;
    } finally {
      for (const file of [still, voice, padded, raw]) await unlink(file).catch(() => {});
    }
  }

  // One studio portrait per character per video; every still of that character is
  // generated from it (image-edit reference), so the face stays the same across clips.
  async castPortrait(projectId, character) {
    const key = projectId + '::' + character.id;
    if (!this.castPortraits.has(key)) {
      this.castPortraits.set(key, this.generateFirstFrame(buildCastPortraitPrompt(character), ''));
    }
    return this.castPortraits.get(key);
  }

  // One fixed TTS voice per character per video, chosen from a pool by apparent gender.
  castVoice(projectId, character) {
    let voices = this.castVoices.get(projectId);
    if (!voices) { voices = new Map(); this.castVoices.set(projectId, voices); }
    if (!voices.has(character.id)) {
      const pool = this.voicePools[apparentGender(character) === 'male' ? 'male' : 'female'];
      const used = new Set(voices.values());
      voices.set(character.id, pool.find((voice) => !used.has(voice)) || pool[voices.size % pool.length]);
    }
    return voices.get(character.id);
  }

  // The saved view for this scene, when its location is filmed from different camera angles.
  locationShot({ segment, productionScript, storyBible }) {
    if (!this.locationSet) return null;
    const planned = segment.conversationSpeakerIndex != null
      ? { locationId: segment.locationId, angle: conversationAngle(segment.conversationSpeakerIndex) }
      : planLocationAngles(productionScript).get(segment.index);
    if (!planned) return null;
    const location = (storyBible?.locations || productionScript?.locations || []).find((l) => l.id === planned.locationId);
    return location ? { location, angle: planned.angle } : null;
  }

  // One opening still per character per location, reused by every act there so the room,
  // furniture and light are identical. Regenerating the act that made it replaces it,
  // otherwise a bad still could never be retried away.
  async locationStill({ segment, productionScript, storyBible, projectId, character, reference, regeneration = null }) {
    const record = { locationId: segment.locationId, characterId: character.id };
    const known = segment.locationId ? this.locationStills.get(locationStillKey(projectId, record)) : null;
    if (known && !(regeneration && known.actIndex === segment.index)) return known.image;
    const image = await this.generateFirstFrame(buildLocalFirstFramePrompt({ segment, productionScript, storyBible }), reference);
    if (segment.locationId) {
      this.locationStills.set(locationStillKey(projectId, record), { ...record, image, actIndex: segment.index });
    }
    return image;
  }

  async generateCastSpeakingAct({ segment, productionScript, storyBible, projectId, speaker, seconds, previousAsset, regeneration = null }) {
    const characters = storyBible?.characters || productionScript?.characters || [];
    // After a resume the in-memory cast is empty: reuse the portrait and voice saved on the
    // previous clip so the face and voice do not change mid-video.
    if (previousAsset?.castVoices) {
      const known = previousAsset.castReferences
        || (previousAsset.castReference && previousAsset.castVoices[speaker.id] ? { [speaker.id]: previousAsset.castReference } : {});
      for (const [characterId, portrait] of Object.entries(known)) {
        const key = projectId + '::' + characterId;
        if (!this.castPortraits.has(key)) this.castPortraits.set(key, Promise.resolve(portrait));
      }
      let voices = this.castVoices.get(projectId);
      if (!voices) { voices = new Map(); this.castVoices.set(projectId, voices); }
      for (const [id, voice] of Object.entries(previousAsset.castVoices)) if (!voices.has(id)) voices.set(id, voice);
    }
    const reference = await this.castPortrait(projectId, speaker);
    if (previousAsset?.locationStill && !this.locationStills.has(locationStillKey(projectId, previousAsset.locationStill))) {
      this.locationStills.set(locationStillKey(projectId, previousAsset.locationStill), previousAsset.locationStill);
    }
    const shot = this.locationShot({ segment, productionScript, storyBible });
    const placement = shot
      ? await this.locationSet.placeCharacter({ projectId, location: shot.location, angle: shot.angle, characterId: speaker.id, portrait: reference, regeneration, gaze: segment.conversationGaze || null })
      : null;
    const startImageName = placement
      ? placement.image
      : await this.locationStill({ segment, productionScript, storyBible, projectId, character: speaker, reference, regeneration });
    const turns = (segment.dialogueTurns?.length
      ? segment.dialogueTurns
      : [{ speakerCharacterId: speaker.id, text: segment.dialogue }])
      .filter((turn) => String(turn.text || '').trim());
    const id = crypto.randomUUID();
    const base = path.join(this.assetDir, safeName(projectId || 'project') + '-act-' +
      String(segment.index ?? 0) + '-cast-' + id.slice(0, 12));
    const parts = [];
    const voicesUsed = {};
    try {
      for (const turn of turns) {
        const who = characters.find((c) => c.id === turn.speakerCharacterId) || speaker;
        const voice = this.castVoice(projectId, who);
        voicesUsed[who.id] = voice;
        parts.push((await this.localTts.synthesize({ text: turn.text, projectId, segmentIndex: segment.index, voice })).localPath);
      }
      // Turns joined with short pauses and a small lead-in, sped up slightly if needed, padded to the act.
      const joined = base + '-voice.wav';
      const chain = parts.map((_, i) => `[${i}:a]aresample=24000,aformat=channel_layouts=mono,apad=pad_dur=0.25[a${i}]`).join(';');
      await this.runCommand('ffmpeg', ['-y', ...parts.flatMap((file) => ['-i', file]), '-filter_complex',
        chain + ';' + parts.map((_, i) => `[a${i}]`).join('') + `concat=n=${parts.length}:v=0:a=1,adelay=150[out]`,
        '-map', '[out]', joined]);
      const spoken = Number(String(await this.runCommand('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', joined], true)).trim()) || 0;
      const room = Math.max(1, seconds - 0.2);
      const tempo = spoken > room ? Math.min(1.3, spoken / room) : 1;
      const actSeconds = speakingActSeconds(spoken / tempo, seconds);
      const fitted = base + '-voice-fitted.wav';
      await this.runCommand('ffmpeg', ['-y', '-i', joined, '-af', (tempo > 1 ? `atempo=${tempo.toFixed(3)},` : '') + 'apad',
        '-t', String(actSeconds), fitted]);
      let out = await this.applyInfiniteTalk({
        startImageName, audioPath: fitted, seconds: actSeconds, segment, productionScript, storyBible, projectId, promptId: id,
      });
      let roomLock = null;
      if (placement) {
        try {
          const locked = await this.locationSet.lockRoom({ clipPath: out, placement, seconds: actSeconds });
          await unlink(out).catch(() => {});
          out = locked;
          roomLock = { passed: true };
        } catch (error) {
          // The animated clip is still usable; QC judges it without the locked room.
          roomLock = { passed: false, error: error.message };
        }
      }
      return {
        provider: 'comfyui-local',
        providerModelId: 'comfyui-local-cast-infinitetalk',
        type: 'ai-video',
        model: 'comfyui-workflow',
        audioMode: 'local-tts-cast-voice',
        localPath: out,
        rawLocalPath: out,
        generationId: id,
        generatedDuration: actSeconds + 's',
        durationSeconds: actSeconds,
        aspectRatio: this.infiniteTalk.width + ':' + this.infiniteTalk.height,
        prompt: buildInfiniteTalkPrompt({ segment, productionScript, storyBible }),
        dialogueTrack: { localPath: fitted, turns: segment.dialogueTurns || [], provider: 'local-tts', voices: voicesUsed },
        dialogueTurns: segment.dialogueTurns || [],
        speakerCharacterIds: Object.keys(voicesUsed),
        castVoices: voicesUsed,
        castReference: reference,
        castReferences: { ...previousAsset?.castReferences, [speaker.id]: reference },
        cameraAngle: shot?.angle || null,
        roomLock,
        locationStill: segment.locationId ? this.locationStills.get(locationStillKey(projectId, { locationId: segment.locationId, characterId: speaker.id })) : null,
        referenceImageCount: 1,
        referenceVideoCount: 0,
        referenceAudioCount: 1,
        previousGenerationId: previousAsset?.generationId || null,
        keyframeMode: 'first',
        motionControlMode: 'audio-driven',
        nativeMotionMask: false,
        speechOnsetSeconds: 0.15,
        trailingSilenceSeconds: null,
        lipSyncPass: { provider: 'comfyui-infinitetalk', passed: true, drivenBy: 'local-tts' },
        sourceUrl: null,
        providerUsage: { provider: 'comfyui-local', operation: 'video-generation', model: 'local-workflow', costUsd: 0 },
      };
    } finally {
      for (const file of parts) await unlink(file).catch(() => {});
    }
  }

  // Two people talking: one clip per line showing whoever speaks, cut together like a filmed
  // conversation. InfiniteTalk animates one face per clip, so each line needs its own shot.
  async generateCastConversationAct({ segment, productionScript, storyBible, projectId, conversation, seconds, previousAsset, regeneration }) {
    const { turns, speakers } = conversation;
    const totalWords = turns.reduce((sum, turn) => sum + countWords(turn.text), 0) || 1;
    const clips = [];
    let previous = previousAsset;
    for (const turn of turns) {
      const speakerIndex = speakers.findIndex((c) => c.id === turn.speakerCharacterId);
      const clip = await this.generateCastSpeakingAct({
        segment: {
          ...segment, dialogue: turn.text, dialogueTurns: [turn], speakerCharacterId: turn.speakerCharacterId,
          characterIds: [turn.speakerCharacterId], conversationSpeakerIndex: speakerIndex,
          conversationGaze: speakerIndex % 2 === 0 ? 'right' : 'left',
        },
        productionScript, storyBible, projectId, speaker: speakers[speakerIndex],
        // A little slack; each clip is trimmed back to its real speech length.
        seconds: Math.max(2, (seconds * countWords(turn.text)) / totalWords + 0.6),
        previousAsset: previous, regeneration,
      });
      clips.push(clip);
      previous = clip;
    }
    const id = crypto.randomUUID();
    const base = path.join(this.assetDir, safeName(projectId || 'project') + '-act-' + String(segment.index ?? 0) + '-talk-' + id.slice(0, 12));
    const video = base + '.mp4';
    const voice = base + '-voice.wav';
    const inputs = clips.flatMap((clip) => ['-i', clip.localPath]);
    const parts = clips.map((_, i) => `[${i}:v]fps=25,setsar=1,format=yuv420p[v${i}];[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`).join(';');
    const joins = clips.map((_, i) => `[v${i}][a${i}]`).join('');
    await this.runCommand('ffmpeg', ['-y', ...inputs, '-filter_complex', `${parts};${joins}concat=n=${clips.length}:v=1:a=1[v][a]`,
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-c:a', 'aac', '-b:a', '192k', video]);
    await this.runCommand('ffmpeg', ['-y', ...clips.flatMap((clip) => ['-i', clip.dialogueTrack.localPath]), '-filter_complex',
      clips.map((_, i) => `[${i}:a]`).join('') + `concat=n=${clips.length}:v=0:a=1[out]`, '-map', '[out]', voice]);
    for (const clip of clips) await unlink(clip.localPath).catch(() => {});
    const durationSeconds = Math.round(clips.reduce((sum, clip) => sum + clip.durationSeconds, 0) * 100) / 100;
    const last = clips[clips.length - 1];
    return {
      ...last,
      localPath: video,
      rawLocalPath: video,
      generationId: id,
      generatedDuration: durationSeconds + 's',
      durationSeconds,
      dialogueTrack: { localPath: voice, turns: segment.dialogueTurns, provider: 'local-tts', voices: Object.assign({}, ...clips.map((clip) => clip.castVoices)) },
      dialogueTurns: segment.dialogueTurns,
      speakerCharacterIds: speakers.map((c) => c.id),
      castVoices: Object.assign({}, ...clips.map((clip) => clip.castVoices)),
      cameraAngle: clips[0].cameraAngle,
      cameraAngles: clips.map((clip) => clip.cameraAngle),
      roomLock: clips.every((clip) => clip.roomLock) ? { passed: clips.every((clip) => clip.roomLock.passed) } : null,
      conversationShots: clips.length,
      previousGenerationId: previousAsset?.generationId || null,
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
      : ext === '.webp' ? 'image/webp' : ext === '.wav' ? 'audio/wav'
        : ext === '.mp4' ? 'video/mp4' : 'image/png';
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

  async generateFirstFrame(prompt, characterReference = '', size = null) {
    const raw = JSON.parse(await readFile(this.firstFrameWorkflowPath, 'utf8'));
    const template = raw.workflow || raw.prompt || raw;
    if (!hasPlaceholder(template, 'PROMPT')) {
      throw new Error('COMFYUI_FIRST_FRAME_WORKFLOW_PATH must include {{PROMPT}}');
    }
    const reference = characterReference || this.emptyReferenceImage;
    if (hasPlaceholder(template, 'CHARACTER_REFERENCE') && !reference) {
      throw new Error('First-frame workflow uses {{CHARACTER_REFERENCE}}; set COMFYUI_EMPTY_REFERENCE_IMAGE to an image in the ComfyUI input folder for acts without a reference.');
    }
    const workflow = bindWorkflow(template, {
      PROMPT: prompt, NEGATIVE_PROMPT: 'bad anatomy, deformed objects, fake skin, text artifacts',
      SEED: crypto.randomInt(1, 2147483647), WIDTH: size?.width || this.width, HEIGHT: size?.height || this.height,
      FPS: this.fps, FRAMES: 1, DURATION_SECONDS: 0, FIRST_FRAME: '', DIALOGUE: '',
      CHARACTER_REFERENCE: reference,
    });
    const queued = await this.requestJson('/prompt', {
      method: 'POST', body: { prompt: workflow, client_id: crypto.randomUUID() },
    });
    if (!queued.prompt_id) throw new Error('ComfyUI image workflow did not return prompt_id');
    const history = await this.waitForHistory(queued.prompt_id);
    const media = selectImageOutput(history.outputs);
    if (!media) throw new Error('ComfyUI first-frame image workflow did not emit a PNG/JPEG/WebP image');
    return this.importOutputImage(media);
  }

  async mediaBytes(media) {
    const params = new URLSearchParams({
      filename: media.filename, subfolder: media.subfolder || '',
      type: media.type || 'output',
    });
    const response = await this.fetch(this.baseUrl + '/view?' + params, {
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error('Failed to download ' + media.filename + ' (' + response.status + ')');
    return new Uint8Array(await response.arrayBuffer());
  }

  async importOutputImage(media) {
    return this.uploadImage(await this.mediaBytes(media), path.basename(media.filename));
  }

  async downloadMedia(media, file) {
    await writeFile(file, await this.mediaBytes(media));
  }

  async downloadInputFile(name, file) {
    const slash = name.lastIndexOf('/');
    await this.downloadMedia({ filename: name.slice(slash + 1), subfolder: slash < 0 ? '' : name.slice(0, slash), type: 'input' }, file);
  }

  async runWorkflow(workflow) {
    const queued = await this.requestJson('/prompt', {
      method: 'POST', body: { prompt: workflow, client_id: crypto.randomUUID() },
    });
    if (!queued.prompt_id) throw new Error('ComfyUI workflow did not return prompt_id');
    return (await this.waitForHistory(queued.prompt_id)).outputs;
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

// Still-image prompt for the opening frame: no dialogue or audio (image models tend to
// draw quoted words as text), just who is where, framed like the first shot.
export function buildLocalFirstFramePrompt({ segment, productionScript, storyBible }) {
  const characters = (segment.characterIds || []).map(id =>
    (storyBible?.characters || productionScript?.characters || []).find(c => c.id === id))
    .filter(Boolean).map(c => [c.name, c.description, c.physicalTraits, c.wardrobe].filter(Boolean).join(', '));
  const location = (storyBible?.locations || productionScript?.locations || [])
    .find(l => l.id === segment.locationId);
  const speaking = hasVisibleSpeech({ segment, productionScript, storyBible });
  return [
    'Candid vertical smartphone video frame of a real person filming themselves for social media, shot on a phone camera. Natural uneven daylight from a window, realistic unretouched skin with visible pores, fine lines and small imperfections, natural hair flyaways, ordinary everyday room with some real-life clutter, slight sensor noise.',
    'Not cinematic, not glossy, no studio lighting, no golden glow, no beauty filter, not a stock photo, not CGI. One single full-frame image (no collage, split-screen, panels or borders).',
    speaking ? 'Framing: head-and-shoulders portrait, ' + SPEAKER_FRAMING : '',
    speaking ? 'The speaker looks toward the camera with lips gently closed and a relaxed, neutral expression, about to speak.' : '',
    // Full-body poses in startState override the framing in image models, so skip them for speakers.
    speaking ? '' : (segment.startState ? 'Moment: ' + segment.startState : 'Moment: ' + (segment.action || '')),
    speaking ? '' : 'Camera: ' + (segment.camera || ''),
    characters.length ? 'People: ' + characters.join(' | ') : '',
    'Location: ' + [location?.description, location?.lighting].filter(Boolean).join('. '),
    'No text, captions, logos, watermarks or signage lettering.',
  ].filter(Boolean).join('\n').slice(0, 1800);
}

// Video models only lip-sync well when the mouth is large in frame, so speaking acts are
// forced to a medium close-up regardless of the screenplay's wide/overhead/detail camera.
const SPEAKER_FRAMING = 'locked-off static camera on a tripod, medium close-up from chest up for the whole shot, no zoom, no pull-back, no dolly or tracking; the speaker stays in place with the face large in frame, mouth and lips clearly visible and in focus.';

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

// Lines of a scene where two or more on-screen people talk, with back-to-back lines by the same
// person merged into one shot. Null for anything else.
export function conversationTurns({ segment, productionScript, storyBible }) {
  const characters = castCharacters({ productionScript, storyBible });
  const turns = [];
  for (const turn of segment.dialogueTurns || []) {
    if (!String(turn.text || '').trim()) continue;
    const previous = turns[turns.length - 1];
    if (previous?.speakerCharacterId === turn.speakerCharacterId) previous.text += ' ' + turn.text;
    else turns.push({ ...turn });
  }
  const speakers = [...new Set(turns.map((turn) => turn.speakerCharacterId))].map((id) => characters.find((c) => c.id === id));
  if (speakers.length < 2 || speakers.some((c) => !c || c.onScreen === false)) return null;
  return { turns, speakers };
}

function hasVisibleSpeech({ segment, productionScript, storyBible }) {
  const characters = storyBible?.characters || productionScript?.characters || [];
  const turns = segment.dialogueTurns?.length
    ? segment.dialogueTurns
    : (segment.dialogue ? [{ speakerCharacterId: segment.speakerCharacterId, text: segment.dialogue }] : []);
  return turns.some((turn) => {
    if (!String(turn.text || '').trim()) return false;
    const speaker = characters.find((c) => c.id === turn.speakerCharacterId);
    if (speaker) return speaker.onScreen !== false;
    // Unknown speaker: treat as visible when someone is on screen in this act.
    return (segment.characterIds || []).length > 0;
  });
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
  const speaking = hasVisibleSpeech({ segment, productionScript, storyBible });
  return [
    'Generate one continuous photorealistic vertical video that looks like real handheld smartphone footage with synchronized natural audio: natural uneven light, unretouched skin texture, ordinary real-world setting, not cinematic or glossy, as a single full-frame shot (no split-screen or panels).',
    'Scene: ' + (segment.action || ''),
    'Camera: ' + (speaking ? SPEAKER_FRAMING : (segment.camera || '')),
    'Location: ' + [location?.description, location?.lighting].filter(Boolean).join('. '),
    'Characters: ' + characters.join(' | '),
    turns
      ? (speaking
        ? 'Exact spoken dialogue, spoken by the on-screen speaker looking at the camera in a calm, natural conversational voice, starting right away: "' + turns + '"'
        : 'Exact spoken dialogue, from an off-screen narrator: "' + turns + '"')
      : 'Exact spoken dialogue: None',
    speaking ? 'Lip sync: small, natural lip and jaw movements that follow every audible syllable, no exaggerated or wide-open mouth shapes; before and after the line the mouth stays closed and still. Never mouth words silently; no extra words.' : '',
    'Audio ambience: ' + (segment.ambience || ''),
    'Sound effects: ' + (segment.soundEffects || []).join(', '),
    'Continuity: match the supplied opening frame if present. Keep faces, clothing, environment and lighting consistent.',
    'No captions, logos, artificial looking skin or extra dialogue.',
    regeneration?.guidance ? 'Fix previous generation errors: ' + regeneration.guidance : '',
  ].filter(Boolean).join('\n').slice(0, 2800);
}

// Seconds of near-silence at the start and end of a clip (0 when sound fills that edge).
export async function measureSilenceGaps(file, runCommand, clipSeconds) {
  const out = await runCommand('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn',
    '-af', 'silencedetect=n=-40dB:d=0.25,ametadata=mode=print:file=-', '-f', 'null', '-'], true);
  const starts = [...String(out).matchAll(/lavfi\.silence_start=([\d.]+)/g)].map(m => Number(m[1]));
  const ends = [...String(out).matchAll(/lavfi\.silence_end=([\d.]+)/g)].map(m => Number(m[1]));
  const leading = !starts.length || starts[0] > 0.05 ? 0 : (ends.length ? ends[0] : Number(clipSeconds) || Infinity);
  // More starts than ends means the last silence runs to the end of the clip.
  const trailing = starts.length > ends.length && Number(clipSeconds) > 0
    ? Math.max(0, Number(clipSeconds) - starts[starts.length - 1])
    : 0;
  return { leading, trailing };
}

export async function measureLeadingSilence(file, runCommand) {
  return (await measureSilenceGaps(file, runCommand, 0)).leading;
}

async function discardRender(render) {
  await unlink(render.localPath).catch(() => {});
  if (render.finalPath !== render.localPath) await unlink(render.finalPath).catch(() => {});
}

function castCharacters({ productionScript, storyBible }) {
  return storyBible?.characters || productionScript?.characters || [];
}

function visibleCharacters({ segment, productionScript, storyBible }) {
  const characters = castCharacters({ productionScript, storyBible });
  return (segment.characterIds || []).map((id) => characters.find((c) => c.id === id))
    .filter((c) => c && c.onScreen !== false);
}

function primarySpeaker({ segment, productionScript, storyBible }) {
  const characters = castCharacters({ productionScript, storyBible });
  const ids = (segment.dialogueTurns || []).map((turn) => turn.speakerCharacterId)
    .concat(segment.speakerCharacterId || []);
  return ids.map((id) => characters.find((c) => c.id === id)).find((c) => c && c.onScreen !== false)
    || visibleCharacters({ segment, productionScript, storyBible })[0] || null;
}

function locationStillKey(projectId, { locationId, characterId }) {
  return [projectId, locationId, characterId].join('::');
}

// A cast clip ends just after its last word instead of holding silently to the planned length.
// `spokenSeconds` already includes the short pause after the final turn.
export function speakingActSeconds(spokenSeconds, plannedSeconds) {
  const planned = Number(plannedSeconds) || 0;
  const spoken = Number(spokenSeconds) || 0;
  if (spoken <= 0) return planned;
  return Math.min(planned, Math.max(2, Math.ceil((spoken + 0.2) * 25 - 1e-6) / 25));
}

export function apparentGender(character) {
  const text = [character?.name, character?.description, character?.physicalTraits, character?.wardrobe].filter(Boolean).join(' ');
  if (/\b(woman|women|female|girl|lady|she|her|mother|mom|wife|sister|daughter|grandmother|actress|mrs|ms|miss)\b/i.test(text)) return 'female';
  if (/\b(man|men|male|boy|guy|he|his|him|father|dad|husband|brother|son|grandfather|gentleman|mr)\b/i.test(text)) return 'male';
  return 'unknown';
}

export function buildCastPortraitPrompt(character) {
  return [
    'Candid smartphone photo of a real, ordinary person, head and shoulders, looking at the camera with a relaxed natural expression, lips closed.',
    'Natural window daylight, realistic unretouched skin with pores, fine lines and small imperfections, no makeup look, natural hair flyaways, plain painted wall behind, slight sensor noise.',
    'Not a studio portrait, not glossy, no beauty filter, not CGI. One single full-frame vertical photo, no collage or panels.',
    [character.name, character.description, character.physicalTraits, character.wardrobe].filter(Boolean).join(', ') + '.',
    'No text, captions, logos or watermarks.',
  ].join('\n');
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
