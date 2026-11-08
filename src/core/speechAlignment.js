// Caption timing for clips whose voice track we own: with no transcriber available, the
// words of the known script are laid over the stretches of the track that contain speech.
import { spawn } from 'node:child_process';
import { approximateWordTimingsFromScenes } from './subtitleBuilder.js';

const CAST_VOICE_AUDIO_MODE = 'local-tts-cast-voice';
const SILENCE_FILTER = 'silencedetect=noise=-35dB:d=0.08';
const MIN_SPEECH_SECONDS = 0.03;
const BRIDGE_GAP_SECONDS = 0.35; // shorter pauses keep the caption on screen instead of blinking
// Matches the subtitle builder's limit for keeping words in one cue, so a pause inside a phrase
// never blanks the caption between two of its words.
const PHRASE_GAP_SECONDS = 0.65;
const TAIL_HOLD_SECONDS = 0.3;

export function speechIntervalsFromSilenceLog(log, durationSeconds) {
  const text = String(log);
  const starts = [...text.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...text.matchAll(/silence_end: (-?[\d.]+)/g)].map((m) => Number(m[1]));
  const duration = Number(durationSeconds) || 0;
  const intervals = [];
  let cursor = 0;
  starts.forEach((start, index) => {
    if (start > cursor) intervals.push({ start: cursor, end: start });
    cursor = ends[index] ?? Math.max(duration, start);
  });
  if (duration > cursor) intervals.push({ start: cursor, end: duration });
  return intervals.filter((item) => item.end - item.start >= MIN_SPEECH_SECONDS);
}

export async function measureSpeechIntervals(file, durationSeconds, ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg') {
  const log = await new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', SILENCE_FILTER, '-f', 'null', '-']);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg exited with code ${code}`))));
  });
  return speechIntervalsFromSilenceLog(log, durationSeconds);
}

function wordWeight(token) {
  const word = token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const groups = (word.match(/[aeiouy]+/g) || []).length;
  const silentE = groups > 1 && /[^aeiouy]e$/.test(word) ? 1 : 0;
  const digits = (word.match(/\p{N}/gu) || []).length;
  return Math.max(1, groups - silentE) + word.length * 0.1 + digits * 1.5;
}

/**
 * Word timings for `text`, relative to the track start plus `offset`. Each word takes a share
 * of the speaking time by its length, so words never land on a pause.
 */
export function alignWordsToSpeech(text, intervals, { offset = 0, clipEnd = Infinity } = {}) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !intervals?.length) return [];

  const speechTotal = intervals.reduce((sum, item) => sum + (item.end - item.start), 0);
  const weights = tokens.map(wordWeight);
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const locate = (elapsed) => {
    let remaining = elapsed;
    for (const interval of intervals) {
      const length = interval.end - interval.start;
      if (remaining <= length || interval === intervals.at(-1)) {
        return { time: interval.start + Math.min(remaining, length), interval };
      }
      remaining -= length;
    }
    return null;
  };

  let elapsed = 0;
  const words = tokens.map((word, index) => {
    const span = speechTotal * (weights[index] / weightTotal);
    const home = locate(elapsed + span / 2).interval; // a word straddling a pause stays on one side
    const start = Math.max(home.start, locate(elapsed).time);
    const end = Math.min(home.end, locate(elapsed + span).time);
    elapsed += span;
    return { word, start, end };
  });

  words.forEach((word, index) => {
    const next = words[index + 1];
    if (!next) return;
    const gap = next.start - word.end;
    const midPhrase = !/[.!?…,;:]["')\]]*$/.test(word.word);
    if (gap <= BRIDGE_GAP_SECONDS || (midPhrase && gap <= PHRASE_GAP_SECONDS)) word.end = next.start;
  });
  const last = words.at(-1);
  last.end = Math.max(last.end, Math.min(clipEnd, last.end + TAIL_HOLD_SECONDS));

  return words.map((word, index) => ({
    word: word.word,
    start: round(offset + word.start),
    end: round(offset + word.end),
    boundary: index === words.length - 1, // never let a caption run across a cut
  }));
}

export async function collectVoiceTrackWordTimings(scenes, measure = measureSpeechIntervals) {
  let aligned = false;
  const timings = [];
  for (const scene of scenes) {
    const start = Number(scene.start) || 0;
    const duration = Number(scene.duration) || 0;
    const track = scene.asset?.audioMode === CAST_VOICE_AUDIO_MODE ? scene.asset.dialogueTrack?.localPath : null;
    const intervals = track && scene.narration ? await measure(track, duration).catch(() => []) : [];
    const words = alignWordsToSpeech(scene.narration, intervals, { offset: start, clipEnd: duration });
    if (words.length) {
      aligned = true;
      timings.push(...words);
    } else {
      timings.push(...approximateWordTimingsFromScenes([scene]).map((word, index, all) => ({
        ...word,
        boundary: index === all.length - 1,
      })));
    }
  }
  return aligned ? timings : [];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
