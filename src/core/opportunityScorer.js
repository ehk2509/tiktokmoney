const WEIGHTS = Object.freeze({
  velocity: 0.2,
  acceleration: 0.15,
  audienceFit: 0.15,
  novelty: 0.1,
  contentPotential: 0.15,
  monetization: 0.15,
  feasibility: 0.1,
});

const PENALTIES = Object.freeze({
  saturation: 0.12,
  copyrightRisk: 0.1,
  misinformationRisk: 0.12,
});

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function scoreOpportunity(signal) {
  const positives = Object.entries(WEIGHTS).reduce(
    (sum, [key, weight]) => sum + clamp(signal[key]) * weight,
    0,
  );

  const penalties = Object.entries(PENALTIES).reduce(
    (sum, [key, weight]) => sum + clamp(signal[key]) * weight,
    0,
  );

  return Math.round(clamp(positives - penalties) * 100) / 100;
}

export function rankOpportunities(signals) {
  return signals
    .map((signal) => ({ ...signal, opportunityScore: scoreOpportunity(signal) }))
    .sort((a, b) => b.opportunityScore - a.opportunityScore);
}
