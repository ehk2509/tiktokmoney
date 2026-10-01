import { spawn } from 'node:child_process';

export class PhonemeVisemeQcProvider {
  constructor({
    command = process.env.PHONEME_VISEME_COMMAND || 'python3',
    args = parseArgs(process.env.PHONEME_VISEME_ARGS)
      || [
        'scripts/phoneme_viseme_qc.py',
        '--video', '{video}',
        '--transcription-json', '{transcription_json}',
      ],
    minPhonemeAlignment = Number(process.env.PHONEME_VISEME_MIN_PHONEME_ALIGNMENT || 0.72),
    minVisemeAlignment = Number(process.env.PHONEME_VISEME_MIN_VISEME_ALIGNMENT || 0.68),
    minCoverage = Number(process.env.PHONEME_VISEME_MIN_COVERAGE || 0.72),
    maxRegenerations = Number(process.env.PHONEME_VISEME_MAX_REGENERATIONS || 1),
    timeoutMs = Number(process.env.PHONEME_VISEME_TIMEOUT_MS || 120000),
    runCommand = run,
  } = {}) {
    this.command = command;
    this.args = args;
    this.minPhonemeAlignment = clampRatio(minPhonemeAlignment, 0.72);
    this.minVisemeAlignment = clampRatio(minVisemeAlignment, 0.68);
    this.minCoverage = clampRatio(minCoverage, 0.72);
    this.maxRegenerations = Math.max(0, Math.min(3, Number(maxRegenerations) || 0));
    this.timeoutMs = Math.max(5000, Number(timeoutMs) || 120000);
    this.runCommand = runCommand;
  }

  async evaluate(asset, {
    transcription = null,
    expectedText = '',
  } = {}) {
    if (!asset?.localPath) {
      throw new Error('phoneme/viseme QC requires a local audiovisual asset');
    }
    if (!Array.isArray(transcription?.words) || !transcription.words.length) {
      return {
        provider: 'phoneme-viseme-local',
        passed: false,
        phonemeAlignmentScore: 0,
        visemeAlignmentScore: 0,
        coverage: 0,
        issues: [{
          code: 'phoneme-viseme-word-timestamps-missing',
          severity: 'high',
          evidence: 'Independent word timestamps are required for phoneme/viseme verification.',
        }],
        regenerationGuidance: 'Regenerate with clear audible dialogue and a visible speaking face.',
      };
    }

    const args = this.args.map((value) => replacePlaceholders(value, {
      video: asset.localPath,
      expected: expectedText || '',
      transcriptionJson: JSON.stringify({
        text: transcription.text || expectedText || '',
        language: transcription.language || null,
        duration: transcription.duration || null,
        words: transcription.words,
      }),
    }));

    const result = await this.runCommand(this.command, args, {
      timeoutMs: this.timeoutMs,
    });
    const parsed = parseJsonOutput(result?.stdout ?? result);
    return normalizePhonemeVisemeResult(parsed, {
      minPhonemeAlignment: this.minPhonemeAlignment,
      minVisemeAlignment: this.minVisemeAlignment,
      minCoverage: this.minCoverage,
    });
  }
}

