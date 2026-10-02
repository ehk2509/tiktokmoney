import { FrameSampler } from '../services/frameSampler.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterRealismQcProvider {
  constructor({
    apiKey = process.env.OPENROUTER_API_KEY,
    baseUrl = process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.REALISM_QC_MODEL,
    threshold = Number(process.env.REALISM_QC_THRESHOLD || 82),
    temporalThreshold = Number(process.env.REALISM_QC_TEMPORAL_THRESHOLD || 80),
    continuityThreshold = Number(process.env.REALISM_QC_CONTINUITY_THRESHOLD || 85),
    keyframeThreshold = Number(process.env.REALISM_QC_KEYFRAME_THRESHOLD || 84),
    temporalEnabled = parseBoolean(process.env.REALISM_QC_TEMPORAL_ENABLED, true),
    maxRegenerations = Number(process.env.REALISM_MAX_REGENERATIONS || 1),
    failClosed = parseBoolean(process.env.REALISM_QC_FAIL_CLOSED, true),
    frameSampler = new FrameSampler(),
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for realism QC');
    if (!model) throw new Error('REALISM_QC_MODEL is required for realism QC');
    if (!fetchImpl) throw new Error('fetch is required');

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.threshold = clampScore(threshold);
    this.temporalThreshold = clampScore(temporalThreshold);
    this.continuityThreshold = clampScore(continuityThreshold);
    this.keyframeThreshold = clampScore(keyframeThreshold);
    this.temporalEnabled = Boolean(temporalEnabled);
    this.maxRegenerations = Math.max(0, Math.min(3, Number(maxRegenerations) || 0));
    this.failClosed = Boolean(failClosed);
    this.frameSampler = frameSampler;
    this.fetch = fetchImpl;
  }

  async evaluateScene(scene, asset, { previousAsset = null, storyBible = null } = {}) {
    if (!asset?.localPath) {
      throw new Error('realism QC requires a local video asset');
    }

    const durationSeconds = parseDuration(asset.generatedDuration)
      || Number(asset.durationSeconds)
      || Number(scene.duration)
      || 5;

    const frames = await this.frameSampler.sample(asset.localPath, { durationSeconds });
    const temporalFrames = this.temporalEnabled
      ? await this.frameSampler.sampleTemporal(asset.localPath, { durationSeconds })
      : [];
    const previousDuration = parseDuration(previousAsset?.generatedDuration)
      || Number(previousAsset?.durationSeconds)
      || durationSeconds;
    const previousFrames = previousAsset?.localPath && this.frameSampler.sampleComparison
      ? await this.frameSampler.sampleComparison(previousAsset.localPath, { durationSeconds: previousDuration })
      : [];

    const prompt = buildPrompt({
      scene,
      asset,
      previousAsset,
      storyBible,
      temporalEnabled: this.temporalEnabled,
      temporalFrameCount: temporalFrames.length,
      previousFrameCount: previousFrames.length,
    });

    const keyframeImages = [];
    if (asset.keyframes?.first?.url) {
      keyframeImages.push(
        { type: 'text', text: 'INTENDED FIRST KEYFRAME — compare the generated opening frames against this exact visual anchor:' },
        { type: 'image_url', image_url: { url: asset.keyframes.first.url } },
      );
    }
    if (asset.keyframes?.last?.url) {
      keyframeImages.push(
        { type: 'text', text: 'INTENDED LAST KEYFRAME — compare the generated ending frames against this exact visual anchor:' },
        { type: 'image_url', image_url: { url: asset.keyframes.last.url } },
      );
    }

    const content = [
      { type: 'text', text: prompt },
      ...keyframeImages,
      { type: 'text', text: 'STATIC REALISM CHECKPOINTS — judge individual visual quality:' },
      ...labelledImageParts(frames, 'Static'),
      ...(previousFrames.length ? [
        { type: 'text', text: 'PREVIOUS ACCEPTED ACT — compare identity, apparent age, wardrobe, location and visual language against the current act:' },
        ...labelledImageParts(previousFrames, 'Previous'),
      ] : []),
      ...(this.temporalEnabled ? [
        { type: 'text', text: 'TEMPORAL SEQUENCE — these frames are strictly chronological. Compare adjacent frames for motion and identity stability:' },
        ...labelledImageParts(temporalFrames, 'Temporal'),
      ] : []),
    ];

    const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'You are a strict visual and temporal quality-control reviewer for photorealistic short-form video.',
              'Judge only what is visible in the supplied sampled frames.',
              'The temporal sequence is ordered chronologically; compare adjacent frames carefully.',
              'Do not reward cinematic style if the scene looks synthetic, morphs, flickers, teleports, or violates physics.',
              'Return JSON only.',
            ].join(' '),
          },
          {
            role: 'user',
            content,
          },
        ],
      }),
    });

    const payload = await readJsonResponse(response);
    const raw = payload?.choices?.[0]?.message?.content;
    const parsed = parseJsonObject(raw);

    const scores = normalizeScores(parsed?.scores);
    const temporalScores = normalizeTemporalScores(parsed?.temporalScores);
    const issues = normalizeIssues(parsed?.issues);
    const temporalIssues = normalizeIssues(parsed?.temporalIssues);

    const overallScore = clampScore(
      parsed?.overallScore ?? average(Object.values(scores)),
    );
    const temporalScore = this.temporalEnabled
      ? clampScore(parsed?.temporalScore ?? average(Object.values(temporalScores)))
      : 100;

    const allIssues = [...issues, ...temporalIssues];
    const criticalFailure = allIssues.some((issue) => issue.severity === 'critical');
    const staticPassed = overallScore >= this.threshold;
    const temporalPassed = !this.temporalEnabled || temporalScore >= this.temporalThreshold;
    const hasRecurringCharacter = Boolean(previousAsset && scene.continuity?.characterIds?.length);
    const hasRecurringLocation = Boolean(previousAsset && scene.continuity?.locationId);
    const identityContinuityPassed = !hasRecurringCharacter
      || scores.identityContinuity >= this.continuityThreshold;
    const locationContinuityPassed = !hasRecurringLocation
      || scores.locationContinuity >= this.continuityThreshold;
    const continuityPassed = identityContinuityPassed && locationContinuityPassed;
    const hasFirstKeyframe = Boolean(asset.keyframes?.first?.url);
    const hasLastKeyframe = Boolean(asset.keyframes?.last?.url);
    const keyframeStartPassed = !hasFirstKeyframe
      || scores.keyframeStartMatch >= this.keyframeThreshold;
    const keyframeEndPassed = !hasLastKeyframe
      || scores.keyframeEndMatch >= this.keyframeThreshold;
    const keyframeAdherencePassed = keyframeStartPassed && keyframeEndPassed;
    const passed = staticPassed
      && temporalPassed
      && continuityPassed
      && keyframeAdherencePassed
      && !criticalFailure;

    return {
      provider: 'openrouter',
      model: this.model,
      threshold: this.threshold,
      temporalThreshold: this.temporalThreshold,
      continuityThreshold: this.continuityThreshold,
      keyframeThreshold: this.keyframeThreshold,
      temporalEnabled: this.temporalEnabled,
      passed,
      staticPassed,
      temporalPassed,
      continuityPassed,
      identityContinuityPassed,
      locationContinuityPassed,
      keyframeAdherencePassed,
      keyframeStartPassed,
      keyframeEndPassed,
      overallScore,
      temporalScore,
      scores,
      temporalScores,
      issues,
      temporalIssues,
      summary: stringOrEmpty(parsed?.summary),
      temporalSummary: stringOrEmpty(parsed?.temporalSummary),
      regenerationGuidance: stringOrEmpty(parsed?.regenerationGuidance)
        || buildGuidance(allIssues, scores, temporalScores),
      sampledFrames: frames.map(({ index, timestamp }) => ({ index, timestamp })),
      temporalFrames: temporalFrames.map(({ index, timestamp }) => ({ index, timestamp })),
      previousFrames: previousFrames.map(({ index, timestamp }) => ({ index, timestamp })),
      previousGenerationId: previousAsset?.generationId || null,
      rawUsage: payload?.usage || null,
    };
  }
}

