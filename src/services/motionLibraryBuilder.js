import crypto from 'node:crypto';
import {
  mkdir,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  comparePoseSequences,
  normalizePoseSequence,
} from '../core/poseMotion.js';
import { PoseMotionExtractor } from './poseMotionExtractor.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);

export class MotionLibraryBuilder {
  constructor({
    store,
    extractor = new PoseMotionExtractor(),
    libraryDir = process.env.MOTION_LIBRARY_ASSET_DIR || './data/motion-library',
    ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg',
    ffprobeBin = process.env.FFPROBE_BIN || 'ffprobe',
    minSegmentSeconds = Number(process.env.MOTION_LIBRARY_MIN_SEGMENT_SECONDS || 2.5),
    maxSegmentSeconds = Number(process.env.MOTION_LIBRARY_MAX_SEGMENT_SECONDS || 12),
    maxSegmentsPerClip = Number(process.env.MOTION_LIBRARY_MAX_SEGMENTS_PER_CLIP || 4),
    minQualityScore = Number(process.env.MOTION_LIBRARY_MIN_QUALITY_SCORE || 62),
    dedupeThreshold = Number(process.env.MOTION_LIBRARY_DEDUPE_THRESHOLD || 0.9),
    allowGeneral = envBool(process.env.MOTION_LIBRARY_ALLOW_GENERAL, false),
    maxDataUriSourceBytes = Number(process.env.MOTION_GUIDE_MAX_DATA_URI_BYTES || 3600000),
    fetchImpl = globalThis.fetch,
    runCommand = run,
  } = {}) {
    if (!store) throw new Error('MotionLibraryBuilder requires a motion-reference store');
    this.store = store;
    this.extractor = extractor;
    this.libraryDir = libraryDir;
    this.ffmpegBin = ffmpegBin;
    this.ffprobeBin = ffprobeBin;
    this.minSegmentSeconds = clamp(minSegmentSeconds, 1.5, 10, 2.5);
    this.maxSegmentSeconds = clamp(maxSegmentSeconds, this.minSegmentSeconds, 15, 12);
    this.maxSegmentsPerClip = Math.max(1, Math.min(12, Math.round(maxSegmentsPerClip || 4)));
    this.minQualityScore = clamp(minQualityScore, 0, 100, 62);
    this.dedupeThreshold = clamp(dedupeThreshold, 0.5, 0.999, 0.9);
    this.allowGeneral = Boolean(allowGeneral);
    this.maxDataUriSourceBytes = Math.max(500000, Math.min(3900000, maxDataUriSourceBytes));
    this.fetch = fetchImpl;
    this.runCommand = runCommand;
  }

  async build({
    clips = [],
    directory = null,
    source = '',
    license = '',
    rightsConfirmed = false,
    actionHint = null,
    cameraMode = 'any',
    people = 1,
  } = {}) {
    if (!rightsConfirmed) {
      throw new Error('motion-library ingestion requires rightsConfirmed=true');
    }
    if (!license) {
      throw new Error('motion-library ingestion requires a documented license/rights note');
    }
    if (!this.extractor?.available) {
      throw new Error('pose extractor unavailable; run npm run setup:pose before building the motion library');
    }

    const discovered = directory ? await discoverVideoFiles(directory) : [];
    const inputs = [
      ...clips,
      ...discovered.map((localPath) => ({ localPath })),
    ].map((clip) => (
      typeof clip === 'string' ? { localPath: clip } : clip
    ));

    if (!inputs.length) throw new Error('no motion clips were provided');

    await mkdir(this.libraryDir, { recursive: true });
    let references = await this.store.list();
    const report = {
      inputClips: inputs.length,
      accepted: [],
      duplicates: [],
      rejected: [],
      errors: [],
    };

    for (const input of inputs) {
      try {
        const result = await this.ingestClip({
          ...input,
          source: input.source || source,
          license: input.license || license,
          rightsConfirmed: input.rightsConfirmed ?? rightsConfirmed,
          actionHint: input.actionHint || actionHint,
          cameraMode: input.cameraMode || cameraMode,
          people: input.people || people,
        }, references);

        for (const item of result.accepted) {
          references = references.filter((reference) => reference.id !== item.replacesId);
          references.push(item.reference);
          report.accepted.push(item.reference);
        }
        report.duplicates.push(...result.duplicates);
        report.rejected.push(...result.rejected);
      } catch (error) {
        report.errors.push({
          input: input.localPath || input.url || 'unknown',
          error: error.message,
        });
      }
    }

    await this.store.write(references);
    report.librarySize = references.length;
    return report;
  }

