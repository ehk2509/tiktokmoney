import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveQcApplicability } from '../src/core/qcApplicability.js';

function baseScript(characters) {
  return { characters };
}

test('QC applicability enables visual speech checks for a visible speaker', () => {
  const result = resolveQcApplicability({
    segment: {
      dialogue: 'Visible speech.',
      speakerCharacterId: 'host',
      characterIds: ['host'],
      dialogueTurns: [{ speakerCharacterId: 'host', text: 'Visible speech.' }],
    },
    productionScript: baseScript([
      { id: 'host', onScreen: true },
    ]),
    asset: {},
  });

  assert.equal(result.dialogue.applicable, true);
  assert.equal(result.lipSync.applicable, true);
  assert.equal(result.deepLipSync.applicable, true);
  assert.equal(result.phonemeViseme.applicable, true);
  assert.equal(result.poseMotion.applicable, true);
  assert.equal(result.speakerTurn.applicable, false);
  assert.equal(result.speakerTurn.reason, 'fewer-than-two-visible-speakers');
});

test('QC applicability skips visual speech and pose checks for pure off-screen voiceover', () => {
  const result = resolveQcApplicability({
    segment: {
      dialogue: 'Voiceover line.',
      speakerCharacterId: 'narrator',
      characterIds: ['narrator'],
      dialogueTurns: [{ speakerCharacterId: 'narrator', text: 'Voiceover line.' }],
    },
    productionScript: baseScript([
      { id: 'narrator', onScreen: false },
    ]),
    asset: {},
  });

  assert.equal(result.dialogue.applicable, true);
  assert.equal(result.lipSync.applicable, false);
  assert.equal(result.lipSync.reason, 'offscreen-voiceover');
  assert.equal(result.deepLipSync.reason, 'offscreen-voiceover');
  assert.equal(result.phonemeViseme.reason, 'offscreen-voiceover');
  assert.equal(result.speakerTurn.reason, 'offscreen-voiceover');
  assert.equal(result.poseMotion.applicable, false);
  assert.equal(result.poseMotion.reason, 'no-visible-human');
});

test('QC applicability does not grade a mixed visible plus voiceover track as one visible mouth', () => {
  const result = resolveQcApplicability({
    segment: {
      dialogue: 'Host line. Narrator line.',
      speakerCharacterId: 'host',
      characterIds: ['host'],
      dialogueTurns: [
        { speakerCharacterId: 'host', text: 'Host line.' },
        { speakerCharacterId: 'narrator', text: 'Narrator line.' },
      ],
    },
    productionScript: baseScript([
      { id: 'host', onScreen: true },
      { id: 'narrator', onScreen: false },
    ]),
    asset: {
      dialogueTrack: {
        turns: [
          { speakerCharacterId: 'host', text: 'Host line.' },
          { speakerCharacterId: 'narrator', text: 'Narrator line.' },
        ],
      },
    },
  });

  assert.equal(result.dialogue.applicable, true);
  assert.equal(result.lipSync.applicable, false);
  assert.equal(result.lipSync.reason, 'mixed-visible-and-offscreen-speech');
  assert.equal(result.deepLipSync.reason, 'mixed-visible-and-offscreen-speech');
  assert.equal(result.phonemeViseme.reason, 'mixed-visible-and-offscreen-speech');
  assert.equal(result.speakerTurn.applicable, false);
  assert.equal(result.speakerTurn.reason, 'mixed-visible-and-offscreen-speech');
  assert.equal(result.poseMotion.applicable, true);
});

test('speaker-turn visual QC requires at least two visible speaking characters', () => {
  const result = resolveQcApplicability({
    segment: {
      dialogue: 'A then B.',
      speakerCharacterId: 'a',
      characterIds: ['a', 'b'],
      dialogueTurns: [
        { speakerCharacterId: 'a', text: 'A.' },
        { speakerCharacterId: 'b', text: 'B.' },
      ],
    },
    productionScript: baseScript([
      { id: 'a', onScreen: true },
      { id: 'b', onScreen: true },
    ]),
    asset: {},
  });

  assert.equal(result.speakerTurn.applicable, true);
  assert.equal(result.speakerTurn.visibleSpeakerCount, 2);
});

test('unknown speaker identity blocks visual speech QC instead of assuming visibility', () => {
  const result = resolveQcApplicability({
    segment: {
      dialogue: 'Unknown speaker.',
      speakerCharacterId: 'missing',
      characterIds: ['missing'],
      dialogueTurns: [{ speakerCharacterId: 'missing', text: 'Unknown speaker.' }],
    },
    productionScript: baseScript([]),
    asset: {},
  });

  assert.equal(result.dialogue.applicable, true);
  assert.equal(result.lipSync.applicable, false);
  assert.equal(result.lipSync.reason, 'unknown-speaker');
  assert.deepEqual(result.context.unknownSpeakerIds, ['missing']);
  assert.equal(result.poseMotion.applicable, false);
});
