import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveQcApplicability } from '../src/core/qcApplicability.js';
import { AudiovisualPipeline } from '../src/core/audiovisualPipeline.js';
import { TemplateLlmProvider } from '../src/providers.js';

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
  assert.equal(result.poseMotion.applicable, false);
  assert.equal(result.poseMotion.reason, 'no-motion-reference');
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
          { speakerCharacterId: 'host', text: 'Host line.', start: 0, end: 1 },
          { speakerCharacterId: 'narrator', text: 'Narrator line.', start: 1.2, end: 2.2 },
        ],
      },
      motionGuideMode: 'reference-video',
      motionGuide: { localPath: '/tmp/reference.mp4' },
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
    asset: {
      dialogueTrack: {
        turns: [
          { speakerCharacterId: 'a', text: 'A.', start: 0, end: 1 },
          { speakerCharacterId: 'b', text: 'B.', start: 1.2, end: 2.2 },
        ],
      },
    },
  });

  assert.equal(result.speakerTurn.applicable, true);
  assert.equal(result.speakerTurn.visibleSpeakerCount, 2);
  assert.equal(result.speakerTurn.timedVisibleSpeakerCount, 2);
});

test('speaker-turn visual QC stays inapplicable until timed turns exist', () => {
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

  assert.equal(result.speakerTurn.applicable, false);
  assert.equal(result.speakerTurn.reason, 'speaker-turn-timing-missing');
  assert.equal(result.speakerTurn.timedTurnCount, 0);
});

