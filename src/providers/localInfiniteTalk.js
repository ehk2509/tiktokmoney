// Lip-sync pass for local audiovisual clips: keep the video model's voice/ambience and
// re-render the speaker with Wan 2.1 InfiniteTalk (ComfyUI core node), which drives the
// mouth from the audio. Chunks are 81 frames; each extension re-uses the last
// `motionFrames` frames as context and those overlap frames are trimmed.

export const INFINITETALK_FPS = 25;
export const INFINITETALK_CHUNK = 81;

export function infiniteTalkPassCount(seconds, { chunk = INFINITETALK_CHUNK, motionFrames = 9 } = {}) {
  const needed = Math.ceil(Number(seconds) * INFINITETALK_FPS) + 1;
  if (needed <= chunk) return 1;
  return 1 + Math.ceil((needed - chunk) / (chunk - motionFrames));
}

export function infiniteTalkFrameCount(passes, { chunk = INFINITETALK_CHUNK, motionFrames = 9 } = {}) {
  return chunk + (passes - 1) * (chunk - motionFrames);
}

// Builds an API-format ComfyUI graph. Inputs are names of files already uploaded to
// ComfyUI's input folder: the start image and the (silence-padded) driving audio.
export function buildInfiniteTalkWorkflow({
  startImage, drivingAudio, outputAudio, prompt, seed, passes, width, height,
  models, steps = 6, motionFrames = 9, audioScale = 1, filenamePrefix = 'tiktokmoney/infinitetalk',
}) {
  const w = {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: models.unet, weight_dtype: 'default' } },
    lora: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['unet', 0], lora_name: models.lora, strength_model: 1 } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: models.textEncoder, type: 'wan', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
    patch: { class_type: 'ModelPatchLoader', inputs: { name: models.patch } },
    audioEncoder: { class_type: 'AudioEncoderLoader', inputs: { audio_encoder_name: models.audioEncoder } },
    image: { class_type: 'LoadImage', inputs: { image: startImage } },
    audio: { class_type: 'LoadAudio', inputs: { audio: drivingAudio } },
    outAudio: { class_type: 'LoadAudio', inputs: { audio: outputAudio || drivingAudio } },
    encoded: { class_type: 'AudioEncoderEncode', inputs: { audio_encoder: ['audioEncoder', 0], audio: ['audio', 0] } },
    positive: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['clip', 0] } },
    negative: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['positive', 0] } },
  };
  let frames = null; // node id holding all frames generated so far
  for (let pass = 0; pass < passes; pass += 1) {
    const p = 'p' + pass;
    w[p + 'talk'] = {
      class_type: 'WanInfiniteTalkToVideo',
      inputs: {
        mode: 'single_speaker',
        model: ['lora', 0], model_patch: ['patch', 0],
        positive: ['positive', 0], negative: ['negative', 0], vae: ['vae', 0],
        width, height, length: INFINITETALK_CHUNK,
        audio_encoder_output_1: ['encoded', 0],
        motion_frame_count: motionFrames, audio_scale: audioScale,
        start_image: ['image', 0],
        ...(frames ? { previous_frames: [frames, 0] } : {}),
      },
    };
    w[p + 'noise'] = { class_type: 'RandomNoise', inputs: { noise_seed: seed + pass } };
    w[p + 'sampler'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } };
    w[p + 'sigmas'] = { class_type: 'BasicScheduler', inputs: { model: [p + 'talk', 0], scheduler: 'normal', steps, denoise: 1 } };
    w[p + 'guider'] = { class_type: 'CFGGuider', inputs: { model: [p + 'talk', 0], positive: [p + 'talk', 1], negative: [p + 'talk', 2], cfg: 1 } };
    w[p + 'sample'] = {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: [p + 'noise', 0], guider: [p + 'guider', 0], sampler: [p + 'sampler', 0], sigmas: [p + 'sigmas', 0], latent_image: [p + 'talk', 3] },
    };
    w[p + 'decode'] = { class_type: 'VAEDecode', inputs: { samples: [p + 'sample', 0], vae: ['vae', 0] } };
    if (!frames) {
      frames = p + 'decode';
    } else {
      // Drop the repeated motion-context frames, then append to everything so far.
      w[p + 'trim'] = { class_type: 'ImageFromBatch', inputs: { image: [p + 'decode', 0], batch_index: motionFrames, length: INFINITETALK_CHUNK } };
      w[p + 'all'] = { class_type: 'ImageBatch', inputs: { image1: [frames, 0], image2: [p + 'trim', 0] } };
      frames = p + 'all';
    }
  }
  w.video = { class_type: 'CreateVideo', inputs: { images: [frames, 0], fps: INFINITETALK_FPS, audio: ['outAudio', 0] } };
  w.save = { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: filenamePrefix, format: 'auto', 'format.codec': 'auto', codec: 'auto' } };
  return w;
}

export function buildInfiniteTalkPrompt({ segment, productionScript, storyBible }) {
  const characters = storyBible?.characters || productionScript?.characters || [];
  const speakerId = segment.dialogueTurns?.[0]?.speakerCharacterId || segment.speakerCharacterId;
  const speaker = characters.find((c) => c.id === speakerId) || characters.find((c) => (segment.characterIds || []).includes(c.id));
  const location = (storyBible?.locations || productionScript?.locations || []).find((l) => l.id === segment.locationId);
  return [
    'A person talks directly to the camera in a calm, natural conversational way, with small natural head movements and blinking.',
    speaker ? [speaker.name, speaker.description].filter(Boolean).join(', ') + '.' : '',
    location?.description ? 'Setting: ' + location.description + '.' : '',
    'Static camera, single continuous shot, photorealistic.',
  ].filter(Boolean).join(' ');
}