export function normalizePhonemeVisemeResult(raw, {
  minPhonemeAlignment = 0.72,
  minVisemeAlignment = 0.68,
  minCoverage = 0.72,
} = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('phoneme/viseme evaluator returned an invalid payload');
  }
  if (raw.error) {
    throw new Error(`phoneme/viseme evaluator failed: ${raw.error}`);
  }

  const phonemeAlignmentScore = clampRatio(
    raw.phonemeAlignmentScore ?? raw.phoneme_alignment_score,
    0,
  );
  const visemeAlignmentScore = clampRatio(
    raw.visemeAlignmentScore ?? raw.viseme_alignment_score,
    0,
  );
  const coverage = clampRatio(
    raw.coverage ?? raw.faceCoverage ?? raw.face_coverage,
    0,
  );

  const issues = [];
  if (phonemeAlignmentScore < minPhonemeAlignment) {
    issues.push({
      code: 'phoneme-mouth-alignment',
      severity: phonemeAlignmentScore < minPhonemeAlignment * 0.7 ? 'critical' : 'high',
      evidence: `Phoneme-mouth alignment ${round(phonemeAlignmentScore)} is below ${minPhonemeAlignment}.`,
    });
  }
  if (visemeAlignmentScore < minVisemeAlignment) {
    issues.push({
      code: 'viseme-classification-alignment',
      severity: visemeAlignmentScore < minVisemeAlignment * 0.7 ? 'critical' : 'high',
      evidence: `Viseme alignment ${round(visemeAlignmentScore)} is below ${minVisemeAlignment}.`,
    });
  }
  if (coverage < minCoverage) {
    issues.push({
      code: 'viseme-face-coverage',
      severity: coverage < minCoverage * 0.6 ? 'critical' : 'high',
      evidence: `Usable speaking-face coverage ${round(coverage)} is below ${minCoverage}.`,
    });
  }

  const mismatches = normalizeMismatches(raw.worstMismatches ?? raw.worst_mismatches);
  const passed = issues.length === 0;

  return {
    provider: 'phoneme-viseme-local',
    evaluator: {
      name: String(raw.evaluator?.name || 'tiktokmoney-mouth-landmark-viseme-v1'),
      version: raw.evaluator?.version || '1',
      mode: String(raw.evaluator?.mode || 'phoneme-viseme-landmark'),
    },
    passed,
    phonemeAlignmentScore,
    visemeAlignmentScore,
    coverage,
    evaluatedPhonemes: Math.max(0, Number(raw.evaluatedPhonemes ?? raw.evaluated_phonemes) || 0),
    totalPhonemes: Math.max(0, Number(raw.totalPhonemes ?? raw.total_phonemes) || 0),
    familyAccuracy: normalizeScoreMap(raw.familyAccuracy ?? raw.family_accuracy),
    confusion: normalizeConfusion(raw.confusion),
    worstMismatches: mismatches,
    thresholds: {
      minPhonemeAlignment,
      minVisemeAlignment,
      minCoverage,
    },
    issues,
    regenerationGuidance: passed
      ? ''
      : buildGuidance({
        issues,
        mismatches,
      }),
    limitation: String(
      raw.limitation
      || 'visual classifier uses mouth-landmark geometry and scores phonemes through visually compatible viseme families',
    ),
  };
}

function buildGuidance({ issues, mismatches }) {
  const parts = [
    'Regenerate with the supplied dialogue audio as the exact timing master.',
    'Keep the speaking face large, frontal enough to see the mouth, and unobstructed.',
  ];

  if (issues.some((issue) => issue.code === 'phoneme-mouth-alignment')) {
    parts.push('Make mouth-shape changes occur at the expected spoken phoneme timings rather than early or late.');
  }
  if (issues.some((issue) => issue.code === 'viseme-classification-alignment')) {
    parts.push('Improve visible closures, rounding, opening and wide-vowel mouth shapes so they match the spoken sounds.');
  }
  if (issues.some((issue) => issue.code === 'viseme-face-coverage')) {
    parts.push('Avoid profile angles, hand occlusion, extreme motion blur or framing that hides the lips during speech.');
  }
  if (mismatches.length) {
    const compact = mismatches
      .slice(0, 5)
      .map((item) => `${item.start}s ${item.phoneme}/${item.expectedFamily}->${item.observedFamily}`)
      .join('; ');
    parts.push(`Worst measured mismatches: ${compact}.`);
  }

  return parts.join(' ');
}

function normalizeMismatches(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item === 'object')
    .slice(0, 12)
    .map((item) => ({
      start: round(Number(item.start) || 0),
      end: round(Number(item.end) || Number(item.start) || 0),
      phoneme: String(item.phoneme || '').slice(0, 24),
      viseme: String(item.viseme || '').slice(0, 24),
      expectedFamily: String(item.expectedFamily || item.expected_family || '').slice(0, 32),
      observedFamily: String(item.observedFamily || item.observed_family || '').slice(0, 32),
      confidence: clampRatio(item.confidence, 0),
    }));
}

function normalizeScoreMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 20)
      .map(([key, score]) => [String(key).slice(0, 40), clampRatio(score, 0)]),
  );
}

function normalizeConfusion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 40)
      .map(([key, count]) => [String(key).slice(0, 80), Math.max(0, Number(count) || 0)]),
  );
}

function replacePlaceholders(value, replacements) {
  return String(value)
    .replaceAll('{video}', replacements.video)
    .replaceAll('{expected}', replacements.expected)
    .replaceAll('{transcription_json}', replacements.transcriptionJson);
}

function parseArgs(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new Error('PHONEME_VISEME_ARGS must be a JSON array of argument strings');
  }
}

function parseJsonOutput(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').trim();
  if (!text) throw new Error('phoneme/viseme evaluator returned empty output');

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
  }
  throw new Error('phoneme/viseme evaluator did not return JSON');
}

function run(command, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`phoneme/viseme evaluator timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-3000)}`));
    });
  });
}

function clampRatio(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function round(value) {
  return Math.round(Number(value) * 10000) / 10000;
}
