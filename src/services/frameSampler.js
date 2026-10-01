import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class FrameSampler {
  constructor({
    ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg',
    frameCount = Number(process.env.REALISM_QC_FRAMES || 3),
    maxWidth = Number(process.env.REALISM_QC_FRAME_WIDTH || 512),
    temporalFrameCount = Number(process.env.REALISM_QC_TEMPORAL_FRAMES || 8),
    temporalMaxWidth = Number(process.env.REALISM_QC_TEMPORAL_FRAME_WIDTH || 384),
    comparisonFrameCount = Number(process.env.REALISM_QC_COMPARISON_FRAMES || 2),
    comparisonMaxWidth = Number(process.env.REALISM_QC_COMPARISON_FRAME_WIDTH || 384),
    runCommand = run,
  } = {}) {
    this.ffmpegBin = ffmpegBin;
    this.frameCount = clampInt(frameCount, 1, 5, 3);
    this.maxWidth = clampInt(maxWidth, 256, 1024, 512);
    this.temporalFrameCount = clampInt(temporalFrameCount, 4, 12, 8);
    this.temporalMaxWidth = clampInt(temporalMaxWidth, 256, 768, 384);
    this.comparisonFrameCount = clampInt(comparisonFrameCount, 1, 3, 2);
    this.comparisonMaxWidth = clampInt(comparisonMaxWidth, 256, 768, 384);
    this.runCommand = runCommand;
  }

  async sample(localPath, { durationSeconds = 5 } = {}) {
    const duration = normalizeDuration(durationSeconds);
    const timestamps = evenlySpacedTimestamps(duration, this.frameCount);
    return this.sampleAt(localPath, timestamps, {
      maxWidth: this.maxWidth,
      prefix: 'frame',
    });
  }

  async sampleTemporal(localPath, { durationSeconds = 5 } = {}) {
    const duration = normalizeDuration(durationSeconds);
    const timestamps = denseTemporalTimestamps(duration, this.temporalFrameCount);
    return this.sampleAt(localPath, timestamps, {
      maxWidth: this.temporalMaxWidth,
      prefix: 'temporal',
    });
  }

  async sampleComparison(localPath, { durationSeconds = 5 } = {}) {
    const duration = normalizeDuration(durationSeconds);
    const timestamps = evenlySpacedTimestamps(duration, this.comparisonFrameCount);
    return this.sampleAt(localPath, timestamps, {
      maxWidth: this.comparisonMaxWidth,
      prefix: 'comparison',
    });
  }

  async sampleAt(localPath, timestamps, { maxWidth, prefix }) {
    if (!localPath) throw new Error('localPath is required to sample video frames');

    const workDir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-qc-'));

    try {
      const frames = [];
      for (let index = 0; index < timestamps.length; index += 1) {
        const timestamp = round(timestamps[index]);
        const outputPath = path.join(workDir, `${prefix}-${index}.jpg`);

        await this.runCommand(this.ffmpegBin, [
          '-y',
          '-ss', String(timestamp),
          '-i', localPath,
          '-frames:v', '1',
          '-vf', `scale='min(${maxWidth},iw)':-2`,
          '-q:v', '4',
          outputPath,
        ]);

        const bytes = await readFile(outputPath);
        frames.push({
          index,
          timestamp,
          mediaType: 'image/jpeg',
          dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        });
      }

      return frames;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

export function evenlySpacedTimestamps(durationSeconds, count) {
  const duration = normalizeDuration(durationSeconds);
  return Array.from({ length: count }, (_, index) => {
    const position = (index + 1) / (count + 1);
    return round(safeTimestamp(duration, duration * position));
  });
}

export function denseTemporalTimestamps(durationSeconds, count) {
  const duration = normalizeDuration(durationSeconds);
  const start = Math.min(0.12, duration * 0.04);
  const end = Math.max(start, duration - Math.min(0.12, duration * 0.04));

  if (count <= 1 || end <= start) return [round(safeTimestamp(duration, duration / 2))];

  const step = (end - start) / (count - 1);
  return Array.from({ length: count }, (_, index) => (
    round(safeTimestamp(duration, start + (step * index)))
  ));
}

function safeTimestamp(duration, value) {
  const lower = Math.min(0.05, duration / 4);
  const upper = Math.max(lower, duration - lower);
  return Math.min(Math.max(lower, value), upper);
}

function normalizeDuration(value) {
  return Math.max(1, Number(value) || 5);
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-2500)}`));
    });
  });
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
