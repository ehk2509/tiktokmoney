import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterTextArtifactQcProvider } from '../src/providers/openRouterTextArtifactQcProvider.js';
import { AudiovisualPipeline } from '../src/core/audiovisualPipeline.js';

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function providerReturning(content, sampled = []) {
  return new OpenRouterTextArtifactQcProvider({
    apiKey: 'router-key',
    model: 'vision-model',
    frames: 4,
    frameSampler: {
      sampleAt: async (_path, timestamps) => {
        sampled.push(...timestamps);
        return timestamps.map((timestamp, index) => ({
          index,
          timestamp,
          dataUrl: `data:image/jpeg;base64,FRAME${index}`,
        }));
      },
    },
    fetchImpl: async () => jsonResponse({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }),
  });
}

test('generated-text QC rejects frames with model-rendered labels', async () => {
  const sampled = [];
  const provider = providerReturning({
    hasText: true,
    detections: [{ frame: 3, text: 'HEMOCYANIN BR', kind: 'label' }],
  }, sampled);

  const result = await provider.evaluate({ localPath: '/fake/act.mp4', durationSeconds: 8 });

  assert.deepEqual(sampled, [1, 3, 5, 7]);
  assert.equal(result.passed, false);
  assert.equal(result.issues[0].code, 'generated-text');
  assert.equal(result.issues[0].severity, 'critical');
  assert.match(result.issues[0].evidence, /HEMOCYANIN BR/);
  assert.match(result.regenerationGuidance, /no labels/i);
});

test('generated-text QC passes clean footage', async () => {
  const provider = providerReturning({ hasText: false, detections: [] });
  const result = await provider.evaluate({ localPath: '/fake/act.mp4' }, { durationSeconds: 6 });

  assert.equal(result.passed, true);
  assert.deepEqual(result.issues, []);
});

test('audiovisual pipeline regenerates an act when generated text is detected', async () => {
  const regenerations = [];
  let textChecks = 0;
  const pipeline = new AudiovisualPipeline({
    llm: {
      async generateProductionScript() {
        return {
          title: 'Octopus',
          characters: [{
            id: 'narrator',
            name: 'Narrator',
            description: 'Unseen narrator.',
            onScreen: false,
            voice: { presetId: 'Bernard' },
          }],
          segments: [{
            durationSeconds: 6,
            speakerCharacterId: 'narrator',
            dialogue: 'An octopus has three hearts.',
            action: 'An octopus rests on the reef.',
          }],
        };
      },
    },
    audiovisual: {
      async generateSegment({ regeneration }) {
        regenerations.push(regeneration);
        return { type: 'ai-video', localPath: '/fake/act.mp4', generationId: `g${regenerations.length}` };
      },
    },
    renderer: null,
    store: { saveProject: async () => {} },
    textArtifactQc: {
      maxRegenerations: 1,
      async evaluate() {
        textChecks += 1;
        return textChecks === 1
          ? {
            passed: false,
            issues: [{ code: 'generated-text', severity: 'critical', evidence: 'label' }],
            regenerationGuidance: 'Remove every written element from the picture.',
          }
          : { passed: true, issues: [], regenerationGuidance: '' };
      },
    },
  });

  const project = await pipeline.generate({ topic: 'octopus', durationSeconds: 6, render: false });

  assert.equal(project.status, 'READY');
  assert.equal(regenerations.length, 2);
  assert.match(regenerations[1].guidance, /Remove every written element/);
  assert.deepEqual(regenerations[1].triggeredBy, ['textArtifact']);
});
