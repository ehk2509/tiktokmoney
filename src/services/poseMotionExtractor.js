import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { normalizePoseSequence } from '../core/poseMotion.js';

export class PoseMotionExtractor {
  constructor({
    command = process.env.POSE_EXTRACTOR_COMMAND || '',
    args = parseArgs(process.env.POSE_EXTRACTOR_ARGS),
    sampleFps = Number(process.env.POSE_EXTRACTOR_FPS || 8),
    timeoutMs = Number(process.env.POSE_EXTRACTOR_TIMEOUT_MS || 120000),
    runCommand = run,
  } = {}) {
    this.command = String(command || '').trim();
    this.args = Array.isArray(args) ? args : [];
    this.sampleFps = clampInt(sampleFps, 2, 30, 8);
    this.timeoutMs = clampInt(timeoutMs, 1000, 600000, 120000);
    this.runCommand = runCommand;
  }

  get available() {
    return Boolean(this.command);
  }

  async extract(videoPath, {
    durationSeconds = null,
    embeddedPoseSequence = null,
  } = {}) {
    if (embeddedPoseSequence) {
      return {
        source: 'embedded',
        extractor: 'precomputed',
        sequence: normalizePoseSequence({
          ...embeddedPoseSequence,
          durationSeconds: embeddedPoseSequence.durationSeconds || durationSeconds,
        }),
      };
    }

    if (!this.available) {
      return {
        source: 'unavailable',
        extractor: null,
        sequence: null,
      };
    }
    if (!videoPath) throw new Error('videoPath is required for pose extraction');

    const workDir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-pose-'));
    const outputPath = path.join(workDir, 'pose.json');

    try {
      const args = this.args.map((arg) => String(arg)
        .replaceAll('{video}', videoPath)
        .replaceAll('{output_json}', outputPath)
        .replaceAll('{fps}', String(this.sampleFps))
        .replaceAll('{duration}', durationSeconds == null ? '' : String(durationSeconds)));

      await this.runCommand(this.command, args, {
        timeoutMs: this.timeoutMs,
      });

      const parsed = JSON.parse(await readFile(outputPath, 'utf8'));
      return {
        source: 'external-command',
        extractor: this.command,
        sequence: normalizePoseSequence({
          ...parsed,
          durationSeconds: parsed.durationSeconds || durationSeconds,
        }),
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

function parseArgs(value) {
  if (!value) {
    return ['--video', '{video}', '--output-json', '{output_json}', '--fps', '{fps}'];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error('POSE_EXTRACTOR_ARGS must be a JSON array');
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function run(command, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`pose extractor timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(
        `${command} exited with code ${code}: ${stderr.slice(-2500)}`,
      ));
    });
  });
}
