const DEFAULT_WEIGHTS = Object.freeze({
  hookStrength: 0.22,
  retentionPotential: 0.20,
  clarity: 0.13,
  novelty: 0.12,
  productionFeasibility: 0.10,
  monetizationFit: 0.08,
  factualSafety: 0.08,
  platformFit: 0.07,
});

export class CreativeTournament {
  constructor({
    llm,
    enabled = envBool(process.env.CREATIVE_TOURNAMENT_ENABLED, true),
    candidateCount = Number(process.env.CREATIVE_TOURNAMENT_CANDIDATES || 5),
    minWinnerScore = Number(process.env.CREATIVE_TOURNAMENT_MIN_WINNER_SCORE || 68),
    minMargin = Number(process.env.CREATIVE_TOURNAMENT_MIN_MARGIN || 2),
    weights = DEFAULT_WEIGHTS,
    learningService = null,
    maxLearningAdjustment = Number(process.env.CREATIVE_LEARNING_MAX_ADJUSTMENT || 4),
  } = {}) {
    this.llm = llm;
    this.enabled = Boolean(enabled);
    this.candidateCount = clampInt(candidateCount, 2, 8, 5);
    this.minWinnerScore = clampScore(minWinnerScore, 68);
    this.minMargin = Math.max(0, Math.min(20, Number(minMargin) || 0));
    this.weights = normalizeWeights(weights);
    this.learningService = learningService;
    this.maxLearningAdjustment = Math.max(0, Math.min(10, Number(maxLearningAdjustment) || 0));
  }

  async run({
    topic,
    audience,
    durationSeconds,
    researchPacket = null,
    candidateCount = null,
    variantIndex = 0,
  }) {
    if (!this.enabled) {
      return {
        enabled: false,
        skipped: true,
        candidates: [],
        ranking: [],
        winner: null,
        winnerScore: null,
        margin: null,
        judge: null,
      };
    }

    const effectiveCandidateCount = clampInt(
      candidateCount,
      2,
      8,
      this.candidateCount,
    );

    const generated = typeof this.llm?.generateCreativeCandidates === 'function'
      ? await this.llm.generateCreativeCandidates({
        topic,
        audience,
        durationSeconds,
        count: effectiveCandidateCount,
        researchPacket,
        variantIndex,
      })
      : fallbackCandidates({ topic, count: effectiveCandidateCount });

    const candidates = normalizeCandidates(generated?.candidates ?? generated, {
      topic,
      count: effectiveCandidateCount,
    });
    if (candidates.length < 2) {
      throw new Error('creative tournament requires at least two valid candidates');
    }

    const judged = typeof this.llm?.judgeCreativeCandidates === 'function'
      ? await this.llm.judgeCreativeCandidates({
        topic,
        audience,
        durationSeconds,
        candidates: candidates.map(stripInternal),
        researchPacket,
        variantIndex,
      })
      : deterministicJudge(candidates);

    let ranking = rankCandidates({
      candidates,
      judgments: judged?.judgments ?? judged,
      weights: this.weights,
    });
    const performanceEvidence = this.learningService?.contextFor
      ? await this.learningService.contextFor({ topic, audience })
      : null;
    ranking = applyPerformanceEvidence({
      ranking,
      candidates,
      evidence: performanceEvidence,
      maxAdjustment: this.maxLearningAdjustment,
    });
    if (!ranking.length) throw new Error('creative tournament did not produce a ranking');

    const winner = ranking[0];
    const runnerUp = ranking[1] || null;
    const margin = runnerUp ? round(winner.score - runnerUp.score) : winner.score;
    const accepted = winner.score >= this.minWinnerScore;
    const confidence = margin >= this.minMargin ? 'clear' : 'close';

    return {
      enabled: true,
      skipped: false,
      candidateCount: candidates.length,
      requestedCandidateCount: effectiveCandidateCount,
      variantIndex,
      candidates,
      ranking,
      winner: {
        ...candidates.find((candidate) => candidate.id === winner.candidateId),
        score: winner.score,
        scores: winner.scores,
        rationale: winner.rationale,
        strengths: winner.strengths,
        weaknesses: winner.weaknesses,
        redFlags: winner.redFlags,
      },
      winnerScore: winner.score,
      runnerUpScore: runnerUp?.score ?? null,
      margin,
      confidence,
      accepted,
      minimumWinnerScore: this.minWinnerScore,
      minimumMargin: this.minMargin,
      researchEvidenceCount: researchPacket?.evidence?.length || 0,
      judge: {
        source: judged?.source || 'deterministic',
        model: judged?.model || null,
      },
      performanceEvidence,
    };
  }
}