  async ingestClip(input, existingReferences = []) {
    if (input.rightsConfirmed !== true) {
      throw new Error('clip rights are not confirmed');
    }
    if (!input.license) throw new Error('clip license/rights note is required');

    const sourceMedia = await this.resolveSource(input);
    const durationSeconds = Number(input.durationSeconds)
      || await probeDuration(sourceMedia.localPath, this.ffprobeBin, this.runCommand);
    const extracted = await this.extractor.extract(sourceMedia.localPath, { durationSeconds });
    if (!extracted.sequence?.frames?.length) {
      throw new Error('pose extraction returned no usable frames');
    }

    const sequence = normalizePoseSequence(extracted.sequence);
    const windows = detectMotionSegments(sequence, {
      minSegmentSeconds: this.minSegmentSeconds,
      maxSegmentSeconds: this.maxSegmentSeconds,
      maxSegments: this.maxSegmentsPerClip,
    });

    const accepted = [];
    const duplicates = [];
    const rejected = [];
    let comparisonPool = [...existingReferences];

    for (let index = 0; index < windows.length; index += 1) {
      const window = windows[index];
      const poseSequence = slicePoseSequence(sequence, window.start, window.end);
      const classification = classifyPoseSequence(poseSequence, {
        actionHint: input.actionHint,
      });
      const quality = scoreMotionReferenceQuality(poseSequence, {
        classificationConfidence: classification.confidence,
        durationSeconds: window.end - window.start,
      });

      if ((!this.allowGeneral && classification.actionClass === 'general')
        || quality.score < this.minQualityScore) {
        rejected.push({
          source: sourceMedia.sourceLabel,
          start: round(window.start),
          end: round(window.end),
          actionClass: classification.actionClass,
          classificationConfidence: classification.confidence,
          qualityScore: quality.score,
          reasons: [
            ...(classification.actionClass === 'general' && !this.allowGeneral
              ? ['ambiguous action classification']
              : []),
            ...(quality.score < this.minQualityScore
              ? [`quality ${quality.score} below ${this.minQualityScore}`]
              : []),
          ],
        });
        continue;
      }

      const id = buildReferenceId(sourceMedia.sourceLabel, classification.actionClass, window, index);
      const segmentPath = path.join(this.libraryDir, `${id}.mp4`);
      await createReferenceClip({
        sourcePath: sourceMedia.localPath,
        destination: segmentPath,
        start: window.start,
        duration: window.end - window.start,
        ffmpegBin: this.ffmpegBin,
        maxBytes: this.maxDataUriSourceBytes,
        runCommand: this.runCommand,
      });

      const withContacts = {
        ...poseSequence,
        contacts: detectFootContacts(poseSequence),
      };
      const reference = {
        id,
        actionClass: classification.actionClass,
        tags: buildTags(classification, withContacts),
        cameraMode: input.cameraMode || 'any',
        people: clampInt(input.people, 1, 8, 1),
        durationSeconds: round(window.end - window.start),
        localPath: segmentPath,
        source: input.source || sourceMedia.sourceLabel,
        license: input.license,
        notes: `auto-built from ${sourceMedia.sourceLabel} @ ${round(window.start)}-${round(window.end)}s`,
        verifiedHumanMotion: true,
        rightsConfirmed: true,
        poseSequence: withContacts,
        qualityScore: quality.score,
        classificationConfidence: classification.confidence,
        autoGenerated: true,
        sourceClip: sourceMedia.sourceLabel,
        segmentStartSeconds: round(window.start),
        segmentEndSeconds: round(window.end),
        createdAt: new Date().toISOString(),
      };

      const duplicate = findDuplicate(reference, comparisonPool, this.dedupeThreshold);
      if (duplicate && Number(duplicate.reference.qualityScore || 0) >= quality.score) {
        duplicates.push({
          candidateId: id,
          keptId: duplicate.reference.id,
          similarity: duplicate.similarity,
          reason: 'existing reference is equal or higher quality',
        });
        continue;
      }

      if (duplicate) {
        duplicates.push({
          candidateId: id,
          replacedId: duplicate.reference.id,
          similarity: duplicate.similarity,
          reason: 'candidate has higher quality',
        });
      }

      accepted.push({
        reference,
        replacesId: duplicate?.reference.id || null,
      });
      comparisonPool = comparisonPool.filter(
        (item) => item.id !== duplicate?.reference.id,
      );
      comparisonPool.push(reference);
    }

    return { accepted, duplicates, rejected };
  }

