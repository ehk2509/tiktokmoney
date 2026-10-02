import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { renderAssDocument, renderSrtDocument } from '../core/subtitleBuilder.js';
import { AudioQualityInspector } from '../services/audioQualityInspector.js';
import { AntiPlasticPostProcessor } from '../services/antiPlasticPostProcessor.js';

export class AudiovisualRenderer {
  constructor({
    ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg',
    outputDir = process.env.OUTPUT_DIR || './outputs',
    audioTargetLufs = Number(process.env.AUDIO_TARGET_LUFS || -14),
    audioTruePeakDbtp = Number(process.env.AUDIO_TRUE_PEAK_DBTP || -1),
    audioLra = Number(process.env.AUDIO_TARGET_LRA || 7),
    runCommand = run,
    audioInspector = null,
    antiPlasticPostProcessor = null,
  } = {}) {
    this.ffmpegBin = ffmpegBin;
    this.outputDir = outputDir;
    this.audioTargetLufs = Number.isFinite(audioTargetLufs) ? audioTargetLufs : -14;
    this.audioTruePeakDbtp = Number.isFinite(audioTruePeakDbtp) ? audioTruePeakDbtp : -1;
    this.audioLra = Number.isFinite(audioLra) ? audioLra : 7;
    this.runCommand = runCommand;
    this.postProcessor = antiPlasticPostProcessor || new AntiPlasticPostProcessor();
    this.audioInspector = audioInspector || new AudioQualityInspector({
      ffmpegBin,
      targetLufs: this.audioTargetLufs,
      truePeakLimitDbtp: this.audioTruePeakDbtp,
    });
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

    if (project.subtitles?.layout?.passed === false) {
      throw new Error(
        `subtitle layout failed safe-area validation: ${JSON.stringify(project.subtitles.layout.violations)}`,
      );
    }

    const normalized = [];
    const outputFrameRate = Number(
      project.productionScript?.realismDirection?.outputFrameRate,
    ) || 30;
    for (const scene of project.scenes) {
      if (!scene.asset?.localPath) {
        throw new Error(`audiovisual scene ${scene.index} is missing a generated asset`);
      }
      const clipPath = path.join(workDir, `act-${String(scene.index).padStart(3, '0')}.mp4`);
      const antiPlasticProfile = scene.production?.realismDirection?.post
        || project.productionScript?.realismDirection?.postProfile
        || null;
      const sceneVideoFilter = this.postProcessor.buildVideoFilter({
        baseFilter: 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1',
        profile: antiPlasticProfile,
        frameRate: outputFrameRate,
      });
      await this.runCommand(this.ffmpegBin, [
        '-y',
        '-i', scene.asset.localPath,
        '-t', String(Math.max(0.5, Number(scene.duration) || 1)),
        '-vf', sceneVideoFilter,
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

    // Raw clips only need audible speech here; loudnorm below enforces the true-peak ceiling,
    // which the final output check verifies.
    const inputAudioQuality = await this.audioInspector.inspect(joinedPath, { checkTruePeak: false });
    if (!inputAudioQuality.passed) {
      throw new Error(
        `audiovisual output failed audio publishability: ${inputAudioQuality.issues.map((issue) => issue.message).join(' ')}`,
      );
    }

    const hasSubtitles = Boolean(
      project.subtitles?.enabled
        && (project.subtitles.events?.length || project.subtitles.labels?.length),
    );
    if (hasSubtitles) {
      await writeFile(subtitleAssPath, renderAssDocument(project.subtitles));
      await writeFile(subtitleSrtPath, renderSrtDocument(project.subtitles));
    }

    const args = ['-y', '-i', joinedPath];
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
      '-af', `loudnorm=I=${this.audioTargetLufs}:LRA=${this.audioLra}:TP=${this.audioTruePeakDbtp}`,
      '-c:a', 'aac',
      '-b:a', '160k',
      '-ar', '48000',
      '-ac', '2',
      '-movflags', '+faststart',
      outputPath,
    );

    await this.runCommand(this.ffmpegBin, args);

    const outputAudioQuality = await this.audioInspector.inspect(outputPath);
    if (!outputAudioQuality.passed) {
      throw new Error(
        `final render failed audio publishability: ${outputAudioQuality.issues.map((issue) => issue.message).join(' ')}`,
      );
    }

    await rm(workDir, { recursive: true, force: true });

    return {
      outputPath,
      manifestPath,
      subtitleAssPath: hasSubtitles ? subtitleAssPath : null,
      subtitleSrtPath: hasSubtitles ? subtitleSrtPath : null,
      sceneCount: normalized.length,
      audioMode: 'native-audiovisual',
      audioQuality: {
        input: inputAudioQuality,
        output: outputAudioQuality,
        normalizedToLufs: this.audioTargetLufs,
        truePeakCeilingDbtp: this.audioTruePeakDbtp,
      },
      width: 1080,
      height: 1920,
      frameRate: outputFrameRate,
      antiPlasticPost: {
        enabled: this.postProcessor.enabled,
        profile: project.productionScript?.realismDirection?.profile || null,
      },
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
