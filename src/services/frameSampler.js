import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class FrameSampler {
  constructor({
    ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg',
    frameCount = Number(process.env.REALISM_QC_FRAMES || 3),
    maxWidth = Number(process.env.REALISM_QC_FRAME_WIDTH || 512),
    runCommand = run,
  } = {}) {
    this.ffmpegBin = ffmpegBin;
    this.frameCount = Math.max(1, Math.min(5, Number(frameCount) || 3));
    this.maxWidth = Math.max(256, Math.min(1024, Number(maxWidth) || 512));
    this.runCommand = runCommand;
  }

  async sample(localPath, { durationSeconds = 5 } = {}) {
    if (!localPath) throw new Error('localPath is required to sample video frames');

    const duration = Math.max(1, Number(durationSeconds) || 5);
    const workDir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-qc-'));

    try {
      const frames = [];
      for (let index = 0; index < this.frameCount; index += 1) {
        const position = (index + 1) / (this.frameCount + 1);
        const timestamp = round(Math.min(Math.max(0.05, duration * position), Math.max(0.05, duration - 0.05)));
        const outputPath = path.join(workDir, `frame-${index}.jpg`);

        await this.runCommand(this.ffmpegBin, [
          '-y',
          '-ss', String(timestamp),
          '-i', localPath,
          '-frames:v', '1',
          '-vf', `scale='min(${this.maxWidth},iw)':-2`,
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
