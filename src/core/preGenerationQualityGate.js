import { buildSubtitles } from './subtitleBuilder.js';
import { classifyMotionAction } from './motionGuideDirector.js';

const META_LANGUAGE_PATTERNS = [
  /a strong (?:short-form )?explanation should/i,
  /the viewer should/i,
  /give one concrete example/i,
  /explain the mechanism first/i,
  /the core idea (?:is|should)/i,
  /this script should/i,
];

const TEXT_DIRECTION = /\b(label(?:s|ed|led|ing)?|caption(?:s|ed)?|callouts?|lettering|written|text|typography|title card|signage)\b/i;
const BRAND_PATTERN = /\b(nike|adidas|puma|reebok|under armour|jordan|new balance|converse|gucci|prada|louis vuitton)\b/i;
const SPEECH_SAFE_SHOTS = new Set(['wide-establishing', 'medium', 'close-up', 'tracking']);
const GUIDE_WORTHY = new Set([
  'running', 'walking', 'squat', 'lifting', 'jumping', 'reaching', 'placing',
  'drinking', 'throwing', 'dancing', 'boxing', 'turning',
]);

/**
 * Mirrors post-generation QC at planning time.
 *
 * It cannot prove facts about pixels/audio that do not exist yet. Instead it validates
 * every available prerequisite/contract so expensive video generation only starts from
 * a plan that is capable of passing the post checks.
 */
export class PreGenerationQualityGate {
  constructor({
    llm = null,
    subtitleConfig = null,
    semanticReviewEnabled = envBool(process.env.PRE_GENERATION_SEMANTIC_QC_ENABLED, true),
  } = {}) {
    this.llm = llm;
    this.subtitleConfig = subtitleConfig || {};
    this.semanticReviewEnabled = Boolean(semanticReviewEnabled);
  }

  async evaluate(productionScript, {
    topic = productionScript?.topic || '',
    audience = productionScript?.audience || '',
    creativeBrief = null,
  } = {}) {
    const checks = deterministicChecks(productionScript, {
      subtitleConfig: this.subtitleConfig,
    });

    let semantic = null;
    if (this.semanticReviewEnabled && typeof this.llm?.reviewProductionPlan === 'function') {
      semantic = normalizeSemanticReview(await this.llm.reviewProductionPlan({
        topic,
        audience,
        creativeBrief,
        productionScript,
      }));
      checks.semanticPlanReview = semantic;
    }

    const blockers = Object.entries(checks)
      .flatMap(([stage, result]) => (
        (result?.blockers || []).map((item) => ({ stage, ...item }))
      ));
    const warnings = Object.entries(checks)
      .flatMap(([stage, result]) => (
        (result?.warnings || []).map((item) => ({ stage, ...item }))
      ));

    return {
      passed: blockers.length === 0,
      stage: 'pre-generation',
      checks,
      blockers,
      warnings,
      feedback: blockers.map((item) => (
        `[${item.stage}/${item.code}] ${item.message}`
      )).join(' '),
      mirroredPostStages: [
        'realism',
        'temporal-realism',
        'identity-location-continuity',
        'keyframe-adherence',
        'motion-region',
        'motion-guide',
        'dialogue-fidelity',
        'lip-sync',
        'deep-lip-sync',
        'phoneme-viseme',
        'speaker-turn',
        'pose-motion',
        'text-artifact',
        'visual-factual',
        'editorial-variety',
        'production-integrity',
        'subtitle-layout',
        'audio-quality',
        'publishability',
      ],
      inherentlyPostGeneration: [
        'actual pixel realism / anatomy / flicker / morphing',
        'actual generated speech WER',
        'actual audiovisual lip/phoneme timing',
        'actual pose trajectory produced by the model',
        'actual hallucinated text/logo pixels',
        'actual factual depiction in generated pixels',
        'actual cross-act frame similarity',
        'measured loudness / true peak / silence',
      ],
    };
  }
}

