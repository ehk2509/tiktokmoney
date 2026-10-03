import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PreGenerationQualityGate,
  deterministicChecks,
} from '../src/core/preGenerationQualityGate.js';
import { AudiovisualPipeline } from '../src/core/audiovisualPipeline.js';

function validPlan() {
  return {
    topic: 'simple object demonstration',
    audience: 'curious adults',
    fullDialogue: 'Here is the demonstration.',
    characters: [{
      id: 'presenter',
      name: 'Presenter',
      description: 'An adult presenter.',
      physicalTraits: 'Natural adult face and proportions.',
      wardrobe: 'Generic unbranded dark shirt.',
      onScreen: true,
      voice: { presetId: 'Bernard', languageCode: 'en' },
    }],
    locations: [{
      id: 'room',
      name: 'Studio',
      description: 'A plain realistic studio.',
      lighting: 'Soft window light.',
      fixedElements: ['wood table', 'plain wall'],
    }],
    visualStyle: {
      description: 'Photorealistic documentary footage.',
      cameraRules: 'Natural 35mm camera.',
      lightingRules: 'Motivated practical light.',
    },
    audioDirection: {
      mix: 'Speech clear and close.',
      musicPolicy: 'No music over speech.',
    },
    directorialContract: {
      primaryVisibleRole: '',
      expectedRoleHints: [],
      requiredVisibleCharacterIds: [],
      requiredInteraction: '',
      interactionMustBeginBySeconds: 1.2,
      allowMontage: false,
      brandPolicy: { mode: 'unbranded', allowedBrands: [] },
    },
    realismDirection: {
      enabled: true,
      outputFrameRate: 30,
    },
    keyframeDirection: {
      enabled: true,
      mode: 'auto',
    },
    motionRegionDirection: {
      enabled: true,
      mode: 'semantic',
    },
    motionGuideDirection: {
      enabled: true,
      requireRightsConfirmed: true,
    },
    generatedDurationSeconds: 6,
    segments: [{
      index: 0,
      start: 0,
      duration: 6,
      durationSeconds: 6,
      purpose: 'explain',
      speakerCharacterId: 'presenter',
      speakerMode: 'single-speaker',
      dialogueTurns: [{
        turnIndex: 0,
        speakerCharacterId: 'presenter',
        text: 'Here is the demonstration.',
        delivery: 'clear',
        pauseAfterSeconds: 0,
      }],
      characterIds: ['presenter'],
      locationId: 'room',
      dialogue: 'Here is the demonstration.',
      startState: 'Presenter faces camera beside one generic object on the table.',
      endState: 'Presenter remains beside the same object after pointing to it.',
      action: 'Presenter points once to the generic object while keeping a readable face.',
      shotType: 'medium',
      camera: 'Medium eye-level documentary shot with the speaking face clearly readable.',
      onScreenLabels: [],
      ambience: 'Quiet studio room tone.',
      soundEffects: [],
      music: '',
      transition: 'none',
      editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
      realismDirection: {
        riskScore: 34,
        camera: { axis: 'locked' },
        humanMotion: { rule: 'one simple gesture' },
        microMotion: ['natural breathing'],
      },
      keyframeDirection: {
        enabled: true,
        policy: 'first',
        firstFrame: { state: 'Presenter faces camera beside the object.' },
        lastFrame: null,
      },
      motionRegionDirection: {
        enabled: true,
        allowedMotion: [{
          id: 'speech-mouth-jaw',
          region: 'mouth and jaw',
          behavior: 'speech articulation',
          intensity: 'low',
        }],
        lockedRegions: [{
          id: 'face-identity',
          region: 'face',
          rule: 'preserve identity',
          tolerance: 'identity-locked',
        }],
        allowedRegionIds: ['speech-mouth-jaw'],
        lockedRegionIds: ['face-identity'],
      },
      motionGuideDirection: {
        enabled: true,
        eligible: false,
        actionClass: 'talking',
        selectedReference: null,
      },
    }],
  };
}