  async resolveSource(input) {
    if (input.localPath) {
      const localPath = path.resolve(input.localPath);
      const info = await stat(localPath);
      if (!info.isFile()) throw new Error('motion source is not a file');
      return {
        localPath,
        sourceLabel: input.source || path.basename(localPath),
      };
    }

    if (!/^https:\/\//i.test(String(input.url || ''))) {
      throw new Error('motion source must provide localPath or HTTPS url');
    }
    if (!this.fetch) throw new Error('fetch is unavailable for remote motion source');

    const response = await this.fetch(input.url);
    if (!response.ok) throw new Error(`motion source download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const ext = safeVideoExtension(new URL(input.url).pathname);
    const localPath = path.join(
      this.libraryDir,
      `source-${crypto.createHash('sha256').update(input.url).digest('hex').slice(0, 16)}${ext}`,
    );
    await writeFile(localPath, bytes);
    return {
      localPath,
      sourceLabel: input.source || input.url,
    };
  }
}

export function detectMotionSegments(sequence, {
  minSegmentSeconds = 2.5,
  maxSegmentSeconds = 12,
  maxSegments = 4,
} = {}) {
  const normalized = normalizePoseSequence(sequence);
  const frames = normalized.frames || [];
  if (frames.length < 3) return [];

  const samples = [];
  for (let index = 1; index < frames.length; index += 1) {
    samples.push({
      time: frames[index].time,
      energy: frameMotionEnergy(frames[index - 1], frames[index]),
    });
  }

  const positive = samples.map((item) => item.energy).filter((value) => value > 0);
  const baseline = quantile(positive, 0.55);
  const threshold = Math.max(0.018, baseline * 0.7);
  const active = samples.filter((item) => item.energy >= threshold);

  if (!active.length) return [];

  const groups = [];
  let current = null;
  for (const sample of samples) {
    if (sample.energy >= threshold) {
      if (!current || sample.time - current.end > 0.8) {
        current = { start: Math.max(0, sample.time - 0.4), end: sample.time + 0.5 };
        groups.push(current);
      } else {
        current.end = sample.time + 0.5;
      }
    }
  }

  const duration = normalized.durationSeconds || frames.at(-1).time;
  const windows = [];
  for (const group of groups) {
    let start = Math.max(0, group.start);
    const finalEnd = Math.min(duration, group.end);
    while (finalEnd - start > maxSegmentSeconds) {
      windows.push({ start, end: start + maxSegmentSeconds });
      start += maxSegmentSeconds;
    }
    if (finalEnd - start >= minSegmentSeconds) {
      windows.push({ start, end: finalEnd });
    } else if (windows.length && windows.at(-1).end <= start) {
      windows.at(-1).end = Math.min(
        duration,
        Math.max(windows.at(-1).end, finalEnd),
      );
    }
  }

  if (!windows.length && duration >= minSegmentSeconds) {
    windows.push({ start: 0, end: Math.min(duration, maxSegmentSeconds) });
  }

  return windows
    .map((window) => ({
      start: round(window.start),
      end: round(window.end),
      activityScore: round(meanEnergyBetween(samples, window.start, window.end)),
    }))
    .sort((a, b) => b.activityScore - a.activityScore)
    .slice(0, maxSegments)
    .sort((a, b) => a.start - b.start);
}

export function classifyPoseSequence(sequence, { actionHint = null } = {}) {
  if (actionHint) {
    return {
      actionClass: normalizeActionHint(actionHint),
      confidence: 1,
      reason: 'explicit action hint',
    };
  }

  const normalized = normalizePoseSequence(sequence);
  const frames = normalized.frames || [];
  const metrics = motionMetrics(frames);
  const candidates = [];

  if (metrics.kneeRange >= 38 && metrics.bilateralKneeCorrelation >= 0.45) {
    candidates.push(['squat', clamp01(0.55 + metrics.kneeRange / 180)]);
  }
  if (metrics.wristVerticalRange >= 0.65 && metrics.elbowRange >= 24) {
    candidates.push(['lifting', clamp01(0.5 + metrics.wristVerticalRange * 0.2 + metrics.elbowRange / 240)]);
  }
  if (metrics.ankleTravel >= 0.28 && metrics.kneeRange >= 18 && metrics.alternatingLegMotion >= 0.22) {
    const running = metrics.meanEnergy >= 0.11;
    candidates.push([
      running ? 'running' : 'walking',
      clamp01(0.5 + metrics.ankleTravel * 0.2 + metrics.alternatingLegMotion * 0.3),
    ]);
  }
  if (metrics.maxWristTravel >= 0.5 && metrics.kneeRange < 35) {
    candidates.push(['reaching', clamp01(0.48 + metrics.maxWristTravel * 0.25)]);
  }
  if (metrics.meanEnergy >= 0.16 && metrics.ankleTravel >= 0.35) {
    candidates.push(['jumping', clamp01(0.48 + metrics.meanEnergy)]);
  }

  candidates.sort((a, b) => b[1] - a[1]);
  const winner = candidates[0];
  return winner
    ? {
      actionClass: winner[0],
      confidence: round(winner[1]),
      reason: 'pose heuristics',
      metrics,
    }
    : {
      actionClass: 'general',
      confidence: 0.35,
      reason: 'no strong pose heuristic',
      metrics,
    };
}

export function detectFootContacts(sequence) {
  const normalized = normalizePoseSequence(sequence);
  const frames = normalized.frames || [];
  if (frames.length < 3) return [];

  const contacts = [];
  for (const side of ['left', 'right']) {
    const joint = `${side}_ankle`;
    for (let index = 1; index < frames.length - 1; index += 1) {
      const prev = frames[index - 1].joints?.[joint];
      const current = frames[index].joints?.[joint];
      const next = frames[index + 1].joints?.[joint];
      if (!prev || !current || !next) continue;
      const speed = (distance(prev, current) + distance(current, next)) / 2;
      if (speed > 0.07 || current.y < 0.9) continue;
      const last = contacts.at(-1);
      if (last?.type === `${side}-foot-plant` && frames[index].time - last.time < 0.45) {
        continue;
      }
      contacts.push({
        type: `${side}-foot-plant`,
        time: round(frames[index].time),
        normalizedTime: round(frames[index].time / Math.max(0.001, normalized.durationSeconds)),
      });
    }
  }
  return contacts.slice(0, 16);
}

export function scoreMotionReferenceQuality(sequence, {
  classificationConfidence = 0.5,
  durationSeconds = null,
} = {}) {
  const normalized = normalizePoseSequence(sequence);
  const frames = normalized.frames || [];
  if (!frames.length) return { score: 0, coverage: 0, motionEnergy: 0 };

  const core = [
    'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
    'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
    'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
  ];
  const coverage = frames.reduce((sum, frame) => (
    sum + core.filter((name) => Number(frame.joints?.[name]?.confidence || 0) >= 0.4).length / core.length
  ), 0) / frames.length;

  const energies = [];
  for (let index = 1; index < frames.length; index += 1) {
    energies.push(frameMotionEnergy(frames[index - 1], frames[index]));
  }
  const motionEnergy = energies.length
    ? energies.reduce((sum, value) => sum + value, 0) / energies.length
    : 0;
  const duration = Number(durationSeconds) || normalized.durationSeconds || 0;
  const durationFit = duration >= 3 && duration <= 10
    ? 1
    : Math.max(0, 1 - Math.abs(duration - 6.5) / 10);
  const motionFit = Math.min(1, motionEnergy / 0.09);

  const score = Math.round(
    (coverage * 50)
    + (durationFit * 18)
    + (motionFit * 20)
    + (clamp01(classificationConfidence) * 12),
  );

  return {
    score,
    coverage: round(coverage),
    motionEnergy: round(motionEnergy),
    durationFit: round(durationFit),
  };
}

export function findDuplicate(candidate, references, threshold = 0.9) {
  if (!candidate?.poseSequence) return null;
  let best = null;
  for (const reference of references || []) {
    if (
      reference.actionClass !== candidate.actionClass
      || !reference.poseSequence
    ) continue;
    const comparison = comparePoseSequences(candidate.poseSequence, reference.poseSequence);
    const similarity = comparison.overallScore / 100;
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { reference, similarity: round(similarity), comparison };
    }
  }
  return best;
}

function slicePoseSequence(sequence, start, end) {
  const frames = (sequence.frames || [])
    .filter((frame) => frame.time >= start && frame.time <= end)
    .map((frame) => ({
      ...frame,
      time: round(frame.time - start),
    }));
  return normalizePoseSequence({
    coordinateSpace: 'body-normalized-2d',
    durationSeconds: end - start,
    frames,
    contacts: [],
  });
}

async function createReferenceClip({
  sourcePath,
  destination,
  start,
  duration,
  ffmpegBin,
  maxBytes,
  runCommand,
}) {
  await mkdir(path.dirname(destination), { recursive: true });
  const maxRateKbps = Math.max(220, Math.floor((maxBytes * 8) / Math.max(1, duration) / 1000 * 0.72));
  const filter = 'scale=if(gt(iw,ih),640,-2):if(gt(iw,ih),-2,640)';
  await runCommand(ffmpegBin, [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', String(start),
    '-i', sourcePath,
    '-t', String(duration),
    '-an',
    '-vf', filter,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '30',
    '-maxrate', `${maxRateKbps}k`,
    '-bufsize', `${maxRateKbps * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    destination,
  ], { timeoutMs: 120000 });

  const info = await stat(destination);
  if (info.size > maxBytes) {
    throw new Error(
      `motion segment ${path.basename(destination)} is ${info.size} bytes; exceeds data-URI source budget ${maxBytes}`,
    );
  }
}

async function probeDuration(filePath, ffprobeBin, runCommand) {
  const result = await runCommand(ffprobeBin, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    filePath,
  ], { timeoutMs: 30000, captureStdout: true });
  const duration = Number(result.stdout);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('ffprobe returned invalid motion-source duration');
  }
  return duration;
}

