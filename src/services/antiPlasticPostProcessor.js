export class AntiPlasticPostProcessor {
  constructor({
    enabled = envBool(process.env.ANTI_PLASTIC_POST_ENABLED, true),
    softnessMaxSigma = Number(process.env.ANTI_PLASTIC_SOFTNESS_MAX_SIGMA || 0.35),
    grainMaxStrength = Number(process.env.ANTI_PLASTIC_GRAIN_MAX_STRENGTH || 2.2),
  } = {}) {
    this.enabled = Boolean(enabled);
    this.softnessMaxSigma = clamp(softnessMaxSigma, 0, 1, 0.35);
    this.grainMaxStrength = clamp(grainMaxStrength, 0, 6, 2.2);
  }

  buildVideoFilter({
    baseFilter,
    profile = null,
    frameRate = 30,
    subtitlesFilter = null,
  } = {}) {
    const filters = [baseFilter].filter(Boolean);
    if (this.enabled && profile) {
      const softness = clamp(profile.opticalSoftness, 0, this.softnessMaxSigma, 0);
      const saturation = clamp(profile.saturation, 0.85, 1.05, 0.96);
      const contrast = clamp(profile.contrast, 0.92, 1.06, 0.99);
      const grain = clamp(profile.grainStrength, 0, this.grainMaxStrength, 0);

      if (softness >= 0.05) filters.push(`gblur=sigma=${round(softness)}:steps=1`);
      filters.push(`eq=saturation=${round(saturation)}:contrast=${round(contrast)}`);
      if (grain >= 0.25) {
        filters.push(`noise=alls=${round(grain)}:allf=t+u`);
      }
    }
    if (Number.isFinite(Number(frameRate))) filters.push(`fps=${Math.round(Number(frameRate))}`);
    if (subtitlesFilter) filters.push(subtitlesFilter);
    return filters.join(',');
  }
}

export function shouldApplySyntheticMotionBlur(qc) {
  if (!qc) return false;
  const issues = [
    ...(qc.issues || []),
    ...(qc.temporalIssues || []),
  ];
  const hasMorphing = issues.some((issue) => /morph|anatom|geometry|duplicate|melting/i.test(
    `${issue.code || ''} ${issue.evidence || ''}`,
  ));
  if (hasMorphing) return false;

  return issues.some((issue) => /stutter|judder|frame skip|choppy motion/i.test(
    `${issue.code || ''} ${issue.evidence || ''}`,
  ));
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

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
