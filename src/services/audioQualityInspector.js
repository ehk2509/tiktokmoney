import { spawn } from 'node:child_process';

export class AudioQualityInspector {
  constructor({
    ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg',
    targetLufs = Number(process.env.AUDIO_TARGET_LUFS || -14),
    truePeakLimitDbtp = Number(process.env.AUDIO_TRUE_PEAK_DBTP || -1),
    minIntegratedLufs = Number(process.env.AUDIO_MIN_LUFS || -45),
    required = parseBoolean(process.env.PUBLISHABILITY_AUDIO_REQUIRED, true),
    runCapture = capture,
  } = {}) {
    this.ffmpegBin = ffmpegBin;
    this.targetLufs = Number.isFinite(targetLufs) ? targetLufs : -14;
    this.truePeakLimitDbtp = Number.isFinite(truePeakLimitDbtp) ? truePeakLimitDbtp : -1;
    this.minIntegratedLufs = Number.isFinite(minIntegratedLufs) ? minIntegratedLufs : -45;
    this.required = Boolean(required);
    this.runCapture = runCapture;
  }

  async inspect(filePath) {
    const output = await this.runCapture(this.ffmpegBin, [
      '-hide_banner',
      '-nostats',
      '-i', filePath,
      '-filter_complex', 'ebur128=peak=true',
      '-f', 'null',
      '-',
    ]);

    return parseEbur128(output, {
      minIntegratedLufs: this.minIntegratedLufs,
      truePeakLimitDbtp: this.truePeakLimitDbtp,
      required: this.required,
    });
  }
}

export function parseEbur128(output, {
  minIntegratedLufs = -45,
  truePeakLimitDbtp = -1,
  required = true,
} = {}) {
  const text = String(output || '');
  const summary = text.includes('Summary:')
    ? text.slice(text.lastIndexOf('Summary:'))
    : text;

  const integratedMatches = [...summary.matchAll(/\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/gi)];
  const truePeakMatches = [...summary.matchAll(/\bPeak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/gi)];
  const integratedLufs = integratedMatches.length
    ? Number(integratedMatches.at(-1)[1])
    : null;
  const truePeakDbtp = truePeakMatches.length
    ? Number(truePeakMatches.at(-1)[1])
    : null;
  const hasAudioMeasurement = Number.isFinite(integratedLufs);
  const audible = hasAudioMeasurement && integratedLufs > minIntegratedLufs;
  const peakSafe = !Number.isFinite(truePeakDbtp) || truePeakDbtp <= truePeakLimitDbtp + 0.25;
  const passed = required
    ? audible && peakSafe
    : (!hasAudioMeasurement || audible) && peakSafe;

  const issues = [];
  if (required && !hasAudioMeasurement) {
    issues.push({ code: 'audio-missing', message: 'No measurable audio signal was found.' });
  } else if (hasAudioMeasurement && !audible) {
    issues.push({
      code: 'audio-silent',
      message: `Integrated loudness ${integratedLufs} LUFS is below the minimum ${minIntegratedLufs} LUFS.`,
    });
  }
  if (!peakSafe) {
    issues.push({
      code: 'audio-true-peak',
      message: `True peak ${truePeakDbtp} dBTP exceeds the allowed ${truePeakLimitDbtp} dBTP ceiling.`,
    });
  }

  return {
    passed,
    audible,
    integratedLufs,
    truePeakDbtp,
    minIntegratedLufs,
    truePeakLimitDbtp,
    issues,
  };
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';

    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(output);
      reject(new Error(`${command} exited with code ${code}: ${output.slice(-3000)}`));
    });
  });
}

function parseBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
