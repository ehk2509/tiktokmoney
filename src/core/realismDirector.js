const COMPLEX_INTERACTION_PATTERNS = [
  /pick(?:s|ing)? up/i,
  /grab(?:s|bing)?/i,
  /drink(?:s|ing)?/i,
  /pour(?:s|ing)?/i,
  /tie(?:s|ing)?/i,
  /lace(?:s|ing)?/i,
  /handshake|shake hands/i,
  /open(?:s|ing)? .*door/i,
  /close(?:s|ing)? .*door/i,
  /use(?:s|ing)? .*phone/i,
  /hold(?:s|ing)? .*glass|cup|bottle/i,
];

const ACTION_PATTERNS = [
  /run(?:s|ning)?|sprint|jump|workout|training|exercise|lift|squat|deadlift|boxing|football|basketball/i,
];

const CAMERA_COMPLEXITY_PATTERNS = [
  /360|orbit|crane|drone|whip pan|rapid zoom|dolly zoom|spiral|rotation/i,
];

export class RealismDirector {
  constructor({
    enabled = envBool(process.env.ANTI_PLASTIC_REALISM_ENABLED, true),
    maxShotsPerAct = Number(process.env.REALISM_MAX_SHOTS_PER_ACT || 3),
    defaultProfile = process.env.REALISM_CAPTURE_PROFILE || 'auto',
  } = {}) {
    this.enabled = Boolean(enabled);
    this.maxShotsPerAct = clampInt(maxShotsPerAct, 1, 4, 3);
    this.defaultProfile = defaultProfile;
  }

  direct(script) {
    if (!this.enabled || !script?.segments?.length) {
      return {
        ...script,
        realismDirection: {
          enabled: false,
          profile: 'none',
          outputFrameRate: 30,
        },
      };
    }

    const profile = chooseCaptureProfile(script, this.defaultProfile);
    const profileConfig = captureProfile(profile);
    const segments = script.segments.map((segment) => (
      directSegment(segment, {
        profile,
        profileConfig,
        maxShotsPerAct: this.maxShotsPerAct,
      })
    ));

    return {
      ...script,
      realismDirection: {
        enabled: true,
        profile,
        outputFrameRate: profileConfig.frameRate,
        philosophy: 'physical-camera realism over synthetic perfection',
        postProfile: {
          opticalSoftness: profileConfig.opticalSoftness,
          saturation: profileConfig.saturation,
          contrast: profileConfig.contrast,
          grainStrength: profileConfig.grainStrength,
          chromaticAberrationPx: profileConfig.chromaticAberrationPx,
          motionBlur: false,
        },
      },
      visualStyle: {
        ...script.visualStyle,
        description: removePlasticKeywords(script.visualStyle?.description),
        cameraRules: [
          removePlasticKeywords(script.visualStyle?.cameraRules),
          profileConfig.globalCameraRule,
        ].filter(Boolean).join(' '),
        lightingRules: [
          removePlasticKeywords(script.visualStyle?.lightingRules),
          'Use motivated practical or natural light with believable falloff, mild exposure variation, and no glossy beauty-lighting sheen.',
        ].filter(Boolean).join(' '),
      },
      segments,
    };
  }
}