export function rankCandidates({
  candidates,
  judgments,
  weights = DEFAULT_WEIGHTS,
}) {
  const normalizedWeights = normalizeWeights(weights);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const rawJudgments = Array.isArray(judgments) ? judgments : [];
  const seen = new Set();

  const ranking = rawJudgments
    .map((judgment, index) => {
      const candidateId = String(
        judgment?.candidateId || judgment?.id || candidates[index]?.id || '',
      ).trim();
      if (!byId.has(candidateId) || seen.has(candidateId)) return null;
      seen.add(candidateId);

      const scores = normalizeScores(judgment?.scores || judgment);
      const hardReject = Boolean(judgment?.hardReject);
      const weighted = hardReject ? 0 : weightedScore(scores, normalizedWeights);
      return {
        candidateId,
        score: round(weighted),
        scores,
        hardReject,
        rationale: clean(judgment?.rationale, 600),
        strengths: normalizeStrings(judgment?.strengths, 5, 180),
        weaknesses: normalizeStrings(judgment?.weaknesses, 5, 180),
        redFlags: normalizeStrings(judgment?.redFlags, 5, 180),
      };
    })
    .filter(Boolean);

  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    const scores = deterministicScores(candidate);
    ranking.push({
      candidateId: candidate.id,
      score: round(weightedScore(scores, normalizedWeights)),
      scores,
      hardReject: false,
      rationale: 'Fallback deterministic scoring because the judge omitted this candidate.',
      strengths: [],
      weaknesses: [],
      redFlags: [],
    });
  }

  return ranking.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aCandidate = byId.get(a.candidateId);
    const bCandidate = byId.get(b.candidateId);
    return tieBreaker(bCandidate) - tieBreaker(aCandidate);
  });
}

function normalizeCandidates(value, { topic, count }) {
  const list = Array.isArray(value) ? value : [];
  const output = [];
  const ids = new Set();
  const hooks = new Set();

  for (let index = 0; index < list.length && output.length < count; index += 1) {
    const item = list[index];
    if (!item || typeof item !== 'object') continue;

    const hook = clean(item.hook, 320);
    if (!hook) continue;
    const hookKey = hook.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (hooks.has(hookKey)) continue;
    hooks.add(hookKey);

    let id = safeId(item.id || `creative-${index + 1}`);
    if (!id || ids.has(id)) id = `creative-${index + 1}`;
    while (ids.has(id)) id = `${id}-alt`;
    ids.add(id);

    output.push({
      id,
      angle: clean(item.angle || item.concept || `Alternative angle on ${topic}`, 300),
      hook,
      format: clean(item.format || 'direct explainer', 100),
      emotionalDriver: clean(item.emotionalDriver || '', 160),
      retentionDevice: clean(item.retentionDevice || '', 220),
      payoff: clean(item.payoff || '', 320),
      visualOpportunity: clean(item.visualOpportunity || '', 300),
      dialogueStyle: clean(item.dialogueStyle || '', 180),
      monetizationFit: clean(item.monetizationFit || '', 220),
      productionNotes: clean(item.productionNotes || '', 260),
      riskNotes: normalizeStrings(item.riskNotes, 4, 180),
    });
  }

  const fallback = fallbackCandidates({ topic, count });
  for (const candidate of fallback) {
    if (output.length >= count) break;
    if (hooks.has(candidate.hook.toLowerCase())) continue;
    if (ids.has(candidate.id)) continue;
    output.push(candidate);
    hooks.add(candidate.hook.toLowerCase());
    ids.add(candidate.id);
  }

  return output;
}

function deterministicJudge(candidates) {
  return {
    source: 'deterministic',
    model: null,
    judgments: candidates.map((candidate) => ({
      candidateId: candidate.id,
      scores: deterministicScores(candidate),
      rationale: 'Local fallback creative scoring.',
      strengths: [],
      weaknesses: [],
      redFlags: candidate.riskNotes,
    })),
  };
}

