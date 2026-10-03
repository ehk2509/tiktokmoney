import { FrameSampler } from '../services/frameSampler.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterEditorialVarietyQcProvider {
  constructor({
    apiKey = process.env.OPENROUTER_API_KEY,
    baseUrl = process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.EDITORIAL_VARIETY_QC_MODEL || process.env.REALISM_QC_MODEL,
    threshold = Number(process.env.EDITORIAL_VARIETY_QC_THRESHOLD || 80),
    frames = Number(process.env.EDITORIAL_VARIETY_QC_FRAMES || 3),
    frameWidth = Number(process.env.EDITORIAL_VARIETY_QC_FRAME_WIDTH || 512),
    maxRegenerations = Number(process.env.EDITORIAL_VARIETY_QC_MAX_REGENERATIONS || 2),
    frameSampler = new FrameSampler(),
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for editorial variety QC');
    if (!model) throw new Error('EDITORIAL_VARIETY_QC_MODEL or REALISM_QC_MODEL is required for editorial variety QC');
    if (!fetchImpl) throw new Error('fetch is required');

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.threshold = clampScore(threshold);
    this.frames = clampInt(frames, 2, 6, 3);
    this.frameWidth = clampInt(frameWidth, 320, 768, 512);
    this.maxRegenerations = Math.max(0, Math.min(2, Number(maxRegenerations) || 0));
    this.frameSampler = frameSampler;
    this.fetch = fetchImpl;
  }

  async evaluate(asset, {
    segment,
    previousAsset = null,
    previousSegment = null,
  } = {}) {
    if (!asset?.localPath) throw new Error('editorial variety QC requires a local video asset');
    if (!previousAsset?.localPath || !previousSegment) {
      return skippedResult('first-act-or-no-previous-asset', this.model, this.threshold);
    }
    if (!segment?.shotType || segment.shotType === previousSegment.shotType) {
      return skippedResult('no-distinct-shot-contract', this.model, this.threshold);
    }

    const currentDuration = Number(asset.durationSeconds) || Number(segment.durationSeconds) || 5;
    const previousDuration = Number(previousAsset.durationSeconds)
      || Number(previousSegment.durationSeconds)
      || 5;
    const currentTimes = sampleTimes(currentDuration, this.frames);
    const previousTailTimes = transitionTailTimes(previousDuration);
    const currentOpeningTimes = transitionOpeningTimes(currentDuration);

    const [previousFrames, currentOpeningFrames, currentFrames] = await Promise.all([
      this.frameSampler.sampleAt(previousAsset.localPath, previousTailTimes, {
        maxWidth: this.frameWidth,
        prefix: 'editorial-prev-tail',
      }),
      this.frameSampler.sampleAt(asset.localPath, currentOpeningTimes, {
        maxWidth: this.frameWidth,
        prefix: 'editorial-current-opening',
      }),
      this.frameSampler.sampleAt(asset.localPath, currentTimes, {
        maxWidth: this.frameWidth,
        prefix: 'editorial-current',
      }),
    ]);

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
              'You are an editorial shot-variety reviewer for short-form vertical video.',
              'Compare the PREVIOUS accepted act with the CURRENT generated act.',
              'Identity, wardrobe, location and object continuity may remain the same.',
              'Judge whether the new act creates a materially different composition that actually fulfills its requested shot type.',
              'Do not reward superficial subject motion when camera distance, angle and composition remain effectively unchanged.',
              'Return JSON only.',
            ].join(' '),
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: buildPrompt({ segment, previousSegment }),
              },
              ...previousFrames.flatMap((frame, index) => ([
                { type: 'text', text: `PREVIOUS TAIL frame ${index + 1} at ${frame.timestamp.toFixed(2)}s` },
                { type: 'image_url', image_url: { url: frame.dataUrl } },
              ])),
              ...currentOpeningFrames.flatMap((frame, index) => ([
                { type: 'text', text: `CURRENT OPENING frame ${index + 1} at ${frame.timestamp.toFixed(2)}s` },
                { type: 'image_url', image_url: { url: frame.dataUrl } },
              ])),
              ...currentFrames.flatMap((frame, index) => ([
                { type: 'text', text: `CURRENT WHOLE-ACT frame ${index + 1} at ${frame.timestamp.toFixed(2)}s` },
                { type: 'image_url', image_url: { url: frame.dataUrl } },
              ])),
            ],
          },
        ],
      }),
    });

    const payload = await readJsonResponse(response);
    const parsed = parseJsonObject(payload?.choices?.[0]?.message?.content);
    const scores = {
      transitionDistinctness: clampScore(
        parsed?.scores?.transitionDistinctness ?? parsed?.scores?.compositionDifference,
      ),
      shotTypeAdherence: clampScore(parsed?.scores?.shotTypeAdherence),
      compositionDifference: clampScore(parsed?.scores?.compositionDifference),
      scaleOrAngleDifference: clampScore(parsed?.scores?.scaleOrAngleDifference),
      editorialNovelty: clampScore(parsed?.scores?.editorialNovelty),
    };
    const score = clampScore(parsed?.score ?? average(Object.values(scores)));
    const reported = normalizeIssues(parsed?.issues);
    // Issue-driven like factual QC: only a concrete high/critical defect (e.g.
    // repeated-framing) regenerates. A low score with no such defect is a warning,
    // because the reviewer often scores visibly distinct shots in the high 60s.
    const issues = reported.filter((issue) => ['high', 'critical'].includes(issue.severity));
    const passed = issues.length === 0;
    const warnings = [
      ...reported.filter((issue) => !issues.includes(issue)).map((issue) => ({ ...issue, severity: 'warning' })),
      ...(score < this.threshold && passed ? [{
        code: 'editorial-variety-low',
        severity: 'warning',
        evidence: `Diagnostic editorial-variety score ${score} is below warning threshold ${this.threshold}, but no blocking framing defect was found.`,
      }] : []),
    ];

    return {
      provider: 'openrouter',
      model: this.model,
      passed,
      skipped: false,
      score,
      threshold: this.threshold,
      scores,
      previousShotType: previousSegment.shotType,
      currentShotType: segment.shotType,
      issues,
      warnings,
      summary: stringOrEmpty(parsed?.summary),
      regenerationGuidance: passed
        ? ''
        : stringOrEmpty(parsed?.regenerationGuidance)
          || buildGuidance(segment, previousSegment, scores),
      sampledFrames: {
        previous: previousFrames.map(({ index, timestamp }) => ({ index, timestamp })),
        currentOpening: currentOpeningFrames.map(({ index, timestamp }) => ({ index, timestamp })),
        current: currentFrames.map(({ index, timestamp }) => ({ index, timestamp })),
      },
      rawUsage: payload?.usage || null,
    };
  }
}

