import { FrameSampler } from '../services/frameSampler.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterRealismQcProvider {
  constructor({
    apiKey = process.env.OPENROUTER_API_KEY,
    baseUrl = process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.REALISM_QC_MODEL,
    threshold = Number(process.env.REALISM_QC_THRESHOLD || 82),
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
    this.maxRegenerations = Math.max(0, Math.min(3, Number(maxRegenerations) || 0));
    this.failClosed = Boolean(failClosed);
    this.frameSampler = frameSampler;
    this.fetch = fetchImpl;
  }

  async evaluateScene(scene, asset, { previousAsset = null } = {}) {
    if (!asset?.localPath) {
      throw new Error('realism QC requires a local video asset');
    }

    const frames = await this.frameSampler.sample(asset.localPath, {
      durationSeconds: parseDuration(asset.generatedDuration)
        || Number(asset.durationSeconds)
        || Number(scene.duration)
        || 5,
    });

    const prompt = buildPrompt({ scene, asset, previousAsset });
    const content = [
      { type: 'text', text: prompt },
      ...frames.map((frame) => ({
        type: 'image_url',
        image_url: { url: frame.dataUrl },
      })),
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
              'You are a strict visual quality-control reviewer for photorealistic short-form video.',
              'Judge only what is visible in the supplied sampled frames.',
              'Do not reward cinematic style if the scene looks synthetic or physically implausible.',
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
    const issues = normalizeIssues(parsed?.issues);
    const overallScore = clampScore(
      parsed?.overallScore ?? average(Object.values(scores)),
    );
    const criticalFailure = issues.some((issue) => issue.severity === 'critical');
    const passed = overallScore >= this.threshold && !criticalFailure;

    return {
      provider: 'openrouter',
      model: this.model,
      threshold: this.threshold,
      passed,
      overallScore,
      scores,
      issues,
      summary: stringOrEmpty(parsed?.summary),
      regenerationGuidance: stringOrEmpty(parsed?.regenerationGuidance)
        || buildGuidance(issues, scores),
      sampledFrames: frames.map(({ index, timestamp }) => ({ index, timestamp })),
      previousGenerationId: previousAsset?.generationId || null,
      rawUsage: payload?.usage || null,
    };
  }
}

function buildPrompt({ scene, asset, previousAsset }) {
  return [
    'Evaluate these frames from ONE AI-generated vertical video scene.',
    '',
    `Narrative requirement: ${scene.narration}`,
    `Intended visual prompt: ${asset.prompt || scene.realism?.motionPrompt || scene.visualPrompt || ''}`,
    previousAsset
      ? 'Continuity requirement: the scene should plausibly belong to the same visual world as the preceding scene.'
      : 'Continuity requirement: this is the first scene.',
    '',
    'Score each dimension from 0 to 100:',
    '- photorealism: would an ordinary viewer plausibly believe this was camera footage?',
    '- anatomy: faces, hands, limbs and bodies are structurally plausible.',
    '- geometry: objects, architecture and backgrounds are coherent and stable.',
    '- physics: gravity, contact, reflections, perspective and physical interactions look plausible.',
    '- motionConsistency: sampled frames imply stable identity and non-morphing motion.',
    '- continuity: subject/environment/style stay coherent across the sampled frames.',
    '- sceneRelevance: visuals actually illustrate the narration.',
    '- artifactFreedom: no obvious AI artifacts, duplicate objects, warped text, watermarks or impossible details.',
    '',
    'List only concrete visible defects. Severity must be low, medium, high, or critical.',
    'regenerationGuidance must be a compact instruction describing what the next generation should correct.',
    '',
    'Return exactly one JSON object shaped like:',
    '{',
    '  "overallScore": 0,',
    '  "scores": {',
    '    "photorealism": 0, "anatomy": 0, "geometry": 0, "physics": 0,',
    '    "motionConsistency": 0, "continuity": 0, "sceneRelevance": 0, "artifactFreedom": 0',
    '  },',
    '  "issues": [{"code":"hands","severity":"high","evidence":"brief visible evidence"}],',
    '  "summary": "one sentence",',
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
    'sceneRelevance',
    'artifactFreedom',
  ];

  return Object.fromEntries(keys.map((key) => [key, clampScore(scores?.[key] ?? 0)]));
}

function normalizeIssues(issues) {
  if (!Array.isArray(issues)) return [];

  return issues
    .filter((issue) => issue && typeof issue === 'object')
    .slice(0, 8)
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

function buildGuidance(issues, scores) {
  const severe = issues
    .filter((issue) => ['high', 'critical'].includes(issue.severity))
    .map((issue) => `${issue.code}: ${issue.evidence}`)
    .slice(0, 3);

  if (severe.length) {
    return `Correct these visible defects: ${severe.join('; ')}. Preserve realistic anatomy, geometry, physics and identity.`;
  }

  const weakest = Object.entries(scores)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 2)
    .map(([name]) => name)
    .join(' and ');

  return `Improve ${weakest || 'photorealism'} while preserving the scene content and continuity.`;
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
