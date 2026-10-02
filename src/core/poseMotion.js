const CORE_JOINTS = [
  'nose',
  'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist',
  'left_hip', 'right_hip',
  'left_knee', 'right_knee',
  'left_ankle', 'right_ankle',
];

const ANGLE_TRIPLETS = [
  ['left_shoulder', 'left_elbow', 'left_wrist', 'left_elbow'],
  ['right_shoulder', 'right_elbow', 'right_wrist', 'right_elbow'],
  ['left_shoulder', 'left_hip', 'left_knee', 'left_hip'],
  ['right_shoulder', 'right_hip', 'right_knee', 'right_hip'],
  ['left_hip', 'left_knee', 'left_ankle', 'left_knee'],
  ['right_hip', 'right_knee', 'right_ankle', 'right_knee'],
];

export function normalizePoseSequence(input) {
  const rawFrames = Array.isArray(input)
    ? input
    : Array.isArray(input?.frames)
      ? input.frames
      : [];

  const frames = rawFrames
    .map((frame, index) => normalizeFrame(frame, index))
    .filter((frame) => Object.keys(frame.joints).length >= 4)
    .sort((a, b) => a.time - b.time);

  if (!frames.length) {
    return {
      schemaVersion: 1,
      coordinateSpace: 'body-normalized-2d',
      durationSeconds: 0,
      frames: [],
      contacts: [],
    };
  }

  const firstTime = frames[0].time;
  const shifted = frames.map((frame) => ({
    ...frame,
    time: Math.max(0, frame.time - firstTime),
  }));
  const durationSeconds = Math.max(
    Number(input?.durationSeconds) || 0,
    shifted.at(-1)?.time || 0,
  );

  const normalizedFrames = shifted.map(bodyNormalizeFrame);
  return {
    schemaVersion: 1,
    coordinateSpace: 'body-normalized-2d',
    durationSeconds: round(durationSeconds),
    frames: normalizedFrames,
    contacts: normalizeContacts(input?.contacts, durationSeconds),
  };
}

export function summarizePoseSequence(sequence, { maxBeats = 6 } = {}) {
  const normalized = normalizePoseSequence(sequence);
  if (normalized.frames.length < 2) return null;

  const resampled = resamplePoseSequence(normalized, Math.max(3, Math.min(12, maxBeats)));
  const beats = resampled.frames.map((frame, index) => {
    const joints = frame.joints;
    const hipY = averageValues([
      joints.left_hip?.y,
      joints.right_hip?.y,
    ]);
    const wristY = averageValues([
      joints.left_wrist?.y,
      joints.right_wrist?.y,
    ]);
    const ankleSpan = distance(joints.left_ankle, joints.right_ankle);
    return {
      beat: index + 1,
      t: round(frame.normalizedTime),
      hipHeight: finiteOrNull(hipY),
      wristHeight: finiteOrNull(wristY),
      stanceWidth: finiteOrNull(ankleSpan),
      kneeFlexion: finiteOrNull(averageJointAngle(frame, ['left_knee', 'right_knee'])),
      elbowFlexion: finiteOrNull(averageJointAngle(frame, ['left_elbow', 'right_elbow'])),
    };
  });

  return {
    durationSeconds: normalized.durationSeconds,
    beatCount: beats.length,
    beats,
    contacts: normalized.contacts.slice(0, 12),
  };
}

export function poseSummaryToPrompt(summary) {
  if (!summary?.beats?.length) return '';

  const beats = summary.beats.map((beat) => {
    const fields = [
      `t=${beat.t}`,
      beat.hipHeight != null ? `hipY=${beat.hipHeight}` : '',
      beat.wristHeight != null ? `wristY=${beat.wristHeight}` : '',
      beat.stanceWidth != null ? `stance=${beat.stanceWidth}` : '',
      beat.kneeFlexion != null ? `knee=${Math.round(beat.kneeFlexion)}deg` : '',
      beat.elbowFlexion != null ? `elbow=${Math.round(beat.elbowFlexion)}deg` : '',
    ].filter(Boolean);
    return `beat ${beat.beat}[${fields.join(', ')}]`;
  }).join(' -> ');

  const contacts = summary.contacts?.length
    ? ` Contacts: ${summary.contacts.map((contact) => (
      `${contact.type}@${round(contact.normalizedTime ?? 0)}`
    )).join(', ')}.`
    : '';

  return `Normalized skeleton timing: ${beats}.${contacts}`;
}

