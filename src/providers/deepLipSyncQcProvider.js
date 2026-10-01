import { spawn } from 'node:child_process';

export class DeepLipSyncQcProvider {
  constructor({
    command = process.env.DEEP_LIPSYNC_COMMAND,
    args = parseArgs(process.env.DEEP_LIPSYNC_ARGS),
    maxOffsetMs = Number(process.env.DEEP_LIPSYNC_MAX_OFFSET_MS || 80),
    minConfidence = Number(process.env.DEEP_LIPSYNC_MIN_CONFIDENCE || 5),
    minSegmentPassRate = Number(process.env.DEEP_LIPSYNC_MIN_SEGMENT_PASS_RATE || 0.8),
    minPhonemeAlignment = optionalNumber(process.env.DEEP_LIPSYNC_MIN_PHONEME_ALIGNMENT),
    minVisemeAlignment = optionalNumber(process.env.DEEP_LIPSYNC_MIN_VISEME_ALIGNMENT),
    maxRegenerations = Number(process.env.DEEP_LIPSYNC_MAX_REGENERATIONS || 1),
    timeoutMs = Number(process.env.DEEP_LIPSYNC_TIMEOUT_MS || 120000),
    runCommand = run,
  } = {}) {
    if (!command) throw new Error('DEEP_LIPSYNC_COMMAND is required for deep lip-sync QC');

    this.command = command;
    this.args = Array.isArray(args) && args.length ? args : ['{video}'];
    this.maxOffsetMs = clampPositive(maxOffsetMs, 80);
    this.minConfidence = Number.isFinite(Number(minConfidence)) ? Number(minConfidence) : 5;
    this.minSegmentPassRate = clampRatio(minSegmentPassRate, 0.8);
    this.minPhonemeAlignment = minPhonemeAlignment;
    this.minVisemeAlignment = minVisemeAlignment;
    this.maxRegenerations = Math.max(0, Math.min(3, Number(maxRegenerations) || 0));
    this.timeoutMs = Math.max(5000, Number(timeoutMs) || 120000);
    this.runCommand = runCommand;
  }

  async evaluate(asset, {
    transcription = null,
    expectedText = '',
  } = {}) {
    if (!asset?.localPath) throw new Error('deep lip-sync QC requires a local audiovisual asset');

    const args = this.args.map((value) => replacePlaceholders(value, {
      video: asset.localPath,
      transcript: transcription?.text || '',
      expected: expectedText || '',
    }));

    const result = await this.runCommand(this.command, args, {
      timeoutMs: this.timeoutMs,
    });
    const parsed = parseJsonOutput(result?.stdout ?? result);
    const normalized = normalizeDeepLipSyncResult(parsed, {
      maxOffsetMs: this.maxOffsetMs,
      minConfidence: this.minConfidence,
      minSegmentPassRate: this.minSegmentPassRate,
      minPhonemeAlignment: this.minPhonemeAlignment,
      minVisemeAlignment: this.minVisemeAlignment,
    });

    return {
      provider: 'deep-av-sync',
      command: this.command,
      ...normalized,
    };
  }
}

export function normalizeDeepLipSyncResult(raw, {
  maxOffsetMs = 80,
  minConfidence = 5,
  minSegmentPassRate = 0.8,
  minPhonemeAlignment = null,
  minVisemeAlignment = null,
} = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('deep lip-sync evaluator returned an invalid payload');
  }

  const frameRate = positiveNumber(raw.frameRate ?? raw.fps, 25);
  const offsetFrames = finiteNumber(raw.offsetFrames ?? raw.avOffsetFrames ?? raw.offset, null);
  const offsetMs = finiteNumber(
    raw.offsetMs ?? raw.avOffsetMs,
    offsetFrames == null ? null : (offsetFrames / frameRate) * 1000,
  );
  const confidence = finiteNumber(
    raw.confidence ?? raw.syncConfidence ?? raw.score,
    null,
  );

  const segments = normalizeSegments(raw.segments, {
    frameRate,
    maxOffsetMs,
    minConfidence,
  });
  const segmentPassRate = segments.length
    ? segments.filter((segment) => segment.passed).length / segments.length
    : 1;

  const phonemeAlignment = normalizeOptionalScore(
    raw.phonemeAlignment
      ?? raw.phonemeAlignmentScore
      ?? raw.metrics?.phonemeAlignment,
  );
  const visemeAlignment = normalizeOptionalScore(
    raw.visemeAlignment
      ?? raw.visemeAlignmentScore
      ?? raw.metrics?.visemeAlignment,
  );

  const issues = [];
  if (offsetMs == null) {
    issues.push({
      code: 'deep-sync-offset-missing',
      severity: 'high',
      evidence: 'Evaluator did not return an audiovisual offset.',
    });
  } else if (Math.abs(offsetMs) > maxOffsetMs) {
    issues.push({
      code: 'deep-sync-offset',
      severity: Math.abs(offsetMs) > maxOffsetMs * 2 ? 'critical' : 'high',
      evidence: `A/V offset ${round(offsetMs)}ms exceeds ${maxOffsetMs}ms.`,
    });
  }

  if (confidence == null) {
    issues.push({
      code: 'deep-sync-confidence-missing',
      severity: 'high',
      evidence: 'Evaluator did not return sync confidence.',
    });
  } else if (confidence < minConfidence) {
    issues.push({
      code: 'deep-sync-confidence',
      severity: confidence < minConfidence * 0.6 ? 'critical' : 'high',
      evidence: `Sync confidence ${round(confidence)} is below ${minConfidence}.`,
    });
  }

  if (segmentPassRate < minSegmentPassRate) {
    issues.push({
      code: 'deep-sync-segment-instability',
      severity: segmentPassRate < minSegmentPassRate * 0.6 ? 'critical' : 'high',
      evidence: `Only ${round(segmentPassRate * 100)}% of evaluated speech segments pass frame-level sync thresholds.`,
    });
  }

  if (
    minPhonemeAlignment != null
    && phonemeAlignment != null
    && phonemeAlignment < minPhonemeAlignment
  ) {
    issues.push({
      code: 'phoneme-alignment',
      severity: 'high',
      evidence: `Phoneme alignment ${round(phonemeAlignment)} is below ${minPhonemeAlignment}.`,
    });
  }

  if (
    minVisemeAlignment != null
    && visemeAlignment != null
    && visemeAlignment < minVisemeAlignment
  ) {
    issues.push({
      code: 'viseme-alignment',
      severity: 'high',
      evidence: `Viseme alignment ${round(visemeAlignment)} is below ${minVisemeAlignment}.`,
    });
  }

  const passed = issues.length === 0;

  return {
    passed,
    frameRate,
    offsetFrames,
    offsetMs: offsetMs == null ? null : round(offsetMs),
    confidence,
    segments,
    segmentPassRate: round(segmentPassRate),
    phonemeAlignment,
    visemeAlignment,
    thresholds: {
      maxOffsetMs,
      minConfidence,
      minSegmentPassRate,
      minPhonemeAlignment,
      minVisemeAlignment,
    },
    issues,
    regenerationGuidance: passed
      ? ''
      : buildGuidance({
        offsetMs,
        maxOffsetMs,
        confidence,
        minConfidence,
        segmentPassRate,
        minSegmentPassRate,
        phonemeAlignment,
        minPhonemeAlignment,
        visemeAlignment,
        minVisemeAlignment,
      }),
    evaluator: {
      name: String(raw.evaluator?.name || raw.model || raw.backend || 'external'),
      version: raw.evaluator?.version || raw.version || null,
      mode: String(raw.evaluator?.mode || raw.mode || 'frame-level-av-sync'),
    },
    limitation: phonemeAlignment == null && visemeAlignment == null
      ? 'frame-level audiovisual synchronization; evaluator did not provide phoneme/viseme metrics'
      : null,
  };
}

