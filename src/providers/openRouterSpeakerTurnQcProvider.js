import { FrameSampler } from '../services/frameSampler.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterSpeakerTurnQcProvider {
  constructor({
    apiKey = process.env.OPENROUTER_API_KEY,
    baseUrl = process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.SPEAKER_TURN_QC_MODEL || process.env.REALISM_QC_MODEL,
    threshold = Number(process.env.SPEAKER_TURN_QC_THRESHOLD || 82),
    frameWidth = Number(process.env.SPEAKER_TURN_QC_FRAME_WIDTH || 448),
    maxRegenerations = Number(process.env.SPEAKER_TURN_QC_MAX_REGENERATIONS || 1),
    frameSampler = new FrameSampler(),
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for speaker-turn QC');
    if (!model) throw new Error('SPEAKER_TURN_QC_MODEL or REALISM_QC_MODEL is required for speaker-turn QC');
    if (!fetchImpl) throw new Error('fetch is required');

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.threshold = clampScore(threshold);
    this.frameWidth = clampInt(frameWidth, 256, 768, 448);
    this.maxRegenerations = Math.max(0, Math.min(3, Number(maxRegenerations) || 0));
    this.frameSampler = frameSampler;
    this.fetch = fetchImpl;
  }

  async evaluate(asset, {
    dialogueTurns = [],
    characters = [],
  } = {}) {
    const turns = normalizeTurns(dialogueTurns);
    const uniqueSpeakers = new Set(turns.map((turn) => turn.speakerCharacterId));

    if (turns.length < 2 || uniqueSpeakers.size < 2) {
      return {
        provider: 'openrouter',
        model: this.model,
        passed: true,
        skipped: true,
        score: 100,
        threshold: this.threshold,
        issues: [],
        regenerationGuidance: '',
        sampledFrames: [],
      };
    }
    if (!asset?.localPath) throw new Error('speaker-turn QC requires a local audiovisual asset');

    const samples = buildSpeakerSamples(turns);
    const frames = await this.frameSampler.sampleAt(
      asset.localPath,
      samples.map((sample) => sample.timestamp),
      { maxWidth: this.frameWidth, prefix: 'speaker-turn' },
    );

    const cast = new Map(characters.map((character) => [character.id, character]));
    const content = [
      {
        type: 'text',
        text: buildPrompt({ turns, samples, cast }),
      },
      ...frames.flatMap((frame, index) => ([
        {
          type: 'text',
          text: `Frame ${index + 1}/${frames.length} at ${frame.timestamp.toFixed(3)}s — ${samples[index].label}`,
        },
        {
          type: 'image_url',
          image_url: { url: frame.dataUrl },
        },
      ])),
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
              'You are a strict dialogue blocking and speaker-attribution reviewer.',
              'Judge visible speaker identity and mouth activity only from the supplied frames and timing plan.',
              'Return JSON only.',
            ].join(' '),
          },
          { role: 'user', content },
        ],
      }),
    });

    const payload = await readJsonResponse(response);
    const raw = payload?.choices?.[0]?.message?.content;
    const parsed = parseJsonObject(raw);
    const scores = {
      speakerAttribution: clampScore(parsed?.scores?.speakerAttribution),
      activeSpeakerMouthMotion: clampScore(parsed?.scores?.activeSpeakerMouthMotion),
      listenerStillness: clampScore(parsed?.scores?.listenerStillness),
      castIdentityStability: clampScore(parsed?.scores?.castIdentityStability),
      turnTakingClarity: clampScore(parsed?.scores?.turnTakingClarity),
    };
    const score = clampScore(parsed?.score ?? average(Object.values(scores)));
    const issues = normalizeIssues(parsed?.issues);
    const critical = issues.some((issue) => issue.severity === 'critical');
    const passed = score >= this.threshold && !critical;

    return {
      provider: 'openrouter',
      model: this.model,
      passed,
      skipped: false,
      score,
      threshold: this.threshold,
      scores,
      issues,
      summary: stringOrEmpty(parsed?.summary),
      regenerationGuidance: stringOrEmpty(parsed?.regenerationGuidance)
        || buildGuidance(scores, issues, turns),
      sampledFrames: frames.map((frame, index) => ({
        index: frame.index,
        timestamp: frame.timestamp,
        speakerCharacterId: samples[index].speakerCharacterId,
        kind: samples[index].kind,
      })),
      rawUsage: payload?.usage || null,
    };
  }
}

