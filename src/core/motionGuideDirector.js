const ACTION_RULES = [
  ['running', /\brun(?:s|ning)?\b|\bsprint(?:s|ing)?\b|\bjog(?:s|ging)?\b/i],
  ['walking', /\bwalk(?:s|ing)?\b|\bstep(?:s|ping)?\b/i],
  ['squat', /\bsquat(?:s|ting)?\b/i],
  ['lifting', /\blift(?:s|ing)?\b|deadlift|curl(?:s|ing)?|press(?:es|ing)?\b|dumbbell|barbell/i],
  ['jumping', /\bjump(?:s|ing)?\b|\bleap(?:s|ing)?\b/i],
  ['reaching', /\breach(?:es|ing)?\b|pick(?:s|ing)? up|grab(?:s|bing)?|take(?:s|ing)? .* from/i],
  ['placing', /\bplace(?:s|ing)?\b|put(?:s|ting)? .* down|set(?:s|ting)? .* down/i],
  ['drinking', /\bdrink(?:s|ing)?\b|sip(?:s|ping)?\b/i],
  ['throwing', /\bthrow(?:s|ing)?\b|\btoss(?:es|ing)?\b/i],
  ['dancing', /\bdanc(?:e|es|ing)\b/i],
  ['boxing', /\bbox(?:es|ing)?\b|punch(?:es|ing)?|jab(?:s|bing)?/i],
  ['turning', /turn(?:s|ing)? (?:around|left|right|head|body)/i],
];

export class MotionGuideDirector {
  constructor({
    store,
    enabled = envBool(process.env.MOTION_GUIDE_ENABLED, true),
    mode = process.env.MOTION_GUIDE_MODE || 'auto',
    minRiskScore = Number(process.env.MOTION_GUIDE_MIN_RISK_SCORE || 50),
    minSelectionScore = Number(process.env.MOTION_GUIDE_MIN_SELECTION_SCORE || 0.55),
    maxReferenceSeconds = Number(process.env.MOTION_GUIDE_MAX_REFERENCE_SECONDS || 15),
    requireRightsConfirmed = envBool(process.env.MOTION_GUIDE_REQUIRE_RIGHTS_CONFIRMED, true),
  } = {}) {
    this.store = store;
    this.enabled = Boolean(enabled);
    this.mode = normalizeMode(mode);
    this.minRiskScore = clamp(minRiskScore, 0, 100, 50);
    this.minSelectionScore = clamp(minSelectionScore, 0, 1, 0.55);
    this.maxReferenceSeconds = clamp(maxReferenceSeconds, 1, 15, 15);
    this.requireRightsConfirmed = Boolean(requireRightsConfirmed);
  }

  async direct(script) {
    if (!script?.segments?.length) return script;
    const references = this.enabled && this.store?.list
      ? await this.store.list()
      : [];

    const segments = script.segments.map((segment) => (
      directMotionGuide(segment, references, {
        enabled: this.enabled,
        mode: this.mode,
        minRiskScore: this.minRiskScore,
        minSelectionScore: this.minSelectionScore,
        maxReferenceSeconds: this.maxReferenceSeconds,
        requireRightsConfirmed: this.requireRightsConfirmed,
      })
    ));

    return {
      ...script,
      motionGuideDirection: {
        enabled: this.enabled,
        mode: this.mode,
        librarySize: references.length,
        requireRightsConfirmed: this.requireRightsConfirmed,
        usableLibrarySize: references.filter((reference) => (
          !this.requireRightsConfirmed || reference.rightsConfirmed
        )).length,
        selectedActs: segments.filter((segment) => segment.motionGuideDirection?.selectedReference).length,
        eligibleWithoutReference: segments.filter((segment) => (
          segment.motionGuideDirection?.eligible
          && !segment.motionGuideDirection?.selectedReference
        )).length,
      },
      segments,
    };
  }
}

export function directMotionGuide(segment, references = [], {
  enabled = true,
  mode = 'auto',
  minRiskScore = 50,
  minSelectionScore = 0.55,
  maxReferenceSeconds = 15,
  requireRightsConfirmed = true,
} = {}) {
  const normalizedMode = normalizeMode(mode);
  const riskScore = Number(segment.realismDirection?.riskScore) || 0;
  const actionClass = classifyMotionAction(segment);
  const guideWorthyAction = actionClass !== 'general' && actionClass !== 'talking';
  const forced = normalizedMode === 'always';
  const eligible = Boolean(
    enabled
    && normalizedMode !== 'off'
    && guideWorthyAction
    && (forced || riskScore >= Number(minRiskScore)),
  );

  if (!eligible) {
    return {
      ...segment,
      motionGuideDirection: {
        enabled: Boolean(enabled),
        mode: normalizedMode,
        eligible: false,
        actionClass,
        riskScore,
        reason: !enabled || normalizedMode === 'off'
          ? 'motion guidance disabled'
          : !guideWorthyAction
            ? 'scene has no guide-worthy body/object action'
            : `risk ${riskScore} below threshold ${minRiskScore}`,
        selectedReference: null,
      },
    };
  }

  const scored = (references || [])
    .filter((reference) => (
      reference?.verifiedHumanMotion !== false
      && (!requireRightsConfirmed || reference?.rightsConfirmed === true)
      && Number(reference?.durationSeconds) > 0
      && Number(reference?.durationSeconds) <= maxReferenceSeconds
    ))
    .map((reference) => ({
      reference,
      score: scoreReference(segment, reference, actionClass),
    }))
    .sort((a, b) => b.score - a.score);

  const winner = scored[0];
  const selectedReference = winner && winner.score >= minSelectionScore
    ? {
      ...winner.reference,
      selectionScore: round(winner.score),
      selectionReason: buildSelectionReason(segment, winner.reference, actionClass),
    }
    : null;

  return {
    ...segment,
    motionGuideDirection: {
      enabled: true,
      mode: normalizedMode,
      eligible: true,
      actionClass,
      riskScore,
      minimumSelectionScore: minSelectionScore,
      selectedReference,
      reason: selectedReference
        ? `selected ${selectedReference.id} at score ${selectedReference.selectionScore}`
        : 'no motion reference met the selection threshold',
    },
  };
}