export function comparePoseSequences(referenceInput, generatedInput, {
  sampleCount = 12,
  minJointConfidence = 0.35,
} = {}) {
  const reference = resamplePoseSequence(
    normalizePoseSequence(referenceInput),
    sampleCount,
  );
  const generated = resamplePoseSequence(
    normalizePoseSequence(generatedInput),
    sampleCount,
  );

  if (reference.frames.length < 3 || generated.frames.length < 3) {
    return {
      passed: false,
      overallScore: 0,
      coverage: 0,
      poseTrajectoryScore: 0,
      bodyMechanicsScore: 0,
      timingRhythmScore: 0,
      contactMechanicsScore: 0,
      issues: ['insufficient pose frames'],
    };
  }

  let positionError = 0;
  let positionCount = 0;
  let commonJointObservations = 0;
  let possibleJointObservations = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const refFrame = reference.frames[index];
    const genFrame = generated.frames[index];
    for (const joint of CORE_JOINTS) {
      possibleJointObservations += 1;
      const ref = refFrame?.joints?.[joint];
      const gen = genFrame?.joints?.[joint];
      if (!isUsableJoint(ref, minJointConfidence) || !isUsableJoint(gen, minJointConfidence)) {
        continue;
      }
      positionError += distance(ref, gen);
      positionCount += 1;
      commonJointObservations += 1;
    }
  }

  const coverage = possibleJointObservations
    ? commonJointObservations / possibleJointObservations
    : 0;
  const meanPositionError = positionCount ? positionError / positionCount : 1;
  const poseTrajectoryScore = scoreFromError(meanPositionError, 0.75);

  const refAngles = angleSeries(reference);
  const genAngles = angleSeries(generated);
  const angleErrors = [];
  for (const key of Object.keys(refAngles)) {
    const a = refAngles[key] || [];
    const b = genAngles[key] || [];
    const count = Math.min(a.length, b.length);
    for (let index = 0; index < count; index += 1) {
      if (!Number.isFinite(a[index]) || !Number.isFinite(b[index])) continue;
      angleErrors.push(Math.abs(a[index] - b[index]) / 180);
    }
  }
  const bodyMechanicsScore = angleErrors.length
    ? scoreFromError(averageValues(angleErrors), 0.55)
    : poseTrajectoryScore;

  const refVelocity = motionEnergySeries(reference);
  const genVelocity = motionEnergySeries(generated);
  const rhythmError = normalizedSeriesError(refVelocity, genVelocity);
  const durationRatioError = relativeDifference(
    reference.durationSeconds || 1,
    generated.durationSeconds || 1,
  );
  const timingRhythmScore = scoreFromError(
    (rhythmError * 0.7) + (durationRatioError * 0.3),
    0.8,
  );

  const contactResult = compareContacts(reference.contacts, generated.contacts);
  const contactMechanicsScore = contactResult.score;

  const weighted = [
    [poseTrajectoryScore, 0.4],
    [bodyMechanicsScore, 0.3],
    [timingRhythmScore, 0.2],
    [contactMechanicsScore, 0.1],
  ];
  const overallScore = Math.round(weighted.reduce(
    (sum, [score, weight]) => sum + (score * weight),
    0,
  ));

  const issues = [];
  if (coverage < 0.55) issues.push('low common-joint coverage');
  if (poseTrajectoryScore < 75) issues.push('pose trajectory diverges from reference');
  if (bodyMechanicsScore < 75) issues.push('joint-angle/body mechanics diverge');
  if (timingRhythmScore < 72) issues.push('movement rhythm/timing diverges');
  if (contactMechanicsScore < 70) issues.push('contact-event timing diverges');

  return {
    passed: overallScore >= 78 && coverage >= 0.55,
    overallScore,
    coverage: round(coverage),
    poseTrajectoryScore,
    bodyMechanicsScore,
    timingRhythmScore,
    contactMechanicsScore,
    meanPositionError: round(meanPositionError),
    contactDetails: contactResult.details,
    issues,
  };
}