export function buildSpeakerSamples(turns) {
  const samples = [];
  for (const turn of normalizeTurns(turns)) {
    const duration = Math.max(0.05, turn.end - turn.start);
    samples.push({
      kind: 'turn-early',
      speakerCharacterId: turn.speakerCharacterId,
      timestamp: round(turn.start + duration * 0.35),
      label: `ACTIVE SPEAKER ${turn.speakerCharacterId} during: "${turn.text}"`,
    });
    if (duration >= 0.8) {
      samples.push({
        kind: 'turn-late',
        speakerCharacterId: turn.speakerCharacterId,
        timestamp: round(turn.start + duration * 0.72),
        label: `ACTIVE SPEAKER ${turn.speakerCharacterId} later in the same line`,
      });
    }
  }
  return samples.slice(0, 10).sort((a, b) => a.timestamp - b.timestamp);
}

function buildPrompt({ turns, samples, cast }) {
  const characterDescriptions = [...new Set(turns.map((turn) => turn.speakerCharacterId))]
    .map((id) => {
      const character = cast.get(id);
      if (!character) return `${id}: recurring character`;
      return [
        `${id}: ${character.name}`,
        character.description,
        character.physicalTraits,
        `wardrobe: ${character.wardrobe}`,
      ].filter(Boolean).join('. ');
    });

  return [
    'Evaluate a multi-speaker generated video act against its exact dialogue turn plan.',
    '',
    'CAST:',
    ...characterDescriptions.map((description) => `- ${description}`),
    '',
    'TURN PLAN:',
    ...turns.map((turn) => (
      `- ${turn.start.toFixed(3)}s–${turn.end.toFixed(3)}s ${turn.speakerCharacterId}: "${turn.text}"`
    )),
    '',
    'Rules:',
    '- At each sampled turn timestamp, the intended speaker should be the visibly active talker.',
    '- Non-speaking characters may react naturally but should not show strong simultaneous talking unless the turn plan explicitly overlaps (this version does not).',
    '- Keep each recurring character visually identifiable and do not swap faces/identities between turns.',
    '- Penalize wrong-person lip movement, both characters talking together, frozen intended speaker, identity swaps, or ambiguous blocking.',
    '',
    'Return JSON:',
    '{',
    '  "score": 0,',
    '  "scores": {',
    '    "speakerAttribution": 0,',
    '    "activeSpeakerMouthMotion": 0,',
    '    "listenerStillness": 0,',
    '    "castIdentityStability": 0,',
    '    "turnTakingClarity": 0',
    '  },',
    '  "issues": [{"code":"wrong-speaker","severity":"high","evidence":"brief concrete evidence"}],',
    '  "summary": "one sentence",',
    '  "regenerationGuidance": "specific corrective instruction"',
    '}',
    '',
    `Sample plan: ${samples.map((sample) => `${sample.timestamp}s ${sample.label}`).join(' | ')}`,
  ].join('\n');
}

function normalizeTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns
    .filter((turn) => (
      turn
      && turn.speakerCharacterId
      && String(turn.text || '').trim()
      && Number.isFinite(Number(turn.start))
      && Number.isFinite(Number(turn.end))
      && Number(turn.end) > Number(turn.start)
    ))
    .map((turn, index) => ({
      turnIndex: turn.turnIndex ?? index,
      speakerCharacterId: String(turn.speakerCharacterId),
      text: String(turn.text).trim(),
      start: Number(turn.start),
      end: Number(turn.end),
    }));
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
  return ['low', 'medium', 'high', 'critical'].includes(normalized)
    ? normalized
    : 'medium';
}

function buildGuidance(scores, issues, turns) {
  const severe = issues
    .filter((issue) => ['high', 'critical'].includes(issue.severity))
    .map((issue) => `${issue.code}: ${issue.evidence}`)
    .slice(0, 4);

  const order = turns.map((turn) => `${turn.speakerCharacterId}: "${turn.text}"`).join(' THEN ');
  return [
    'Regenerate the dialogue scene with strict speaker ownership and no crosstalk.',
    `Turn order must be: ${order}.`,
    severe.length ? `Correct: ${severe.join('; ')}.` : '',
    scores.speakerAttribution < 80
      ? 'Make it visually unambiguous which named character is speaking each line.'
      : '',
    scores.listenerStillness < 80
      ? 'Keep listeners reactive but silent; do not animate their mouths as if speaking.'
      : '',
  ].filter(Boolean).join(' ');
}

async function readJsonResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('speaker-turn QC returned a non-JSON response');
  }

  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || response.statusText || 'request failed';
    throw new Error(`speaker-turn QC request failed (${response.status}): ${detail}`);
  }
  return payload;
}

function parseJsonObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('speaker-turn QC returned empty content');

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
  throw new Error('speaker-turn QC returned invalid JSON');
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.max(0, Math.min(100, number)) * 100) / 100;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(Number(value)));
  if (!valid.length) return 0;
  return valid.reduce((sum, value) => sum + Number(value), 0) / valid.length;
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
