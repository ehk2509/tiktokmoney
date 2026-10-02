import { comparePoseSequences } from '../core/poseMotion.js';
import { PoseMotionExtractor } from '../services/poseMotionExtractor.js';

export class PoseMotionQcProvider {
  constructor({
    extractor = new PoseMotionExtractor(),
    threshold = Number(process.env.POSE_MOTION_QC_THRESHOLD || 78),
    minCoverage = Number(process.env.POSE_MOTION_QC_MIN_COVERAGE || 0.55),
    maxRegenerations = Number(process.env.POSE_MOTION_QC_MAX_REGENERATIONS || 1),
    failClosed = envBool(process.env.POSE_MOTION_QC_FAIL_CLOSED, true),
  } = {}) {
    this.extractor = extractor;
    this.threshold = clamp(threshold, 0, 100, 78);
    this.minCoverage = clamp(minCoverage, 0, 1, 0.55);
    this.maxRegenerations = Math.max(0, Math.min(3, Number(maxRegenerations) || 0));
    this.failClosed = Boolean(failClosed);
  }

  get enabled() {
    return Boolean(this.extractor?.available);
  }

  async evaluate(asset, { segment = null } = {}) {
    const motionGuide = asset?.motionGuide;
    if (asset?.motionGuideMode !== 'reference-video' || !motionGuide?.localPath) {
      return {
        enabled: this.enabled,
        applied: false,
        passed: true,
        reason: 'no real-motion guide was applied',
      };
    }

    if (!this.enabled) {
      return {
        enabled: false,
        applied: false,
        passed: true,
        reason: 'pose extractor is not configured for generated video',
      };
    }

    try {
      const reference = await this.extractor.extract(motionGuide.localPath, {
        durationSeconds: motionGuide.selectedReference?.durationSeconds,
        embeddedPoseSequence: motionGuide.selectedReference?.poseSequence || null,
      });
      const generated = await this.extractor.extract(asset.localPath, {
        durationSeconds: Number(segment?.durationSeconds)
          || parseDuration(asset.generatedDuration)
          || null,
      });

      if (!reference.sequence?.frames?.length || !generated.sequence?.frames?.length) {
        throw new Error('pose extractor returned insufficient frames');
      }

      const comparison = comparePoseSequences(reference.sequence, generated.sequence);
      const passed = comparison.overallScore >= this.threshold
        && comparison.coverage >= this.minCoverage;

      return {
        enabled: true,
        applied: true,
        passed,
        threshold: this.threshold,
        minCoverage: this.minCoverage,
        referenceSource: reference.source,
        generatedSource: generated.source,
        referenceExtractor: reference.extractor,
        generatedExtractor: generated.extractor,
        ...comparison,
        regenerationGuidance: passed
          ? ''
          : buildGuidance(comparison),
      };
    } catch (error) {
      return {
        enabled: true,
        applied: true,
        passed: !this.failClosed,
        threshold: this.threshold,
        minCoverage: this.minCoverage,
        error: error.message,
        regenerationGuidance: this.failClosed
          ? 'Regenerate the physical action with clear full-body visibility, stable framing and unobstructed limbs so pose-level motion can be verified.'
          : '',
      };
    }
  }
}

function buildGuidance(comparison) {
  const weak = [
    ['pose trajectory', comparison.poseTrajectoryScore],
    ['body mechanics / joint angles', comparison.bodyMechanicsScore],
    ['timing rhythm', comparison.timingRhythmScore],
    ['contact mechanics', comparison.contactMechanicsScore],
  ]
    .filter(([, score]) => Number(score) < 78)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([name]) => name);

  return [
    `POSE MOTION CORRECTION: improve ${weak.join(', ') || 'pose-level motion fidelity'}.`,
    'Match the normalized real-motion skeleton trajectory rather than the reference performer appearance.',
    'Preserve canonical identity, wardrobe, location, keyframes, dialogue and motion-region locks.',
    'Keep limbs unobstructed enough for stable pose verification and preserve physically plausible contacts/weight transfer.',
  ].join(' ');
}

function parseDuration(value) {
  const match = String(value || '').match(/([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : 0;
}

function envBool(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
