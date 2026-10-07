export class KeyframeDirector {
  constructor({
    enabled = envBool(process.env.FIRST_LAST_FRAME_ENABLED, true),
    mode = process.env.KEYFRAME_MODE || 'auto',
    firstFrameRiskThreshold = Number(process.env.KEYFRAME_FIRST_RISK_THRESHOLD || 32),
    lastFrameRiskThreshold = Number(process.env.KEYFRAME_LAST_RISK_THRESHOLD || 50),
  } = {}) {
    this.enabled = Boolean(enabled);
    this.mode = normalizeMode(mode);
    this.firstFrameRiskThreshold = clampScore(firstFrameRiskThreshold, 32);
    this.lastFrameRiskThreshold = Math.max(
      this.firstFrameRiskThreshold,
      clampScore(lastFrameRiskThreshold, 50),
    );
  }

  direct(script) {
    if (!script?.segments?.length) return script;

    const segments = script.segments.map((segment) => {
      const riskScore = Number(segment.realismDirection?.riskScore) || 0;
      const policy = selectPolicy({
        enabled: this.enabled,
        mode: this.mode,
        riskScore,
        firstFrameRiskThreshold: this.firstFrameRiskThreshold,
        lastFrameRiskThreshold: this.lastFrameRiskThreshold,
      });

      return {
        ...segment,
        keyframeDirection: {
          enabled: policy !== 'off',
          policy,
          riskScore,
          firstFrame: policy === 'off'
            ? null
            : {
              state: clean(
                segment.startState
                || inferStartState(segment),
                900,
              ),
              purpose: 'Lock identity, wardrobe, location geometry, lighting, camera height and initial body/object state.',
            },
          lastFrame: policy === 'first-last'
            ? {
              state: clean(
                segment.endState
                || inferEndState(segment),
                900,
              ),
              purpose: 'Lock the physically plausible result of the action while preserving identity, wardrobe, location geometry and lighting.',
            }
            : null,
        },
      };
    });

    return {
      ...script,
      keyframeDirection: {
        enabled: this.enabled,
        mode: this.mode,
        firstFrameRiskThreshold: this.firstFrameRiskThreshold,
        lastFrameRiskThreshold: this.lastFrameRiskThreshold,
        firstFrameActs: segments.filter((segment) => segment.keyframeDirection?.firstFrame).length,
        firstLastFrameActs: segments.filter((segment) => segment.keyframeDirection?.lastFrame).length,
      },
      segments,
    };
  }
}

export function selectKeyframePolicy({
  enabled = true,
  mode = 'auto',
  riskScore = 0,
  firstFrameRiskThreshold = 32,
  lastFrameRiskThreshold = 50,
} = {}) {
  return selectPolicy({
    enabled,
    mode: normalizeMode(mode),
    riskScore,
    firstFrameRiskThreshold,
    lastFrameRiskThreshold,
  });
}

const CLOSE_SHOTS = new Set(['close-up', 'macro-detail']);

function stripNames(text, characters) {
  return (characters || []).reduce((value, character, index) => {
    const name = String(character?.name || '').trim();
    if (!name) return value;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return value.replace(new RegExp(`\\b${escaped}\\b`, 'g'), `Person ${index + 1}`);
  }, String(text || ''));
}

// Leads every keyframe prompt so it survives trimming to the image prompt limit.
const KEYFRAME_HARD_RULE = 'Photorealistic. No text, letters, numbers, names or logos anywhere, including on clothing and shoes; all garments plain and unbranded.';

/**
 * A full room description pulls generators back to a wide view of the whole set.
 * Close shots keep only the lighting and state that the setting is out of frame.
 */