export function deterministicChecks(script, { subtitleConfig = {} } = {}) {
  const segments = Array.isArray(script?.segments) ? script.segments : [];
  const characters = Array.isArray(script?.characters) ? script.characters : [];
  const locations = Array.isArray(script?.locations) ? script.locations : [];
  const characterById = new Map(characters.map((item) => [item.id, item]));
  const locationById = new Map(locations.map((item) => [item.id, item]));

  return {
    realism: checkRealism(segments),
    temporalRealism: checkTemporal(segments, script),
    continuity: checkContinuity(segments, characters, locations, characterById, locationById),
    keyframeAdherence: checkKeyframes(segments),
    motionRegion: checkMotionRegions(segments),
    motionGuide: checkMotionGuides(segments, script),
    dialogueFidelity: checkDialogue(segments, characterById),
    lipSync: checkVisibleSpeech(segments, characterById, 'lip-sync'),
    deepLipSync: checkVisibleSpeech(segments, characterById, 'deep-lip-sync'),
    phonemeViseme: checkVisibleSpeech(segments, characterById, 'phoneme-viseme'),
    speakerTurn: checkSpeakerTurns(segments, characterById),
    poseMotion: checkPoseMotion(segments),
    textArtifact: checkTextArtifacts(segments),
    visualFactual: checkVisualFactualPlan(segments),
    editorialVariety: checkEditorialVariety(segments),
    productionIntegrity: checkProductionIntegrity(script, segments, characters),
    subtitleLayout: checkSubtitleLayout(segments, subtitleConfig),
    audioQuality: checkAudioPlan(script, segments, characterById),
    publishability: checkPublishabilityPlan(script),
  };
}

function checkRealism(segments) {
  const blockers = [];
  const warnings = [];
  for (const segment of segments) {
    const direction = segment.realismDirection;
    if (!direction) {
      warnings.push(issue('realism-direction-missing', `Act ${segment.index} has no anti-plastic realism direction.`));
      continue;
    }
    if (!direction.camera?.axis || !direction.humanMotion?.rule) {
      blockers.push(issue('realism-contract-incomplete', `Act ${segment.index} is missing physical camera or human-motion constraints.`));
    }
    if (Number(direction.riskScore) >= 50 && !direction.microMotion?.length) {
      warnings.push(issue('realism-micro-motion-missing', `High-risk act ${segment.index} has no explicit natural micro-motion plan.`));
    }
  }
  return result(blockers, warnings);
}

function checkTemporal(segments, script) {
  const blockers = [];
  const warnings = [];
  const allowMontage = script?.directorialContract?.allowMontage === true;
  for (const segment of segments) {
    if (!allowMontage && (
      segment.editing?.allowInternalCuts
      || segment.editing?.allowDissolves
      || Number(segment.editing?.shotCount) > 1
    )) {
      blockers.push(issue('internal-edit-plan', `Act ${segment.index} violates the no-montage contract before generation.`));
    }
    if (segment.editing?.allowDissolves) {
      warnings.push(issue('dissolve-risk', `Act ${segment.index} plans a dissolve/crossfade, which raises ghost-transition risk.`));
    }
    if (Number(segment.realismDirection?.riskScore) >= 32 && !String(segment.startState || '').trim()) {
      blockers.push(issue('start-state-missing', `Risky act ${segment.index} has no explicit opening physical state.`));
    }
    if (Number(segment.realismDirection?.riskScore) >= 50 && !String(segment.endState || '').trim()) {
      blockers.push(issue('end-state-missing', `High-risk act ${segment.index} has no explicit reachable ending state.`));
    }
  }
  return result(blockers, warnings);
}