function buildPrompt({ segment, previousSegment }) {
  return [
    'The screenplay intentionally requires visually distinct consecutive acts.',
    `PREVIOUS shot type: ${previousSegment.shotType || '(unknown)'}.`,
    `PREVIOUS camera direction: ${previousSegment.camera || '(none)'}.`,
    `CURRENT required shot type: ${segment.shotType || '(unknown)'}.`,
    `CURRENT camera direction: ${segment.camera || '(none)'}.`,
    `CURRENT action: ${segment.action || '(none)'}.`,
    '',
    'Score 0-100:',
    '- transitionDistinctness: compare PREVIOUS TAIL with CURRENT OPENING. The current act must open directly in its planned new framing; it must not reuse the previous framing for the first seconds and only change later.',
    '- shotTypeAdherence: current frames actually look like the requested current shot type.',
    '- compositionDifference: subject placement/framing is materially different from the previous act.',
    '- scaleOrAngleDifference: camera scale, axis, angle or perspective changes enough to create a new shot.',
    '- editorialNovelty: the viewer receives meaningfully new visual information rather than the same setup with only minor motion.',
    '',
    'For close-up/macro, require a clear crop/scale change. For wide, require meaningful environmental context. For overhead/POV, require a materially different camera axis. For tracking, require visible camera travel/parallax.',
    'Same location, same character, same apparatus and continuity are NOT failures by themselves.',
    'If CURRENT OPENING substantially matches PREVIOUS TAIL before changing later, emit issue code "transition-framing-reuse" with severity high even if the later whole-act frames are diverse.',
    'If the current act is distinct from its first visible frames onward, do not emit transition-framing-reuse.',
    'A 20-60 second explainer should not feel like one unchanged composition repeated across acts.',
    'Return JSON:',
    '{"score":0,"scores":{"transitionDistinctness":0,"shotTypeAdherence":0,"compositionDifference":0,"scaleOrAngleDifference":0,"editorialNovelty":0},"issues":[{"code":"transition-framing-reuse","severity":"high","evidence":"opening frames visibly reuse the previous tail framing before the planned change"}],"summary":"one sentence","regenerationGuidance":"specific camera/framing correction"}',
  ].join('\n');
}

