import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProductionScriptGenerator,
} from '../src/core/productionScriptGenerator.js';
import {
  buildAudiovisualPrompt,
} from '../src/providers/runwayAudiovisualProvider.js';
import {
  OpenRouterProductionIntegrityQcProvider,
} from '../src/providers/openRouterProductionIntegrityQcProvider.js';
import { AudiovisualPipeline } from '../src/core/audiovisualPipeline.js';
import { evaluateAudiovisualPublishability } from '../src/core/publishabilityGate.js';
import { RealismDirector } from '../src/core/realismDirector.js';

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test('screenplay preflight fixes a missing required coach before video generation', async () => {
  const calls = [];
  const scripts = [
    {
      title: 'Championship',
      characters: [{
        id: 'player',
        name: 'Player',
        description: 'An adult basketball player preparing alone.',
        wardrobe: 'Generic navy basketball uniform.',
        voice: { presetId: 'Bernard' },
      }],
      locations: [{
        id: 'locker',
        name: 'Locker room',
        description: 'A basketball locker room.',
      }],
      segments: [{
        durationSeconds: 8,
        purpose: 'hook',
        speakerCharacterId: 'player',
        characterIds: ['player'],
        locationId: 'locker',
        dialogue: 'We have prepared for this moment.',
        action: 'The player silently ties his shoes alone.',
        shotType: 'close-up',
        camera: 'Close handheld shot.',
        editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
      }],
    },
    {
      title: 'Championship',
      directorialContract: {
        primaryVisibleRole: 'coach',
        requiredVisibleCharacterIds: ['coach'],
        requiredInteraction: 'The coach visibly addresses and motivates the basketball team.',
        interactionMustBeginBySeconds: 6,
        allowMontage: false,
        brandPolicy: { mode: 'unbranded', allowedBrands: [] },
      },
      characters: [
        {
          id: 'coach',
          name: 'Head Coach',
          description: 'An adult basketball coach leading the team.',
          wardrobe: 'Generic unbranded navy coaching clothes.',
          voice: { presetId: 'Bernard' },
        },
        {
          id: 'captain',
          name: 'Team Captain',
          description: 'An adult basketball player listening to the coach.',
          wardrobe: 'Generic unbranded navy basketball uniform.',
          voice: { presetId: 'Maya' },
        },
      ],
      locations: [{
        id: 'locker',
        name: 'Locker room',
        description: 'A basketball locker room.',
      }],
      segments: [{
        durationSeconds: 8,
        purpose: 'hook',
        speakerCharacterId: 'coach',
        characterIds: ['coach', 'captain'],
        locationId: 'locker',
        dialogue: 'Look at each other. We win this together.',
        action: 'The coach stands in front of the seated team and visibly addresses them; players look up and react.',
        shotType: 'wide-establishing',
        camera: 'Wide handheld shot showing coach and team together.',
        editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
      }],
    },
  ];

  const generator = new ProductionScriptGenerator({
    preflightMaxRetries: 1,
    llm: {
      async generateProductionScript(args) {
        calls.push(args);
        return scripts[calls.length - 1];
      },
    },
  });

  const script = await generator.generate({
    topic: 'A coach motivating his team to win the basketball championship',
    audience: 'basketball fans',
    durationSeconds: 40,
  });

  assert.equal(calls.length, 2);
  assert.match(calls[1].preflightFeedback, /visible coach/i);
  assert.equal(script.preflight.passed, true);
  assert.equal(script.preflight.attempt, 2);
  assert.equal(script.directorialContract.primaryVisibleRole, 'coach');
  assert.deepEqual(script.directorialContract.requiredVisibleCharacterIds, ['coach']);
  assert.equal(script.directorialContract.brandPolicy.mode, 'unbranded');
});

