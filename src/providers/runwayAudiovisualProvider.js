import crypto from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DialogueAudioComposer } from '../services/dialogueAudioComposer.js';
import { buildRealismPromptBlock } from '../core/realismDirector.js';
import { buildKeyframePrompts } from '../core/keyframeDirector.js';
import { buildMotionRegionPromptBlock } from '../core/motionRegionDirector.js';
import { buildMotionGuidePromptBlock } from '../core/motionGuideDirector.js';
import { PoseMotionExtractor } from '../services/poseMotionExtractor.js';
import { summarizePoseSequence } from '../core/poseMotion.js';

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
    imageModel = process.env.RUNWAY_IMAGE_MODEL || 'gen4_image',
    keyframeImageRatio = process.env.KEYFRAME_IMAGE_RATIO || '720:1280',
    keyframeVideoRatio = process.env.KEYFRAME_VIDEO_RATIO || 'auto_720p',
    keyframeFailOpen = parseBoolean(process.env.KEYFRAME_FAIL_OPEN, true),
    motionGuideFailOpen = parseBoolean(process.env.MOTION_GUIDE_FAIL_OPEN, true),
    motionGuideMaxDataUriBytes = Number(process.env.MOTION_GUIDE_MAX_DATA_URI_BYTES || 3600000),
    assetDir = process.env.ASSET_DIR || './outputs/assets',
    pollIntervalMs = Number(process.env.RUNWAY_POLL_INTERVAL_MS || 2500),
    maxPolls = Number(process.env.RUNWAY_MAX_POLLS || 120),
    dialogueComposer = null,
    poseExtractor = null,
    ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg',
    ffprobeBin = process.env.FFPROBE_BIN || 'ffprobe',
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
    this.imageModel = imageModel;
    this.keyframeImageRatio = keyframeImageRatio;
    this.keyframeVideoRatio = keyframeVideoRatio;
    this.keyframeFailOpen = Boolean(keyframeFailOpen);
    this.motionGuideFailOpen = Boolean(motionGuideFailOpen);
    this.motionGuideMaxDataUriBytes = Math.max(
      500000,
      Math.min(3900000, Number(motionGuideMaxDataUriBytes) || 3600000),
    );
    this.assetDir = assetDir;
    this.pollIntervalMs = pollIntervalMs;
    this.maxPolls = maxPolls;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.poseExtractor = poseExtractor || new PoseMotionExtractor();
    this.dialogueComposer = dialogueComposer || new DialogueAudioComposer({
      ffmpegBin,
      ffprobeBin,
      assetDir,
    });
  }

  async generateSegment({
    segment,
    productionScript,
    storyBible = null,
    previousAsset = null,
    regeneration = null,
    projectId,
  }) {
    const dialogueTurns = normalizedDialogueTurns(segment, productionScript);
    const speakerIds = [...new Set(dialogueTurns.map((turn) => turn.speakerCharacterId))];
    const characters = (segment.characterIds || [])
      .map((id) => productionScript.characters.find((item) => item.id === id))
      .filter(Boolean);
    const primaryCharacter = productionScript.characters.find(
      (item) => item.id === dialogueTurns[0]?.speakerCharacterId,
    ) || characters[0] || productionScript.characters[0];

    const references = collectImageReferences(segment, storyBible, previousAsset);
    let motionGuide = null;
    let motionGuideError = null;
    if (segment.motionGuideDirection?.selectedReference) {
      if (supportsMotionGuide(this.model)) {
        try {
          motionGuide = await this.prepareMotionGuide({
            segment,
            projectId,
          });
        } catch (error) {
          if (!this.motionGuideFailOpen) throw error;
          motionGuideError = error.message;
        }
      } else {
        motionGuideError = `motion-guide reference video is not enabled for audiovisual model ${this.model}`;
      }
    }

    const videoReferencePlan = buildVideoReferencePlan({
      motionGuide,
      previousAsset,
      maxCombinedSeconds: 15,
    });
    const referenceVideos = videoReferencePlan.references;
    const referenceAudio = [];

    let dialogueTrack = null;
    let actDurationSeconds = Number(segment.durationSeconds);
    // Off-screen narration has no lips to sync, so the exact recording is mixed in
    // after generation instead of asking the video model to re-speak (and garble) it.
    const narrationInPost = this.dialogueMode === 'locked'
      && dialogueTurns.length > 0
      && dialogueTurns.every((turn) => (
        productionScript.characters.find((item) => item.id === turn.speakerCharacterId)?.onScreen === false
      ));
    if (this.dialogueMode === 'locked' && dialogueTurns.length) {
      if (dialogueTurns.length > 1 || speakerIds.length > 1) {
        const turnTracks = [];
        for (const turn of dialogueTurns) {
          const character = productionScript.characters.find(
            (item) => item.id === turn.speakerCharacterId,
          );
          const track = await this.generateDialogueTrack({
            text: turn.text,
            character,
            projectId,
            segmentIndex: segment.index,
            turnIndex: turn.turnIndex,
            downloadLocal: true,
          });
          turnTracks.push({
            ...track,
            turnIndex: turn.turnIndex,
            speakerCharacterId: turn.speakerCharacterId,
            delivery: turn.delivery,
            pauseAfterSeconds: turn.pauseAfterSeconds,
          });
        }

        dialogueTrack = await this.dialogueComposer.compose({
          projectId,
          segmentIndex: segment.index,
          tracks: turnTracks,
        });
        dialogueTrack.speakerMode = 'multi-speaker';
        dialogueTrack.sourceTracks = turnTracks.map((track) => ({
          generationId: track.generationId,
          speakerCharacterId: track.speakerCharacterId,
          voicePresetId: track.voicePresetId,
          exactText: track.exactText,
          localPath: track.localPath,
        }));

        if (dialogueTrack.durationSeconds > 15.05) {
          throw new Error(
            `multi-speaker dialogue master is ${dialogueTrack.durationSeconds}s; locked WAN reference audio must stay within 15 seconds`,
          );
        }
        // Speech length is only known after TTS; stretch the act to fit rather than cut dialogue.
        if (dialogueTrack.durationSeconds > actDurationSeconds + 0.25) {
          actDurationSeconds = Math.ceil(dialogueTrack.durationSeconds + 0.25);
        }
        if (!narrationInPost) referenceAudio.push({ type: 'audio', uri: dialogueTrack.dataUri });
      } else {
        const character = productionScript.characters.find(
          (item) => item.id === dialogueTurns[0].speakerCharacterId,
        ) || primaryCharacter;
        dialogueTrack = await this.generateDialogueTrack({
          text: dialogueTurns[0].text,
          character,
          projectId,
          segmentIndex: segment.index,
          turnIndex: 0,
          downloadLocal: false,
        });
        dialogueTrack.speakerMode = 'single-speaker';
        const spokenSeconds = await this.measureDialogueTrack(dialogueTrack, {
          projectId,
          segmentIndex: segment.index,
        });
        if (spokenSeconds > actDurationSeconds + 0.25) {
          actDurationSeconds = Math.ceil(spokenSeconds + 0.25);
        }
        dialogueTrack.turns = [{
          turnIndex: 0,
          speakerCharacterId: dialogueTurns[0].speakerCharacterId,
          text: dialogueTurns[0].text,
          start: 0,
          end: actDurationSeconds,
          duration: actDurationSeconds,
          voicePresetId: dialogueTrack.voicePresetId,
          delivery: dialogueTurns[0].delivery || '',
        }];
        if (!narrationInPost) referenceAudio.push({ type: 'audio', uri: dialogueTrack.url });
      }
    }

    const promptSegment = motionGuide
      ? {
        ...segment,
        motionGuideDirection: {
          ...(segment.motionGuideDirection || {}),
          poseSummary: motionGuide.poseSummary || null,
        },
      }
      : {
        ...segment,
        motionGuideDirection: {
          ...(segment.motionGuideDirection || {}),
          selectedReference: null,
        },
      };
    const promptText = buildAudiovisualPrompt({
      narrationInPost,
      segment: promptSegment,
      productionScript,
      characters,
      primaryCharacter,
      dialogueTurns,
      dialogueTrack,
      regeneration,
      previousAsset,
    });

    let keyframes = null;
    let keyframeError = null;
    if (segment.keyframeDirection?.enabled && supportsWanKeyframes(this.model)) {
      try {
        keyframes = await this.generateKeyframes({
          segment,
          productionScript,
          storyBible,
          previousAsset,
          regeneration,
          projectId,
        });
      } catch (error) {
        if (!this.keyframeFailOpen) throw error;
        keyframeError = error.message;
      }
    }

    if (segment.keyframeDirection?.enabled && !supportsWanKeyframes(this.model)) {
      keyframeError = `keyframe mode is not enabled for audiovisual model ${this.model}`;
    }

    const duration = clamp(Math.round(actDurationSeconds), 4, 15);
    const keyframePromptImages = [];
    if (keyframes?.first?.url) {
      keyframePromptImages.push({
        uri: keyframes.first.url,
        position: 'first',
      });
    }
    if (keyframes?.last?.url) {
      keyframePromptImages.push({
        uri: keyframes.last.url,
        position: 'last',
      });
    }

    const task = keyframePromptImages.length
      ? await this.createTask('/image_to_video', {
        model: this.model,
        promptImage: keyframePromptImages,
        promptText,
        audio: true,
        duration,
        ratio: this.keyframeVideoRatio,
        ...(referenceVideos.length ? { referenceVideos } : {}),
        ...(referenceAudio.length ? { referenceAudio } : {}),
      })
      : await this.createTask('/text_to_video', {
        model: this.model,
        promptText,
        audio: true,
        duration,
        ratio: this.ratio,
        ...(references.length ? { references } : {}),
        ...(referenceVideos.length ? { referenceVideos } : {}),
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

    let finalPath = localPath;
    if (narrationInPost) {
      if (!dialogueTrack?.localPath) {
        throw new Error(`voiceover act ${segment.index} has no local narration track to mix`);
      }
      finalPath = await this.dialogueComposer.mixVoiceover({
        videoPath: localPath,
        voicePath: dialogueTrack.localPath,
        projectId,
        segmentIndex: segment.index,
        generationId: task.id,
      });
    }

    const multiSpeaker = speakerIds.length > 1;
    return {
      provider: 'runway',
      providerModelId: `runway-${this.model}-audiovisual`,
      type: 'ai-video',
      audioMode: narrationInPost
        ? 'voiceover-post-mix'
        : this.dialogueMode === 'locked'
        ? multiSpeaker
          ? 'locked-multi-speaker-native-mix'
          : 'locked-dialogue-native-mix'
        : multiSpeaker
          ? 'native-multi-speaker'
          : 'native',
      model: this.model,
      localPath: finalPath,
      rawLocalPath: localPath,
      sourceUrl,
      generationId: task.id,
      generatedDuration: `${duration}s`,
      durationSeconds: duration,
      aspectRatio: '9:16',
      prompt: promptText,
      dialogueTrack,
      dialogueTurns: dialogueTrack?.turns || dialogueTurns,
      speakerCharacterIds: speakerIds,
      referenceImageCount: references.length,
      referenceVideoCount: referenceVideos.length,
      referenceAudioCount: referenceAudio.length,
      keyframeMode: keyframes?.last?.url
        ? 'first-last'
        : keyframes?.first?.url
          ? 'first'
          : 'off',
      keyframes,
      keyframeError,
      motionGuideMode: motionGuide ? 'reference-video' : 'off',
      motionGuide,
      motionGuideError,
      referenceVideoPlan: videoReferencePlan.metadata,
      motionControlMode: segment.motionRegionDirection?.enabled
        ? 'semantic-region-prompt'
        : 'off',
      nativeMotionMask: false,
      motionRegionDirection: segment.motionRegionDirection || null,
      referenceImageUrl: keyframes?.first?.url || references[0]?.uri || null,
      referenceEndImageUrl: keyframes?.last?.url || null,
      previousGenerationId: previousAsset?.generationId || null,
    };
  }

  async prepareMotionGuide({
    segment,
    projectId = 'project',
  }) {
    const selected = segment.motionGuideDirection?.selectedReference;
    if (!selected?.url && !selected?.localPath) return null;

    await mkdir(this.assetDir, { recursive: true });
    let localPath;
    let providerUri;
    if (selected.localPath) {
      localPath = path.resolve(selected.localPath);
      if (!(await fileExists(localPath))) {
        throw new Error(`local motion reference is missing: ${localPath}`);
      }
      providerUri = await videoFileToDataUri(
        localPath,
        this.motionGuideMaxDataUriBytes,
      );
    } else {
      localPath = path.join(
        this.assetDir,
        `motion-guide-${safe(selected.id)}-${fingerprint(selected.url)}.mp4`,
      );
      if (!(await fileExists(localPath))) {
        await this.download(selected.url, localPath);
      }
      providerUri = selected.url;
    }

    let poseExtraction = null;
    if (selected.poseSequence || this.poseExtractor?.available) {
      try {
        poseExtraction = await this.poseExtractor.extract(localPath, {
          durationSeconds: selected.durationSeconds,
          embeddedPoseSequence: selected.poseSequence || null,
        });
      } catch (error) {
        poseExtraction = {
          source: 'failed',
          extractor: this.poseExtractor?.command || null,
          sequence: null,
          error: error.message,
        };
      }
    }
    const poseSummary = poseExtraction?.sequence?.frames?.length
      ? summarizePoseSequence(poseExtraction.sequence)
      : null;

    return {
      actionClass: segment.motionGuideDirection.actionClass,
      selectedReference: selected,
      providerUri,
      localPath,
      poseSource: poseExtraction?.source || 'none',
      poseExtractor: poseExtraction?.extractor || null,
      poseSummary,
      poseError: poseExtraction?.error || null,
      projectId,
      segmentIndex: segment.index,
    };
  }

  async generateKeyframes({
    segment,
    productionScript,
    storyBible = null,
    previousAsset = null,
    regeneration = null,
    projectId = 'project',
  }) {
    const prompts = buildKeyframePrompts({
      segment,
      productionScript,
      storyBible,
      previousAsset,
      regeneration,
    });
    if (!prompts.first) return null;

    const references = collectKeyframeReferences(segment, storyBible, previousAsset);
    const first = await this.generateKeyframeImage({
      prompt: prompts.first,
      references,
      projectId,
      segmentIndex: segment.index,
      position: 'first',
    });

    let last = null;
    if (prompts.last) {
      const lastReferences = uniqueTaggedReferences([
        { uri: first.url, tag: 'firstframe' },
        ...references,
      ]).slice(0, 6);
      last = await this.generateKeyframeImage({
        prompt: prompts.last,
        references: lastReferences,
        projectId,
        segmentIndex: segment.index,
        position: 'last',
      });
    }

    return {
      policy: segment.keyframeDirection?.policy || (last ? 'first-last' : 'first'),
      provider: 'runway',
      imageModel: this.imageModel,
      first,
      last,
    };
  }

  async generateKeyframeImage({
    prompt,
    references = [],
    projectId = 'project',
    segmentIndex = 0,
    position = 'first',
  }) {
    const task = await this.createTask('/text_to_image', {
      model: this.imageModel,
      promptText: prompt,
      ratio: this.keyframeImageRatio,
      ...(references.length ? { referenceImages: references } : {}),
    });
    const completed = await this.wait(task.id);
    const url = firstOutputUrl(completed);
    if (!url) {
      throw new Error(`Runway ${position} keyframe task completed without output`);
    }

    return {
      generationId: task.id,
      url,
      prompt,
      position,
      projectId,
      segmentIndex,
    };
  }

  // Best effort: an unmeasured track keeps the planned act duration.
  async measureDialogueTrack(track, { projectId, segmentIndex }) {
    try {
      if (!track.localPath) {
        await mkdir(this.assetDir, { recursive: true });
        const localPath = path.join(
          this.assetDir,
          `dialogue-${safe(projectId)}-${segmentIndex}-0-${track.generationId}.mp3`,
        );
        if (!(await fileExists(localPath))) await this.download(track.url, localPath);
        track.localPath = localPath;
      }
      const seconds = Number(await this.dialogueComposer.probeDuration(
        this.dialogueComposer.ffprobeBin,
        track.localPath,
      ));
      if (!Number.isFinite(seconds) || seconds <= 0) return null;
      track.durationSeconds = seconds;
      return seconds;
    } catch (error) {
      track.durationError = error.message;
      return null;
    }
  }

  async generateDialogueTrack({
    text,
    character,
    projectId = 'project',
    segmentIndex = 0,
    turnIndex = 0,
    downloadLocal = false,
  }) {
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

    let localPath = null;
    if (downloadLocal) {
      await mkdir(this.assetDir, { recursive: true });
      localPath = path.join(
        this.assetDir,
        `dialogue-${safe(projectId)}-${segmentIndex}-${turnIndex}-${task.id}.mp3`,
      );
      if (!(await fileExists(localPath))) await this.download(url, localPath);
    }

    return {
      provider: 'runway',
      model: this.ttsModel,
      generationId: task.id,
      url,
      localPath,
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
  narrationInPost = false,
  segment,
  productionScript,
  characters,
  primaryCharacter,
  dialogueTurns,
  dialogueTrack,
  regeneration,
  previousAsset,
}) {
  const location = productionScript.locations.find((item) => item.id === segment.locationId);
  const timedTurns = Array.isArray(dialogueTrack?.turns) && dialogueTrack.turns.length
    ? dialogueTrack.turns
    : dialogueTurns;
  const multiSpeaker = new Set(
    dialogueTurns.map((turn) => turn.speakerCharacterId),
  ).size > 1;
  const speakerVisibility = timedTurns.map((turn) => (
    characters.find((character) => character.id === turn.speakerCharacterId)?.onScreen !== false
  ));
  const voiceoverOnly = speakerVisibility.length > 0 && speakerVisibility.every((visible) => !visible);
  const mixedSpeakerVisibility = speakerVisibility.some(Boolean)
    && speakerVisibility.some((visible) => !visible);
  const visibleSpeakersOnly = speakerVisibility.length > 0
    && speakerVisibility.every(Boolean);
  const castLines = characters.length
    ? characters.map((character) => (character.onScreen === false
      ? `${character.id.toUpperCase()} = ${character.name}, an unseen voiceover narrator who never appears in frame. Voice: ${character.voice?.description || ''}; delivery: ${character.voice?.delivery || ''}.`
      : `${character.id.toUpperCase()} = ${character.name}. ${character.description}. Physical traits: ${character.physicalTraits}. Exact wardrobe: ${character.wardrobe}. Voice: ${character.voice?.description || ''}; delivery: ${character.voice?.delivery || ''}.`
    ))
    : primaryCharacter
      ? [`${primaryCharacter.id.toUpperCase()} = ${primaryCharacter.name}. ${primaryCharacter.description}. Physical traits: ${primaryCharacter.physicalTraits}. Exact wardrobe: ${primaryCharacter.wardrobe}.`]
      : [];

  const turnPlan = timedTurns.map((turn, index) => {
    const start = Number(turn.start);
    const end = Number(turn.end);
    const timing = Number.isFinite(start) && Number.isFinite(end)
      ? `${start.toFixed(2)}-${end.toFixed(2)}s`
      : `turn ${index + 1}`;
    return `${timing} ${String(turn.speakerCharacterId).toUpperCase()} says exactly: "${turn.text}"`;
  });

  return [
    'Create a single continuous photorealistic vertical short-form video act with synchronized audiovisual output.',
    `ACT PURPOSE: ${segment.purpose}.`,
    castLines.length ? `CAST: ${castLines.join(' | ')}` : '',
    location ? `LOCATION: ${location.name}. ${location.description}. Lighting: ${location.lighting}. Fixed elements: ${location.fixedElements.join(', ')}.` : '',
    `ACTION: ${segment.action}.`,
    segment.shotType ? `SHOT TYPE: ${segment.shotType}.` : '',
    segment.shotType ? shotTypeDirective(segment.shotType) : '',
    `CAMERA: ${segment.camera}.`,
    buildRealismPromptBlock(segment),
    buildMotionRegionPromptBlock(segment),
    buildMotionGuidePromptBlock(segment),
    segment.editing?.allowInternalCuts
      ? `EDITING: internal cuts allowed; maximum ${segment.editing.shotCount || 2} shots. Use only clean motivated cuts.`
      : 'EDITING: ONE continuous shot only. No internal cuts, dissolves, crossfades, flash transitions, ghosting, double exposure or montage.',
    segment.editing?.allowDissolves
      ? 'A motivated dissolve is allowed only if explicitly required by the action.'
      : 'Dissolves and crossfades are forbidden.',
    narrationInPost
      ? 'AUDIO: ambience and sound effects only. No speech, voices, narration, singing or vocal sounds of any kind; the narration is added in post-production. No visible person speaks.'
      : multiSpeaker
        ? voiceoverOnly
          ? 'MULTI-VOICE VOICEOVER PLAN:'
          : mixedSpeakerVisibility
            ? 'MIXED ON-CAMERA / VOICEOVER PLAN:'
            : 'MULTI-SPEAKER DIALOGUE BLOCKING:'
        : 'EXACT SPOKEN DIALOGUE:',
    ...(narrationInPost ? [] : turnPlan),
    multiSpeaker && visibleSpeakersOnly
      ? 'Turn-taking is strict and non-overlapping. During each line, ONLY the named active visible speaker talks and moves their mouth as speech. Other visible characters listen/react silently with closed or naturally resting mouths. Never swap speakers, voices, faces, or lines.'
      : '',
    voiceoverOnly && !narrationInPost
      ? 'VOICEOVER: all dialogue is off-screen narration. No visible person speaks or lip-syncs; keep the picture on the described action.'
      : '',
    mixedSpeakerVisibility
      ? 'MIXED DIALOGUE: visible-speaker turns must lip-sync only the named visible character. Off-screen narrator turns must remain disembodied voiceover; no visible character may mouth those lines. Keep turn ownership exact and non-overlapping.'
      : '',
    narrationInPost
      ? ''
      : dialogueTrack
      ? multiSpeaker && visibleSpeakersOnly
        ? 'The supplied audio reference is the exact composed dialogue master containing the named visible characters in the exact turn order above. Treat it as the timing master. Preserve every word and assign each audible voice to the matching visible character.'
        : voiceoverOnly
          ? 'The supplied audio reference contains the exact off-screen voiceover master. Preserve every word and keep every narrator off camera.'
          : mixedSpeakerVisibility
            ? 'The supplied audio reference is the exact mixed dialogue master. Preserve every word; synchronize visible-speaker turns to their matching visible character and keep off-screen narrator turns as voiceover with no visible mouth movement.'
            : 'The supplied audio reference contains the exact spoken dialogue performance. Preserve those words verbatim and synchronize the visible speaker naturally to that performance.'
      : 'Generate natural synchronized speech using the exact dialogue turns above. Do not paraphrase, omit, summarize, add words, swap voices, or create crosstalk.',
    `AMBIENCE: ${segment.ambience}.`,
    segment.soundEffects.length ? `SOUND EFFECTS: ${segment.soundEffects.join('; ')}.` : '',
    segment.music ? `MUSIC: ${segment.music}. Keep it below dialogue.` : '',
    `GLOBAL VISUAL STYLE: ${productionScript.visualStyle.description}. ${productionScript.visualStyle.cameraRules}. ${productionScript.visualStyle.lightingRules}.`,
    `AUDIO MIX: ${productionScript.audioDirection.mix}. ${productionScript.audioDirection.musicPolicy}.`,
    previousAsset ? 'The previous accepted act is supplied as a video reference. Match its recurring character identity, apparent age, face geometry, hair, body proportions, wardrobe, environment anchors, lighting and visual language exactly.' : '',
    regeneration?.guidance ? `QC CORRECTION: ${regeneration.guidance}` : '',
    'No on-screen text, captions, logos, watermarks, CGI look, anatomy errors, face morphing, flicker, or unexplained cuts.',
  ].filter(Boolean).join(' ');
}

function normalizedDialogueTurns(segment, productionScript) {
  if (Array.isArray(segment.dialogueTurns) && segment.dialogueTurns.length) {
    return segment.dialogueTurns
      .filter((turn) => (
        productionScript.characters.some((character) => character.id === turn.speakerCharacterId)
        && String(turn.text || '').trim()
      ))
      .slice(0, 5);
  }

  if (!segment.dialogue) return [];
  const speakerCharacterId = segment.speakerCharacterId
    || segment.characterIds?.[0]
    || productionScript.characters[0]?.id;
  if (!speakerCharacterId) return [];

  return [{
    turnIndex: 0,
    speakerCharacterId,
    text: segment.dialogue,
    delivery: '',
    pauseAfterSeconds: 0,
  }];
}

export function buildVideoReferencePlan({
  motionGuide = null,
  previousAsset = null,
  maxCombinedSeconds = 15,
} = {}) {
  const candidates = [];
  const motionGuideUri = motionGuide?.providerUri
    || motionGuide?.selectedReference?.url;
  if (motionGuideUri) {
    candidates.push({
      role: 'motion-guide',
      uri: motionGuideUri,
      durationSeconds: Number(motionGuide.selectedReference.durationSeconds) || 0,
    });
  }
  if (previousAsset?.sourceUrl) {
    candidates.push({
      role: 'previous-act',
      uri: previousAsset.sourceUrl,
      durationSeconds: parseVideoDuration(previousAsset),
    });
  }

  const selected = [];
  let totalDurationSeconds = 0;
  for (const candidate of candidates) {
    if (!candidate.uri || selected.some((item) => item.uri === candidate.uri)) continue;
    const duration = Math.max(0, Number(candidate.durationSeconds) || 0);
    if (duration > 0 && totalDurationSeconds + duration > maxCombinedSeconds + 1e-9) {
      continue;
    }
    selected.push(candidate);
    totalDurationSeconds += duration;
  }

  return {
    references: selected.map((item) => ({ type: 'video', uri: item.uri })),
    metadata: {
      maxCombinedSeconds,
      totalDurationSeconds: Math.round(totalDurationSeconds * 1000) / 1000,
      roles: selected.map((item) => item.role),
      droppedRoles: candidates
        .filter((candidate) => !selected.some((item) => item.role === candidate.role))
        .map((item) => item.role),
    },
  };
}

function parseVideoDuration(asset) {
  const direct = Number(asset?.durationSeconds);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const match = String(asset?.generatedDuration || '').match(/([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : 15;
}

async function videoFileToDataUri(filePath, maxSourceBytes) {
  const info = await stat(filePath);
  if (info.size > maxSourceBytes) {
    throw new Error(
      `local motion reference is ${info.size} bytes; exceeds safe data-URI source budget ${maxSourceBytes}`,
    );
  }
  const bytes = await readFile(filePath);
  const encoded = bytes.toString('base64');
  const uri = `data:video/mp4;base64,${encoded}`;
  if (Buffer.byteLength(uri) > 5000000) {
    throw new Error('encoded local motion reference exceeds Runway 5MB data-URI limit');
  }
  return uri;
}

function supportsMotionGuide(model) {
  return ['wan3', 'wan3_prime'].includes(String(model || '').toLowerCase());
}

function collectKeyframeReferences(segment, storyBible, previousAsset) {
  const refs = [];
  let characterIndex = 0;
  for (const characterId of segment.characterIds || []) {
    for (const image of storyBible?.references?.characters?.[characterId]?.images || []) {
      if (image.url) {
        refs.push({
          uri: image.url,
          tag: `character${characterIndex++}`,
        });
      }
    }
  }

  const location = storyBible?.references?.locations?.[segment.locationId];
  if (location?.url) refs.push({ uri: location.url, tag: 'location' });

  const previousEnd = previousAsset?.keyframes?.last?.url
    || previousAsset?.referenceEndImageUrl
    || previousAsset?.referenceImageUrl;
  if (previousEnd) refs.push({ uri: previousEnd, tag: 'previousact' });

  return uniqueTaggedReferences(refs).slice(0, 6);
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

function uniqueTaggedReferences(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.uri || seen.has(item.uri)) return false;
    seen.add(item.uri);
    return true;
  });
}

function shotTypeDirective(shotType) {
  const directives = {
    'wide-establishing': 'FRAMING CONTRACT: show the complete primary subject/mechanism plus meaningful surrounding environment. Keep generous context around it; do not crop into a medium or close framing.',
    'close-up': 'FRAMING CONTRACT: move materially closer than an establishing shot. The primary face, object, or mechanism should dominate the frame with much less environment visible.',
    'medium': 'FRAMING CONTRACT: use a true medium composition between wide and close-up. Show the primary subject clearly while retaining some contextual environment.',
    'macro-detail': 'FRAMING CONTRACT: use an extreme detail view of the exact mechanism/action being explained. Exclude most of the wider environment so this cannot resemble the establishing composition.',
    'tracking': 'FRAMING CONTRACT: create a clearly moving tracking composition with noticeable parallax or lateral/forward camera travel while keeping the subject readable. Do not render a static tripod-like view.',
    'overhead': 'FRAMING CONTRACT: use a clearly elevated top-down or steep high-angle view. The camera axis must be materially different from eye-level or side-on shots.',
    'pov': 'FRAMING CONTRACT: use a first-person/subjective perspective from the participant or observer position. Do not render a conventional detached third-person composition.',
  };
  return directives[String(shotType || '').toLowerCase()] || '';
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

function safe(value) {
  return String(value || 'project').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 100);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function supportsWanKeyframes(model) {
  return ['wan3', 'wan3_prime'].includes(String(model || '').toLowerCase());
}

function parseBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

async function fileExists(file) {
  try { await stat(file); return true; } catch { return false; }
}
