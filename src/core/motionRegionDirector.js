const SPEECH_REGION = {
  id: 'speech-mouth-jaw',
  region: 'active speaker mouth and jaw',
  behavior: 'speech articulation only, synchronized to the assigned dialogue turn',
  intensity: 'low',
};

export class MotionRegionDirector {
  constructor({
    enabled = envBool(process.env.MOTION_REGION_CONTROL_ENABLED, true),
    mode = process.env.MOTION_REGION_MODE || 'semantic',
    backgroundLock = envBool(process.env.MOTION_REGION_BACKGROUND_LOCK, true),
    faceLock = envBool(process.env.MOTION_REGION_FACE_LOCK, true),
  } = {}) {
    this.enabled = Boolean(enabled);
    this.mode = normalizeMode(mode);
    this.backgroundLock = Boolean(backgroundLock);
    this.faceLock = Boolean(faceLock);
  }

  direct(script) {
    if (!script?.segments?.length) return script;

    const segments = script.segments.map((segment) => (
      directMotionRegions(segment, {
        enabled: this.enabled,
        mode: this.mode,
        backgroundLock: this.backgroundLock,
        faceLock: this.faceLock,
      })
    ));

    return {
      ...script,
      motionRegionDirection: {
        enabled: this.enabled,
        mode: this.mode,
        controlType: this.enabled ? 'semantic-region-control' : 'off',
        nativeSpatialMask: false,
        actsControlled: segments.filter((segment) => segment.motionRegionDirection?.enabled).length,
      },
      segments,
    };
  }
}

export function directMotionRegions(segment, {
  enabled = true,
  mode = 'semantic',
  backgroundLock = true,
  faceLock = true,
} = {}) {
  if (!enabled || normalizeMode(mode) === 'off') {
    return {
      ...segment,
      motionRegionDirection: {
        enabled: false,
        mode: 'off',
        controlType: 'off',
        nativeSpatialMask: false,
        allowedMotion: [],
        lockedRegions: [],
      },
    };
  }

  const action = String(segment.action || '').toLowerCase();
  const direction = segment.realismDirection || {};
  const cameraAxis = direction.camera?.axis || 'locked';
  const cameraMoving = !['locked', 'static', 'tripod'].includes(cameraAxis);
  const complexInteraction = Boolean(direction.complexInteraction)
    || /pick|grab|hold|pour|drink|open|close|phone|cup|glass|bottle|dumbbell|tool/i.test(action);
  const actionHeavy = Boolean(direction.actionHeavy)
    || /run|jump|squat|lift|deadlift|boxing|dance|sprint|throw|kick/i.test(action);
  // Everyday whole-body movement must not be locked to breathing micro-motion.
  const bodyMovement = !actionHeavy
    && /\b(walk|stride|step|stand(?:s|ing)? up|rises?|gets? up|turns?|pivots?|paces?|huddles?|gathers?|circles?|approach(?:es)?|moves? (?:to|toward|towards|across|into|forward|closer)|lean(?:s|ing)?|kneel|crouch|sit(?:s)? down|stack|hands? in)/i.test(action);
  const multiSpeaker = segment.speakerMode === 'multi-speaker'
    || new Set((segment.dialogueTurns || []).map((turn) => turn.speakerCharacterId)).size > 1;
  const hasSpeech = Boolean(
    String(segment.dialogue || '').trim()
    || (segment.dialogueTurns || []).some((turn) => String(turn.text || '').trim()),
  );

  const allowedMotion = [];
  const lockedRegions = [];

  if (hasSpeech) allowedMotion.push(SPEECH_REGION);

  if (complexInteraction) {
    allowedMotion.push({
      id: 'hands-primary-prop',
      region: 'hands, wrists, forearms, and only the primary manipulated object',
      behavior: 'execute the single planned object interaction with continuous contact and believable grip',
      intensity: 'medium',
    });
  }

  if (actionHeavy) {
    allowedMotion.push({
      id: 'body-action-chain',
      region: 'hips, torso, legs, arms and feet required by the planned athletic/body action',
      behavior: 'move as one biomechanical chain with gravity, inertia, foot contact and balance recovery',
      intensity: 'high',
    });
  } else if (bodyMovement) {
    allowedMotion.push({
      id: 'body-movement',
      region: 'legs, feet, hips, torso and arms required by the planned movement',
      behavior: 'natural walking, standing, turning or gathering with grounded foot contact and steady balance',
      intensity: 'medium',
    });
  } else {
    allowedMotion.push({
      id: 'posture-micro-motion',
      region: 'shoulders and upper torso',
      behavior: 'tiny breathing and natural posture correction only',
      intensity: 'very-low',
    });
  }

  const microText = (direction.microMotion || []).join(' ').toLowerCase();
  if (/hair|fabric|clothing/.test(microText)) {
    allowedMotion.push({
      id: 'hair-fabric',
      region: 'loose hair and loose fabric only',
      behavior: 'small physically motivated secondary motion from body movement or visible airflow',
      intensity: 'low',
    });
  }

  if (/curtain|foliage|leaf|tree|water|smoke|steam|wind|airflow/.test(microText)) {
    allowedMotion.push({
      id: 'environment-micro-motion',
      region: 'only environmental elements explicitly motivated by airflow or visible physics',
      behavior: 'subtle secondary motion; do not animate unrelated background objects',
      intensity: 'low',
    });
  }

  if (faceLock) {
    lockedRegions.push({
      id: 'face-identity',
      region: hasSpeech
        ? 'face geometry excluding mouth/jaw articulation'
        : 'entire face geometry',
      rule: 'preserve eye spacing, nose, cheeks, jaw identity, apparent age, hairline and skin structure; no morphing',
      tolerance: 'identity-locked',
    });
  }

  if (!actionHeavy && !bodyMovement) {
    lockedRegions.push({
      id: 'body-shape',
      region: complexInteraction
        ? 'torso, hips and legs not required by the hand/object interaction'
        : 'body silhouette outside breathing/posture micro-motion',
      rule: 'do not stretch, resize, melt, sway or drift',
      tolerance: 'micro-only',
    });
  }

  if (multiSpeaker) {
    lockedRegions.push({
      id: 'inactive-speakers',
      region: 'all non-active speakers during another character dialogue turn',
      rule: 'mouth closed/resting; preserve face identity and body position; allow only subtle listening reactions',
      tolerance: 'reaction-only',
    });
  }

  if (backgroundLock) {
    lockedRegions.push({
      id: 'environment-anchors',
      region: 'walls, doors, windows, furniture, equipment and fixed architecture',
      rule: cameraMoving
        ? 'geometry must remain rigid; screen-space movement may occur only from correct camera parallax'
        : 'keep anchor geometry and screen-space position stable; no breathing, warping or sliding',
      tolerance: cameraMoving ? 'parallax-only' : 'locked',
    });
    lockedRegions.push({
      id: 'unmotivated-background',
      region: 'all background objects not named in allowed motion regions',
      rule: 'remain static unless motion is physically caused by the visible scene',
      tolerance: 'locked',
    });
  }

  const allowedIds = [...new Set(allowedMotion.map((item) => item.id))];
  const lockedIds = [...new Set(lockedRegions.map((item) => item.id))];

  return {
    ...segment,
    motionRegionDirection: {
      enabled: true,
      mode: normalizeMode(mode),
      controlType: 'semantic-region-control',
      nativeSpatialMask: false,
      cameraMoving,
      allowedMotion: dedupeById(allowedMotion),
      lockedRegions: dedupeById(lockedRegions),
      allowedRegionIds: allowedIds,
      lockedRegionIds: lockedIds,
      globalRule: [
        'Motion is sparse and intentional.',
        'Only the allowed regions may perform visible subject/environment motion.',
        'Locked regions preserve geometry and identity.',
        cameraMoving
          ? 'Camera-induced parallax is allowed but does not count as object motion.'
          : 'The background must not drift, breathe, pulse or subtly animate.',
      ].join(' '),
    },
  };
}