export function classifyMotionAction(segment) {
  const text = [
    segment?.action,
    segment?.purpose,
    segment?.startState,
    segment?.endState,
  ].filter(Boolean).join(' ');

  for (const [name, pattern] of ACTION_RULES) {
    if (pattern.test(text)) return name;
  }

  if (String(segment?.dialogue || '').trim()) return 'talking';
  return 'general';
}

export function scoreReference(segment, reference, actionClass = classifyMotionAction(segment)) {
  let score = 0;

  if (reference.actionClass === actionClass) score += 0.55;
  else if (reference.tags?.includes(actionClass)) score += 0.32;

  const actionTokens = tokenize([
    segment.action,
    segment.startState,
    segment.endState,
  ].filter(Boolean).join(' '));
  const referenceTokens = new Set([
    ...(reference.tags || []),
    reference.actionClass,
  ].flatMap((value) => tokenize(value)));
  const overlap = actionTokens.filter((token) => referenceTokens.has(token)).length;
  score += Math.min(0.2, overlap * 0.04);

  const cameraAxis = normalizeCamera(segment.realismDirection?.camera?.axis);
  const refCamera = normalizeCamera(reference.cameraMode);
  if (refCamera === 'any' || refCamera === cameraAxis) score += 0.1;

  const targetDuration = Math.max(1, Number(segment.durationSeconds) || 5);
  const refDuration = Math.max(0.1, Number(reference.durationSeconds) || targetDuration);
  const durationFit = Math.max(0, 1 - Math.abs(targetDuration - refDuration) / targetDuration);
  score += 0.1 * durationFit;

  const expectedPeople = Math.max(1, (segment.characterIds || []).length || 1);
  if (Number(reference.people || 1) === expectedPeople) score += 0.05;

  return Math.max(0, Math.min(1, score));
}

export function buildMotionGuidePromptBlock(segment) {
  const guide = segment?.motionGuideDirection?.selectedReference;
  if (!guide) return '';

  return [
    'VIDEO MOTION REFERENCE GUIDANCE:',
    `A real-motion reference video is supplied for the ${segment.motionGuideDirection.actionClass} action.`,
    'Use it ONLY for temporal rhythm, pose progression, body mechanics, balance, contact timing, weight transfer and physically plausible trajectory.',
    'Do NOT copy the reference performer identity, face, apparent age, body appearance, clothing, location, lighting, background, color palette or camera styling unless those already match the canonical scene.',
    'Canonical character identity, wardrobe, location, keyframes, dialogue and visual style remain authoritative.',
    'Match important contact events and body timing from the reference while respecting the scene-specific motion-region locks.',
  ].join(' ');
}

export function buildMotionGuideQcContract(scene, asset) {
  const guide = asset?.motionGuide;
  if (!guide?.selectedReference || !guide.localPath) return null;

  return {
    actionClass: guide.actionClass,
    referenceId: guide.selectedReference.id,
    durationSeconds: guide.selectedReference.durationSeconds,
    localPath: guide.localPath,
    selectionScore: guide.selectedReference.selectionScore,
  };
}

function buildSelectionReason(segment, reference, actionClass) {
  return [
    `action=${actionClass}`,
    `camera=${normalizeCamera(segment.realismDirection?.camera?.axis)}`,
    `referenceCamera=${normalizeCamera(reference.cameraMode)}`,
    `duration=${reference.durationSeconds}s`,
  ].join('; ');
}

function normalizeMode(value) {
  const normalized = String(value || 'auto').toLowerCase();
  return ['auto', 'always', 'off'].includes(normalized) ? normalized : 'auto';
}

function normalizeCamera(value) {
  const normalized = String(value || 'any').toLowerCase();
  if (/track|follow/.test(normalized)) return 'tracking';
  if (/pan/.test(normalized)) return 'pan';
  if (/push|dolly/.test(normalized)) return 'push-in';
  if (/lock|static|tripod/.test(normalized)) return 'locked';
  return normalized || 'any';
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .slice(0, 80);
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function envBool(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