function labelledImageParts(frames, prefix) {
  return frames.flatMap((frame, index) => ([
    {
      type: 'text',
      text: `${prefix} frame ${index + 1}/${frames.length} at ${frame.timestamp.toFixed(3)}s`,
    },
    {
      type: 'image_url',
      image_url: { url: frame.dataUrl },
    },
  ]));
}

function buildPrompt({
  scene,
  asset,
  previousAsset,
  storyBible,
  temporalEnabled,
  temporalFrameCount,
  previousFrameCount,
}) {
  const binding = scene.continuity || {};
  const characters = (storyBible?.characters || [])
    .filter((character) => (binding.characterIds || []).includes(character.id));
  const location = (storyBible?.locations || [])
    .find((item) => item.id === binding.locationId);
  const style = storyBible?.visualStyle || {};
  const realismDirection = scene.realismDirection || {};

  return [
    'Evaluate ONE AI-generated vertical video scene.',
    '',
    `Narrative requirement: ${scene.narration}`,
    `Intended visual prompt: ${asset.prompt || scene.realism?.motionPrompt || scene.visualPrompt || ''}`,
    previousAsset
      ? 'Continuity requirement: the scene should plausibly belong to the same visual world as the preceding scene.'
      : 'Continuity requirement: this is the first scene.',
    style.description ? `Canonical style: ${style.description}` : '',
    style.cameraRules ? `Canonical camera rules: ${style.cameraRules}` : '',
    style.lightingRules ? `Canonical lighting rules: ${style.lightingRules}` : '',
    realismDirection.profile ? `Capture realism profile: ${realismDirection.profile}; risk level: ${realismDirection.riskLevel}; stable-shot target: ${realismDirection.stableShotSeconds}s.` : '',
    realismDirection.microMotion?.length ? `Expected physically motivated micro-motion: ${realismDirection.microMotion.join('; ')}.` : '',
    ...characters.map((character) => [
      `Canonical character ${character.name}: ${character.description}`,
      character.physicalTraits ? `Physical traits: ${character.physicalTraits}` : '',
      character.wardrobe ? `Wardrobe: ${character.wardrobe}` : '',
    ].filter(Boolean).join('. ')),
    location
      ? [
        `Canonical location ${location.name}: ${location.description}`,
        location.lighting ? `Location lighting: ${location.lighting}` : '',
        location.fixedElements?.length
          ? `Fixed elements: ${location.fixedElements.join(', ')}`
          : '',
      ].filter(Boolean).join('. ')
      : '',
    'Treat visible drift from canonical character/location/style details as a continuity defect.',
    previousFrameCount
      ? `You also have ${previousFrameCount} frames from the previous accepted act. Compare the same recurring person/location directly across acts.`
      : '',
    '',
    'STATIC scores, each from 0 to 100:',
    '- photorealism: would an ordinary viewer plausibly believe this was camera footage?',
    '- anatomy: faces, hands, limbs and bodies are structurally plausible.',
    '- geometry: objects, architecture and backgrounds are coherent and stable.',
    '- physics: gravity, contact, reflections, perspective and physical interactions look plausible.',
    '- motionConsistency: sparse checkpoints imply stable identity and non-morphing motion.',
    '- continuity: subject/environment/style stay coherent.',
    '- identityContinuity: recurring character face, apparent age, hair, body proportions and wardrobe match the previous accepted act.',
    '- locationContinuity: recurring environment geometry, fixed objects and lighting match the previous accepted act.',
    '- sceneRelevance: visuals actually illustrate the narration.',
    '- artifactFreedom: no obvious AI artifacts, duplicate objects, warped text, watermarks or impossible details.',
    '- materialRealism: skin, fabric, hair, metal, glass and surfaces have believable non-waxy texture and specular response.',
    '- cameraPhysics: lens perspective, handheld inertia, focus behavior and camera path feel physically operated rather than floating or impossible.',
    '- lightingNaturalism: illumination has believable source direction/falloff, natural exposure behavior and no uniform glossy AI sheen.',
    '- keyframeStartMatch: when a FIRST KEYFRAME is supplied, the generated opening preserves its identity, pose/object state, framing, geometry and lighting.',
    '- keyframeEndMatch: when a LAST KEYFRAME is supplied, the generated ending reaches that physically plausible state without identity/location drift.',
    ...(temporalEnabled ? [
      '',
      `TEMPORAL sequence contains ${temporalFrameCount} ordered frames. Score each from 0 to 100:`,
      '- identityStability: faces, bodies, clothing and recurring subjects do not morph between adjacent frames.',
      '- objectPersistence: objects neither appear/disappear nor change shape without a physical reason.',
      '- geometryStability: environment and object geometry remain structurally stable through motion.',
      '- motionPlausibility: velocities, acceleration, body mechanics and object motion are physically believable.',
      '- cameraContinuity: camera movement is smooth and consistent with the intended shot, without teleporting or unexplained jumps.',
      '- flickerFreedom: lighting, texture, color and fine detail do not pulse or flicker unnaturally.',
      '- temporalArtifactFreedom: no melting, rubbery motion, frame-to-frame duplication anomalies or sudden AI artifacts.',
      '- actionContinuity: the intended action progresses coherently through time.',
      '',
      'Look especially for defects that may exist for only one or two adjacent frames.',
    ] : []),
    '',
    'List only concrete visible defects. Severity must be low, medium, high, or critical.',
    'regenerationGuidance must specifically describe how the next generation should correct both static and temporal failures.',
    '',
    'Return exactly one JSON object shaped like:',
    '{',
    '  "overallScore": 0,',
    '  "temporalScore": 0,',
    '  "scores": {',
    '    "photorealism": 0, "anatomy": 0, "geometry": 0, "physics": 0,',
    '    "motionConsistency": 0, "continuity": 0, "identityContinuity": 0, "locationContinuity": 0,',
    '    "sceneRelevance": 0, "artifactFreedom": 0,',
    '    "materialRealism": 0, "cameraPhysics": 0, "lightingNaturalism": 0,',
    '    "keyframeStartMatch": 0, "keyframeEndMatch": 0',
    '  },',
    '  "temporalScores": {',
    '    "identityStability": 0, "objectPersistence": 0, "geometryStability": 0, "motionPlausibility": 0,',
    '    "cameraContinuity": 0, "flickerFreedom": 0, "temporalArtifactFreedom": 0, "actionContinuity": 0',
    '  },',
    '  "issues": [{"code":"hands","severity":"high","evidence":"brief visible evidence"}],',
    '  "temporalIssues": [{"code":"face-morph","severity":"high","evidence":"face shape changes between temporal frames 4 and 5"}],',
    '  "summary": "one sentence",',
    '  "temporalSummary": "one sentence",',
    '  "regenerationGuidance": "one compact corrective instruction"',
    '}',
  ].join('\n');
}