function checkContinuity(segments, characters, locations, characterById, locationById) {
  const blockers = [];
  const warnings = [];
  const recurring = new Map();
  for (const segment of segments) {
    for (const id of segment.characterIds || []) {
      recurring.set(id, (recurring.get(id) || 0) + 1);
      if (!characterById.has(id)) {
        blockers.push(issue('unknown-character', `Act ${segment.index} binds unknown character "${id}".`));
      }
    }
    if (!locationById.has(segment.locationId)) {
      blockers.push(issue('unknown-location', `Act ${segment.index} binds unknown location "${segment.locationId}".`));
    }
  }

  for (const character of characters) {
    if ((recurring.get(character.id) || 0) > 1) {
      if (!String(character.physicalTraits || '').trim()) {
        blockers.push(issue('recurring-character-traits-missing', `Recurring character ${character.id} needs stable physicalTraits.`));
      }
      if (!String(character.wardrobe || '').trim()) {
        blockers.push(issue('recurring-character-wardrobe-missing', `Recurring character ${character.id} needs exact wardrobe continuity.`));
      }
    }
  }
  for (const location of locations) {
    if (!String(location.lighting || '').trim()) {
      warnings.push(issue('location-lighting-missing', `Location ${location.id} has no stable lighting contract.`));
    }
    if (!Array.isArray(location.fixedElements) || !location.fixedElements.length) {
      warnings.push(issue('location-anchors-missing', `Location ${location.id} has no fixed continuity anchors.`));
    }
  }
  return result(blockers, warnings);
}

function checkKeyframes(segments) {
  const blockers = [];
  const warnings = [];
  for (const segment of segments) {
    const risk = Number(segment.realismDirection?.riskScore) || 0;
    const plan = segment.keyframeDirection;
    if (risk >= 32 && (!plan || plan.policy === 'off')) {
      warnings.push(issue('keyframe-risk-unanchored', `Act ${segment.index} has realism risk ${risk} but no opening keyframe plan.`));
      continue;
    }
    if (plan?.enabled && !String(plan.firstFrame?.state || '').trim()) {
      blockers.push(issue('keyframe-start-missing', `Act ${segment.index} enables keyframes without a first-frame state.`));
    }
    if (plan?.policy === 'first-last' && !String(plan.lastFrame?.state || '').trim()) {
      blockers.push(issue('keyframe-end-missing', `Act ${segment.index} requires first-last keyframes but has no ending state.`));
    }
  }
  return result(blockers, warnings);
}

function checkMotionRegions(segments) {
  const blockers = [];
  const warnings = [];
  for (const segment of segments) {
    const plan = segment.motionRegionDirection;
    if (!plan?.enabled) continue;
    if (!Array.isArray(plan.allowedMotion) || !plan.allowedMotion.length) {
      blockers.push(issue('motion-region-empty', `Act ${segment.index} enables motion-region control without allowed motion.`));
    }
    if (!Array.isArray(plan.lockedRegions) || !plan.lockedRegions.length) {
      warnings.push(issue('motion-locks-empty', `Act ${segment.index} has no locked regions, increasing drift risk.`));
    }
    if (String(segment.dialogue || '').trim()
      && !(plan.allowedRegionIds || []).includes('speech-mouth-jaw')) {
      blockers.push(issue('speech-region-missing', `Act ${segment.index} has speech but mouth/jaw articulation is not in allowed motion.`));
    }
    const speakerCount = new Set((segment.dialogueTurns || []).map((turn) => turn.speakerCharacterId)).size;
    if (speakerCount > 1 && !(plan.lockedRegionIds || []).includes('inactive-speakers')) {
      blockers.push(issue('inactive-speaker-lock-missing', `Multi-speaker act ${segment.index} does not lock inactive speakers.`));
    }
  }
  return result(blockers, warnings);
}

function checkMotionGuides(segments, script) {
  const blockers = [];
  const warnings = [];
  const rightsRequired = script?.motionGuideDirection?.requireRightsConfirmed !== false;
  for (const segment of segments) {
    const plan = segment.motionGuideDirection;
    if (!plan?.eligible) continue;
    const reference = plan.selectedReference;
    if (!reference) {
      warnings.push(issue('motion-guide-unavailable', `Act ${segment.index} is guide-worthy but no motion reference met selection criteria.`));
      continue;
    }
    if (rightsRequired && reference.rightsConfirmed !== true) {
      blockers.push(issue('motion-guide-rights', `Act ${segment.index} selected motion reference without confirmed rights.`));
    }
    if (Number(reference.durationSeconds) <= 0 || Number(reference.durationSeconds) > 15) {
      blockers.push(issue('motion-guide-duration', `Act ${segment.index} selected motion reference with invalid duration.`));
    }
  }
  return result(blockers, warnings);
}