export function buildMotionRegionPromptBlock(segment) {
  const plan = segment?.motionRegionDirection;
  if (!plan?.enabled) return '';

  const allowed = (plan.allowedMotion || [])
    .map((item) => `${item.region}: ${item.behavior} [${item.intensity}]`)
    .join(' | ');
  const locked = (plan.lockedRegions || [])
    .map((item) => `${item.region}: ${item.rule} [${item.tolerance}]`)
    .join(' | ');

  return [
    'MOTION REGION CONTROL:',
    plan.globalRule,
    allowed ? `ALLOWED TO MOVE: ${allowed}.` : '',
    locked ? `LOCKED / STABILIZE: ${locked}.` : '',
    'Do not spread motion from an allowed region into neighboring anatomy, clothing, props, furniture, architecture or background.',
    'Do not animate the entire image. Preserve stillness where no physical cause for motion exists.',
  ].filter(Boolean).join(' ');
}

export function buildMotionRegionQcContract(segment) {
  const plan = segment?.motionRegionDirection;
  if (!plan?.enabled) return null;

  return {
    allowedMotion: (plan.allowedMotion || []).map((item) => ({
      id: item.id,
      region: item.region,
      expected: item.behavior,
      intensity: item.intensity,
    })),
    lockedRegions: (plan.lockedRegions || []).map((item) => ({
      id: item.id,
      region: item.region,
      expected: item.rule,
      tolerance: item.tolerance,
    })),
    cameraMoving: Boolean(plan.cameraMoving),
  };
}

function dedupeById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function normalizeMode(value) {
  const normalized = String(value || 'semantic').toLowerCase();
  return ['semantic', 'off'].includes(normalized) ? normalized : 'semantic';
}

function envBool(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