function normalizeScores(scores = {}) {
  const keys = [
    'photorealism',
    'anatomy',
    'geometry',
    'physics',
    'motionConsistency',
    'continuity',
    'identityContinuity',
    'locationContinuity',
    'sceneRelevance',
    'artifactFreedom',
    'materialRealism',
    'cameraPhysics',
    'lightingNaturalism',
    'keyframeStartMatch',
    'keyframeEndMatch',
  ];

  const realismFallback = scores?.photorealism ?? 0;
  return Object.fromEntries(keys.map((key) => [
    key,
    clampScore(
      scores?.[key]
      ?? (['materialRealism', 'cameraPhysics', 'lightingNaturalism', 'keyframeStartMatch', 'keyframeEndMatch'].includes(key)
        ? realismFallback
        : 0),
    ),
  ]));
}

function normalizeTemporalScores(scores = {}) {
  const keys = [
    'identityStability',
    'objectPersistence',
    'geometryStability',
    'motionPlausibility',
    'cameraContinuity',
    'flickerFreedom',
    'temporalArtifactFreedom',
    'actionContinuity',
  ];

  return Object.fromEntries(keys.map((key) => [key, clampScore(scores?.[key] ?? 0)]));
}

function normalizeIssues(issues) {
  if (!Array.isArray(issues)) return [];

  return issues
    .filter((issue) => issue && typeof issue === 'object')
    .slice(0, 10)
    .map((issue) => ({
      code: String(issue.code || 'unspecified').slice(0, 80),
      severity: normalizeSeverity(issue.severity),
      evidence: String(issue.evidence || '').slice(0, 300),
    }));
}