export function directSegment(segment, {
  profile = 'organic-documentary',
  profileConfig = captureProfile(profile),
  maxShotsPerAct = 3,
} = {}) {
  const action = String(segment.action || '');
  const camera = String(segment.camera || '');
  const complexInteraction = COMPLEX_INTERACTION_PATTERNS.some((pattern) => pattern.test(action));
  const actionHeavy = ACTION_PATTERNS.some((pattern) => pattern.test(action));
  const complexCamera = CAMERA_COMPLEXITY_PATTERNS.some((pattern) => pattern.test(camera));
  const multiSpeaker = segment.speakerMode === 'multi-speaker'
    || new Set((segment.dialogueTurns || []).map((turn) => turn.speakerCharacterId)).size > 1;

  let riskScore = 18;
  if (complexInteraction) riskScore += 34;
  if (actionHeavy) riskScore += 20;
  if (complexCamera) riskScore += 26;
  if ((segment.characterIds || []).length > 1) riskScore += 14;
  if (multiSpeaker) riskScore += 10;
  riskScore = clamp(riskScore, 0, 100);

  const stableShotSeconds = riskScore >= 70
    ? 2.2
    : riskScore >= 50
      ? 3
      : riskScore >= 32
        ? 4
        : 5.5;
  const recommendedShots = clampInt(
    Math.ceil((Number(segment.durationSeconds) || 5) / stableShotSeconds),
    1,
    maxShotsPerAct,
    1,
  );

  const axis = chooseCameraAxis(camera, profileConfig.defaultAxis);
  const microMotion = chooseMicroMotion(segment, { actionHeavy });
  const soundscape = buildSoundscape(segment, { actionHeavy, complexInteraction });
  const highRisk = riskScore >= 50;

  return {
    ...segment,
    action: removePlasticKeywords(segment.action),
    camera: removePlasticKeywords(segment.camera),
    ambience: removePlasticKeywords(segment.ambience),
    editing: {
      ...segment.editing,
      allowDissolves: false,
      allowInternalCuts: highRisk ? recommendedShots > 1 : Boolean(segment.editing?.allowInternalCuts),
      shotCount: highRisk ? recommendedShots : Math.max(1, Number(segment.editing?.shotCount) || 1),
    },
    realismDirection: {
      profile,
      riskScore,
      riskLevel: riskScore >= 70 ? 'very-high' : riskScore >= 50 ? 'high' : riskScore >= 32 ? 'medium' : 'low',
      complexInteraction,
      complexCamera,
      actionHeavy,
      stableShotSeconds,
      recommendedShots,
      camera: {
        fieldOfView: profileConfig.fieldOfView,
        apertureLook: profileConfig.apertureLook,
        support: profileConfig.support,
        axis,
        movement: cameraMovement(axis, profileConfig),
        operatorImperfection: profileConfig.operatorImperfection,
        forbidden: [
          'compound orbit + zoom + tilt moves',
          'impossible 360-degree camera travel',
          'perfect floating gimbal motion unless explicitly motivated',
        ],
      },
      lighting: {
        direction: 'motivated by visible windows, practical lamps, or believable environment sources',
        imperfection: 'allow mild natural falloff, tiny exposure breathing, soft shadow variation, and realistic highlight clipping',
        forbidden: [
          'uniform beauty lighting',
          'glossy plastic skin',
          'neon HDR sheen unless the location physically contains it',
        ],
      },
      humanMotion: {
        rule: highRisk
          ? 'one primary physical action at a time; separate hand/object interactions into distinct beats'
          : 'keep body mechanics natural with small posture corrections and breathing',
        maxComplexActionsPerShot: highRisk ? 1 : 2,
        preserveWeight: true,
      },
      microMotion,
      soundscape,
      post: {
        opticalSoftness: profileConfig.opticalSoftness,
        saturation: profileConfig.saturation,
        contrast: profileConfig.contrast,
        grainStrength: profileConfig.grainStrength,
        chromaticAberrationPx: profileConfig.chromaticAberrationPx,
        motionBlur: false,
      },
    },
  };
}