function checkDialogue(segments, characterById) {
  const blockers = [];
  const warnings = [];
  for (const segment of segments) {
    const turns = Array.isArray(segment.dialogueTurns) ? segment.dialogueTurns : [];
    for (const turn of turns) {
      if (!characterById.has(turn.speakerCharacterId)) {
        blockers.push(issue('dialogue-speaker-unknown', `Act ${segment.index} has dialogue assigned to unknown speaker ${turn.speakerCharacterId}.`));
      }
      if (!String(turn.text || '').trim()) {
        blockers.push(issue('dialogue-empty-turn', `Act ${segment.index} contains an empty dialogue turn.`));
      }
    }
    const wordCount = wordCountOf(segment.dialogue);
    const budget = Math.floor(Math.max(1, Number(segment.durationSeconds) || 1) * 2);
    if (wordCount > budget) {
      blockers.push(issue('dialogue-duration-budget', `Act ${segment.index} has ${wordCount} words for a ${segment.durationSeconds}s act; pre-generation limit is ${budget}.`));
    } else if (wordCount > budget * 0.9) {
      warnings.push(issue('dialogue-duration-tight', `Act ${segment.index} uses more than 90% of its speech budget.`));
    }
  }
  return result(blockers, warnings);
}

function checkVisibleSpeech(segments, characterById, stage) {
  const blockers = [];
  const warnings = [];
  for (const segment of segments) {
    const visibleTurns = (segment.dialogueTurns || []).filter((turn) => (
      characterById.get(turn.speakerCharacterId)?.onScreen !== false
      && String(turn.text || '').trim()
    ));
    if (!visibleTurns.length) continue;
    if (!SPEECH_SAFE_SHOTS.has(segment.shotType)) {
      blockers.push(issue(`${stage}-shot-risk`, `Act ${segment.index} has visible speech in ${segment.shotType}; use a face-readable shot or move the line to voiceover.`));
    }
    const visualText = [segment.startState, segment.endState, segment.action, segment.camera].filter(Boolean).join(' ');
    if (/\b(back to camera|back of (?:his|her|their) head|face (?:hidden|obscured|covered)|mouth (?:hidden|covered|obscured))\b/i.test(visualText)) {
      blockers.push(issue(`${stage}-mouth-occluded`, `Act ${segment.index} explicitly hides the mouth of an on-screen speaker.`));
    }
    if (segment.shotType === 'wide-establishing') {
      warnings.push(issue(`${stage}-wide-face-risk`, `Act ${segment.index} uses a wide shot for visible speech; ensure the speaking face remains large enough to inspect.`));
    }
  }
  return result(blockers, warnings);
}

function checkSpeakerTurns(segments, characterById) {
  const blockers = [];
  const warnings = [];
  for (const segment of segments) {
    const turns = Array.isArray(segment.dialogueTurns) ? segment.dialogueTurns : [];
    const speakerIds = [...new Set(turns.map((turn) => turn.speakerCharacterId).filter(Boolean))];
    if (speakerIds.length < 2) continue;
    if (turns.length < 2) {
      blockers.push(issue('speaker-turn-count', `Multi-speaker act ${segment.index} has fewer than two turns.`));
    }
    for (const id of speakerIds) {
      const character = characterById.get(id);
      if (!character || character.onScreen === false) {
        blockers.push(issue('speaker-turn-visibility', `Multi-speaker act ${segment.index} requires visible speaker ${id} but that character is missing/off-screen.`));
      }
    }
    const voices = speakerIds.map((id) => characterById.get(id)?.voice?.presetId).filter(Boolean);
    if (new Set(voices).size !== speakerIds.length) {
      warnings.push(issue('speaker-voice-collision', `Act ${segment.index} reuses a voice preset across visible speakers.`));
    }
    for (const turn of turns) {
      const pause = Number(turn.pauseAfterSeconds);
      if (Number.isFinite(pause) && (pause < 0 || pause > 0.8)) {
        blockers.push(issue('speaker-pause-invalid', `Act ${segment.index} has an invalid dialogue pause of ${pause}s.`));
      }
    }
  }
  return result(blockers, warnings);
}

