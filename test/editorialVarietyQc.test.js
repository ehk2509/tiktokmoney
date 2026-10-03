import test from 'node:test';
import assert from 'node:assert/strict';

import { OpenRouterEditorialVarietyQcProvider } from '../src/providers/openRouterEditorialVarietyQcProvider.js';
import { AudiovisualPipeline } from '../src/core/audiovisualPipeline.js';
import { evaluateAudiovisualPublishability } from '../src/core/publishabilityGate.js';

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function makeProvider(content, prompts = []) {
  return new OpenRouterEditorialVarietyQcProvider({
    apiKey: 'router-key',
    model: 'vision-model',
    threshold: 80,
    maxRegenerations: 1,
    frameSampler: {
      async sampleAt(_path, timestamps) {
        return timestamps.map((timestamp, index) => ({
          index,
          timestamp,
          dataUrl: `data:image/jpeg;base64,F${index}`,
        }));
      },
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      prompts.push(body.messages[1].content[0].text);
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { input_tokens: 200, output_tokens: 60 },
      });
    },
  });
}

test('editorial variety QC fails when a planned close-up still looks like the previous wide composition', async () => {
  const prompts = [];
  const provider = makeProvider({
    score: 58,
    scores: {
      shotTypeAdherence: 45,
      compositionDifference: 55,
      scaleOrAngleDifference: 48,
      editorialNovelty: 62,
    },
    issues: [{
      code: 'repeated-framing',
      severity: 'high',
      evidence: 'The apparatus remains the same size and position in both acts.',
    }],
    summary: 'The second act repeats the previous composition.',
    regenerationGuidance: 'Move much closer and isolate the wing mechanism.',
  }, prompts);

  const result = await provider.evaluate(
    { localPath: '/fake/current.mp4', durationSeconds: 6 },
    {
      segment: {
        shotType: 'close-up',
        camera: 'Close view of the wing.',
        action: 'Show airflow separation.',
        durationSeconds: 6,
      },
      previousAsset: { localPath: '/fake/previous.mp4', durationSeconds: 6 },
      previousSegment: {
        shotType: 'wide-establishing',
        camera: 'Wide view of the full wind tunnel.',
        durationSeconds: 6,
      },
    },
  );

  assert.equal(result.passed, false);
  assert.equal(result.score, 58);
  assert.equal(result.issues[0].code, 'repeated-framing');
  assert.match(result.regenerationGuidance, /Move much closer/i);
  assert.match(prompts[0], /CURRENT required shot type: close-up/i);
  assert.match(prompts[0], /PREVIOUS shot type: wide-establishing/i);
});

test('editorial variety QC skips the first act because there is no previous composition', async () => {
  const provider = makeProvider({});
  const result = await provider.evaluate(
    { localPath: '/fake/first.mp4', durationSeconds: 6 },
    {
      segment: { shotType: 'wide-establishing', durationSeconds: 6 },
      previousAsset: null,
      previousSegment: null,
    },
  );

  assert.equal(result.passed, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'first-act-or-no-previous-asset');
});

test('audiovisual pipeline regenerates only the redundant second act', async () => {
  const generated = [];
  let varietyCalls = 0;
  const pipeline = new AudiovisualPipeline({
    llm: {
      async generateProductionScript() {
        return {
          title: 'Wing stall',
          characters: [{
            id: 'narrator',
            name: 'Narrator',
            description: 'Unseen narrator.',
            onScreen: false,
            voice: { presetId: 'Bernard' },
          }],
          segments: [
            {
              durationSeconds: 5,
              purpose: 'hook',
              speakerCharacterId: 'narrator',
              dialogue: 'Watch the airflow cling to the wing.',
              action: 'Show the complete wind tunnel apparatus.',
              shotType: 'wide-establishing',
            },
            {
              durationSeconds: 5,
              purpose: 'explain',
              speakerCharacterId: 'narrator',
              dialogue: 'Now the airflow separates.',
              action: 'Show separation over the upper wing surface.',
              shotType: 'macro-detail',
            },
          ],
        };
      },
    },
    audiovisual: {
      async generateSegment({ segment, regeneration }) {
        generated.push({ index: segment.index, regeneration });
        return {
          type: 'ai-video',
          localPath: `/fake/scene-${segment.index}-${generated.length}.mp4`,
          generationId: `g-${segment.index}-${generated.length}`,
          durationSeconds: segment.durationSeconds,
        };
      },
    },
    renderer: null,
    store: { saveProject: async () => {} },
    editorialVarietyQc: {
      maxRegenerations: 1,
      async evaluate(_asset, { segment, previousAsset }) {
        if (!previousAsset) {
          return { passed: true, skipped: true, score: null, issues: [], regenerationGuidance: '' };
        }
        varietyCalls += 1;
        return varietyCalls === 1
          ? {
            passed: false,
            score: 52,
            issues: [{ code: 'repeated-framing', severity: 'high', evidence: 'Same wide composition.' }],
            regenerationGuidance: 'Use a true macro detail and exclude most of the apparatus.',
          }
          : {
            passed: true,
            score: 91,
            issues: [],
            regenerationGuidance: '',
          };
      },
    },
  });

  const project = await pipeline.generate({
    topic: 'why wings stall',
    durationSeconds: 10,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.deepEqual(generated.map((item) => item.index), [0, 1, 1]);
  assert.deepEqual(generated[2].regeneration.triggeredBy, ['editorialVariety']);
  assert.match(generated[2].regeneration.guidance, /macro detail/i);
  assert.equal(project.scenes[1].editorialVarietyQc.score, 91);
});

test('publishability exposes an unresolved repeated-framing failure', () => {
  const result = evaluateAudiovisualPublishability({
    productionScript: {
      fullDialogue: 'One. Two.',
      segments: [
        { index: 0, locationId: 'lab' },
        { index: 1, locationId: 'lab' },
      ],
    },
    scenes: [
      { index: 0, asset: { localPath: '/fake/a.mp4' }, visualQcHistory: [] },
      {
        index: 1,
        asset: { localPath: '/fake/b.mp4' },
        visualQcHistory: [],
        editorialVarietyQc: { passed: false },
      },
    ],
  });

  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((item) => item.code === 'editorial-variety'));
});

test('a low variety score without a concrete framing defect passes with a warning', async () => {
  const provider = makeProvider({
    score: 67,
    scores: { shotTypeAdherence: 70, compositionDifference: 65, scaleOrAngleDifference: 65, editorialNovelty: 68 },
    issues: [{ code: 'tight-start', severity: 'low', evidence: 'Opening could be slightly wider.' }],
    summary: 'The act executes a distinct side tracking move.',
    regenerationGuidance: 'Consider widening the initial framing.',
  }, []);

  const result = await provider.evaluate(
    { localPath: '/fake/current.mp4', durationSeconds: 8 },
    {
      segment: { shotType: 'tracking', camera: 'Side tracking.', action: 'Track along the wing.', durationSeconds: 8 },
      previousAsset: { localPath: '/fake/previous.mp4', durationSeconds: 7 },
      previousSegment: { shotType: 'macro-detail', camera: 'Macro push-in.', durationSeconds: 7 },
    },
  );

  assert.equal(result.passed, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['tight-start', 'editorial-variety-low']);
  assert.equal(result.regenerationGuidance, '');

  const gate = evaluateAudiovisualPublishability({
    productionScript: { segments: [] },
    scenes: [{ index: 1, editorialVarietyQc: result }],
    subtitles: null,
  });
  assert.ok(gate.warnings.some((warning) => warning.code === 'qc-warnings'));
});