export function describeLocationForShot(location, shotType) {
  if (!location) return '';
  if (CLOSE_SHOTS.has(shotType)) {
    return [
      `Setting (out of frame, implied only by background blur): ${location.name}.`,
      location.lighting ? `Lighting: ${location.lighting}.` : '',
      'Do not show the room, enclosure, walls, stand or full apparatus; only the described detail fills the frame.',
    ].filter(Boolean).join(' ');
  }
  return [
    `Location: ${location.name}. ${location.description}.`,
    location.lighting ? `Lighting: ${location.lighting}.` : '',
    location.fixedElements?.length ? `Fixed elements: ${location.fixedElements.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
}

export function buildKeyframePrompts({
  segment,
  productionScript,
  storyBible = null,
  previousAsset = null,
  regeneration = null,
} = {}) {
  const direction = segment?.keyframeDirection || {};
  if (!direction.enabled || direction.policy === 'off') {
    return { first: null, last: null };
  }

  const characters = (segment.characterIds || [])
    .map((id) => productionScript?.characters?.find((item) => item.id === id))
    .filter(Boolean);
  const location = productionScript?.locations?.find(
    (item) => item.id === segment.locationId,
  );
  const canonicalStyle = storyBible?.visualStyle || productionScript?.visualStyle || {};

  const continuity = [
    // Image models print names they are given onto jerseys and signs, so people
    // are introduced by position only.
    ...characters.map((character, index) => [
      `Person ${index + 1}: ${stripNames(character.description, characters)}.`,
      character.physicalTraits ? `Exact physical traits: ${character.physicalTraits}.` : '',
      character.wardrobe ? `Exact wardrobe: ${character.wardrobe}.` : '',
    ].filter(Boolean).join(' ')),
    describeLocationForShot(location, segment.shotType),
  ].filter(Boolean).join(' ');

  const shared = [
    'Photorealistic vertical keyframe captured by a real physical camera.',
    continuity,
    canonicalStyle.description || '',
    canonicalStyle.cameraRules || '',
    canonicalStyle.lightingRules || '',
    segment.realismDirection?.camera
      ? [
        segment.realismDirection.camera.fieldOfView,
        segment.realismDirection.camera.apertureLook,
        segment.realismDirection.camera.support,
      ].filter(Boolean).join('. ')
      : '',
    previousAsset?.keyframes?.last?.url
      ? 'Match the previous accepted act end-frame identity, wardrobe, environment geometry and color response.'
      : previousAsset
        ? 'Match the previous accepted act identity and visual language.'
        : '',
    regeneration?.guidance
      ? `Correct prior QC defects without changing canonical identity or location: ${regeneration.guidance}`
      : '',
    'Natural skin texture, believable fabric/hair, motivated practical or daylight illumination, realistic contact shadows and lens perspective.',
    'No text, captions, logos, watermarks, CGI sheen, waxy skin, beauty retouching, impossible reflections, duplicate limbs or distorted hands.',
  ].filter(Boolean).join(' ');

  // The frame-specific state leads: image prompts are capped (1000 chars on Runway),
  // so shared identity/style text is what gets trimmed, never the framing.
  const first = [
    KEYFRAME_HARD_RULE,
    'FIRST FRAME / STARTING STATE:',
    // Directions snapshot startState when planned; prefer the segment's current text
    // so edits and screenplay rewrites cannot leave a stale keyframe behind.
    stripNames(direction.firstFrame?.explicit
      ? direction.firstFrame.state
      : segment.startState || direction.firstFrame?.state || inferStartState(segment), characters),
    'Show the stable physical state immediately before the main action progresses.',
    shared,
  ].filter(Boolean).join(' ');

  const last = direction.policy === 'first-last'
    ? [
      KEYFRAME_HARD_RULE,
      'LAST FRAME / ENDING STATE:',
      stripNames(direction.lastFrame?.explicit
        ? direction.lastFrame.state
        : segment.endState || direction.lastFrame?.state || inferEndState(segment), characters),
      `The visible action that has progressed is: ${stripNames(segment.action || 'the planned scene action', characters)}.`,
      'This must look like a physically reachable end state from the first frame, not a different shot, person, wardrobe, room or lighting setup.',
      shared,
    ].filter(Boolean).join(' ')
    : null;

  return { first, last };
}

function selectPolicy({
  enabled,
  mode,
  riskScore,
  firstFrameRiskThreshold,
  lastFrameRiskThreshold,
}) {
  if (!enabled || mode === 'off') return 'off';
  if (mode === 'first') return 'first';
  if (mode === 'first-last') return 'first-last';

  const score = Number(riskScore) || 0;
  if (score >= Number(lastFrameRiskThreshold)) return 'first-last';
  if (score >= Number(firstFrameRiskThreshold)) return 'first';
  return 'off';
}

function inferStartState(segment) {
  const action = clean(segment?.action || 'the subject remains naturally posed', 650);
  return [
    'Initial subject/object positions are stable and anatomically plausible.',
    `Before the main action: ${action}`,
    'Hands are relaxed and clearly formed; objects are already placed where the action logically begins.',
  ].join(' ');
}

function inferEndState(segment) {
  const action = clean(segment?.action || 'the planned action', 650);
  return [
    `Immediately after completing the primary action described as: ${action}`,
    'The subject has believable balance, weight and posture.',
    'Any manipulated object remains physically consistent and in a plausible final position.',
  ].join(' ');
}

function normalizeMode(value) {
  const normalized = String(value || 'auto').toLowerCase();
  if (['auto', 'first', 'first-last', 'off'].includes(normalized)) return normalized;
  return 'auto';
}

function clampScore(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, number));
}

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function envBool(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
