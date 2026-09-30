import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { renderAssDocument, renderSrtDocument } from '../core/subtitleBuilder.js';

export class FfmpegRenderer {
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
    const manifestPath = path.join(this.outputDir, `${project.id}.render.json`);
    const outputPath = path.join(this.outputDir, `${project.id}.mp4`);
    const subtitleAssPath = path.join(this.outputDir, `${project.id}.subtitles.ass`);
    const subtitleSrtPath = path.join(this.outputDir, `${project.id}.subtitles.srt`);
    const workDir = path.join(this.outputDir, `.${project.id}-render`);
    await mkdir(workDir, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(project, null, 2));

    const hasSubtitles = Boolean(project.subtitles?.enabled && project.subtitles?.events?.length);
    if (hasSubtitles) {
      await writeFile(subtitleAssPath, renderAssDocument(project.subtitles));
      await writeFile(subtitleSrtPath, renderSrtDocument(project.subtitles));
    }

    const clips = [];
    for (const scene of project.scenes) {
      const clipPath = path.join(workDir, `scene-${String(scene.index).padStart(3, '0')}.mp4`);
      await this.renderScene(scene, clipPath);
      clips.push(clipPath);
    }

    const concatFile = path.join(workDir, 'concat.txt');
    await writeFile(
      concatFile,
      clips.map((clip) => `file '${escapeConcatPath(path.resolve(clip))}'`).join('\n'),
    );

    const videoOnlyPath = path.join(workDir, 'video.mp4');
    await this.runCommand(this.ffmpegBin, [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c', 'copy',
      videoOnlyPath,
    ]);

    const args = ['-y', '-i', videoOnlyPath];
    if (project.voice?.audioPath) {
      args.push('-i', project.voice.audioPath);
    } else {
      args.push(
        '-f', 'lavfi',
        '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      );
    }

    args.push(
      '-map', '0:v:0',
      '-map', '1:a:0',
    );

    if (hasSubtitles) {
      args.push(
        '-vf', `ass=filename='${escapeFilterPath(path.resolve(subtitleAssPath))}'`,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
      );
    } else {
      args.push('-c:v', 'copy');
    }

    args.push(
      '-c:a', 'aac',
      '-b:a', project.voice?.audioPath ? '128k' : '96k',
      '-shortest',
      '-movflags', '+faststart',
      outputPath,
    );

    await this.runCommand(this.ffmpegBin, args);
    await rm(workDir, { recursive: true, force: true });

    return {
      outputPath,
      manifestPath,
      subtitleAssPath: hasSubtitles ? subtitleAssPath : null,
      subtitleSrtPath: hasSubtitles ? subtitleSrtPath : null,
      subtitleSource: project.subtitles?.source || 'none',
      subtitleCueCount: project.subtitles?.cues?.length || 0,
      sceneCount: clips.length,
      width: 1080,
      height: 1920,
    };
  }

  async renderScene(scene, outputPath) {
    const duration = Math.max(0.5, Number(scene.duration) || 1);
    const visualFilter = [
      'scale=1080:1920:force_original_aspect_ratio=increase',
      'crop=1080:1920',
      'setsar=1',
      'fps=30',
    ].join(',');

    const args = ['-y'];

    if (scene.asset?.localPath) {
      args.push(
        '-stream_loop', '-1',
        '-i', scene.asset.localPath,
        '-t', String(duration),
        '-vf', visualFilter,
      );
    } else {
      args.push(
        '-f', 'lavfi',
        '-i', `color=c=0x111827:s=1080x1920:d=${duration}`,
        '-vf', 'setsar=1,fps=30',
      );
    }

    args.push(
      '-an',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-movflags', '+faststart',
      outputPath,
    );

    await this.runCommand(this.ffmpegBin, args);
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
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'");
}

function escapeConcatPath(value) {
  return value.replaceAll("'", "'\\''");
}
