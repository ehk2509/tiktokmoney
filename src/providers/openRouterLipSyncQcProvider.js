import { FrameSampler } from '../services/frameSampler.js';
import { normalizeScoreScale, SCORE_SCALE_INSTRUCTION } from './qcScores.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterLipSyncQcProvider {
  constructor({
    apiKey = process.env.OPENROUTER_API_KEY,
    baseUrl = process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.LIPSYNC_QC_MODEL || process.env.REALISM_QC_MODEL,
    threshold = Number(process.env.LIPSYNC_QC_THRESHOLD || 80),
    minScore = Number(process.env.LIPSYNC_QC_MIN_SCORE || 55),
    maxFrames = Number(process.env.LIPSYNC_QC_FRAMES || 10),
    frameWidth = Number(process.env.LIPSYNC_QC_FRAME_WIDTH || 384),
    maxRegenerations = Number(process.env.LIPSYNC_QC_MAX_REGENERATIONS || 2),
    frameSampler = new FrameSampler(),
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for lip-sync QC');
    if (!model) throw new Error('LIPSYNC_QC_MODEL or REALISM_QC_MODEL is required for lip-sync QC');
    if (!fetchImpl) throw new Error('fetch is required');

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.threshold = clampScore(threshold);
    this.minScore = clampScore(minScore);
    this.maxFrames = clampInt(maxFrames, 4, 14, 10);
    this.frameWidth = clampInt(frameWidth, 256, 768, 384);
    this.maxRegenerations = Math.max(0, Math.min(3, Number(maxRegenerations) || 0));
    this.frameSampler = frameSampler;
    this.fetch = fetchImpl;
  }

  async evaluate(asset, {
    transcription,
    expectedText = '',
    speakerDescription = '',
    turns = [],
    characters = [],
  } = {}) {
    if (!asset?.localPath) throw new Error('lip-sync QC requires a local audiovisual asset');

    const words = Array.isArray(transcription?.words) ? transcription.words : [];
    if (!words.length) {
      return {
        provider: 'openrouter',
        model: this.model,
        passed: false,
        score: 0,
        threshold: this.threshold,
        issues: [{
          code: 'lip-sync-no-word-timestamps',
          severity: 'high',
          evidence: 'No word-level timestamps were available for mouth-motion timing QC.',
        }],
        regenerationGuidance: 'Regenerate with clearly audible dialogue and visible synchronized speech.',
        sampledFrames: [],
        limitation: 'visual speech-timing proxy; not phoneme-level alignment',
      };
    }

    const speakers = assignSpeakers(words, turns, characters);
    const samples = buildLipSyncSamples(speakers.words, {
      durationSeconds: Number(transcription?.duration) || inferDuration(words),
      maxFrames: this.maxFrames,
    });
    const frames = await this.frameSampler.sampleAt(
      asset.localPath,
      samples.map((sample) => sample.timestamp),
      { maxWidth: this.frameWidth, prefix: 'lipsync' },
    );

    const content = [
      {
        type: 'text',
        text: buildPrompt({
          expectedText,
          actualText: transcription?.text || '',
          speakerDescription,
          samples,
          cast: speakers.cast,
        }),
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
              'You are a strict audiovisual continuity reviewer.',
              'You are NOT given phoneme-level mouth landmarks, so do not claim phoneme-perfect sync.',
              'Judge whether visible mouth activity is plausibly aligned with the supplied speech-active and pause timestamps.',
              SCORE_SCALE_INSTRUCTION,
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
    let scores = {
      speakerVisibility: clampScore(parsed?.scores?.speakerVisibility),
      mouthActivityDuringSpeech: clampScore(parsed?.scores?.mouthActivityDuringSpeech),
      mouthStillnessDuringPauses: clampScore(parsed?.scores?.mouthStillnessDuringPauses),
      faceStability: clampScore(parsed?.scores?.faceStability),
      timingPlausibility: clampScore(parsed?.scores?.timingPlausibility),
    };
    let score;
    ({ score, scores } = normalizeScoreScale(parsed?.score, scores));
    const reported = normalizeIssues(parsed?.issues);
    // Issue-driven like factual/variety QC: regenerate for a concrete high/critical
    // defect seen across frames, or clearly broken sync below the hard floor.
    // A score between the floor and the threshold is a warning, not a retake.
    const issues = reported.filter((issue) => ['high', 'critical'].includes(issue.severity));
    const passed = issues.length === 0 && score >= this.minScore;
    const warnings = [
      ...reported.filter((issue) => !issues.includes(issue)).map((issue) => ({ ...issue, severity: 'warning' })),
      ...(passed && score < this.threshold ? [{
        code: 'lip-sync-low',
        severity: 'warning',
        evidence: `Diagnostic lip-sync score ${score} is below warning threshold ${this.threshold}, but no blocking defect was found.`,
      }] : []),
    ];
    if (!passed && !issues.length) {
      issues.push({
        code: 'lip-sync-score-floor',
        severity: 'high',
        evidence: `Lip-sync score ${score} is below the minimum ${this.minScore}.`,
      });
    }

    return {
      provider: 'openrouter',
      model: this.model,
      passed,
      score,
      threshold: this.threshold,
      minScore: this.minScore,
      scores,
      issues,
      warnings,
      summary: stringOrEmpty(parsed?.summary),
      regenerationGuidance: passed
        ? ''
        : stringOrEmpty(parsed?.regenerationGuidance) || buildGuidance(scores, issues),
      sampledFrames: frames.map((frame, index) => ({
        index: frame.index,
        timestamp: frame.timestamp,
        kind: samples[index].kind,
        word: samples[index].word || null,
      })),
      rawUsage: payload?.usage || null,
      limitation: 'visual speech-timing proxy; not phoneme-level alignment',
    };
  }
}

/**
 * Attribute transcript words to dialogue turns by word order (the dialogue QC has
 * already verified the words match the script), so multi-speaker acts are judged
 * per line instead of against a single speaker.
 */
export function assignSpeakers(words = [], turns = [], characters = []) {
  const ordered = (Array.isArray(turns) ? turns : []).filter((turn) => String(turn?.text || '').trim());
  const speakerIds = [...new Set(ordered.map((turn) => turn.speakerCharacterId))];
  if (speakerIds.length < 2) return { words, cast: [] };

  const byId = new Map((characters || []).map((character) => [character.id, character]));
  const nameOf = (id) => byId.get(id)?.name || String(id);
  const cast = speakerIds.map((id) => ({
    label: nameOf(id),
    description: [byId.get(id)?.description, byId.get(id)?.physicalTraits].filter(Boolean).join('. ') || nameOf(id),
  }));

  const counts = ordered.map((turn) => String(turn.text).trim().split(/\s+/).filter(Boolean).length);
  let turnIndex = 0;
  let used = 0;
  const labelled = words.map((word) => {
    while (turnIndex < ordered.length - 1 && used >= counts[turnIndex]) {
      turnIndex += 1;
      used = 0;
    }
    used += 1;
    return { ...word, speaker: nameOf(ordered[turnIndex].speakerCharacterId) };
  });
  return { words: labelled, cast };
}

export function lipContactSounds(word) {
  const lower = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  const found = [];
  if (/[mbp]/.test(lower)) found.push('m/b/p lip closure');
  if (/[fv]/.test(lower) || /ph/.test(lower)) found.push('f/v lip-teeth contact');
  return found.join(' and ');
}

export function buildLipSyncSamples(words, {
  durationSeconds = null,
  maxFrames = 10,
} = {}) {
  const cleanWords = words
    .filter((word) => Number.isFinite(Number(word.start)) && Number.isFinite(Number(word.end)))
    .map((word) => ({
      word: String(word.word || '').trim(),
      speaker: word.speaker || null,
      start: Math.max(0, Number(word.start)),
      end: Math.max(Number(word.start), Number(word.end)),
    }))
    .filter((word) => word.word);

  if (!cleanWords.length) return [];

  const activeBudget = Math.max(3, Math.min(cleanWords.length, Math.ceil(maxFrames * 0.7)));
  const activeIndices = spreadIndices(cleanWords.length, activeBudget);
  const active = activeIndices.map((index) => {
    const word = cleanWords[index];
    const closures = lipContactSounds(word.word);
    const who = word.speaker ? ` by ${word.speaker}` : '';
    return {
      kind: 'speech',
      word: word.word,
      speaker: word.speaker || null,
      timestamp: round((word.start + word.end) / 2),
      label: closures
        ? `SPEECH ACTIVE${who} around word "${word.word}" (contains ${closures}: momentary closed lips or lip-teeth contact here is correct articulation)`
        : `SPEECH ACTIVE${who} around word "${word.word}"`,
    };
  });

  const pauses = [];
  // Lips take ~0.3s to settle after a word; sample pauses only past that release.
  const release = 0.3;
  const minPause = 0.28 + (2 * release);
  const firstStart = cleanWords[0].start;
  if (firstStart >= minPause) {
    pauses.push({
      kind: 'pause',
      timestamp: round(Math.min(firstStart / 2, firstStart - release)),
      label: 'EXPECTED PAUSE before speech',
    });
  }
  for (let index = 1; index < cleanWords.length; index += 1) {
    const gap = cleanWords[index].start - cleanWords[index - 1].end;
    if (gap >= minPause) {
      pauses.push({
        kind: 'pause',
        timestamp: round(cleanWords[index - 1].end + (gap / 2)),
        label: 'EXPECTED PAUSE between spoken words/phrases',
      });
    }
  }
  const duration = Number(durationSeconds) || inferDuration(cleanWords);
  const lastEnd = cleanWords.at(-1).end;
  if (duration - lastEnd >= minPause) {
    pauses.push({
      kind: 'pause',
      timestamp: round(Math.max(lastEnd + release + 0.2, lastEnd + ((duration - lastEnd) / 2))),
      label: 'EXPECTED PAUSE after speech',
    });
  }

  const pauseBudget = Math.max(0, maxFrames - active.length);
  const selectedPauses = pauses.length <= pauseBudget
    ? pauses
    : spreadIndices(pauses.length, pauseBudget).map((index) => pauses[index]);

  return [...active, ...selectedPauses]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, maxFrames);
}

function buildPrompt({
  expectedText,
  actualText,
  speakerDescription,
  samples,
  cast = [],
}) {
  const multiSpeaker = cast.length > 1;
  return [
    'Evaluate visual speech timing for ONE generated audiovisual act.',
    `Expected screenplay dialogue: ${expectedText}`,
    `Independent transcript: ${actualText}`,
    multiSpeaker
      ? `Speakers, in order: ${cast.map((member) => `${member.label} = ${member.description}`).join(' | ')}`
      : speakerDescription ? `Intended speaker: ${speakerDescription}` : '',
    multiSpeaker
      ? 'Each SPEECH ACTIVE frame names who is speaking at that moment. Judge THAT person\'s mouth for that frame; the other speakers should be quiet then. Report wrong-speaker only when someone other than the named speaker visibly articulates while the named speaker stays still.'
      : '',
    '',
    'The supplied frames are sampled using independent word timestamps.',
    'Frames labeled SPEECH ACTIVE should normally show plausible visible articulation when the speaker face is visible.',
    'Natural speech includes momentary closed lips (m, b, p), lip-teeth contact (f, v) and brief closures between syllables; a single such frame is NOT a defect.',
    'Frames labeled EXPECTED PAUSE should not show strong continued speaking mouth motion unless the shot hides the mouth or another sound source explains it.',
    'Relaxed, slightly parted resting lips during a pause are normal; flag only active articulation (opening/closing as if speaking).',
    'Report a timing defect only when it persists across at least two frames, and list those frame numbers in "frames". Use severity high only for defects a viewer would clearly notice: frozen or absent mouth during speech, speaking motion through a pause, wrong person speaking, or face morphing.',
    '',
    'Judge these from 0 to 100:',
    '- speakerVisibility: intended speaking face/mouth is sufficiently visible when dialogue is performed.',
    '- mouthActivityDuringSpeech: mouth configuration changes plausibly during speech-active samples.',
    '- mouthStillnessDuringPauses: mouth is plausibly resting during true pauses.',
    '- faceStability: face/mouth geometry stays anatomically stable without morphing.',
    '- timingPlausibility: visual speaking activity broadly lines up with speech-active vs pause timestamps.',
    '',
    'This is a timing-level visual proxy, not phoneme-level verification. Do not claim exact viseme/phoneme matching.',
    'Return JSON:',
    '{',
    '  "score": 0,',
    '  "scores": {',
    '    "speakerVisibility": 0,',
    '    "mouthActivityDuringSpeech": 0,',
    '    "mouthStillnessDuringPauses": 0,',
    '    "faceStability": 0,',
    '    "timingPlausibility": 0',
    '  },',
    '  "issues": [{"code":"frozen-mouth","severity":"high","frames":[2,3],"evidence":"brief concrete evidence"}],',
    '  "summary": "one sentence",',
    '  "regenerationGuidance": "specific corrective instruction"',
    '}',
    '',
    `Sample plan: ${samples.map((sample) => `${sample.timestamp}s ${sample.label}`).join(' | ')}`,
  ].filter(Boolean).join('\n');
}

function spreadIndices(length, count) {
  if (count <= 0 || length <= 0) return [];
  if (count >= length) return Array.from({ length }, (_, index) => index);
  if (count === 1) return [Math.floor((length - 1) / 2)];

  const result = [];
  for (let index = 0; index < count; index += 1) {
    result.push(Math.round(index * (length - 1) / (count - 1)));
  }
  return [...new Set(result)];
}

function inferDuration(words) {
  return Math.max(1, Number(words.at(-1)?.end) || 1);
}

const TIMING_ISSUE = /articulat|aperture|open|closed|pause|lingering|frozen|timing|mouth-during|lag|lead/i;

function normalizeIssues(issues) {
  if (!Array.isArray(issues)) return [];
  return issues
    .filter((issue) => issue && typeof issue === 'object')
    .slice(0, 8)
    .map((issue) => {
      const frames = Array.isArray(issue.frames)
        ? [...new Set(issue.frames.map(Number).filter(Number.isFinite))]
        : [];
      let severity = normalizeSeverity(issue.severity);
      // Timing defects must persist: one sampled frame can land on a natural
      // closure or release, so single-frame timing evidence is capped at medium.
      if (TIMING_ISSUE.test(String(issue.code || '')) && frames.length < 2
        && ['high', 'critical'].includes(severity)) {
        severity = 'medium';
      }
      return {
        code: String(issue.code || 'unspecified').slice(0, 80),
        severity,
        evidence: String(issue.evidence || '').slice(0, 300),
        frames,
      };
    });
}

function normalizeSeverity(value) {
  const normalized = String(value || '').toLowerCase();
  return ['low', 'medium', 'high', 'critical'].includes(normalized)
    ? normalized
    : 'medium';
}

function buildGuidance(scores, issues) {
  const severe = issues
    .filter((issue) => ['high', 'critical'].includes(issue.severity))
    .map((issue) => `${issue.code}: ${issue.evidence}`)
    .slice(0, 4);

  if (severe.length) {
    return `Correct visual speech timing: ${severe.join('; ')}. Keep the speaker face visible and synchronize mouth activity to the supplied dialogue audio.`;
  }

  const weakest = Object.entries(scores)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 2)
    .map(([name]) => name);

  return `Improve ${weakest.join(' and ')} while preserving exact dialogue and stable facial identity.`;
}

async function readJsonResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('lip-sync QC returned a non-JSON response');
  }

  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || response.statusText || 'request failed';
    throw new Error(`lip-sync QC request failed (${response.status}): ${detail}`);
  }
  return payload;
}

function parseJsonObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('lip-sync QC returned empty content');

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
  throw new Error('lip-sync QC returned invalid JSON');
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