export function resamplePoseSequence(input, count = 12) {
  const sequence = input?.coordinateSpace === 'body-normalized-2d'
    ? input
    : normalizePoseSequence(input);
  if (!sequence.frames?.length) return { ...sequence, frames: [] };

  const safeCount = Math.max(2, Math.min(60, Math.round(Number(count) || 12)));
  const duration = Math.max(
    Number(sequence.durationSeconds) || 0,
    sequence.frames.at(-1)?.time || 1,
    0.001,
  );

  const frames = Array.from({ length: safeCount }, (_, index) => {
    const normalizedTime = safeCount === 1 ? 0 : index / (safeCount - 1);
    const time = duration * normalizedTime;
    const frame = interpolateFrame(sequence.frames, time);
    return {
      ...frame,
      time: round(time),
      normalizedTime: round(normalizedTime),
    };
  });

  return {
    ...sequence,
    durationSeconds: round(duration),
    frames,
    contacts: normalizeContacts(sequence.contacts, duration),
  };
}

function normalizeFrame(frame, index) {
  const jointsInput = frame?.joints && typeof frame.joints === 'object'
    ? frame.joints
    : {};
  const joints = {};

  for (const [name, value] of Object.entries(jointsInput)) {
    const joint = normalizeJoint(value);
    if (joint) joints[normalizeJointName(name)] = joint;
  }

  const time = Number(frame?.time ?? frame?.timestamp ?? index / 10);
  return {
    time: Number.isFinite(time) ? Math.max(0, time) : index / 10,
    joints,
  };
}

function normalizeJoint(value) {
  if (Array.isArray(value)) {
    const [x, y, confidence = 1] = value.map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, confidence: clamp(confidence, 0, 1) };
  }

  const x = Number(value?.x);
  const y = Number(value?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x,
    y,
    confidence: clamp(Number(value?.confidence ?? value?.score ?? 1), 0, 1),
  };
}

function bodyNormalizeFrame(frame) {
  const joints = frame.joints || {};
  const leftHip = joints.left_hip;
  const rightHip = joints.right_hip;
  const leftShoulder = joints.left_shoulder;
  const rightShoulder = joints.right_shoulder;

  const center = midpoint(leftHip, rightHip)
    || midpoint(leftShoulder, rightShoulder)
    || centroid(Object.values(joints));

  const shoulderCenter = midpoint(leftShoulder, rightShoulder);
  const hipCenter = midpoint(leftHip, rightHip);
  const torso = distance(shoulderCenter, hipCenter);
  const shoulderWidth = distance(leftShoulder, rightShoulder);
  const hipWidth = distance(leftHip, rightHip);
  const scale = firstPositive([torso, shoulderWidth, hipWidth, 1]);

  const normalized = {};
  for (const [name, joint] of Object.entries(joints)) {
    normalized[name] = {
      x: round((joint.x - center.x) / scale),
      y: round((joint.y - center.y) / scale),
      confidence: round(joint.confidence),
    };
  }

  return {
    time: round(frame.time),
    joints: normalized,
  };
}

function interpolateFrame(frames, time) {
  if (time <= frames[0].time) return cloneFrame(frames[0]);
  if (time >= frames.at(-1).time) return cloneFrame(frames.at(-1));

  let rightIndex = 1;
  while (rightIndex < frames.length && frames[rightIndex].time < time) {
    rightIndex += 1;
  }
  const left = frames[rightIndex - 1];
  const right = frames[rightIndex];
  const span = Math.max(0.0001, right.time - left.time);
  const ratio = (time - left.time) / span;
  const names = new Set([
    ...Object.keys(left.joints || {}),
    ...Object.keys(right.joints || {}),
  ]);
  const joints = {};

  for (const name of names) {
    const a = left.joints?.[name];
    const b = right.joints?.[name];
    if (a && b) {
      joints[name] = {
        x: round(a.x + ((b.x - a.x) * ratio)),
        y: round(a.y + ((b.y - a.y) * ratio)),
        confidence: round(Math.min(a.confidence, b.confidence)),
      };
    } else {
      joints[name] = { ...(a || b) };
    }
  }

  return { time, joints };
}

function angleSeries(sequence) {
  const output = {};
  for (const [, , , key] of ANGLE_TRIPLETS) output[key] = [];

  for (const frame of sequence.frames || []) {
    for (const [a, b, c, key] of ANGLE_TRIPLETS) {
      output[key].push(jointAngle(
        frame.joints?.[a],
        frame.joints?.[b],
        frame.joints?.[c],
      ));
    }
  }
  return output;
}

