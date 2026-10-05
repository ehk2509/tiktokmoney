import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterLipSyncQcProvider, lipContactSounds } from '../src/providers/openRouterLipSyncQcProvider.js';

function providerReturning(review) {
  return new OpenRouterLipSyncQcProvider({
    apiKey: 'router-key',
    model: 'vision-model',
    frameSampler: {
      sampleAt: async (_path, timestamps) => timestamps.map((timestamp, index) => ({
        index,
        timestamp,
        dataUrl: `data:image/jpeg;base64,F${index}`,
      })),
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(review) } }] }),
    }),
  });
}

const transcription = {
  text: 'I fear one mistake could erase everything.',
  duration: 6,
  words: [
    { word: 'I', start: 0.5, end: 0.7 },
    { word: 'fear', start: 0.7, end: 1.1 },
    { word: 'one', start: 1.1, end: 1.4 },
    { word: 'mistake', start: 1.4, end: 2.0 },
    { word: 'could', start: 2.0, end: 2.3 },
    { word: 'erase', start: 2.3, end: 2.8 },
    { word: 'everything', start: 2.8, end: 3.6 },
  ],
};

async function evaluate(review) {
  return providerReturning(review).evaluate({ localPath: '/fake/act.mp4' }, { transcription });
}

test('a single-frame timing note with a middling score passes with warnings', async () => {
  const result = await evaluate({
    score: 70,
    issues: [{ code: 'under-articulation', severity: 'high', frames: [3], evidence: 'Closed lips on one frame.' }],
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['under-articulation', 'lip-sync-low']);
  assert.equal(result.regenerationGuidance, '');
});

test('a timing defect that persists across frames still regenerates', async () => {
  const result = await evaluate({
    score: 72,
    issues: [{ code: 'frozen-mouth', severity: 'high', frames: [2, 3, 4], evidence: 'Mouth closed for the whole line.' }],
  });
  assert.equal(result.passed, false);
  assert.equal(result.issues[0].code, 'frozen-mouth');
});

test('non-timing defects such as morphing block even on one frame', async () => {
  const result = await evaluate({
    score: 78,
    issues: [{ code: 'face-morphing', severity: 'high', frames: [6], evidence: 'Jaw melts.' }],
  });
  assert.equal(result.passed, false);
});

test('clearly broken sync below the hard floor regenerates without a named issue', async () => {
  const result = await evaluate({ score: 41, issues: [] });
  assert.equal(result.passed, false);
  assert.equal(result.issues[0].code, 'lip-sync-score-floor');
});

test('lip-contact sounds are identified for the reviewer', () => {
  assert.equal(lipContactSounds('mistake'), 'm/b/p lip closure');
  assert.equal(lipContactSounds('fear'), 'f/v lip-teeth contact');
  assert.equal(lipContactSounds('could'), '');
});