test('pre-generation mirror covers every current post-generation quality stage', async () => {
  const gate = new PreGenerationQualityGate({
    semanticReviewEnabled: false,
  });
  const result = await gate.evaluate(validPlan());

  assert.equal(result.passed, true);
  assert.deepEqual(result.mirroredPostStages, [
    'realism',
    'temporal-realism',
    'identity-location-continuity',
    'keyframe-adherence',
    'motion-region',
    'motion-guide',
    'dialogue-fidelity',
    'lip-sync',
    'deep-lip-sync',
    'phoneme-viseme',
    'speaker-turn',
    'pose-motion',
    'text-artifact',
    'visual-factual',
    'editorial-variety',
    'production-integrity',
    'subtitle-layout',
    'audio-quality',
    'publishability',
  ]);
  assert.ok(result.inherentlyPostGeneration.some((item) => /actual generated speech WER/i.test(item)));
  assert.ok(result.inherentlyPostGeneration.some((item) => /measured loudness/i.test(item)));
});

test('deterministic pre-generation mirror catches known retry causes before video exists', () => {
  const script = validPlan();
  script.characters[0].wardrobe = 'Nike basketball shirt';
  script.segments[0].dialogue = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty thirty-one.';
  script.segments[0].dialogueTurns[0].text = script.segments[0].dialogue;
  script.fullDialogue = script.segments[0].dialogue;
  script.segments[0].action = 'Presenter points at written signage with a Nike logo.';
  script.segments[0].editing = {
    allowInternalCuts: true,
    allowDissolves: true,
    shotCount: 3,
  };

  const checks = deterministicChecks(script);
  const codes = Object.values(checks)
    .flatMap((item) => item.blockers || [])
    .map((item) => item.code);

  assert.ok(codes.includes('internal-edit-plan'));
  assert.ok(codes.includes('dialogue-duration-budget'));
  assert.ok(codes.includes('generated-text-direction'));
  assert.ok(codes.includes('brand-in-wardrobe'));
  assert.ok(codes.includes('brand-in-scene-plan'));
});

