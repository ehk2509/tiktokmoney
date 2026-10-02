import { FrameSampler } from '../services/frameSampler.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Checks whether generated footage materially misrepresents factual visual content.
 *
 * This is deliberately narrower than general fact-checking: narration/script claims are
 * the reference contract. The reviewer only blocks when the frames clearly contradict
 * that contract or show a high-confidence scientific/anatomical/mechanical depiction
 * that is materially wrong. Ambiguous or merely decorative footage passes as skipped.
 */
export class OpenRouterVisualFactualQcProvider {
  constructor({
    apiKey = process.env.OPENROUTER_API_KEY,
    baseUrl = process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.VISUAL_FACT_QC_MODEL || process.env.REALISM_QC_MODEL,
    threshold = Number(process.env.VISUAL_FACT_QC_THRESHOLD || 82),
    minBlockingConfidence = Number(process.env.VISUAL_FACT_QC_MIN_BLOCKING_CONFIDENCE || 0.85),
    frames = Number(process.env.VISUAL_FACT_QC_FRAMES || 5),
    frameWidth = Number(process.env.VISUAL_FACT_QC_FRAME_WIDTH || 640),
    maxRegenerations = Number(process.env.VISUAL_FACT_QC_MAX_REGENERATIONS || 1),
    frameSampler = new FrameSampler(),
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for visual factual QC');
    if (!model) throw new Error('VISUAL_FACT_QC_MODEL or REALISM_QC_MODEL is required for visual factual QC');
    if (!fetchImpl) throw new Error('fetch is required');

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.threshold = clampScore(threshold);
    this.minBlockingConfidence = clamp01(minBlockingConfidence, 0.85);
    this.frames = clampInt(frames, 3, 10, 5);
    this.frameWidth = clampInt(frameWidth, 320, 1024, 640);
    this.maxRegenerations = Math.max(0, Math.min(3, Number(maxRegenerations) || 0));
    this.frameSampler = frameSampler;
    this.fetch = fetchImpl;
  }

  async evaluate(asset, {
    narration = '',
    action = '',
    purpose = '',
    onScreenLabels = [],
    durationSeconds = null,
  } = {}) {
    if (!asset?.localPath) throw new Error('visual factual QC requires a local video asset');

    const duration = Number(asset.durationSeconds) || Number(durationSeconds) || 5;
    const timestamps = Array.from(
      { length: this.frames },
      (_, index) => round((duration * (index + 0.5)) / this.frames),
    );
    const frames = await this.frameSampler.sampleAt(asset.localPath, timestamps, {
      maxWidth: this.frameWidth,
      prefix: 'visual-fact',
    });

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
              'You are a conservative visual factual-consistency reviewer for short-form educational video.',
              'Treat the supplied narration as the reference claim contract; do not reject it merely because you disagree with the wording.',
              'Judge whether the GENERATED VISUALS materially contradict the narrated claim or depict a specific scientific, anatomical, historical, geographic, mechanical, numerical, or causal relationship incorrectly.',
              'Only flag a blocking contradiction when it is clearly visible and you are highly confident.',
              'Generic, decorative, metaphorical, stylized, or insufficiently detailed footage is not a contradiction; mark the check inapplicable or uncertain instead of guessing.',
              'Do not require the video to prove every spoken claim.',
              'Return JSON only.',
            ].join(' '),
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: buildPrompt({ narration, action, purpose, onScreenLabels }),
              },
              ...frames.flatMap((frame, index) => ([
                {
                  type: 'text',
                  text: `Frame ${index + 1}/${frames.length} at ${frame.timestamp.toFixed(2)}s`,
                },
                { type: 'image_url', image_url: { url: frame.dataUrl } },
              ])),
            ],
          },
        ],
      }),
    });

    const payload = await readJsonResponse(response);
    const parsed = parseJsonObject(payload?.choices?.[0]?.message?.content);
    const applicable = parsed?.applicable === true;
    const uncertain = parsed?.uncertain === true;
    const score = clampScore(parsed?.score ?? (applicable ? 0 : 100));
    const contradictions = normalizeContradictions(parsed?.contradictions, frames.length);
    const blocking = contradictions.filter((item) => (
      ['high', 'critical'].includes(item.severity)
      && item.confidence >= this.minBlockingConfidence
    ));

    if (!applicable) {
      return {
        provider: 'openrouter',
        model: this.model,
        passed: true,
        skipped: true,
        applicable: false,
        uncertain,
        score: null,
        contradictions: [],
        issues: [],
        summary: stringOrEmpty(parsed?.summary),
        regenerationGuidance: '',
        sampledFrames: frames.map(({ index, timestamp }) => ({ index, timestamp })),
        rawUsage: payload?.usage || null,
      };
    }

    const scoreFailed = !uncertain && score < this.threshold;
    const passed = blocking.length === 0 && !scoreFailed;
    const issues = [
      ...blocking.map((item) => ({
        code: 'visual-factual-contradiction',
        severity: item.severity === 'critical' ? 'critical' : 'high',
        evidence: `Frame ${item.frame}: ${item.evidence}${item.claim ? ` Claim: ${item.claim}` : ''}`,
      })),
      ...(scoreFailed && blocking.length === 0 ? [{
        code: 'visual-factual-consistency-low',
        severity: 'high',
        evidence: `Visual factual-consistency score ${score} is below threshold ${this.threshold}.`,
      }] : []),
    ];

    return {
      provider: 'openrouter',
      model: this.model,
      threshold: this.threshold,
      minBlockingConfidence: this.minBlockingConfidence,
      passed,
      skipped: false,
      applicable: true,
      uncertain,
      score,
      contradictions,
      issues,
      summary: stringOrEmpty(parsed?.summary),
      regenerationGuidance: passed
        ? ''
        : buildGuidance(blocking, narration),
      sampledFrames: frames.map(({ index, timestamp }) => ({ index, timestamp })),
      rawUsage: payload?.usage || null,
    };
  }
}