function checkPoseMotion(segments) {
  const blockers = [];
  const warnings = [];
  for (const segment of segments) {
    const actionClass = classifyMotionAction(segment);
    const highRisk = Number(segment.realismDirection?.riskScore) >= 50;
    if (highRisk && GUIDE_WORTHY.has(actionClass) && !segment.motionGuideDirection?.selectedReference) {
      warnings.push(issue('pose-motion-unverified-plan', `Act ${segment.index} contains high-risk ${actionClass} motion without a selected real-motion reference; post pose QC will be unavailable.`));
    }
  }
  return result(blockers, warnings);
}

function checkTextArtifacts(segments) {
  const blockers = [];
  const warnings = [];
  for (const segment of segments) {
    for (const [field, value] of Object.entries({
      startState: segment.startState,
      endState: segment.endState,
      action: segment.action,
      camera: segment.camera,
    })) {
      if (TEXT_DIRECTION.test(String(value || ''))) {
        blockers.push(issue('generated-text-direction', `Act ${segment.index} ${field} still asks the video model to render text/signage.`));
      }
    }
    for (const label of segment.onScreenLabels || []) {
      if (String(label.text || '').length > 24) {
        blockers.push(issue('label-too-long', `Act ${segment.index} has a deterministic label longer than 24 characters.`));
      }
      if (!tokenKey(segment.dialogue).includes(tokenKey(label.text))) {
        blockers.push(issue('label-not-spoken', `Act ${segment.index} label "${label.text}" is not supported by spoken dialogue.`));
      }
    }
  }
  return result(blockers, warnings);
}

function checkVisualFactualPlan(segments) {
  const blockers = [];
  const warnings = [];
  for (const segment of segments) {
    if (!String(segment.action || '').trim()) {
      blockers.push(issue('visual-action-missing', `Act ${segment.index} has narration but no explicit visual action contract.`));
    }
    if (/\b(exactly|precisely)\b/i.test(segment.dialogue || '')
      && !String(segment.action || '').trim()) {
      warnings.push(issue('factual-visualization-underspecified', `Act ${segment.index} makes a precise verbal claim without a visual depiction plan.`));
    }
  }
  return result(blockers, warnings);
}

function checkEditorialVariety(segments) {
  const blockers = [];
  const warnings = [];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (!previous.shotType || !current.shotType) {
      blockers.push(issue('shot-type-missing', `Acts ${previous.index}/${current.index} are missing shot-type contracts.`));
      continue;
    }
    if (previous.shotType === current.shotType) {
      blockers.push(issue('repeated-shot-type', `Acts ${previous.index} and ${current.index} use the same shot type ${current.shotType}.`));
    }
    if (tokenKey(previous.camera) === tokenKey(current.camera)) {
      warnings.push(issue('repeated-camera-direction', `Acts ${previous.index} and ${current.index} use identical camera direction text.`));
    }
  }
  return result(blockers, warnings);
}

function checkProductionIntegrity(script, segments, characters) {
  const blockers = [];
  const warnings = [];
  const contract = script?.directorialContract || {};
  for (const id of contract.requiredVisibleCharacterIds || []) {
    const character = characters.find((item) => item.id === id);
    if (!character || character.onScreen === false) {
      blockers.push(issue('required-role-missing', `Required visible character ${id} is missing/off-screen.`));
    }
  }
  if (contract.brandPolicy?.mode === 'unbranded') {
    for (const character of characters) {
      if (BRAND_PATTERN.test(character.wardrobe || '')) {
        blockers.push(issue('brand-in-wardrobe', `Character ${character.id} wardrobe names a commercial brand under unbranded policy.`));
      }
    }
    for (const segment of segments) {
      const fields = [segment.action, segment.startState, segment.endState, segment.camera].join(' ');
      if (BRAND_PATTERN.test(fields)) {
        blockers.push(issue('brand-in-scene-plan', `Act ${segment.index} names a commercial brand under unbranded policy.`));
      }
    }
  }
  const deadline = Number(contract.interactionMustBeginBySeconds);
  if (contract.requiredInteraction && Number.isFinite(deadline)) {
    const early = segments.filter((segment) => Number(segment.start) < deadline + 0.001);
    if (!early.some((segment) => (
      (segment.characterIds || []).length >= 2
      || /\b(address|motivat|coach|help|hand|give|serve|consult|interview|huddle|react)\w*/i.test([
        segment.action,
        segment.dialogue,
      ].join(' '))
    ))) {
      blockers.push(issue('required-interaction-late', `Required interaction is not planned before ${deadline}s.`));
    }
  }
  return result(blockers, warnings);
}