function deterministicScores(candidate) {
  const hookWords = wordCount(candidate.hook);
  const hasQuestion = /\?/.test(candidate.hook);
  const hasSpecificity = /\d|because|why|how|instead|but|actually|most|never|first/i.test(candidate.hook);
  const formatBonus = /dialogue|debate|interview|story|experiment|demonstration|reaction/i.test(candidate.format);
  const productionPenalty = /crowd|explosion|many locations|complex stunt|celebrity|copyright/i.test(
    `${candidate.productionNotes} ${candidate.visualOpportunity}`,
  );
  const riskPenalty = candidate.riskNotes.length > 1;

  return {
    hookStrength: clampScore(
      62 + (hookWords >= 5 && hookWords <= 18 ? 12 : 0) + (hasQuestion ? 5 : 0) + (hasSpecificity ? 8 : 0),
      70,
    ),
    retentionPotential: clampScore(
      60 + (candidate.retentionDevice ? 14 : 0) + (candidate.payoff ? 10 : 0) + (formatBonus ? 6 : 0),
      70,
    ),
    clarity: clampScore(
      82 - Math.max(0, hookWords - 20) * 2,
      75,
    ),
    novelty: clampScore(62 + (formatBonus ? 16 : 0) + (candidate.angle ? 6 : 0), 70),
    productionFeasibility: clampScore(88 - (productionPenalty ? 28 : 0), 75),
    monetizationFit: clampScore(65 + (candidate.monetizationFit ? 12 : 0), 70),
    factualSafety: clampScore(90 - (riskPenalty ? 25 : candidate.riskNotes.length ? 10 : 0), 80),
    platformFit: clampScore(78 + (hookWords <= 18 ? 8 : 0) + (formatBonus ? 5 : 0), 78),
  };
}

function fallbackCandidates({ topic, count }) {
  const variants = [
    {
      id: 'mechanism-reveal',
      angle: 'Reveal the hidden mechanism before the consequence.',
      hook: `The part of ${topic} most people miss is the mechanism causing the result.`,
      format: 'direct explainer',
      emotionalDriver: 'curiosity',
      retentionDevice: 'withhold the mechanism for one beat, then demonstrate it',
      payoff: `Show the mechanism and connect it to a recognizable outcome in ${topic}.`,
      visualOpportunity: 'presenter plus concrete demonstration',
      dialogueStyle: 'concise expert explanation',
      monetizationFit: 'evergreen educational format with reusable audience interest',
      productionNotes: 'single presenter, simple real-world locations',
      riskNotes: [],
    },
    {
      id: 'skeptic-expert',
      angle: 'Use a skeptic/expert exchange to surface the viewer objection.',
      hook: `“That sounds wrong.” “It does—until you see what actually happens with ${topic}.”`,
      format: 'two-person dialogue',
      emotionalDriver: 'tension and resolution',
      retentionDevice: 'objection first, evidence/mechanism second',
      payoff: 'resolve the disagreement with one concrete explanation',
      visualOpportunity: 'natural two-person conversation with reaction shots',
      dialogueStyle: 'skeptic vs calm expert',
      monetizationFit: 'conversation format supports retention and repeatable series',
      productionNotes: 'two recurring characters in one stable location',
      riskNotes: [],
    },
    {
      id: 'before-after',
      angle: 'Contrast intuition with the observable result.',
      hook: `Before you assume you understand ${topic}, compare what you expect with what actually happens.`,
      format: 'before/after demonstration',
      emotionalDriver: 'surprise',
      retentionDevice: 'prediction before reveal',
      payoff: 'show why the expectation differs from the result',
      visualOpportunity: 'clear visual contrast or staged demonstration',
      dialogueStyle: 'fast explanatory narration',
      monetizationFit: 'high replay potential when the contrast is visual',
      productionNotes: 'two controlled visual states',
      riskNotes: [],
    },
    {
      id: 'micro-story',
      angle: 'Explain the concept through one believable human situation.',
      hook: `One small decision can make ${topic} look completely different in practice.`,
      format: 'micro-story',
      emotionalDriver: 'identification',
      retentionDevice: 'cause-effect progression through a short scenario',
      payoff: 'connect the character outcome back to the general mechanism',
      visualOpportunity: 'character-driven realistic scene progression',
      dialogueStyle: 'natural conversational story',
      monetizationFit: 'story format broadens audience beyond pure explainers',
      productionNotes: 'one or two characters, limited locations',
      riskNotes: [],
    },
    {
      id: 'three-step',
      angle: 'Turn the topic into a compact three-step causal chain.',
      hook: `If you remember only three steps about ${topic}, make them these.`,
      format: 'three-step explainer',
      emotionalDriver: 'utility',
      retentionDevice: 'numbered open loop until step three',
      payoff: 'step three resolves why the first two matter',
      visualOpportunity: 'three distinct but continuous visual beats',
      dialogueStyle: 'precise instructional delivery',
      monetizationFit: 'saveable evergreen utility content',
      productionNotes: 'simple visual staging and captions',
      riskNotes: [],
    },
  ];
  return variants.slice(0, count);
}