async function discoverVideoFiles(directory) {
  const root = path.resolve(directory);
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const candidate = path.join(root, entry.name);
    if (VIDEO_EXTENSIONS.has(path.extname(candidate).toLowerCase())) files.push(candidate);
  }
  return files.sort();
}

function motionMetrics(frames) {
  const kneeLeft = [], kneeRight = [];
  const elbowLeft = [], elbowRight = [];
  const leftWristY = [], rightWristY = [];
  const ankleTravel = [];
  const leftAnkleMotion = [], rightAnkleMotion = [];
  const energies = [];

  for (const frame of frames) {
    kneeLeft.push(angle(frame, 'left_hip', 'left_knee', 'left_ankle'));
    kneeRight.push(angle(frame, 'right_hip', 'right_knee', 'right_ankle'));
    elbowLeft.push(angle(frame, 'left_shoulder', 'left_elbow', 'left_wrist'));
    elbowRight.push(angle(frame, 'right_shoulder', 'right_elbow', 'right_wrist'));
    if (Number.isFinite(frame.joints?.left_wrist?.y)) leftWristY.push(frame.joints.left_wrist.y);
    if (Number.isFinite(frame.joints?.right_wrist?.y)) rightWristY.push(frame.joints.right_wrist.y);
  }
  for (let index = 1; index < frames.length; index += 1) {
    energies.push(frameMotionEnergy(frames[index - 1], frames[index]));
    const l = distance(frames[index - 1].joints?.left_ankle, frames[index].joints?.left_ankle) || 0;
    const r = distance(frames[index - 1].joints?.right_ankle, frames[index].joints?.right_ankle) || 0;
    leftAnkleMotion.push(l);
    rightAnkleMotion.push(r);
    ankleTravel.push(l, r);
  }

  return {
    kneeRange: Math.max(seriesRange(kneeLeft), seriesRange(kneeRight)),
    elbowRange: Math.max(seriesRange(elbowLeft), seriesRange(elbowRight)),
    wristVerticalRange: Math.max(seriesRange(leftWristY), seriesRange(rightWristY)),
    maxWristTravel: Math.max(seriesRange(leftWristY), seriesRange(rightWristY)),
    ankleTravel: ankleTravel.reduce((sum, value) => sum + value, 0),
    alternatingLegMotion: antiCorrelation(leftAnkleMotion, rightAnkleMotion),
    bilateralKneeCorrelation: correlation(kneeLeft, kneeRight),
    meanEnergy: energies.length
      ? energies.reduce((sum, value) => sum + value, 0) / energies.length
      : 0,
  };
}