function buildGuidance(segment, previousSegment, scores) {
  const weakest = Object.entries(scores)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 2)
    .map(([name]) => name)
    .join(' and ');
  return [
    `EDITORIAL VARIETY CORRECTION: make this act visibly different from the previous ${previousSegment.shotType || 'shot'}.`,
    `Honor the current ${segment.shotType || 'shot'} framing contract and improve ${weakest}.`,
    'Preserve character identity, location continuity, dialogue and factual content; change camera distance, angle, axis or composition rather than merely moving the subject.',
  ].join(' ');
}

function skippedResult(reason, model, threshold) {
  return {
    provider: 'openrouter',
    model,
    passed: true,
    skipped: true,
    score: null,
    threshold,
    scores: null,
    issues: [],
    warnings: [],
    summary: '',
    regenerationGuidance: '',
    reason,
    sampledFrames: { previous: [], currentOpening: [], current: [] },
    rawUsage: null,
  };
}

function sampleTimes(duration, count) {
  const safeDuration = Math.max(0.5, Number(duration) || 5);
  return Array.from({ length: count }, (_, index) => (
    round((safeDuration * (index + 0.5)) / count)
  ));
}

function transitionTailTimes(duration) {
  const safeDuration = Math.max(0.5, Number(duration) || 5);
  return uniqueTimes([
    Math.max(0, safeDuration - 1),
    Math.max(0, safeDuration - 0.2),
  ], safeDuration);
}

function transitionOpeningTimes(duration) {
  const safeDuration = Math.max(0.5, Number(duration) || 5);
  return uniqueTimes([
    Math.min(0.15, safeDuration * 0.1),
    Math.min(0.75, safeDuration * 0.35),
    Math.min(1.5, safeDuration * 0.6),
  ], safeDuration);
}

function uniqueTimes(values, duration) {
  return [...new Set(values
    .map((value) => round(Math.max(0, Math.min(Math.max(0, duration - 0.05), value))))
    .map(String))]
    .map(Number)
    .sort((a, b) => a - b);
}

function normalizeIssues(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object')
    .slice(0, 8)
    .map((item) => ({
      code: String(item.code || 'editorial-variety').slice(0, 80),
      severity: normalizeSeverity(item.severity),
      evidence: String(item.evidence || '').slice(0, 400),
    }));
}

async function readJsonResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('editorial variety QC returned a non-JSON response');
  }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || response.statusText || 'request failed';
    throw new Error(`editorial variety QC request failed (${response.status}): ${detail}`);
  }
  return payload;
}

function parseJsonObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('editorial variety QC returned empty content');
  const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  }
  throw new Error('editorial variety QC returned invalid JSON');
}

function normalizeSeverity(value) {
  const severity = String(value || '').toLowerCase();
  return ['low', 'medium', 'high', 'critical'].includes(severity) ? severity : 'medium';
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number * 100) / 100));
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function average(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (!finite.length) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