test('WAN prompt receives the binding human-interaction, single-shot, and unbranded contracts', () => {
  const coach = {
    id: 'coach',
    name: 'Head Coach',
    description: 'An adult basketball coach.',
    physicalTraits: 'Natural athletic adult.',
    wardrobe: 'Generic navy coaching clothes.',
    onScreen: true,
    voice: { description: 'firm coach voice', delivery: 'intense' },
  };
  const captain = {
    id: 'captain',
    name: 'Captain',
    description: 'An adult basketball player.',
    physicalTraits: 'Natural athletic adult.',
    wardrobe: 'Generic navy basketball uniform.',
    onScreen: true,
    voice: { description: 'player voice', delivery: 'focused' },
  };
  const segment = {
    index: 0,
    start: 0,
    durationSeconds: 8,
    purpose: 'hook',
    speakerCharacterId: 'coach',
    characterIds: ['coach', 'captain'],
    locationId: 'locker',
    dialogue: 'We win this together.',
    action: 'The coach visibly addresses the team while players look up and react.',
    startState: 'Coach stands in the center of the locker room facing seated players.',
    endState: 'Players are standing and focused on the coach.',
    shotType: 'wide-establishing',
    camera: 'Handheld wide shot.',
    editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
    ambience: 'Distant arena crowd.',
    soundEffects: [],
    music: '',
  };
  const productionScript = {
    characters: [coach, captain],
    locations: [{
      id: 'locker',
      description: 'Concrete locker room with benches.',
      lighting: 'Practical overhead light.',
      fixedElements: ['benches'],
    }],
    visualStyle: { description: 'documentary realism', cameraRules: 'natural lens', lightingRules: 'motivated light' },
    audioDirection: { mix: 'clear speech', musicPolicy: 'low music' },
    directorialContract: {
      primaryVisibleRole: 'coach',
      requiredVisibleCharacterIds: ['coach'],
      requiredInteraction: 'The coach visibly motivates the team.',
      interactionMustBeginBySeconds: 6,
      allowMontage: false,
      brandPolicy: { mode: 'unbranded', allowedBrands: [] },
    },
  };

  const prompt = buildAudiovisualPrompt({
    segment,
    productionScript,
    characters: [coach, captain],
    primaryCharacter: coach,
    dialogueTurns: [{ speakerCharacterId: 'coach', text: 'We win this together.' }],
    dialogueTrack: null,
    regeneration: null,
    previousAsset: null,
  });

  assert.match(prompt, /PRIMARY VISIBLE ROLE: coach/i);
  assert.match(prompt, /REQUIRED INTERACTION NOW/i);
  assert.match(prompt, /do not replace it with solitary preparation B-roll/i);
  assert.match(prompt, /not a montage/i);
  assert.match(prompt, /everything visible must be generic and unbranded/i);
  assert.match(prompt, /signature swooshes/i);
});

test('realism direction cannot re-enable montage after preflight forbids it', () => {
  const directed = new RealismDirector().direct({
    directorialContract: { allowMontage: false },
    visualStyle: {
      description: 'Photorealistic sports documentary.',
      cameraRules: 'Natural handheld camera.',
      lightingRules: 'Practical locker-room light.',
    },
    segments: [{
      index: 0,
      durationSeconds: 8,
      speakerMode: 'single-speaker',
      dialogueTurns: [{ speakerCharacterId: 'coach', text: 'We win together.' }],
      characterIds: ['coach', 'captain'],
      action: 'The coach grabs a basketball, walks through the team, and players rise around him.',
      camera: '360 orbit with rapid zoom.',
      ambience: 'Locker room.',
      editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
    }],
  });

  assert.equal(directed.segments[0].editing.allowInternalCuts, false);
  assert.equal(directed.segments[0].editing.allowDissolves, false);
  assert.equal(directed.segments[0].editing.shotCount, 1);
  assert.ok(directed.segments[0].realismDirection.recommendedShots > 1);
});

