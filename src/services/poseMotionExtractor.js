import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { normalizePoseSequence } from '../core/poseMotion.js';

export class PoseMotionExtractor {
  constructor({
    command = process.env.POSE_EXTRACTOR_COMMAND || '',
    args = process.env.POSE_EXTRACTOR_ARGS
      ? parseArgs(process.env.POSE_EXTRACTOR_ARGS)
      : undefined,
    sampleFps = Number(process.env.POSE_EXTRACTOR_FPS || 8),
    timeoutMs = Number(process.env.POSE_EXTRACTOR_TIMEOUT_MS || 120000),
    cacheDir = process.env.POSE_CACHE_DIR || './data/pose-cache',
    modelPath = process.env.POSE_MODEL_PATH || './models/pose_landmarker_full.task',
    runCommand = run,
    cwd = process.cwd(),
  } = {}) {
    const resolved = resolveExtractor({
      command,
      args,
      cwd,
      modelPath,
    });
    this.command = resolved.command;
    this.args = resolved.args;
    this.kind = resolved.kind;
    this.sampleFps = clampInt(sampleFps, 2, 30, 8);
    this.timeoutMs = clampInt(timeoutMs, 1000, 600000, 120000);
    this.cacheDir = cacheDir;
    this.modelPath = modelPath;
    this.runCommand = runCommand;
    this.cwd = cwd;
  }

  get available() {
    return Boolean(this.command);
  }

  get bundled() {
    return this.kind === 'bundled-mediapipe';
  }

  async extract(videoPath, {
    durationSeconds = null,
    embeddedPoseSequence = null,
  } = {}) {
    if (embeddedPoseSequence) {
      return {
        source: 'embedded',
        extractor: 'precomputed',
        cached: false,
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
        cached: false,
        sequence: null,
      };
    }
    if (!videoPath) throw new Error('videoPath is required for pose extraction');

    const cacheKey = await buildCacheKey({
      videoPath,
      sampleFps: this.sampleFps,
      command: this.command,
      args: this.args,
    });
    const cached = await this.readCache(cacheKey);
    if (cached) {
      return {
        source: 'cache',
        extractor: cached.extractor || this.command,
        cached: true,
        sequence: normalizePoseSequence({
          ...cached.sequence,
          durationSeconds: cached.sequence?.durationSeconds || durationSeconds,
        }),
      };
    }

    const workDir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-pose-'));
    const outputPath = path.join(workDir, 'pose.json');

    try {
      const args = this.args.map((arg) => String(arg)
        .replaceAll('{video}', videoPath)
        .replaceAll('{output_json}', outputPath)
        .replaceAll('{fps}', String(this.sampleFps))
        .replaceAll('{duration}', durationSeconds == null ? '' : String(durationSeconds))
        .replaceAll('{model}', this.modelPath));

      await this.runCommand(this.command, args, {
        timeoutMs: this.timeoutMs,
        cwd: this.cwd,
      });

      const parsed = JSON.parse(await readFile(outputPath, 'utf8'));
      const sequence = normalizePoseSequence({
        ...parsed,
        durationSeconds: parsed.durationSeconds || durationSeconds,
      });
      const source = this.bundled ? 'bundled-mediapipe' : 'external-command';
      await this.writeCache(cacheKey, {
        extractor: this.command,
        source,
        sequence,
      });

      return {
        source,
        extractor: this.command,
        cached: false,
        sequence,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  async readCache(cacheKey) {
    if (!this.cacheDir || !cacheKey) return null;
    try {
      return JSON.parse(await readFile(
        path.join(this.cacheDir, `${cacheKey}.json`),
        'utf8',
      ));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      return null;
    }
  }

  async writeCache(cacheKey, payload) {
    if (!this.cacheDir || !cacheKey) return;
    await mkdir(this.cacheDir, { recursive: true });
    const target = path.join(this.cacheDir, `${cacheKey}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(payload));
    await rename(temporary, target);
  }
}

export function resolveExtractor({
  command = '',
  args,
  cwd = process.cwd(),
  modelPath = process.env.POSE_MODEL_PATH || './models/pose_landmarker_full.task',
  platform = process.platform,
} = {}) {
  const explicitCommand = String(command || '').trim();
  if (explicitCommand) {
    return {
      command: explicitCommand,
      args: Array.isArray(args) ? args : defaultExternalArgs(),
      kind: 'external-command',
    };
  }

  const scriptPath = path.join(cwd, 'scripts', 'mediapipe_pose_extractor.py');
  if (!existsSync(scriptPath)) {
    return {
      command: '',
      args: [],
      kind: 'unavailable',
    };
  }

  const candidates = bundledPythonCandidates(cwd, platform);
  const python = candidates.find((candidate) => existsSync(candidate));
  if (!python) {
    return {
      command: '',
      args: [],
      kind: 'unavailable',
    };
  }

  return {
    command: python,
    args: Array.isArray(args)
      ? args
      : [
        scriptPath,
        '--video', '{video}',
        '--output-json', '{output_json}',
        '--fps', '{fps}',
        '--duration', '{duration}',
        '--model', modelPath,
      ],
    kind: 'bundled-mediapipe',
  };
}

export function bundledPythonCandidates(cwd = process.cwd(), platform = process.platform) {
  const local = platform === 'win32'
    ? path.join(cwd, '.venv-pose', 'Scripts', 'python.exe')
    : path.join(cwd, '.venv-pose', 'bin', 'python');
  const docker = '/opt/tiktokmoney-pose/bin/python';
  return platform === 'win32' ? [local] : [local, docker];
}

async function buildCacheKey({
  videoPath,
  sampleFps,
  command,
  args,
}) {
  try {
    const info = await stat(videoPath);
    return crypto
      .createHash('sha256')
      .update(JSON.stringify({
        path: path.resolve(videoPath),
        size: info.size,
        mtimeMs: Math.round(info.mtimeMs),
        sampleFps,
        command,
        args,
        schema: 2,
      }))
      .digest('hex')
      .slice(0, 32);
  } catch {
    return null;
  }
}

function defaultExternalArgs() {
  return ['--video', '{video}', '--output-json', '{output_json}', '--fps', '{fps}'];
}

function parseArgs(value) {
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

function run(command, args, { timeoutMs, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
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