function normalizeSegments(items, { frameRate, maxOffsetMs, minConfidence }) {
  if (!Array.isArray(items)) return [];

  return items
    .filter((item) => item && typeof item === 'object')
    .slice(0, 100)
    .map((item, index) => {
      const offsetFrames = finiteNumber(
        item.offsetFrames ?? item.avOffsetFrames ?? item.offset,
        null,
      );
      const offsetMs = finiteNumber(
        item.offsetMs ?? item.avOffsetMs,
        offsetFrames == null ? null : (offsetFrames / frameRate) * 1000,
      );
      const confidence = finiteNumber(
        item.confidence ?? item.syncConfidence ?? item.score,
        null,
      );
      const passed = offsetMs != null
        && confidence != null
        && Math.abs(offsetMs) <= maxOffsetMs
        && confidence >= minConfidence;

      return {
        index,
        start: finiteNumber(item.start, null),
        end: finiteNumber(item.end, null),
        offsetFrames,
        offsetMs: offsetMs == null ? null : round(offsetMs),
        confidence,
        passed,
      };
    });
}

function buildGuidance({
  offsetMs,
  maxOffsetMs,
  confidence,
  minConfidence,
  segmentPassRate,
  minSegmentPassRate,
  phonemeAlignment,
  minPhonemeAlignment,
  visemeAlignment,
  minVisemeAlignment,
}) {
  const guidance = [
    'Regenerate the speaking performance using the exact supplied dialogue audio as the timing master.',
    'Keep the speaking face clearly visible and make mouth motion follow the audio without lead or lag.',
  ];

  if (offsetMs != null && Math.abs(offsetMs) > maxOffsetMs) {
    const direction = offsetMs > 0 ? 'visual mouth motion lags audio' : 'visual mouth motion leads audio';
    guidance.push(`Correct the measured offset of ${round(offsetMs)}ms (${direction}); target within ±${maxOffsetMs}ms.`);
  }
  if (confidence != null && confidence < minConfidence) {
    guidance.push(`Increase stable audiovisual sync confidence above ${minConfidence}.`);
  }
  if (segmentPassRate < minSegmentPassRate) {
    guidance.push('Maintain sync consistently across the whole spoken act, not only at the beginning or end.');
  }
  if (
    minPhonemeAlignment != null
    && phonemeAlignment != null
    && phonemeAlignment < minPhonemeAlignment
  ) {
    guidance.push('Improve phoneme-level timing between the spoken audio and visible articulation.');
  }
  if (
    minVisemeAlignment != null
    && visemeAlignment != null
    && visemeAlignment < minVisemeAlignment
  ) {
    guidance.push('Match visible mouth shapes more closely to the expected speech visemes.');
  }

  return guidance.join(' ');
}

function replacePlaceholders(value, replacements) {
  return String(value)
    .replaceAll('{video}', replacements.video)
    .replaceAll('{transcript}', replacements.transcript)
    .replaceAll('{expected}', replacements.expected);
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
    throw new Error('DEEP_LIPSYNC_ARGS must be a JSON array of argument strings');
  }
}

function parseJsonOutput(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').trim();
  if (!text) throw new Error('deep lip-sync evaluator returned empty output');

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
  throw new Error('deep lip-sync evaluator did not return JSON');
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
      reject(new Error(`deep lip-sync evaluator timed out after ${timeoutMs}ms`));
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

function normalizeOptionalScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number > 1 && number <= 100) return round(number / 100);
  return round(Math.max(0, Math.min(1, number)));
}

function optionalNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clampPositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clampRatio(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function round(value) {
  return Math.round(Number(value) * 10000) / 10000;
}