test('production-integrity QC blocks logo leakage and ghost/montage transitions', async () => {
  let requestBody = null;
  const provider = new OpenRouterProductionIntegrityQcProvider({
    apiKey: 'router-key',
    model: 'vision-model',
    frames: 10,
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
      requestBody = JSON.parse(options.body);
      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              scores: {
                roleAdherence: 96,
                interactionAdherence: 94,
                singleShotIntegrity: 38,
                brandSafety: 42,
              },
              violations: [
                {
                  code: 'ghost-transition',
                  frame: 3,
                  severity: 'high',
                  confidence: 0.97,
                  evidence: 'Two incompatible compositions are simultaneously visible as a double exposure.',
                },
                {
                  code: 'unauthorized-brand-logo',
                  frame: 6,
                  severity: 'high',
                  confidence: 0.96,
                  evidence: 'A recognizable swoosh-style commercial logo is visible on the white basketball shoe.',
                },
              ],
              summary: 'The role is present, but editing and brand contracts are violated.',
            }),
          },
        }],
      });
    },
  });

  const result = await provider.evaluate(
    { localPath: '/fake/basketball.mp4', durationSeconds: 8 },
    {
      segment: {
        index: 0,
        start: 0,
        durationSeconds: 8,
        purpose: 'hook',
        action: 'Coach addresses the team.',
        camera: 'Wide handheld.',
        characterIds: ['coach'],
        editing: { allowInternalCuts: false, allowDissolves: false },
      },
      productionScript: {
        characters: [{
          id: 'coach',
          name: 'Head Coach',
          description: 'Adult basketball coach.',
          wardrobe: 'Generic coaching clothes.',
        }],
        directorialContract: {
          primaryVisibleRole: 'coach',
          requiredVisibleCharacterIds: ['coach'],
          requiredInteraction: 'Coach visibly motivates the team.',
          interactionMustBeginBySeconds: 6,
          brandPolicy: { mode: 'unbranded', allowedBrands: [] },
        },
      },
    },
  );

  assert.equal(result.passed, false);
  assert.deepEqual(result.issues.map((item) => item.code), [
    'ghost-transition',
    'unauthorized-brand-logo',
  ]);
  assert.match(result.regenerationGuidance, /one continuous physical camera take/i);
  assert.match(result.regenerationGuidance, /generic unbranded wardrobe/i);

  const prompt = requestBody.messages[1].content[0].text;
  assert.match(prompt, /BRAND CONTRACT: everything must be unbranded/i);
  assert.match(prompt, /signature swoosh/i);
  assert.match(prompt, /REQUIRED HUMAN INTERACTION/i);
});

test('audiovisual pipeline retries only when the fallback integrity verifier catches model disobedience', async () => {
  const generations = [];
  let checks = 0;
  const pipeline = new AudiovisualPipeline({
    llm: {
      async generateProductionScript() {
        return {
          title: 'Object demo',
          characters: [{
            id: 'presenter',
            name: 'Presenter',
            description: 'An adult presenter.',
            wardrobe: 'Generic unbranded clothes.',
            voice: { presetId: 'Bernard' },
          }],
          locations: [{ id: 'room', name: 'Room', description: 'A plain studio.' }],
          directorialContract: {
            brandPolicy: { mode: 'unbranded', allowedBrands: [] },
            allowMontage: false,
          },
          segments: [{
            durationSeconds: 6,
            purpose: 'explain',
            speakerCharacterId: 'presenter',
            characterIds: ['presenter'],
            locationId: 'room',
            dialogue: 'Here is the simple demonstration.',
            action: 'The presenter demonstrates one generic object.',
            editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
          }],
        };
      },
    },
    audiovisual: {
      async generateSegment({ regeneration }) {
        generations.push(regeneration);
        return {
          type: 'ai-video',
          localPath: '/fake/demo.mp4',
          generationId: `g${generations.length}`,
          durationSeconds: 6,
        };
      },
    },
    renderer: null,
    store: { saveProject: async () => {} },
    productionIntegrityQc: {
      maxRegenerations: 1,
      async evaluate() {
        checks += 1;
        return checks === 1
          ? {
            passed: false,
            issues: [{
              code: 'unauthorized-brand-logo',
              severity: 'high',
              evidence: 'Unexpected commercial logo.',
            }],
            regenerationGuidance: 'Use completely generic unbranded props.',
          }
          : {
            passed: true,
            issues: [],
            warnings: [],
            scores: {
              roleAdherence: 100,
              interactionAdherence: 100,
              singleShotIntegrity: 100,
              brandSafety: 100,
            },
            regenerationGuidance: '',
          };
      },
    },
  });

  const project = await pipeline.generate({
    topic: 'simple object demonstration',
    durationSeconds: 6,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.equal(generations.length, 2);
  assert.deepEqual(generations[1].triggeredBy, ['productionIntegrity']);
  assert.match(generations[1].guidance, /generic unbranded props/i);
  assert.equal(project.scenes[0].productionIntegrityQc.passed, true);
});

test('publishability exposes production-integrity failures as a dedicated blocker', () => {
  const result = evaluateAudiovisualPublishability({
    productionScript: {
      fullDialogue: 'Win this together.',
      segments: [{ index: 0, locationId: 'locker' }],
    },
    scenes: [{
      index: 0,
      asset: { localPath: '/fake/team.mp4' },
      visualQcHistory: [],
      productionIntegrityQc: { passed: false },
    }],
  });

  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((item) => item.code === 'production-integrity'));
});
