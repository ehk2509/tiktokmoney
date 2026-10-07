import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScoreScale } from '../src/providers/qcScores.js';
import { OpenRouterSpeakerTurnQcProvider } from '../src/providers/openRouterSpeakerTurnQcProvider.js';

test('reviewer scores on 0-10 or 0-1 scales are converted to 0-100', () => {
  assert.deepEqual(normalizeScoreScale(7, { a: 7, b: 6 }), { score: 70, scores: { a: 70, b: 60 }, scaleFactor: 10 });
  assert.deepEqual(normalizeScoreScale(0.9, { a: 0.8 }), { score: 90, scores: { a: 80 }, scaleFactor: 100 });
  assert.deepEqual(normalizeScoreScale(88, { a: 91, b: 7 }), { score: 88, scores: { a: 91, b: 7 }, scaleFactor: 1 });
  assert.equal(normalizeScoreScale(undefined, { a: 8, b: 6 }).score, 70);
});

function speakerTurnReturning(review) {
  return new OpenRouterSpeakerTurnQcProvider({
    apiKey: 'router-key',
    model: 'vision-model',
    frameSampler: {
      sampleAt: async (_path, timestamps) => timestamps.map((timestamp, index) => ({ index, timestamp, dataUrl: 'data:image/jpeg;base64,F' })),
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(review) } }] }),
    }),
  });
}

const turnArgs = {
  dialogueTurns: [
    { turnIndex: 0, speakerCharacterId: 'coach', text: 'Jalen, what do you feel?', start: 0, end: 1.6 },
    { turnIndex: 1, speakerCharacterId: 'jalen', text: 'Pressure.', start: 1.8, end: 3 },
  ],
  characters: [{ id: 'coach', name: 'Coach' }, { id: 'jalen', name: 'Jalen' }],
};

test('a clean speaker-turn review returned on a 0-10 scale passes', async () => {
  const result = await speakerTurnReturning({
    score: 7,
    scores: { speakerAttribution: 7, activeSpeakerMouthMotion: 7, listenerStillness: 7, castIdentityStability: 7, turnTakingClarity: 7 },
    issues: [],
    summary: 'Speaker turns and mouth movements match the audio plan cleanly.',
  }).evaluate({ localPath: '/fake/act.mp4' }, turnArgs);

  assert.equal(result.score, 70);
  assert.equal(result.passed, true);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['speaker-turn-low']);
});

test('speaker-turn still blocks a high-severity attribution defect', async () => {
  const result = await speakerTurnReturning({
    score: 85,
    issues: [{ code: 'wrong-speaker', severity: 'high', evidence: 'Jalen mouths the coach line.' }],
  }).evaluate({ localPath: '/fake/act.mp4' }, turnArgs);

  assert.equal(result.passed, false);
  assert.equal(result.issues[0].code, 'wrong-speaker');
});