function normalizeSeverity(value) {
  const normalized = String(value || '').toLowerCase();
  if (['low', 'medium', 'high', 'critical'].includes(normalized)) return normalized;
  return 'medium';
}

function buildGuidance(issues, scores, temporalScores) {
  const severe = issues
    .filter((issue) => ['high', 'critical'].includes(issue.severity))
    .map((issue) => `${issue.code}: ${issue.evidence}`)
    .slice(0, 4);

  if (severe.length) {
    return `Correct these visible defects: ${severe.join('; ')}. Preserve canonical identity, geometry, realistic physics and smooth temporal continuity.`;
  }

  const weakestStatic = weakestNames(scores, 1);
  const weakestTemporal = weakestNames(temporalScores, 2);
  const targets = [...weakestStatic, ...weakestTemporal].filter(Boolean);

  return `Improve ${targets.join(', ') || 'photorealism and temporal stability'} while preserving the scene content and canonical continuity.`;
}

function weakestNames(scores, count) {
  return Object.entries(scores || {})
    .sort((a, b) => a[1] - b[1])
    .slice(0, count)
    .map(([name]) => name);
}

function parseJsonObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('realism QC returned empty content');
  }

  const cleaned = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
  }

  throw new Error('realism QC returned invalid JSON');
}

async function readJsonResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('realism QC returned a non-JSON response');
  }

  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || response.statusText || 'request failed';
    throw new Error(`realism QC request failed (${response.status}): ${detail}`);
  }

  return payload;
}

function parseDuration(value) {
  if (typeof value === 'number') return value;
  const match = String(value || '').match(/^([0-9]+(?:\.[0-9]+)?)s$/);
  return match ? Number(match[1]) : null;
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.max(0, Math.min(100, number)) * 100) / 100;
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(Number(value)));
  if (!valid.length) return 0;
  return valid.reduce((sum, value) => sum + Number(value), 0) / valid.length;
}

function parseBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}