test('pipeline rewrites a failed plan before making the first video-generation call', async () => {
  let llmCalls = 0;
  let videoCalls = 0;
  let gateCalls = 0;
  const feedbacks = [];

  const llm = {
    async generateProductionScript(args) {
      llmCalls += 1;
      feedbacks.push(args.preflightFeedback || '');
      return {
        title: 'Demo',
        characters: [{
          id: 'presenter',
          name: 'Presenter',
          description: 'Adult presenter.',
          physicalTraits: 'Natural adult face.',
          wardrobe: 'Generic dark shirt.',
          voice: { presetId: 'Bernard' },
        }],
        locations: [{
          id: 'room',
          name: 'Room',
          description: 'Plain studio.',
          lighting: 'Window light.',
          fixedElements: ['table'],
        }],
        segments: [{
          durationSeconds: 6,
          purpose: 'explain',
          speakerCharacterId: 'presenter',
          characterIds: ['presenter'],
          locationId: 'room',
          dialogue: 'Here is the demonstration.',
          action: 'Presenter points once to a generic object.',
          startState: 'Presenter stands beside the object.',
          endState: 'Presenter remains beside the same object.',
          shotType: 'medium',
          camera: 'Medium eye-level shot.',
          ambience: 'Room tone.',
          editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
        }],
      };
    },
  };

  const preGenerationQualityGate = {
    async evaluate() {
      gateCalls += 1;
      return gateCalls === 1
        ? {
          passed: false,
          blockers: [{
            stage: 'visualFactual',
            code: 'plan-underspecified',
            message: 'The visual action does not yet demonstrate the spoken claim.',
          }],
          warnings: [],
          feedback: '[visualFactual/plan-underspecified] The visual action does not yet demonstrate the spoken claim.',
          mirroredPostStages: [],
          inherentlyPostGeneration: [],
        }
        : {
          passed: true,
          blockers: [],
          warnings: [],
          feedback: '',
          mirroredPostStages: [],
          inherentlyPostGeneration: [],
        };
    },
  };

  const pipeline = new AudiovisualPipeline({
    llm,
    audiovisual: {
      async generateSegment() {
        videoCalls += 1;
        return {
          type: 'ai-video',
          localPath: '/fake/generated.mp4',
          generationId: 'g1',
          durationSeconds: 6,
        };
      },
    },
    renderer: null,
    store: { saveProject: async () => {} },
    preGenerationQualityGate,
    preGenerationMaxRewrites: 1,
  });

  const project = await pipeline.generate({
    topic: 'simple object demonstration',
    durationSeconds: 6,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.equal(gateCalls, 2);
  assert.equal(llmCalls, 2);
  assert.equal(videoCalls, 1);
  assert.equal(project.planning.preGenerationAttempts, 2);
  assert.match(feedbacks[1], /visual action does not yet demonstrate/i);
});

test('pipeline stops before TTS/video work when pre-generation QC remains invalid', async () => {
  let videoCalls = 0;
  let llmCalls = 0;

  const pipeline = new AudiovisualPipeline({
    llm: {
      async generateProductionScript() {
        llmCalls += 1;
        return {
          title: 'Demo',
          characters: [{
            id: 'presenter',
            name: 'Presenter',
            description: 'Adult presenter.',
            physicalTraits: 'Natural adult face.',
            wardrobe: 'Generic dark shirt.',
            voice: { presetId: 'Bernard' },
          }],
          locations: [{
            id: 'room',
            name: 'Room',
            description: 'Plain studio.',
            lighting: 'Window light.',
            fixedElements: ['table'],
          }],
          segments: [{
            durationSeconds: 6,
            purpose: 'explain',
            speakerCharacterId: 'presenter',
            characterIds: ['presenter'],
            locationId: 'room',
            dialogue: 'Here is the demonstration.',
            action: 'Presenter points once to a generic object.',
            startState: 'Presenter stands beside the object.',
            endState: 'Presenter remains beside the same object.',
            shotType: 'medium',
            camera: 'Medium eye-level shot.',
            ambience: 'Room tone.',
            editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
          }],
        };
      },
    },
    audiovisual: {
      async generateSegment() {
        videoCalls += 1;
        throw new Error('video generation must not be reached');
      },
    },
    renderer: null,
    store: { saveProject: async () => {} },
    preGenerationQualityGate: {
      async evaluate() {
        return {
          passed: false,
          blockers: [{
            stage: 'productionIntegrity',
            code: 'required-role-missing',
            message: 'Required visible role is missing.',
          }],
          warnings: [],
          feedback: '[productionIntegrity/required-role-missing] Required visible role is missing.',
          mirroredPostStages: [],
          inherentlyPostGeneration: [],
        };
      },
    },
    preGenerationMaxRewrites: 1,
  });

  const project = await pipeline.generate({
    topic: 'simple object demonstration',
    durationSeconds: 6,
    render: false,
  });

  assert.equal(project.status, 'PRE_GENERATION_QC_FAILED');
  assert.equal(llmCalls, 2);
  assert.equal(videoCalls, 0);
  assert.equal(project.planning.preGenerationAttempts, 2);
  assert.match(project.error, /before any video generation/i);
});

test('semantic pre-generation review failure is a warning, not an infrastructure blocker', async () => {
  const gate = new PreGenerationQualityGate({
    llm: {
      async reviewProductionPlan() {
        throw new Error('temporary reviewer outage');
      },
    },
    semanticReviewEnabled: true,
  });

  const result = await gate.evaluate(validPlan());

  assert.equal(result.passed, true);
  assert.equal(result.checks.semanticPlanReview.passed, true);
  assert.equal(result.checks.semanticPlanReview.warnings[0].code, 'semantic-preflight-unavailable');
});
