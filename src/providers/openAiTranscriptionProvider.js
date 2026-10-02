import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAiTranscriptionProvider {
  constructor({
    apiKey = process.env.TRANSCRIPTION_API_KEY || process.env.OPENAI_API_KEY,
    baseUrl = process.env.TRANSCRIPTION_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.TRANSCRIPTION_MODEL || 'gpt-transcribe',
    maxWer = Number(process.env.DIALOGUE_QC_MAX_WER || 0.12),
    maxWordCountDelta = Number(process.env.DIALOGUE_QC_MAX_WORD_COUNT_DELTA || 0.12),
    maxRegenerations = Number(process.env.DIALOGUE_QC_MAX_REGENERATIONS || 1),
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new Error('TRANSCRIPTION_API_KEY or OPENAI_API_KEY is required for dialogue QC');
    if (!fetchImpl) throw new Error('fetch is required');

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.maxWer = clampRatio(maxWer, 0.12);
    this.maxWordCountDelta = clampRatio(maxWordCountDelta, 0.12);
    this.maxRegenerations = Math.max(0, Math.min(3, Number(maxRegenerations) || 0));
    this.fetch = fetchImpl;
  }

  async evaluate(asset, {
    expectedText,
    language = null,
  } = {}) {
    if (!asset?.localPath) throw new Error('dialogue QC requires a local audiovisual asset');
    if (!String(expectedText || '').trim()) {
      return {
        provider: 'openai-transcription',
        model: this.model,
        passed: true,
        skipped: true,
        reason: 'no expected dialogue',
        expectedText: '',
        actualText: '',
        wer: 0,
        wordCountDelta: 0,
        transcription: { text: '', words: [], segments: [] },
        issues: [],
        regenerationGuidance: '',
      };
    }

    const transcription = await this.transcribe(asset.localPath, { language });
    const comparison = compareDialogue(expectedText, transcription.text);
    const passed = comparison.wer <= this.maxWer
      && comparison.wordCountDelta <= this.maxWordCountDelta;

    const issues = [];
    if (comparison.wer > this.maxWer) {
      issues.push({
        code: 'dialogue-word-error-rate',
        severity: comparison.wer > 0.3 ? 'critical' : 'high',
        evidence: `WER ${round(comparison.wer)} exceeds ${this.maxWer}. ${summarizeEdits(comparison.edits)}`,
      });
    }
    if (comparison.wordCountDelta > this.maxWordCountDelta) {
      issues.push({
        code: 'dialogue-length-drift',
        severity: 'high',
        evidence: `Word-count delta ${round(comparison.wordCountDelta)} exceeds ${this.maxWordCountDelta}.`,
      });
    }

    return {
      provider: 'openai-transcription',
      model: this.model,
      passed,
      skipped: false,
      expectedText: String(expectedText).trim(),
      actualText: transcription.text,
      wer: round(comparison.wer),
      characterErrorRate: round(comparison.characterErrorRate),
      wordCountDelta: round(comparison.wordCountDelta),
      expectedWordCount: comparison.expectedWords.length,
      actualWordCount: comparison.actualWords.length,
      edits: comparison.edits,
      transcription,
      issues,
      regenerationGuidance: passed
        ? ''
        : buildGuidance(comparison),
    };
  }

  async transcribe(localPath, { language = null } = {}) {
    const bytes = await readFile(localPath);
    let { response, payload } = await this.requestTranscription(localPath, bytes, { language });

    // Newer transcription models only accept json/text; retry without word timestamps.
    if (!response.ok && this.supportsVerboseJson !== false
      && /verbose_json/i.test(payload?.error?.message || '')) {
      this.supportsVerboseJson = false;
      ({ response, payload } = await this.requestTranscription(localPath, bytes, { language }));
    }

    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || response.statusText || 'request failed';
      throw new Error(`transcription request failed (${response.status}): ${detail}`);
    }

    return {
      text: String(payload?.text || '').trim(),
      language: payload?.language || language || null,
      duration: Number(payload?.duration) || null,
      words: normalizeWords(payload?.words),
      segments: normalizeSegments(payload?.segments),
      usage: payload?.usage || null,
    };
  }

  async requestTranscription(localPath, bytes, { language }) {
    const form = new FormData();
    form.append(
      'file',
      new Blob([bytes], { type: mediaTypeFor(localPath) }),
      path.basename(localPath),
    );
    form.append('model', this.model);
    if (this.supportsVerboseJson === false) {
      form.append('response_format', 'json');
    } else {
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      form.append('timestamp_granularities[]', 'segment');
    }
    if (language) form.append('language', String(language).slice(0, 12));

    const response = await this.fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
      },
      body: form,
    });

    try {
      return { response, payload: await response.json() };
    } catch {
      throw new Error('transcription provider returned a non-JSON response');
    }
  }
}