function checkSubtitleLayout(segments, subtitleConfig) {
  const estimatedScenes = segments.map((segment) => ({
    start: segment.start,
    duration: segment.durationSeconds,
    narration: segment.dialogue,
  }));
  const subtitles = buildSubtitles({ scenes: estimatedScenes, config: subtitleConfig });
  const blockers = (subtitles.layout?.violations || []).map((violation) => issue(
    `subtitle-${violation.code}`,
    `Estimated subtitle layout fails before generation at ${violation.cueStart}s (${violation.code}).`,
  ));
  return {
    ...result(blockers, []),
    estimate: {
      source: subtitles.source,
      cueCount: subtitles.cues?.length || 0,
      layout: subtitles.layout,
    },
  };
}

function checkAudioPlan(script, segments, characterById) {
  const blockers = [];
  const warnings = [];
  if (!String(script?.audioDirection?.mix || '').trim()) {
    blockers.push(issue('audio-mix-missing', 'Production script has no audio mix contract.'));
  }
  for (const segment of segments) {
    const hasDialogue = String(segment.dialogue || '').trim();
    const hasOtherAudio = String(segment.ambience || '').trim()
      || String(segment.music || '').trim()
      || (segment.soundEffects || []).length;
    if (!hasDialogue && !hasOtherAudio) {
      blockers.push(issue('audio-plan-silent', `Act ${segment.index} plans neither dialogue nor ambience/effects/music.`));
    }
    for (const turn of segment.dialogueTurns || []) {
      const speaker = characterById.get(turn.speakerCharacterId);
      if (!speaker?.voice?.presetId) {
        blockers.push(issue('voice-preset-missing', `Speaker ${turn.speakerCharacterId} in act ${segment.index} has no voice preset.`));
      }
    }
  }
  return result(blockers, warnings);
}

function checkPublishabilityPlan(script) {
  const blockers = [];
  const warnings = [];
  const dialogue = String(script?.fullDialogue || '');
  if (!dialogue.trim()) blockers.push(issue('dialogue-missing', 'Production script contains no spoken dialogue.'));
  for (const pattern of META_LANGUAGE_PATTERNS) {
    if (pattern.test(dialogue)) {
      blockers.push(issue('script-meta-language', `Production dialogue contains authoring/meta language matching ${pattern}.`));
      break;
    }
  }
  return result(blockers, warnings);
}

function normalizeSemanticReview(value) {
  const blockers = normalizeReviewIssues(value?.blockers, 'semantic-plan');
  const warnings = normalizeReviewIssues(value?.warnings, 'semantic-plan-warning');
  return {
    passed: blockers.length === 0,
    blockers,
    warnings,
    scores: value?.scores || null,
    summary: String(value?.summary || '').trim(),
  };
}

function normalizeReviewIssues(items, fallbackCode) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item === 'object' && String(item.message || item.evidence || '').trim())
    .slice(0, 12)
    .map((item) => ({
      code: String(item.code || fallbackCode).slice(0, 100),
      message: String(item.message || item.evidence).trim().slice(0, 700),
    }));
}

function result(blockers = [], warnings = []) {
  return { passed: blockers.length === 0, blockers, warnings };
}

function issue(code, message) {
  return { code, message };
}

function wordCountOf(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function tokenKey(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function envBool(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
