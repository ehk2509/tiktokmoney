import test from 'node:test';
import assert from 'node:assert/strict';

import { OpenRouterVisualFactualQcProvider } from '../src/providers/openRouterVisualFactualQcProvider.js';
import { AudiovisualPipeline } from '../src/core/audiovisualPipeline.js';
import { evaluateAudiovisualPublishability } from '../src/core/publishabilityGate.js';

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function providerReturning(content, { sampled = [], requestBodies = [] } = {}) {
  return new OpenRouterVisualFactualQcProvider({
    apiKey: 'router-key',
    model: 'vision-model',
    frames: 5,
    threshold: 82,
    minBlockingConfidence: 0.85,
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
    fetchImpl: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { input_tokens: 321, output_tokens: 87 },
      });
    },
  });
}

test('visual factual QC rejects a high-confidence contradiction in an educational depiction', async () => {
  const sampled = [];
  const requests = [];
  const provider = providerReturning({
    applicable: true,
    uncertain: false,
    score: 54,
    contradictions: [{
      frame: 3,
      claim: 'An octopus has three hearts.',
      evidence: 'The anatomical cutaway visibly presents four distinct heart-like chambers as the complete heart set.',
      severity: 'critical',
      confidence: 0.97,
    }],
    summary: 'The diagram contradicts the narrated organ count.',
  }, { sampled, requestBodies: requests });

  const result = await provider.evaluate(
    { localPath: '/fake/octopus.mp4', durationSeconds: 10 },
    {
      narration: 'An octopus has three hearts.',
      action: 'A transparent anatomical cutaway reveals the circulatory system.',
      purpose: 'explain',
      onScreenLabels: [{ text: 'Three hearts' }],
    },
  );

  assert.deepEqual(sampled, [1, 3, 5, 7, 9]);
  assert.equal(result.passed, false);
  assert.equal(result.applicable, true);
  assert.equal(result.score, 54);
  assert.equal(result.issues[0].code, 'visual-factual-contradiction');
  assert.equal(result.issues[0].severity, 'critical');
  assert.match(result.issues[0].evidence, /four distinct heart-like chambers/i);
  assert.match(result.regenerationGuidance, /simpler/i);

  const prompt = requests[0].messages[1].content[0].text;
  assert.match(prompt, /An octopus has three hearts/);
  assert.match(prompt, /anatomical cutaway/i);
  assert.match(prompt, /ambiguous/i);
});

test('visual factual QC passes ambiguous or generic footage without pretending it verified the claim', async () => {
  const provider = providerReturning({
    applicable: false,
    uncertain: true,
    score: 100,
    contradictions: [],
    summary: 'The frames show generic octopus B-roll and do not visualize the internal anatomy claim.',
  });

  const result = await provider.evaluate(
    { localPath: '/fake/broll.mp4', durationSeconds: 8 },
    {
      narration: 'An octopus has three hearts.',
      action: 'An octopus swims over a reef.',
    },
  );

  assert.equal(result.passed, true);
  assert.equal(result.skipped, true);
  assert.equal(result.applicable, false);
  assert.equal(result.uncertain, true);
  assert.equal(result.score, null);
  assert.deepEqual(result.issues, []);
});

test('visual factual QC treats a low score with no contradictions as a warning only', async () => {
  const provider = providerReturning({
    applicable: true,
    uncertain: false,
    score: 72,
    contradictions: [],
    summary: 'The clip shows smoke streamlines adhering smoothly to the upper surface of the airfoil. The narration previews what breaks when angle increases, which is not shown yet.',
  });

  const result = await provider.evaluate(
    { localPath: '/fake/airfoil.mp4', durationSeconds: 6 },
    {
      narration: 'Watch this airflow cling to the wing—then see what breaks when angle increases.',
      action: 'Smoke streamlines adhere smoothly to the upper surface of an airfoil inside a wind tunnel.',
      purpose: 'hook',
      onScreenLabels: [
        { text: 'AIRFLOW' },
        { text: 'ANGLE INCREASES' },
      ],
    },
  );

  assert.equal(result.passed, true);
  assert.equal(result.score, 72);
  assert.deepEqual(result.issues, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'visual-factual-consistency-low');
  assert.equal(result.regenerationGuidance, '');
});