test('pose QC requires an applied real-motion reference', () => {
  const input = {
    segment: {
      dialogue: 'Move naturally.',
      speakerCharacterId: 'host',
      characterIds: ['host'],
      dialogueTurns: [{ speakerCharacterId: 'host', text: 'Move naturally.' }],
    },
    productionScript: baseScript([{ id: 'host', onScreen: true }]),
  };

  const withoutReference = resolveQcApplicability({ ...input, asset: {} });
  assert.equal(withoutReference.poseMotion.applicable, false);
  assert.equal(withoutReference.poseMotion.reason, 'no-motion-reference');

  const withReference = resolveQcApplicability({
    ...input,
    asset: {
      motionGuideMode: 'reference-video',
      motionGuide: { localPath: '/tmp/motion-reference.mp4' },
    },
  });
  assert.equal(withReference.poseMotion.applicable, true);
  assert.equal(withReference.context.hasMotionReference, true);
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


test('inapplicable QC modules do not grant extra regeneration attempts', async () => {
  let generations = 0;
  const audiovisual = {
    async generateSegment({ segment }) {
      generations += 1;
      return {
        type: 'ai-video',
        localPath: `/fake/applicability-${segment.index}-${generations}.mp4`,
        generationId: `applicability-${segment.index}-${generations}`,
        prompt: segment.dialogue,
      };
    },
  };
  const realismQc = {
    maxRegenerations: 0,
    async evaluateScene() {
      return {
        passed: false,
        issues: [{ code: 'realism-failure', severity: 'high', evidence: 'test failure' }],
        regenerationGuidance: 'Do not retry: realism has no retry budget.',
      };
    },
  };
  const speakerTurnQc = {
    maxRegenerations: 3,
    async evaluate() {
      throw new Error('speaker-turn QC must be inapplicable without timed multi-speaker turns');
    },
  };
  const poseMotionQc = {
    maxRegenerations: 3,
    async evaluate() {
      throw new Error('pose QC must be inapplicable without an applied motion reference');
    },
  };

  const pipeline = new AudiovisualPipeline({
    llm: new TemplateLlmProvider(),
    audiovisual,
    renderer: null,
    store: { saveProject: async () => {} },
    realismQc,
    speakerTurnQc,
    poseMotionQc,
  });

  const project = await pipeline.generate({
    topic: 'retry applicability contract',
    durationSeconds: 20,
    render: false,
  });

  assert.equal(project.status, 'AUDIOVISUAL_QC_FAILED');
  assert.equal(generations, 1);
  assert.equal(project.scenes[0].visualQcHistory[0].retryBudget, 0);
  assert.equal(project.scenes[0].qcApplicability.poseMotion.reason, 'no-motion-reference');
});


test('each QC stage keeps its own retry allowance after another stage already retried', async () => {
  let generations = 0;
  let realismCalls = 0;
  let dialogueCalls = 0;
  const llm = {
    async generateProductionScript() {
      return {
        title: 'Sequential QC retries',
        characters: [{
          id: 'host',
          name: 'Host',
          description: 'Visible presenter.',
          physicalTraits: 'Natural appearance.',
          wardrobe: 'Neutral shirt.',
          voice: { presetId: 'Bernard', languageCode: 'en' },
        }],
        locations: [{
          id: 'room',
          name: 'Room',
          description: 'Simple room.',
          lighting: 'Daylight.',
          fixedElements: ['table'],
        }],
        visualStyle: {
          description: 'Photorealistic.',
          cameraRules: 'Stable camera.',
          lightingRules: 'Natural light.',
        },
        audioDirection: {
          mix: 'Clear dialogue.',
          musicPolicy: 'No music.',
        },
        segments: [{
          durationSeconds: 6,
          purpose: 'hook',
          speakerCharacterId: 'host',
          characterIds: ['host'],
          locationId: 'room',
          dialogue: 'A short exact line.',
          dialogueTurns: [{ speakerCharacterId: 'host', text: 'A short exact line.' }],
          action: 'Host speaks to camera.',
          camera: 'Medium close-up.',
          ambience: 'Quiet room.',
          soundEffects: [],
          music: '',
        }],
      };
    },
  };
  const audiovisual = {
    async generateSegment({ segment, regeneration }) {
      generations += 1;
      return {
        type: 'ai-video',
        localPath: `/fake/sequential-${generations}.mp4`,
        generationId: `sequential-${generations}`,
        prompt: segment.dialogue,
        regeneration,
      };
    },
  };
  const realismQc = {
    maxRegenerations: 1,
    async evaluateScene() {
      realismCalls += 1;
      return realismCalls === 1
        ? {
          passed: false,
          issues: [{ code: 'realism', severity: 'high', evidence: 'first attempt' }],
          regenerationGuidance: 'Fix realism.',
        }
        : { passed: true, issues: [], regenerationGuidance: '' };
    },
  };
  const dialogueQc = {
    maxRegenerations: 1,
    async evaluate() {
      dialogueCalls += 1;
      return dialogueCalls === 2
        ? {
          passed: false,
          issues: [{ code: 'dialogue', severity: 'high', evidence: 'second attempt' }],
          regenerationGuidance: 'Fix dialogue.',
          transcription: { text: 'wrong', words: [] },
        }
        : {
          passed: true,
          issues: [],
          regenerationGuidance: '',
          transcription: { text: 'A short exact line.', words: [] },
        };
    },
  };

  const pipeline = new AudiovisualPipeline({
    llm,
    audiovisual,
    renderer: null,
    store: { saveProject: async () => {} },
    realismQc,
    dialogueQc,
  });
  const project = await pipeline.generate({
    topic: 'sequential retry accounting',
    durationSeconds: 6,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.equal(generations, 3);
  assert.equal(project.scenes[0].visualQcHistory.length, 3);
  assert.deepEqual(project.scenes[0].visualQcHistory[0].retryUsage, {
    realism: 0,
    dialogue: 0,
    lipSync: 0,
    deepLipSync: 0,
    phonemeViseme: 0,
    speakerTurn: 0,
    poseMotion: 0,
  });
  assert.deepEqual(project.scenes[0].asset.qc.retryUsage, {
    realism: 1,
    dialogue: 1,
    lipSync: 0,
    deepLipSync: 0,
    phonemeViseme: 0,
    speakerTurn: 0,
    poseMotion: 0,
  });
});
