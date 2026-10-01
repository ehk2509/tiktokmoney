import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { renderAssDocument, renderSrtDocument } from '../core/subtitleBuilder.js';

export class AudiovisualRenderer {
  constructor({
    ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg',
    outputDir = process.env.OUTPUT_DIR || './outputs',
    runCommand = run,
  } = {}) {
    this.ffmpegBin = ffmpegBin;
    this.outputDir = outputDir;
    this.runCommand = runCommand;
  }

  async render(project) {
    await mkdir(this.outputDir, { recursive: true });
    const workDir = path.join(this.outputDir, `.${project.id}-av-render`);
    await mkdir(workDir, { recursive: true });

    const outputPath = path.join(this.outputDir, `${project.id}.mp4`);
    const manifestPath = path.join(this.outputDir, `${project.id}.render.json`);
    const subtitleAssPath = path.join(this.outputDir, `${project.id}.subtitles.ass`);
    const subtitleSrtPath = path.join(this.outputDir, `${project.id}.subtitles.srt`);
    await writeFile(manifestPath, JSON.stringify(project, null, 2));

    const normalized = [];
    for (const scene of project.scenes) {
      if (!scene.asset?.localPath) throw new Error(`audiovisual scene ${scene.index} is missing a generated asset`);
      const clipPath = path.join(workDir, `act-${String(scene.index).padStart(3, '0')}.mp4`);
      await this.runCommand(this.ffmpegBin, [
        '-y',
        '-i', scene.asset.localPath,
        '-t', String(Math.max(0.5, Number(scene.duration) || 1)),
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '160k',
        '-ar', '48000',
        '-ac', '2',
        '-movflags', '+faststart',
        clipPath,
      ]);
      normalized.push(clipPath);
    }

    const concatFile = path.join(workDir, 'concat.txt');
    await writeFile(
      concatFile,
      normalized.map((clip) => `file '${escapeConcatPath(path.resolve(clip))}'`).join('\n'),
    );

    const joinedPath = path.join(workDir, 'joined.mp4');
    await this.runCommand(this.ffmpegBin, [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c', 'copy',
      joinedPath,
    ]);

    const hasSubtitles = Boolean(project.subtitles?.enabled && project.subtitles.events?.length);
    if (hasSubtitles) {
      await writeFile(subtitleAssPath, renderAssDocument(project.subtitles));
      await writeFile(subtitleSrtPath, renderSrtDocument(project.subtitles));
      await this.runCommand(this.ffmpegBin, [
        '-y',
        '-i', joinedPath,
        '-vf', `ass=filename='${escapeFilterPath(path.resolve(subtitleAssPath))}'`,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        outputPath,
      ]);
    } else {
      await this.runCommand(this.ffmpegBin, ['-y', '-i', joinedPath, '-c', 'copy', outputPath]);
    }

    await rm(workDir, { recursive: true, force: true });

    return {
      outputPath,
      manifestPath,
      subtitleAssPath: hasSubtitles ? subtitleAssPath : null,
      subtitleSrtPath: hasSubtitles ? subtitleSrtPath : null,
      sceneCount: normalized.length,
      audioMode: 'native-audiovisual',
      width: 1080,
      height: 1920,
    };
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-3000)}`));
    });
  });
}

function escapeFilterPath(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'");
}

function escapeConcatPath(value) {
  return value.replaceAll("'", "'\\''");
}