function averageJointAngle(frame, names) {
  const values = [];
  for (const name of names) {
    const triplet = ANGLE_TRIPLETS.find((item) => item[3] === name);
    if (!triplet) continue;
    const [a, b, c] = triplet;
    const value = jointAngle(frame.joints?.[a], frame.joints?.[b], frame.joints?.[c]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values.length ? averageValues(values) : null;
}

function motionEnergySeries(sequence) {
  const values = [];
  const frames = sequence.frames || [];
  for (let index = 1; index < frames.length; index += 1) {
    const prev = frames[index - 1];
    const next = frames[index];
    const movements = [];
    for (const joint of CORE_JOINTS) {
      const a = prev.joints?.[joint];
      const b = next.joints?.[joint];
      if (a && b) movements.push(distance(a, b));
    }
    values.push(movements.length ? averageValues(movements) : 0);
  }
  return values;
}

function compareContacts(reference = [], generated = []) {
  if (!reference.length) return { score: 100, details: 'reference has no contact annotations' };
  if (!generated.length) return { score: 55, details: 'generated pose sequence has no contact annotations' };

  const errors = [];
  let matches = 0;
  for (const ref of reference) {
    const candidates = generated
      .filter((item) => item.type === ref.type)
      .map((item) => Math.abs(
        Number(item.normalizedTime) - Number(ref.normalizedTime),
      ));
    if (!candidates.length) {
      errors.push(1);
      continue;
    }
    matches += 1;
    errors.push(Math.min(...candidates));
  }
  const timingError = averageValues(errors);
  const coveragePenalty = 1 - (matches / reference.length);
  return {
    score: scoreFromError((timingError * 0.7) + (coveragePenalty * 0.3), 0.7),
    details: `${matches}/${reference.length} contact types matched`,
  };
}

function normalizeContacts(input, durationSeconds) {
  if (!Array.isArray(input)) return [];
  const duration = Math.max(0.001, Number(durationSeconds) || 1);
  return input
    .filter((item) => item && (item.type || item.label))
    .map((item) => {
      const time = Number(item.time ?? item.timestamp);
      const normalizedTime = Number.isFinite(Number(item.normalizedTime))
        ? clamp(Number(item.normalizedTime), 0, 1)
        : Number.isFinite(time)
          ? clamp(time / duration, 0, 1)
          : 0;
      return {
        type: String(item.type || item.label).toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
        time: Number.isFinite(time) ? round(time) : round(normalizedTime * duration),
        normalizedTime: round(normalizedTime),
      };
    })
    .slice(0, 32);
}

function jointAngle(a, b, c) {
  if (!a || !b || !c) return null;
  const ab = { x: a.x - b.x, y: a.y - b.y };
  const cb = { x: c.x - b.x, y: c.y - b.y };
  const denominator = Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y);
  if (denominator < 1e-6) return null;
  const cosine = clamp(((ab.x * cb.x) + (ab.y * cb.y)) / denominator, -1, 1);
  return Math.acos(cosine) * (180 / Math.PI);
}

function normalizedSeriesError(a, b) {
  const count = Math.min(a.length, b.length);
  if (!count) return 1;
  const maxA = Math.max(...a, 0.001);
  const maxB = Math.max(...b, 0.001);
  let error = 0;
  for (let index = 0; index < count; index += 1) {
    error += Math.abs((a[index] / maxA) - (b[index] / maxB));
  }
  return error / count;
}

function normalizeJointName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[ -]+/g, '_');
}

function isUsableJoint(joint, minConfidence) {
  return Boolean(
    joint
    && Number.isFinite(joint.x)
    && Number.isFinite(joint.y)
    && Number(joint.confidence ?? 1) >= minConfidence,
  );
}

function midpoint(a, b) {
  if (!a || !b) return null;
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function centroid(points) {
  const usable = points.filter(Boolean);
  if (!usable.length) return { x: 0, y: 0 };
  return {
    x: averageValues(usable.map((point) => point.x)),
    y: averageValues(usable.map((point) => point.y)),
  };
}

function distance(a, b) {
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function firstPositive(values) {
  return values.find((value) => Number.isFinite(value) && value > 1e-6) || 1;
}

function relativeDifference(a, b) {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-6);
}

function scoreFromError(error, maxError) {
  const normalized = clamp(1 - (Number(error) / maxError), 0, 1);
  return Math.round(normalized * 100);
}

function averageValues(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length
    ? usable.reduce((sum, value) => sum + value, 0) / usable.length
    : 0;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? round(value) : null;
}

function cloneFrame(frame) {
  return {
    time: frame.time,
    joints: Object.fromEntries(
      Object.entries(frame.joints || {}).map(([key, value]) => [key, { ...value }]),
    ),
  };
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}
