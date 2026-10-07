/**
 * Vision reviewers sometimes answer on a 0-1 or 0-10 scale even when asked for
 * 0-100 (a clean 7/10 was read as 7/100 and rejected). Detect the scale from the
 * full set of returned numbers and convert every score to 0-100.
 *
 * Verdicts stay safe if a genuinely terrible 0-100 review were mis-scaled: real
 * failures carry high/critical issues, which block regardless of the score.
 */
export function normalizeScoreScale(score, scores = {}) {
  const values = [score, ...Object.values(scores)]
    .map(Number)
    .filter((value) => Number.isFinite(value));
  const max = values.length ? Math.max(...values) : 0;
  const factor = max > 0 && max <= 1 ? 100 : max > 1 && max <= 10 ? 10 : 1;
  const scale = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.round(Math.max(0, Math.min(100, number * factor)) * 100) / 100;
  };
  const normalizedScores = Object.fromEntries(
    Object.entries(scores).map(([key, value]) => [key, scale(value)]),
  );
  const normalizedScore = Number.isFinite(Number(score))
    ? scale(score)
    : average(Object.values(normalizedScores));
  return { score: normalizedScore, scores: normalizedScores, scaleFactor: factor };
}

export const SCORE_SCALE_INSTRUCTION = 'All scores are integers from 0 to 100 (not 0-10 and not 0-1), where 100 is flawless.';

function average(values) {
  const valid = values.filter((value) => Number.isFinite(Number(value)));
  if (!valid.length) return 0;
  return Math.round((valid.reduce((sum, value) => sum + Number(value), 0) / valid.length) * 100) / 100;
}