export function buildRealismPromptBlock(segment) {
  const direction = segment?.realismDirection;
  if (!direction) return '';

  const micro = direction.microMotion || [];
  const soundscape = direction.soundscape || {};

  return [
    'ANTI-PLASTIC REALISM DIRECTION:',
    `Capture profile: ${direction.profile}.`,
    `Physical camera: ${direction.camera.fieldOfView}; ${direction.camera.apertureLook}; ${direction.camera.support}.`,
    `Camera move: ${direction.camera.movement}. ${direction.camera.operatorImperfection}.`,
    `Human motion: ${direction.humanMotion.rule}.`,
    micro.length ? `Environmental micro-motion: ${micro.join('; ')}.` : '',
    `Lighting: ${direction.lighting.direction}; ${direction.lighting.imperfection}.`,
    direction.editingNote || '',
    soundscape.roomTone ? `ROOM TONE: ${soundscape.roomTone}.` : '',
    soundscape.foley?.length ? `SYNCED FOLEY: ${soundscape.foley.join('; ')}.` : '',
    soundscape.background?.length ? `BACKGROUND SOUND: ${soundscape.background.join('; ')}.` : '',
    'Avoid beauty-retouched skin, waxy texture, oversharpened edges, excessive saturation, perfect stabilization, synthetic slow-motion float, and decorative CGI particles.',
  ].filter(Boolean).join(' ');
}

export function captureProfile(name) {
  const profiles = {
    'organic-smartphone': {
      frameRate: 30,
      fieldOfView: 'natural smartphone main-camera field of view, roughly 24-28mm equivalent',
      apertureLook: 'moderate depth of field with imperfect phone-camera focus transitions',
      support: 'handheld phone camera',
      defaultAxis: 'follow',
      operatorImperfection: 'subtle hand drift, tiny reframing corrections, and realistic autofocus/exposure settling',
      globalCameraRule: 'Prefer believable handheld smartphone framing over cinematic floating moves.',
      opticalSoftness: 0.18,
      saturation: 0.96,
      contrast: 0.99,
      grainStrength: 1.2,
      chromaticAberrationPx: 0,
    },
    'fitness-action': {
      frameRate: 30,
      fieldOfView: 'natural 28-35mm equivalent field of view',
      apertureLook: 'moderate depth of field so body mechanics remain readable',
      support: 'light handheld or shoulder-level camera',
      defaultAxis: 'tracking',
      operatorImperfection: 'small operator bounce consistent with footsteps; no floating slow-motion drift',
      globalCameraRule: 'Keep action readable, grounded, and slightly imperfect rather than hyper-smooth.',
      opticalSoftness: 0.12,
      saturation: 0.96,
      contrast: 1,
      grainStrength: 0.8,
      chromaticAberrationPx: 0,
    },
    cinematic: {
      frameRate: 24,
      fieldOfView: 'natural 35mm-equivalent field of view',
      apertureLook: 'subtle shallow depth of field, not extreme subject cutout',
      support: 'human-operated handheld or restrained tripod/dolly',
      defaultAxis: 'slow-track',
      operatorImperfection: 'tiny focus breathing and human-operated framing adjustments',
      globalCameraRule: 'Use one restrained physical camera move at a time.',
      opticalSoftness: 0.28,
      saturation: 0.95,
      contrast: 0.98,
      grainStrength: 1.7,
      chromaticAberrationPx: 0,
    },
    'organic-documentary': {
      frameRate: 24,
      fieldOfView: 'natural 35-50mm documentary field of view',
      apertureLook: 'moderate natural depth of field with realistic focus falloff',
      support: 'human-operated documentary handheld camera',
      defaultAxis: 'slow-track',
      operatorImperfection: 'subtle operator sway, small horizon drift, and minor reframing corrections',
      globalCameraRule: 'Use restrained documentary camera physics and never combine several complex moves.',
      opticalSoftness: 0.22,
      saturation: 0.95,
      contrast: 0.99,
      grainStrength: 1.4,
      chromaticAberrationPx: 0,
    },
  };
  return profiles[name] || profiles['organic-documentary'];
}

function chooseCaptureProfile(script, requested) {
  if (requested && requested !== 'auto') return captureProfile(requested) ? requested : 'organic-documentary';
  const haystack = [
    script.topic,
    script.synopsis,
    ...(script.segments || []).flatMap((segment) => [segment.action, segment.camera]),
  ].join(' ');
  if (ACTION_PATTERNS.some((pattern) => pattern.test(haystack))) return 'fitness-action';
  if ((script.segments || []).some((segment) => segment.speakerMode === 'multi-speaker')) {
    return 'organic-smartphone';
  }
  if (/cinematic|film|dramatic|moody/i.test(haystack)) return 'cinematic';
  return 'organic-documentary';
}