function normalizeScores(value) {
  const scores = {};
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    scores[key] = clampScore(value?.[key], deterministicScoreDefault(key));
  }
  return scores;
}

function deterministicScoreDefault(key) {
  return key === 'factualSafety' || key === 'productionFeasibility' ? 80 : 70;
}

function weightedScore(scores, weights) {
  return Object.entries(weights)
    .reduce((total, [key, weight]) => total + scores[key] * weight, 0);
}

function normalizeWeights(weights) {
  const source = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const positive = Object.fromEntries(
    Object.entries(DEFAULT_WEIGHTS).map(([key]) => [
      key,
      Math.max(0, Number(source[key]) || 0),
    ]),
  );
  const total = Object.values(positive).reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries(
    Object.entries(positive).map(([key, value]) => [key, value / total]),
  );
}

function tieBreaker(candidate) {
  if (!candidate) return 0;
  return (
    (candidate.retentionDevice ? 3 : 0)
    + (candidate.visualOpportunity ? 2 : 0)
    + (candidate.riskNotes?.length ? -2 : 0)
  );
}

function stripInternal(candidate) {
  return {
    id: candidate.id,
    angle: candidate.angle,
    hook: candidate.hook,
    format: candidate.format,
    emotionalDriver: candidate.emotionalDriver,
    retentionDevice: candidate.retentionDevice,
    payoff: candidate.payoff,
    visualOpportunity: candidate.visualOpportunity,
    dialogueStyle: candidate.dialogueStyle,
    monetizationFit: candidate.monetizationFit,
    productionNotes: candidate.productionNotes,
    riskNotes: candidate.riskNotes,
  };
}

function normalizeStrings(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => clean(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function wordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function safeId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function clean(value, max = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function clampScore(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.max(0, Math.min(100, number)) * 100) / 100;
}

function envBool(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}


export function applyPerformanceEvidence({
  ranking,
  candidates,
  evidence,
  maxAdjustment = 4,
}) {
  if (!evidence || !Array.isArray(ranking) || !ranking.length) return ranking;
  const byId = new Map((candidates || []).map((candidate) => [candidate.id, candidate]));
  const eligibleScores = [];

  for (const bucket of [evidence.format, evidence.emotionalDriver]) {
    for (const item of Object.values(bucket || {})) {
      if (item?.eligible && Number.isFinite(Number(item.score))) eligibleScores.push(Number(item.score));
    }
  }
  if (!eligibleScores.length) return ranking;

  const baseline = eligibleScores.reduce((sum, value) => sum + value, 0) / eligibleScores.length;
  const cap = Math.max(0, Math.min(10, Number(maxAdjustment) || 0));

  return ranking
    .map((row) => {
      const candidate = byId.get(row.candidateId);
      if (!candidate) return row;
      const signals = [
        evidence.format?.[String(candidate.format || '').trim().toLowerCase()],
        evidence.emotionalDriver?.[String(candidate.emotionalDriver || '').trim().toLowerCase()],
      ].filter((item) => item?.eligible && Number.isFinite(Number(item.score)));

      if (!signals.length || cap === 0) {
        return { ...row, baseScore: row.score, learningAdjustment: 0 };
      }

      const mean = signals.reduce((sum, item) => sum + Number(item.score), 0) / signals.length;
      const adjustment = Math.max(-cap, Math.min(cap, (mean - baseline) * 1.5));
      return {
        ...row,
        baseScore: row.score,
        learningAdjustment: round(adjustment),
        score: round(row.score + adjustment),
      };
    })
    .sort((a, b) => b.score - a.score);
}