export function compareDialogue(expectedText, actualText) {
  const expectedWords = normalizeWordsForComparison(expectedText);
  const actualWords = normalizeWordsForComparison(actualText);
  const { distance, edits } = wordAlignment(expectedWords, actualWords);
  const expectedChars = normalizeCharacters(expectedText);
  const actualChars = normalizeCharacters(actualText);
  const charDistance = levenshtein(expectedChars, actualChars);

  return {
    expectedWords,
    actualWords,
    edits,
    wer: expectedWords.length ? distance / expectedWords.length : (actualWords.length ? 1 : 0),
    characterErrorRate: expectedChars.length
      ? charDistance / expectedChars.length
      : (actualChars.length ? 1 : 0),
    wordCountDelta: expectedWords.length
      ? Math.abs(actualWords.length - expectedWords.length) / expectedWords.length
      : (actualWords.length ? 1 : 0),
  };
}

function wordAlignment(expected, actual) {
  const rows = expected.length + 1;
  const cols = actual.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
  const op = Array.from({ length: rows }, () => Array(cols).fill(null));

  for (let i = 1; i < rows; i += 1) {
    dp[i][0] = i;
    op[i][0] = 'delete';
  }
  for (let j = 1; j < cols; j += 1) {
    dp[0][j] = j;
    op[0][j] = 'insert';
  }

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      if (expected[i - 1] === actual[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
        op[i][j] = 'equal';
        continue;
      }

      const candidates = [
        { cost: dp[i - 1][j - 1] + 1, type: 'substitute' },
        { cost: dp[i - 1][j] + 1, type: 'delete' },
        { cost: dp[i][j - 1] + 1, type: 'insert' },
      ].sort((a, b) => a.cost - b.cost);

      dp[i][j] = candidates[0].cost;
      op[i][j] = candidates[0].type;
    }
  }

  const edits = [];
  let i = expected.length;
  let j = actual.length;
  while (i > 0 || j > 0) {
    const type = op[i][j];
    if (type === 'equal') {
      i -= 1;
      j -= 1;
    } else if (type === 'substitute') {
      edits.push({ type, expected: expected[i - 1], actual: actual[j - 1] });
      i -= 1;
      j -= 1;
    } else if (type === 'delete') {
      edits.push({ type, expected: expected[i - 1], actual: null });
      i -= 1;
    } else {
      edits.push({ type: 'insert', expected: null, actual: actual[j - 1] });
      j -= 1;
    }
  }

  return { distance: dp[expected.length][actual.length], edits: edits.reverse() };
}

function levenshtein(a, b) {
  const left = Array.from(a);
  const right = Array.from(b);
  const prev = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const up = prev[j];
      const substitution = diagonal + (left[i - 1] === right[j - 1] ? 0 : 1);
      const deletion = up + 1;
      const insertion = prev[j - 1] + 1;
      prev[j] = Math.min(substitution, deletion, insertion);
      diagonal = up;
    }
  }

  return prev[right.length];
}

function normalizeWordsForComparison(value) {
  return normalizeCharacters(value)
    .split(' ')
    .filter(Boolean);
}

function normalizeCharacters(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWords(words) {
  if (!Array.isArray(words)) return [];
  return words
    .filter((word) => word && String(word.word || '').trim())
    .map((word) => ({
      word: String(word.word).trim(),
      start: Math.max(0, Number(word.start) || 0),
      end: Math.max(Number(word.start) || 0, Number(word.end) || 0),
    }))
    .filter((word) => word.end >= word.start);
}

function normalizeSegments(segments) {
  if (!Array.isArray(segments)) return [];
  return segments
    .filter(Boolean)
    .map((segment) => ({
      text: String(segment.text || '').trim(),
      start: Math.max(0, Number(segment.start) || 0),
      end: Math.max(Number(segment.start) || 0, Number(segment.end) || 0),
    }));
}

function summarizeEdits(edits) {
  const missing = edits.filter((edit) => edit.type === 'delete').map((edit) => edit.expected);
  const added = edits.filter((edit) => edit.type === 'insert').map((edit) => edit.actual);
  const changed = edits
    .filter((edit) => edit.type === 'substitute')
    .map((edit) => `${edit.expected}->${edit.actual}`);

  return [
    missing.length ? `missing: ${missing.slice(0, 6).join(', ')}` : '',
    added.length ? `added: ${added.slice(0, 6).join(', ')}` : '',
    changed.length ? `changed: ${changed.slice(0, 6).join(', ')}` : '',
  ].filter(Boolean).join('; ');
}

function buildGuidance(comparison) {
  return [
    'Speak the screenplay dialogue verbatim with no paraphrasing, omissions or added words.',
    summarizeEdits(comparison.edits),
    'Keep the supplied reference-audio wording exact and synchronize the visible speaker to it.',
  ].filter(Boolean).join(' ');
}

function mediaTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.webm': 'video/webm',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
  };
  return types[extension] || 'application/octet-stream';
}

function clampRatio(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function round(value) {
  return Math.round(Number(value) * 10000) / 10000;
}
