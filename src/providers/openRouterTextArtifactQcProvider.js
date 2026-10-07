import { FrameSampler } from '../services/frameSampler.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Rejects acts in which the video model rendered written text (labels, captions,
 * signage, pseudo-letters). Generated text is frequently garbled or factually
 * unreliable; any intended text is added deterministically after generation,
 * so this check runs on raw generated footage before subtitles or labels exist.
 */
export class OpenRouterTextArtifactQcProvider {
  constructor({
    apiKey = process.env.OPENROUTER_API_KEY,
    baseUrl = process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.TEXT_ARTIFACT_QC_MODEL || process.env.REALISM_QC_MODEL,
    frames = Number(process.env.TEXT_ARTIFACT_QC_FRAMES || 4),
    frameWidth = Number(process.env.TEXT_ARTIFACT_QC_FRAME_WIDTH || 640),
    maxRegenerations = Number(process.env.TEXT_ARTIFACT_QC_MAX_REGENERATIONS || 1),
    frameSampler = new FrameSampler(),
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for generated-text QC');
    if (!model) throw new Error('TEXT_ARTIFACT_QC_MODEL or REALISM_QC_MODEL is required for generated-text QC');
    if (!fetchImpl) throw new Error('fetch is required');

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.frames = clampInt(frames, 2, 8, 4);
    this.frameWidth = clampInt(frameWidth, 320, 1024, 640);
    this.maxRegenerations = Math.max(0, Math.min(3, Number(maxRegenerations) || 0));
    this.frameSampler = frameSampler;
    this.fetch = fetchImpl;
  }

  async evaluate(asset, { durationSeconds } = {}) {
    if (!asset?.localPath) throw new Error('generated-text QC requires a local video asset');

    const duration = Number(asset.durationSeconds) || Number(durationSeconds) || 5;
    const timestamps = Array.from(
      { length: this.frames },
      (_, index) => round((duration * (index + 0.5)) / this.frames),
    );
    const frames = await this.frameSampler.sampleAt(asset.localPath, timestamps, {
      maxWidth: this.frameWidth,
      prefix: 'text-artifact',
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
            content: 'You detect written text in video frames. Report only what is visible. Return JSON only.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: buildPrompt() },
              ...frames.flatMap((frame, index) => ([
                { type: 'text', text: `Frame ${index + 1}/${frames.length} at ${frame.timestamp.toFixed(2)}s` },
                { type: 'image_url', image_url: { url: frame.dataUrl } },
              ])),
            ],
          },
        ],
      }),
    });

    const payload = await readJsonResponse(response);
    const parsed = parseJsonObject(payload?.choices?.[0]?.message?.content);
    const detections = Array.isArray(parsed?.detections)
      ? parsed.detections
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          frame: clampInt(item.frame, 1, frames.length, 1),
          text: stringOrEmpty(item.text).slice(0, 120),
          kind: stringOrEmpty(item.kind).slice(0, 40) || 'text',
          placement: stringOrEmpty(item.placement).slice(0, 20) || 'unknown',
        }))
        .slice(0, 12)
      : [];
    // A lone locker or jersey number is ordinary set dressing; captions, labels,
    // words and garbled text are what this gate exists to stop.
    const blocking = detections.filter((item) => !isIncidentalMarking(item));
    const incidental = detections.filter((item) => isIncidentalMarking(item));
    const hasText = blocking.length > 0 || (parsed?.hasText === true && detections.length === 0);
    const issues = hasText
      ? [{
        code: 'generated-text',
        severity: 'critical',
        evidence: blocking.length
          ? `Model-rendered text visible: ${blocking.map((item) => `"${item.text || item.kind}" (frame ${item.frame})`).join(', ')}.`
          : 'Model-rendered text is visible in the frame.',
      }]
      : [];
    const warnings = incidental.map((item) => ({
      code: 'incidental-marking',
      severity: 'warning',
      evidence: `Short marking "${item.text}" on a background object (frame ${item.frame}).`,
    }));

    return {
      provider: 'openrouter',
      model: this.model,
      passed: !hasText,
      skipped: false,
      hasText,
      detections,
      issues,
      warnings,
      regenerationGuidance: hasText
        ? 'Remove every written element from the picture: no labels, callouts, captions, diagram text, signage, letters or numbers. Show the subject itself; explanations are added after generation.'
        : '',
      sampledFrames: frames.map((frame) => ({ index: frame.index, timestamp: frame.timestamp })),
      rawUsage: payload?.usage || null,
    };
  }
}

export function isIncidentalMarking(detection) {
  const characters = String(detection?.text || '').replace(/[^\p{L}\p{N}]/gu, '');
  return characters.length > 0
    && characters.length <= 2
    && detection.placement !== 'overlay'
    && !['caption', 'watermark', 'pseudo-text', 'label'].includes(String(detection.kind || '').toLowerCase());
}

function buildPrompt() {
  return [
    'Inspect every frame for written text rendered into the picture: labels, callouts, captions, infographic or diagram text, signage, logos with letters, watermarks, numbers, or letter-like pseudo-text.',
    'Ignore shapes, glows or arrows that contain no letters or digits.',
    'Return JSON with this shape:',
    'For each detection, set placement to "overlay" if it floats on top of the image (captions, titles, watermarks, callouts) or "object" if it is printed on something in the scene (a locker, jersey, sign, equipment).',
    '{"hasText": false, "detections": [{"frame": 1, "text": "exact or approximate characters", "kind": "label|caption|sign|watermark|pseudo-text|number", "placement": "overlay|object"}]}',
  ].join('\n');
}

async function readJsonResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('generated-text QC returned a non-JSON response');
  }

  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || response.statusText || 'request failed';
    throw new Error(`generated-text QC request failed (${response.status}): ${detail}`);
  }
  return payload;
}

function parseJsonObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('generated-text QC returned empty content');

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
  throw new Error('generated-text QC returned invalid JSON');
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
