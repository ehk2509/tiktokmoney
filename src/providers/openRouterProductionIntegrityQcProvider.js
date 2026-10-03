import { FrameSampler, denseTemporalTimestamps } from '../services/frameSampler.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Verifies production intent that should already have been prevented by screenplay/prompt
 * contracts: required visible roles/interactions, single-shot integrity, and brand safety.
 * One chronological vision call covers all four so the fallback gate stays cheaper than
 * multiple specialized retries.
 */
export class OpenRouterProductionIntegrityQcProvider {
  constructor({
    apiKey = process.env.OPENROUTER_API_KEY,
    baseUrl = process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.PRODUCTION_INTEGRITY_QC_MODEL || process.env.REALISM_QC_MODEL,
    threshold = Number(process.env.PRODUCTION_INTEGRITY_QC_THRESHOLD || 82),
    minBlockingConfidence = Number(process.env.PRODUCTION_INTEGRITY_QC_MIN_BLOCKING_CONFIDENCE || 0.85),
    frames = Number(process.env.PRODUCTION_INTEGRITY_QC_FRAMES || 10),
    frameWidth = Number(process.env.PRODUCTION_INTEGRITY_QC_FRAME_WIDTH || 448),
    maxRegenerations = Number(process.env.PRODUCTION_INTEGRITY_QC_MAX_REGENERATIONS || 1),
    frameSampler = new FrameSampler(),
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for production-integrity QC');
    if (!model) throw new Error('PRODUCTION_INTEGRITY_QC_MODEL or REALISM_QC_MODEL is required for production-integrity QC');
    if (!fetchImpl) throw new Error('fetch is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.threshold = clampScore(threshold);
    this.minBlockingConfidence = clamp01(minBlockingConfidence, 0.85);
    this.frames = clampInt(frames, 6, 12, 10);
    this.frameWidth = clampInt(frameWidth, 320, 768, 448);
    this.maxRegenerations = Math.max(0, Math.min(3, Number(maxRegenerations) || 0));
    this.frameSampler = frameSampler;
    this.fetch = fetchImpl;
  }

  async evaluate(asset, { segment, productionScript } = {}) {
    if (!asset?.localPath) throw new Error('production-integrity QC requires a local video asset');
    const duration = Number(asset.durationSeconds) || Number(segment?.durationSeconds) || 5;
    const timestamps = denseTemporalTimestamps(duration, this.frames);
    const frames = await this.frameSampler.sampleAt(asset.localPath, timestamps, {
      maxWidth: this.frameWidth,
      prefix: 'production-integrity',
    });

    const contract = productionScript?.directorialContract || {};
    const deadline = Number(contract.interactionMustBeginBySeconds);
    const segmentStart = Number(segment?.start) || 0;
    const requiredIds = Array.isArray(contract.requiredVisibleCharacterIds)
      ? contract.requiredVisibleCharacterIds
      : [];
    const boundIds = Array.isArray(segment?.characterIds) ? segment.characterIds : [];
    const requiredRoleIds = [...new Set([
      ...requiredIds.filter((id) => boundIds.includes(id)),
      ...(Number.isFinite(deadline) && segmentStart < deadline + 0.001 ? requiredIds : []),
    ])];
    const requiredCharacters = (productionScript?.characters || [])
      .filter((character) => requiredRoleIds.includes(character.id))
      .map((character) => ({
        id: character.id,
        name: character.name,
        description: character.description,
        wardrobe: character.wardrobe,
      }));
    const interactionRequired = Boolean(
      contract.requiredInteraction
      && Number.isFinite(deadline)
      && segmentStart < deadline + 0.001
    );

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
              'You are a strict production-integrity reviewer for generated short-form video.',
              'Judge only visible evidence in the chronological frames and the supplied binding contract.',
              'Do not invent hidden brands, cuts, people, or interactions. Only block high-confidence visible violations.',
              'Return JSON only.',
            ].join(' '),
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: buildPrompt({
                segment,
                contract,
                requiredCharacters,
                interactionRequired,
              }) },
              ...frames.flatMap((frame, index) => ([
                { type: 'text', text: `Chronological frame ${index + 1}/${frames.length} at ${frame.timestamp.toFixed(2)}s` },
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
      roleAdherence: clampScore(parsed?.scores?.roleAdherence ?? 100),
      interactionAdherence: clampScore(parsed?.scores?.interactionAdherence ?? 100),
      singleShotIntegrity: clampScore(parsed?.scores?.singleShotIntegrity ?? 100),
      brandSafety: clampScore(parsed?.scores?.brandSafety ?? 100),
    };
    const violations = normalizeViolations(parsed?.violations, frames.length);
    const blocking = violations.filter((item) => (
      ['high', 'critical'].includes(item.severity)
      && item.confidence >= this.minBlockingConfidence
    ));
    const warnings = blocking.length === 0 && average(Object.values(scores)) < this.threshold
      ? [{
        code: 'production-integrity-low',
        severity: 'warning',
        evidence: `Diagnostic integrity score ${average(Object.values(scores))} is below ${this.threshold}, but no high-confidence blocking violation was found.`,
      }]
      : [];

    return {
      provider: 'openrouter',
      model: this.model,
      threshold: this.threshold,
      minBlockingConfidence: this.minBlockingConfidence,
      passed: blocking.length === 0,
      skipped: false,
      scores,
      violations,
      issues: blocking.map((item) => ({
        code: item.code,
        severity: item.severity,
        evidence: `Frame ${item.frame}: ${item.evidence}`,
      })),
      warnings,
      summary: stringOrEmpty(parsed?.summary),
      regenerationGuidance: blocking.length
        ? buildGuidance(blocking, contract)
        : '',
      sampledFrames: frames.map(({ index, timestamp }) => ({ index, timestamp })),
      rawUsage: payload?.usage || null,
    };
  }
}

function buildPrompt({ segment, contract, requiredCharacters, interactionRequired }) {
  const brandPolicy = contract.brandPolicy || { mode: 'unbranded', allowedBrands: [] };
  return [
    'Inspect this single generated act against four production contracts.',
    `ACT purpose: ${segment?.purpose || '(none)'}.`,
    `ACT action: ${segment?.action || '(none)'}.`,
    `ACT camera: ${segment?.camera || '(none)'}.`,
    `ACT editing contract: ${segment?.editing?.allowInternalCuts ? 'internal cuts explicitly allowed' : 'ONE continuous shot; no internal cuts'}; ${segment?.editing?.allowDissolves ? 'dissolve allowed' : 'no dissolves/crossfades/ghosting'}.`,
    requiredCharacters.length
      ? `REQUIRED VISIBLE ROLE(S) IN THIS ACT: ${requiredCharacters.map((item) => `${item.id}=${item.name}: ${item.description}; wardrobe ${item.wardrobe}`).join(' | ')}`
      : 'No special global role is required in this act beyond the act description.',
    interactionRequired
      ? `REQUIRED HUMAN INTERACTION IN THIS EARLY ACT: ${contract.requiredInteraction}`
      : 'No global interaction-deadline check applies to this act; still follow the ACT action.',
    brandPolicy.mode === 'unbranded'
      ? 'BRAND CONTRACT: everything must be unbranded. A recognizable commercial logo, trademark, sponsor/team mark, signature swoosh/stripe system, or unmistakable branded trade dress is a violation.'
      : `BRAND CONTRACT: only these brands are allowed: ${(brandPolicy.allowedBrands || []).join(', ') || '(none)'}. Any other recognizable brand is a violation.`,
    '',
    'Check these independently:',
    '1) roleAdherence: required visible role/person is actually present and visually occupies the intended role. Do not accept substitution by an anonymous player/narrator.',
    '2) interactionAdherence: when required, the visible interpersonal interaction is already happening in this act rather than being replaced by solitary preparation B-roll.',
    '3) singleShotIntegrity: if one continuous shot is required, reject abrupt composition/time jumps, hidden montage cuts, dissolves, crossfades, ghosting, double exposure, or teleporting between different shots.',
    '4) brandSafety: reject only recognizable unauthorized branding. Do not guess from generic curves, stripes, or ordinary clothing shapes unless the mark is clearly brand-like.',
    '',
    'Allowed violation codes: required-role-missing, required-interaction-missing, internal-cut, ghost-transition, unauthorized-brand-logo.',
    'Only high/critical violations with strong visible evidence should block. If uncertain, lower confidence instead of inventing a failure.',
    'Return JSON:',
    '{"scores":{"roleAdherence":100,"interactionAdherence":100,"singleShotIntegrity":100,"brandSafety":100},"violations":[{"code":"unauthorized-brand-logo","frame":2,"severity":"high","confidence":0.96,"evidence":"recognizable swoosh-shaped commercial shoe logo"}],"summary":"one sentence"}',
  ].join('\n');
}

function normalizeViolations(value, frameCount) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set([
    'required-role-missing',
    'required-interaction-missing',
    'internal-cut',
    'ghost-transition',
    'unauthorized-brand-logo',
  ]);
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      code: allowed.has(String(item.code)) ? String(item.code) : 'production-integrity',
      frame: clampInt(item.frame, 1, frameCount, 1),
      severity: normalizeSeverity(item.severity),
      confidence: clamp01(item.confidence, 0),
      evidence: stringOrEmpty(item.evidence).slice(0, 500),
    }))
    .filter((item) => item.evidence)
    .slice(0, 12);
}