function buildPrompt({ narration, action, purpose, onScreenLabels }) {
  const labels = Array.isArray(onScreenLabels)
    ? onScreenLabels.map((item) => item?.text).filter(Boolean)
    : [];
  return [
    'Inspect the chronological frames against this scene contract.',
    `Narration/reference claims: ${String(narration || '').trim() || '(none)'}`,
    `Intended physical action/depiction: ${String(action || '').trim() || '(none)'}`,
    purpose ? `Scene purpose: ${String(purpose).trim()}` : '',
    labels.length
      ? `Editor-added labels after generation (not expected inside these raw frames): ${labels.join(', ')}`
      : '',
    '',
    'Decide applicability first. Set applicable=true only when the frames attempt to depict a concrete factual relationship that could be visually wrong.',
    'Examples of blocking errors: wrong number of organs/parts when the count is visually asserted; anatomically impossible placement presented as a diagram; wrong direction of a mechanism or flow; showing the wrong object/species/place/person for the narrated claim; a specific causal/process depiction that visibly reverses the described relation.',
    'Non-blocking: artistic glow, simplified styling, missing detail, generic B-roll, or imagery that simply does not prove the narration.',
    'If evidence is ambiguous, set uncertain=true and do not invent a contradiction.',
    'Return exactly this JSON shape:',
    '{"applicable":true,"uncertain":false,"score":92,"contradictions":[{"frame":2,"claim":"short referenced claim","evidence":"specific visible contradiction","severity":"low|medium|high|critical","confidence":0.96}],"summary":"brief visual-factual assessment"}',
  ].filter(Boolean).join('\n');
}

function normalizeContradictions(value, frameCount) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      frame: clampInt(item.frame, 1, frameCount, 1),
      claim: stringOrEmpty(item.claim).slice(0, 220),
      evidence: stringOrEmpty(item.evidence).slice(0, 500),
      severity: normalizeSeverity(item.severity),
      confidence: clamp01(item.confidence, 0),
    }))
    .filter((item) => item.evidence)
    .slice(0, 12);
}

function buildGuidance(blocking, narration) {
  if (!blocking.length) {
    return [
      'Regenerate the scene so the visible depiction accurately matches the narrated factual relationship.',
      'Prefer a simpler, non-diagrammatic visual if the model cannot reliably render the factual structure.',
    ].join(' ');
  }

  const details = blocking
    .slice(0, 4)
    .map((item) => item.evidence)
    .join(' ');
  return [
    'Correct the factual visual contradiction without adding model-rendered text.',
    details,
    narration ? `Keep the picture consistent with the narration: "${String(narration).slice(0, 240)}".` : '',
    'If precise anatomy, structure, count, or mechanism cannot be rendered reliably, use a simpler external/establishing view instead of inventing details.',
  ].filter(Boolean).join(' ');
}

async function readJsonResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('visual factual QC returned a non-JSON response');
  }

  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || response.statusText || 'request failed';
    throw new Error(`visual factual QC request failed (${response.status}): ${detail}`);
  }
  return payload;
}

function parseJsonObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('visual factual QC returned empty content');

  const cleaned = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  }
  throw new Error('visual factual QC returned invalid JSON');
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

function clamp01(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