function frameMotionEnergy(a, b) {
  const joints = [
    'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
    'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
    'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
  ];
  const values = joints
    .map((joint) => distance(a.joints?.[joint], b.joints?.[joint]))
    .filter(Number.isFinite);
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function angle(frame, a, b, c) {
  const pa = frame.joints?.[a], pb = frame.joints?.[b], pc = frame.joints?.[c];
  if (!pa || !pb || !pc) return null;
  const ab = { x: pa.x - pb.x, y: pa.y - pb.y };
  const cb = { x: pc.x - pb.x, y: pc.y - pb.y };
  const den = Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y);
  if (den < 1e-6) return null;
  const cosine = clamp(((ab.x * cb.x) + (ab.y * cb.y)) / den, -1, 1, 0);
  return Math.acos(cosine) * 180 / Math.PI;
}

function buildTags(classification, sequence) {
  const tags = [
    classification.actionClass,
    'auto-built',
    'human-motion',
    sequence.contacts?.length ? 'contact-events' : '',
  ].filter(Boolean);
  return [...new Set(tags)];
}

function buildReferenceId(source, actionClass, window, index) {
  const digest = crypto.createHash('sha1')
    .update(`${source}|${window.start}|${window.end}|${index}`)
    .digest('hex')
    .slice(0, 10);
  return `${actionClass}-${digest}`;
}

function normalizeActionHint(value) {
  return String(value || 'general')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'general';
}

function safeVideoExtension(value) {
  const ext = path.extname(String(value || '')).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext) ? ext : '.mp4';
}

function meanEnergyBetween(samples, start, end) {
  const values = samples
    .filter((item) => item.time >= start && item.time <= end)
    .map((item) => item.energy);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[index];
}

function seriesRange(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? Math.max(...usable) - Math.min(...usable) : 0;
}

function correlation(a, b) {
  const pairs = [];
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) pairs.push([a[i], b[i]]);
  }
  if (pairs.length < 3) return 0;
  const meanA = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const meanB = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let numerator = 0, da = 0, db = 0;
  for (const [x, y] of pairs) {
    numerator += (x - meanA) * (y - meanB);
    da += (x - meanA) ** 2;
    db += (y - meanB) ** 2;
  }
  return da && db ? numerator / Math.sqrt(da * db) : 0;
}

function antiCorrelation(a, b) {
  const value = correlation(a, b);
  return Math.max(0, -value);
}

function distance(a, b) {
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function envBool(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function run(command, args, {
  timeoutMs = 120000,
  captureStdout = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'],
    });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
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
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}