function chooseCameraAxis(camera, fallback) {
  const value = String(camera || '');
  if (/pan left|pan right/i.test(value)) return 'pan';
  if (/track|follow|walk with/i.test(value)) return 'tracking';
  if (/push|dolly in/i.test(value)) return 'push-in';
  if (/locked|tripod|static/i.test(value)) return 'locked';
  return fallback;
}

function cameraMovement(axis, profile) {
  const mapping = {
    pan: 'one slow horizontal pan only; keep lens height and distance physically consistent',
    tracking: 'one gentle tracking/follow movement at human walking speed',
    follow: 'small handheld follow movement with believable operator inertia',
    'push-in': 'one slow physical push-in; no simultaneous orbit or zoom',
    locked: 'mostly locked framing with tiny human-operated corrections',
    'slow-track': 'one restrained slow tracking movement',
  };
  return mapping[axis] || mapping[profile.defaultAxis] || mapping['slow-track'];
}

function chooseMicroMotion(segment, { actionHeavy }) {
  const locationText = `${segment.ambience || ''} ${segment.action || ''}`.toLowerCase();
  const output = ['subtle breathing and posture micro-adjustments'];

  if (/outdoor|street|park|outside|wind|beach|forest/.test(locationText)) {
    output.push('light wind affects loose hair and fabric');
  }
  if (/window|sun|daylight/.test(locationText)) {
    output.push('tiny natural exposure change as subjects move relative to the light');
  }
  if (/gym|training|workout/.test(locationText)) {
    output.push('clothing settles after movement and muscles carry believable weight/inertia');
  }
  if (/room|office|home|studio|indoor/.test(locationText)) {
    output.push('small background activity such as curtain, monitor, or distant practical-light variation only when physically motivated');
  }
  if (actionHeavy) {
    output.push('foot contact, balance recovery, and body momentum follow real gravity');
  }
  return output.slice(0, 4);
}

function buildSoundscape(segment, { actionHeavy, complexInteraction }) {
  const text = `${segment.ambience || ''} ${segment.action || ''}`.toLowerCase();
  let roomTone = 'quiet location-specific air and distant environmental presence';
  const foley = ['subtle clothing friction', 'natural breathing'];
  const background = [];

  if (/street|traffic|city|road/.test(text)) {
    roomTone = 'distant city/traffic bed with believable perspective';
    background.push('far vehicles and diffuse urban reflections');
  } else if (/gym|workout|training/.test(text)) {
    roomTone = 'real gym room tone with distant equipment and ventilation';
    foley.push('foot contact on gym flooring');
    background.push('very distant equipment movement, never louder than dialogue');
  } else if (/home|room|office|studio|indoor/.test(text)) {
    roomTone = 'low indoor HVAC/room tone matched to the apparent room size';
  } else if (/outdoor|park|forest|beach/.test(text)) {
    roomTone = 'natural outdoor ambience with light air movement';
    background.push('distant environment appropriate to the visible location');
  }

  if (actionHeavy) foley.push('weight shift and footfall synchronized to movement');
  if (complexInteraction) foley.push('one restrained object-contact sound exactly at the visible contact');

  return {
    roomTone,
    foley: [...new Set(foley)].slice(0, 5),
    background: [...new Set(background)].slice(0, 3),
    musicRule: 'music remains secondary and must not replace real environmental sound',
  };
}

function removePlasticKeywords(value) {
  return String(value || '')
    .replace(/\b(?:hyperrealistic|ultra[- ]?realistic|8k|4k|trending on artstation|masterpiece|best quality)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function envBool(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
