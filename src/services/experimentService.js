export class ExperimentService {
  constructor({ store } = {}) {
    if (!store) throw new Error('experiment service requires a performance store');
    this.store = store;
  }

  async evaluate(experimentId) {
    const outcomes = (await this.store.listOutcomes({ limit: 5000 }))
      .filter((item) => item.experiment?.id === experimentId);
    if (!outcomes.length) return null;

    const config = outcomes[0].experiment;
    const targetHours = Number(config.observationWindowHours) || 24;
    const toleranceHours = Number(config.comparisonToleranceHours) || 3;
    const arms = [...new Set(outcomes.map((item) => item.experiment?.arm).filter(Boolean))];
    if (arms.length < 2) {
      return pending(experimentId, 'requires at least two experiment arms', arms, targetHours, toleranceHours);
    }

    const selected = [];
    for (const arm of arms) {
      const candidates = outcomes
        .filter((item) => item.experiment?.arm === arm)
        .filter((item) => Number.isFinite(Number(item.observation?.ageHours)))
        .filter((item) => Number(item.observation.ageHours) >= targetHours)
        .sort((a, b) => (
          Math.abs(Number(a.observation.ageHours) - targetHours)
          - Math.abs(Number(b.observation.ageHours) - targetHours)
        ));
      if (!candidates.length) {
        return pending(experimentId, `arm ${arm} has no mature snapshot`, arms, targetHours, toleranceHours);
      }
      selected.push(candidates[0]);
    }

    const ages = selected.map((item) => Number(item.observation.ageHours));
    if (Math.max(...ages) - Math.min(...ages) > toleranceHours) {
      return pending(experimentId, 'mature snapshots are outside comparison tolerance', arms, targetHours, toleranceHours);
    }

    const ranking = selected
      .map((item) => ({
        arm: item.experiment.arm,
        projectId: item.projectId,
        publicationId: item.publicationId,
        outcomeId: item.id,
        ageHours: item.observation.ageHours,
        viewCount: Number(item.metrics?.viewCount) || 0,
        engagementRate: Number(item.metrics?.engagementRate) || 0,
        score: outcomeScore(item),
      }))
      .sort((a, b) => b.score - a.score);

    const result = {
      id: experimentId,
      status: 'COMPLETED',
      evaluatedAt: new Date().toISOString(),
      observationWindowHours: targetHours,
      comparisonToleranceHours: toleranceHours,
      arms: ranking,
      winner: ranking[0],
      margin: round(ranking[0].score - ranking[1].score, 6),
    };

    const selectedIds = new Set(selected.map((item) => item.id));
    for (const outcome of outcomes) {
      outcome.experiment.learningEligible = selectedIds.has(outcome.id);
      outcome.experiment.result = selectedIds.has(outcome.id) ? result : null;
      await this.store.saveOutcome(outcome);
    }

    return result;
  }

  async list() {
    const outcomes = await this.store.listOutcomes({ limit: 5000 });
    const ids = [...new Set(outcomes.map((item) => item.experiment?.id).filter(Boolean))];
    const results = [];
    for (const id of ids) results.push(await this.evaluate(id));
    return results.filter(Boolean);
  }
}

function pending(id, reason, arms, observationWindowHours, comparisonToleranceHours) {
  return {
    id,
    status: 'PENDING',
    reason,
    arms,
    observationWindowHours,
    comparisonToleranceHours,
  };
}

function outcomeScore(outcome) {
  const views = Number(outcome.metrics?.viewCount) || 0;
  const engagementRate = Number(outcome.metrics?.engagementRate) || 0;
  return round(Math.log10(1 + views) + Math.min(0.25, engagementRate) * 8, 6);
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}
