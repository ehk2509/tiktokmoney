import { mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export class DialogueAudioComposer {
  constructor({
    ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg',
    ffprobeBin = process.env.FFPROBE_BIN || 'ffprobe',
    assetDir = process.env.ASSET_DIR || './outputs/assets',
    turnGapSeconds = Number(process.env.MULTISPEAKER_TURN_GAP_SECONDS || 0.16),
    maxDataUriBytes = Number(process.env.MULTISPEAKER_MAX_DATA_URI_BYTES || 15_500_000),
    voiceoverGeneratedAmbienceGain = Number(process.env.VOICEOVER_GENERATED_AMBIENCE_GAIN || 0),
    runCommand = run,
    probeDuration = probe,
  } = {}) {
    this.ffmpegBin = ffmpegBin;
    this.ffprobeBin = ffprobeBin;
    this.assetDir = assetDir;
    this.turnGapSeconds = clamp(Number(turnGapSeconds), 0, 1, 0.16);
    this.maxDataUriBytes = Math.max(1_000_000, Number(maxDataUriBytes) || 15_500_000);
    this.voiceoverGeneratedAmbienceGain = clamp(
      Number(voiceoverGeneratedAmbienceGain),
      0,
      1,
      0,
    );
    this.runCommand = runCommand;
    this.probeDuration = probeDuration;
  }

  async compose({
    projectId = 'project',
    segmentIndex = 0,
    tracks,
  }) {
    if (!Array.isArray(tracks) || tracks.length < 2) {
      throw new Error('multi-speaker dialogue composition requires at least two voice tracks');
    }
    if (tracks.length > 5) {
      throw new Error('multi-speaker dialogue composition supports at most five turns per act');
    }

    await mkdir(this.assetDir, { recursive: true });
    const durations = [];
    for (const track of tracks) {
      if (!track?.localPath) throw new Error('dialogue turn is missing a local audio file');
      const duration = await this.probeDuration(this.ffprobeBin, track.localPath);
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error(`could not determine duration for dialogue turn ${track.turnIndex}`);
      }
      durations.push(duration);
    }

    const timing = [];
    let cursor = 0;
    tracks.forEach((track, index) => {
      const duration = durations[index];
      timing.push({
        turnIndex: track.turnIndex ?? index,
        speakerCharacterId: track.speakerCharacterId,
        text: track.exactText,
        start: round(cursor),
        end: round(cursor + duration),
        duration: round(duration),
        voicePresetId: track.voicePresetId,
        delivery: track.delivery || '',
      });
      cursor += duration;
      if (index < tracks.length - 1) {
        const requestedGap = Number(track.pauseAfterSeconds);
        cursor += Number.isFinite(requestedGap)
          ? clamp(requestedGap, 0, 1, this.turnGapSeconds)
          : this.turnGapSeconds;
      }
    });

    const outputPath = path.join(
      this.assetDir,
      `dialogue-master-${safe(projectId)}-${segmentIndex}.mp3`,
    );
    const inputs = tracks.flatMap((track) => ['-i', track.localPath]);
    const filterParts = tracks.map((_, index) => {
      const delayMs = Math.round(timing[index].start * 1000);
      return `[${index}:a]aresample=48000,asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[a${index}]`;
    });
    const labels = tracks.map((_, index) => `[a${index}]`).join('');
    filterParts.push(
      `${labels}amix=inputs=${tracks.length}:duration=longest:normalize=0,atrim=0:${round(cursor)}[outa]`,
    );

    await this.runCommand(this.ffmpegBin, [
      '-y',
      ...inputs,
      '-filter_complex', filterParts.join(';'),
      '-map', '[outa]',
      '-ar', '48000',
      '-ac', '1',
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      outputPath,
    ]);

    const bytes = await readFile(outputPath);
    const dataUri = `data:audio/mpeg;base64,${bytes.toString('base64')}`;
    if (Buffer.byteLength(dataUri, 'utf8') > this.maxDataUriBytes) {
      throw new Error(
        `composed dialogue data URI exceeds configured limit of ${this.maxDataUriBytes} bytes`,
      );
    }

    return {
      provider: 'local-ffmpeg',
      type: 'dialogue-master',
      localPath: outputPath,
      dataUri,
      durationSeconds: round(cursor),
      turnGapSeconds: this.turnGapSeconds,
      turns: timing,
    };
  }

  /**
   * Lay the exact narration recording over a generated clip, keeping the
   * clip's ambience underneath. Used for off-screen voiceover, where the video
   * model has no lips to sync and tends to paraphrase or garble the words.
   */
  async mixVoiceover({
    videoPath,
    voicePath,
    projectId = 'project',
    segmentIndex = 0,
    generationId = 'clip',
    ambienceGain = null,
  }) {
    await mkdir(this.assetDir, { recursive: true });
    const outputPath = path.join(
      this.assetDir,
      `voiceover-${safe(projectId)}-${segmentIndex}-${safe(generationId)}.mp4`,
    );
    const output = ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', outputPath];
    const generatedAmbienceGain = ambienceGain != null && Number.isFinite(Number(ambienceGain))
      ? clamp(Number(ambienceGain), 0, 1, this.voiceoverGeneratedAmbienceGain)
      : this.voiceoverGeneratedAmbienceGain;

    // Generated audiovisual beds are not trustworthy under off-screen narration:
    // models can emit faint duplicate speech, echo-like vocal artifacts or looping
    // sound effects even when prompted for ambience only. Exact TTS is the
    // authoritative soundtrack, so generated audio is discarded by default.
    if (generatedAmbienceGain <= 0) {
      await this.runCommand(this.ffmpegBin, [
        '-y', '-i', videoPath, '-i', voicePath,
        '-map', '0:v:0', '-map', '1:a:0', '-af', 'apad', '-shortest',
        ...output,
      ]);
      return outputPath;
    }

    try {
      await this.runCommand(this.ffmpegBin, [
        '-y', '-i', videoPath, '-i', voicePath,
        '-filter_complex',
        `[0:a]volume=${generatedAmbienceGain}[bed];[bed][1:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`,
        '-map', '0:v:0', '-map', '[a]',
        ...output,
      ]);
    } catch {
      // Clip without an audio stream: narration alone, padded to the clip length.
      await this.runCommand(this.ffmpegBin, [
        '-y', '-i', videoPath, '-i', voicePath,
        '-map', '0:v:0', '-map', '1:a:0', '-af', 'apad', '-shortest',
        ...output,
      ]);
    }
    return outputPath;
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

function probe(ffprobeBin, localPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobeBin, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      localPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${ffprobeBin} exited with code ${code}: ${stderr.slice(-1000)}`));
        return;
      }
      resolve(Number(stdout.trim()));
    });
  });
}

function safe(value) {
  return String(value || 'project').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 100);
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
