import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export class FfmpegRenderer {
  constructor({ ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg', outputDir = process.env.OUTPUT_DIR || './outputs' } = {}) {
    this.ffmpegBin = ffmpegBin;
    this.outputDir = outputDir;
  }

  async render(project) {
    await mkdir(this.outputDir, { recursive: true });
    const manifestPath = path.join(this.outputDir, `${project.id}.render.json`);
    const outputPath = path.join(this.outputDir, `${project.id}.mp4`);
    await writeFile(manifestPath, JSON.stringify(project, null, 2));

    const duration = Math.max(5, Math.min(90, Math.ceil(project.script.durationSeconds)));
    const safeTitle = escapeDrawText(project.topic.slice(0, 80));
    const safeHook = escapeDrawText(project.script.hook.slice(0, 170));
    const filter = [
      'drawbox=x=70:y=150:w=940:h=1620:color=black@0.20:t=fill',
      `drawtext=text='${safeTitle}':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=260`,
      `drawtext=text='${safeHook}':fontcolor=white:fontsize=42:x=110:y=620:box=1:boxcolor=black@0.35:boxborderw=24`,
      "drawtext=text='TikTokMoney prototype':fontcolor=white@0.65:fontsize=30:x=(w-text_w)/2:y=h-180",
    ].join(',');

    const args = [
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=0x111827:s=1080x1920:d=${duration}`,
      '-f', 'lavfi',
      '-i', `sine=frequency=220:sample_rate=44100:duration=${duration}`,
      '-vf', filter,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-shortest',
      outputPath,
    ];

    await run(this.ffmpegBin, args);
    return { outputPath, manifestPath };
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
      reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function escapeDrawText(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(':', '\\:')
    .replaceAll("'", '’')
    .replaceAll('%', '\\%')
    .replaceAll('\n', ' ');
}
