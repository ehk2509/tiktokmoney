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

test('multi-speaker acts attribute each transcribed word to its own speaker', async () => {
  const { assignSpeakers } = await import('../src/providers/openRouterLipSyncQcProvider.js');
  const words = ['Jalen,', 'what', 'do', 'you', 'feel?', 'Pressure.', 'Every', 'eye', 'waits']
    .map((word, index) => ({ word, start: index * 0.4, end: index * 0.4 + 0.3 }));
  const { words: labelled, cast } = assignSpeakers(words, [
    { speakerCharacterId: 'coach', text: 'Jalen, what do you feel?' },
    { speakerCharacterId: 'jalen', text: 'Pressure. Every eye waits for me to fail.' },
  ], [
    { id: 'coach', name: 'Coach Rivera', description: 'Head coach' },
    { id: 'jalen', name: 'Jalen', description: 'Seated guard' },
  ]);

  assert.deepEqual(cast.map((member) => member.label), ['Coach Rivera', 'Jalen']);
  assert.deepEqual(labelled.map((word) => word.speaker), [
    'Coach Rivera', 'Coach Rivera', 'Coach Rivera', 'Coach Rivera', 'Coach Rivera',
    'Jalen', 'Jalen', 'Jalen', 'Jalen',
  ]);
});

test('lip-sync prompt names the active speaker on each speech frame', async () => {
  let prompt = '';
  const provider = new OpenRouterLipSyncQcProvider({
    apiKey: 'router-key',
    model: 'vision-model',
    frameSampler: {
      sampleAt: async (_path, timestamps) => timestamps.map((timestamp, index) => ({ index, timestamp, dataUrl: 'data:image/jpeg;base64,F' })),
    },
    fetchImpl: async (_url, options) => {
      prompt = JSON.parse(options.body).messages[1].content.map((part) => part.text || '').join('\n');
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"score":82,"issues":[]}' } }] }) };
    },
  });
  await provider.evaluate({ localPath: '/fake/act.mp4' }, {
    transcription: {
      text: 'Jalen, what do you feel? Pressure.',
      duration: 5,
      words: [
        { word: 'Jalen,', start: 0.4, end: 0.8 },
        { word: 'feel?', start: 0.9, end: 1.3 },
        { word: 'Pressure.', start: 2.4, end: 3.0 },
      ],
    },
    turns: [
      { speakerCharacterId: 'coach', text: 'Jalen, feel?' },
      { speakerCharacterId: 'jalen', text: 'Pressure.' },
    ],
    characters: [{ id: 'coach', name: 'Coach Rivera' }, { id: 'jalen', name: 'Jalen' }],
  });

  assert.match(prompt, /Speakers, in order: Coach Rivera = .* \| Jalen = /);
  assert.match(prompt, /SPEECH ACTIVE by Coach Rivera around word "Jalen,"/);
  assert.match(prompt, /SPEECH ACTIVE by Jalen around word "Pressure\."/);
});