function buildGuidance(blocking, contract) {
  const codes = new Set(blocking.map((item) => item.code));
  return [
    codes.has('required-role-missing')
      ? `Show the required primary role clearly and visibly: ${contract.primaryVisibleRole || (contract.requiredVisibleCharacterIds || []).join(', ')}. Do not substitute an anonymous protagonist.`
      : '',
    codes.has('required-interaction-missing')
      ? `Start the required human interaction immediately: ${contract.requiredInteraction || 'follow the interpersonal action in the screenplay'}.`
      : '',
    codes.has('internal-cut') || codes.has('ghost-transition')
      ? 'Render one continuous physical camera take with no internal cuts, montage, dissolve, crossfade, ghosting, double exposure, or time jump.'
      : '',
    codes.has('unauthorized-brand-logo')
      ? 'Use completely generic unbranded wardrobe, shoes, balls, equipment, walls and props. Remove recognizable logos, trademarks, sponsor marks, signature swooshes/stripes and branded trade dress.'
      : '',
  ].filter(Boolean).join(' ');
}

async function readJsonResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('production-integrity QC returned a non-JSON response');
  }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || response.statusText || 'request failed';
    throw new Error(`production-integrity QC request failed (${response.status}): ${detail}`);
  }
  return payload;
}

function parseJsonObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('production-integrity QC returned empty content');
  const cleaned = raw.replace(/^\s*\`\`\`(?:json)?/i, '').replace(/\`\`\`\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  }
  throw new Error('production-integrity QC returned invalid JSON');
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

function average(values) {
  const numeric = values.map(Number).filter(Number.isFinite);
  if (!numeric.length) return 0;
  return Math.round((numeric.reduce((sum, value) => sum + value, 0) / numeric.length) * 100) / 100;
}