test('visual factual QC ignores low-confidence speculative contradictions', async () => {
  const provider = providerReturning({
    applicable: true,
    uncertain: false,
    score: 94,
    contradictions: [{
      frame: 2,
      claim: 'Blood moves through the gills.',
      evidence: 'The glow may move in an unexpected direction, but the frame is ambiguous.',
      severity: 'high',
      confidence: 0.52,
    }],
    summary: 'No high-confidence contradiction.',
  });

  const result = await provider.evaluate(
    { localPath: '/fake/flow.mp4', durationSeconds: 6 },
    {
      narration: 'Branchial hearts pump blood through the gills.',
      action: 'A blue glow travels through vessels near the gills.',
    },
  );

  assert.equal(result.passed, true);
  assert.equal(result.issues.length, 0);
  assert.equal(result.contradictions.length, 1);
});

test('audiovisual pipeline regenerates a scene when visual factual QC finds a contradiction', async () => {
  const regenerations = [];
  let factChecks = 0;

  const pipeline = new AudiovisualPipeline({
    llm: {
      async generateProductionScript() {
        return {
          title: 'Octopus circulation',
          characters: [{
            id: 'narrator',
            name: 'Narrator',
            description: 'Unseen narrator.',
            onScreen: false,
            voice: { presetId: 'Bernard' },
          }],
          segments: [{
            durationSeconds: 6,
            purpose: 'explain',
            speakerCharacterId: 'narrator',
            dialogue: 'An octopus has three hearts.',
            action: 'A clean anatomical visualization shows the three-heart system.',
          }],
        };
      },
    },
    audiovisual: {
      async generateSegment({ regeneration }) {
        regenerations.push(regeneration);
        return {
          type: 'ai-video',
          localPath: '/fake/octopus.mp4',
          generationId: `g${regenerations.length}`,
          durationSeconds: 6,
        };
      },
    },
    renderer: null,
    store: { saveProject: async () => {} },
    visualFactualQc: {
      maxRegenerations: 1,
      async evaluate(_asset, context) {
        factChecks += 1;
        assert.match(context.narration, /three hearts/i);
        assert.match(context.action, /anatomical visualization/i);
        return factChecks === 1
          ? {
            passed: false,
            applicable: true,
            score: 48,
            issues: [{
              code: 'visual-factual-contradiction',
              severity: 'critical',
              evidence: 'The cutaway visibly shows the wrong organ count.',
            }],
            regenerationGuidance: 'Use a simpler external view instead of inventing heart anatomy.',
          }
          : {
            passed: true,
            applicable: true,
            score: 94,
            issues: [],
            regenerationGuidance: '',
          };
      },
    },
  });

  const project = await pipeline.generate({
    topic: 'octopus hearts',
    durationSeconds: 6,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.equal(regenerations.length, 2);
  assert.deepEqual(regenerations[1].triggeredBy, ['visualFactual']);
  assert.match(regenerations[1].guidance, /simpler external view/i);
  assert.equal(project.scenes[0].visualFactualQc.score, 94);
  assert.equal(project.scenes[0].visualQcHistory[0].visualFactual.passed, false);
  assert.equal(project.scenes[0].visualQcHistory[1].visualFactual.passed, true);
});

test('publishability exposes visual factual failures as a dedicated blocker', () => {
  const result = evaluateAudiovisualPublishability({
    productionScript: {
      fullDialogue: 'An octopus has three hearts.',
      segments: [{ index: 0, locationId: 'reef' }],
    },
    scenes: [{
      index: 0,
      asset: { localPath: '/fake/octopus.mp4' },
      visualQcHistory: [],
      visualFactualQc: { passed: false },
    }],
  });

  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((item) => item.code === 'visual-factual-consistency'));
});
