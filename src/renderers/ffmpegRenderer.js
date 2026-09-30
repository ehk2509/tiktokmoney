import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export class FfmpegRenderer {
  constructor({
    ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg',
    outputDir = process.env.OUTPUT_DIR || './outputs',
  } = {}) {
    this.ffmpegBin = ffmpegBin;
    this.outputDir = outputDir;
  }

  async render(project) {
    await mkdir(this.outputDir, { recursive: true });
    const manifestPath = path.join(this.outputDir, `${project.id}.render.json`);
    const outputPath = path.join(this.outputDir, `${project.id}.mp4`);
    const workDir = path.join(this.outputDir, `.${project.id}-render`);
    await mkdir(workDir, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(project, null, 2));

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
    await run(this.ffmpegBin, [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c', 'copy',
      videoOnlyPath,
    ]);

    if (project.voice?.audioPath) {
      await run(this.ffmpegBin, [
        '-y',
        '-i', videoOnlyPath,
        '-i', project.voice.audioPath,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-shortest',
        '-movflags', '+faststart',
        outputPath,
      ]);
    } else {
      await run(this.ffmpegBin, [
        '-y',
        '-i', videoOnlyPath,
        '-f', 'lavfi',
        '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-shortest',
        '-movflags', '+faststart',
        outputPath,
      ]);
    }

    await rm(workDir, { recursive: true, force: true });

    return {
      outputPath,
      manifestPath,
      sceneCount: clips.length,
      width: 1080,
      height: 1920,
    };
  }

  async renderScene(scene, outputPath) {
    const duration = Math.max(0.5, Number(scene.duration) || 1);
    const caption = escapeDrawText((scene.overlay || scene.narration || '').slice(0, 110));
    const visualFilter = [
      'scale=1080:1920:force_original_aspect_ratio=increase',
      'crop=1080:1920',
      'setsar=1',
      'fps=30',
      'drawbox=x=70:y=1320:w=940:h=420:color=black@0.38:t=fill',
      `drawtext=text='${caption}':fontcolor=white:fontsize=54:x=(w-text_w)/2:y=1390:box=0`,
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
        '-vf', [
          'setsar=1',
          'fps=30',
          'drawbox=x=70:y=1320:w=940:h=420:color=black@0.38:t=fill',
          `drawtext=text='${caption}':fontcolor=white:fontsize=54:x=(w-text_w)/2:y=1390:box=0`,
        ].join(','),
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

    await run(this.ffmpegBin, args);
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

function escapeDrawText(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(':', '\\:')
    .replaceAll("'", '’')
    .replaceAll('%', '\\%')
    .replaceAll(',', '\\,')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('\n', ' ');
}

function escapeConcatPath(value) {
  return value.replaceAll("'", "'\\''");
}
