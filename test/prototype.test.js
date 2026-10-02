import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rankOpportunities, scoreOpportunity } from '../src/core/opportunityScorer.js';
import { planScenes } from '../src/core/scenePlanner.js';
import { VideoPipeline } from '../src/core/pipeline.js';
import { StoryBibleGenerator } from '../src/core/storyBibleGenerator.js';
import { TemplateLlmProvider } from '../src/providers.js';
import { OpenAICompatibleLlmProvider } from '../src/providers/openaiCompatibleLlmProvider.js';
import { PexelsStockProvider } from '../src/providers/pexelsStockProvider.js';
import {
  ElevenLabsVoiceProvider,
  alignmentToWords,
} from '../src/providers/elevenLabsVoiceProvider.js';
import { FfmpegRenderer } from '../src/renderers/ffmpegRenderer.js';
import { LumaRealisticVideoProvider } from '../src/providers/lumaRealisticVideoProvider.js';
import { AiFirstVisualProvider } from '../src/providers/visualRouter.js';
import { FrameSampler, denseTemporalTimestamps } from '../src/services/frameSampler.js';
import { OpenRouterRealismQcProvider } from '../src/providers/openRouterRealismQcProvider.js';
import { LumaAgentsVideoProvider } from '../src/providers/lumaAgentsVideoProvider.js';
import { RunwayVideoProvider } from '../src/providers/runwayVideoProvider.js';
import { VideoModelRouter, classifyScene } from '../src/providers/videoModelRouter.js';
import { ProviderStatsStore } from '../src/storage/providerStatsStore.js';
import {
  buildSubtitles,
  punctuateWordsFromScript,
  renderAssDocument,
  renderSrtDocument,
  evaluateSubtitleLayout,
  estimateRenderedWidth,
} from '../src/core/subtitleBuilder.js';
import {
  ProductionScriptGenerator,
  productionScriptToStoryBible,
} from '../src/core/productionScriptGenerator.js';
import {
  RunwayAudiovisualProvider,
  buildVideoReferencePlan,
} from '../src/providers/runwayAudiovisualProvider.js';
import { AudiovisualPipeline } from '../src/core/audiovisualPipeline.js';
import { AudiovisualRenderer } from '../src/renderers/audiovisualRenderer.js';
import {
  RealismDirector,
  directSegment,
  buildRealismPromptBlock,
} from '../src/core/realismDirector.js';
import {
  AntiPlasticPostProcessor,
  shouldApplySyntheticMotionBlur,
} from '../src/services/antiPlasticPostProcessor.js';
import {
  KeyframeDirector,
  selectKeyframePolicy,
  buildKeyframePrompts,
} from '../src/core/keyframeDirector.js';
import {
  MotionRegionDirector,
  directMotionRegions,
  buildMotionRegionPromptBlock,
  buildMotionRegionQcContract,
} from '../src/core/motionRegionDirector.js';
import {
  MotionGuideDirector,
  directMotionGuide,
  classifyMotionAction,
  scoreReference,
  buildMotionGuidePromptBlock,
} from '../src/core/motionGuideDirector.js';
import { MotionReferenceStore } from '../src/storage/motionReferenceStore.js';
import {
  MotionLibraryBuilder,
  detectMotionSegments,
  classifyPoseSequence,
  scoreMotionReferenceQuality,
  findDuplicate,
} from '../src/services/motionLibraryBuilder.js';
import {
  normalizePoseSequence,
  summarizePoseSequence,
  poseSummaryToPrompt,
  comparePoseSequences,
} from '../src/core/poseMotion.js';
import {
  PoseMotionExtractor,
  resolveExtractor,
  bundledPythonCandidates,
} from '../src/services/poseMotionExtractor.js';
import { PoseMotionQcProvider } from '../src/providers/poseMotionQcProvider.js';
import { AudioQualityInspector, parseEbur128 } from '../src/services/audioQualityInspector.js';
import { evaluateAudiovisualPublishability } from '../src/core/publishabilityGate.js';
import {
  OpenAiTranscriptionProvider,
  compareDialogue,
} from '../src/providers/openAiTranscriptionProvider.js';
import {
  OpenRouterLipSyncQcProvider,
  buildLipSyncSamples,
} from '../src/providers/openRouterLipSyncQcProvider.js';
import {
  DeepLipSyncQcProvider,
  normalizeDeepLipSyncResult,
} from '../src/providers/deepLipSyncQcProvider.js';
import {
  PhonemeVisemeQcProvider,
  normalizePhonemeVisemeResult,
} from '../src/providers/phonemeVisemeQcProvider.js';
import { DialogueAudioComposer } from '../src/services/dialogueAudioComposer.js';
import {
  OpenRouterSpeakerTurnQcProvider,
  buildSpeakerSamples,
} from '../src/providers/openRouterSpeakerTurnQcProvider.js';
import {
  CreativeTournament,
  rankCandidates,
} from '../src/core/creativeTournament.js';
import {
  TrendIntelligence,
  clusterTrendSignals,
} from '../src/core/trendIntelligence.js';
import { TrendHistoryStore } from '../src/storage/trendHistoryStore.js';
import { buildResearchPacket } from '../src/core/researchPacketBuilder.js';
import { YouTubeTrendProvider } from '../src/providers/youtubeTrendProvider.js';
import { RedditTrendProvider } from '../src/providers/redditTrendProvider.js';
import { RssTrendProvider } from '../src/providers/rssTrendProvider.js';
import {
  DailyContentPlanner,
  chooseCreativeCandidateCount,
  closestRecentTopic,
} from '../src/core/dailyContentPlanner.js';
import { DailyPlanStore } from '../src/storage/dailyPlanStore.js';

test('high-value low-risk opportunity scores above saturated risky content', () => {
  const strong = scoreOpportunity({
    velocity: 90, acceleration: 85, audienceFit: 90, novelty: 80,
    contentPotential: 95, monetization: 80, feasibility: 90,
    saturation: 20, copyrightRisk: 5, misinformationRisk: 5,
  });
  const weak = scoreOpportunity({
    velocity: 95, acceleration: 90, audienceFit: 50, novelty: 30,
    contentPotential: 40, monetization: 10, feasibility: 90,
    saturation: 95, copyrightRisk: 70, misinformationRisk: 60,
  });
  assert.ok(strong > weak);
});

test('opportunity ranking is descending', () => {
  const ranked = rankOpportunities([{ id: 'a', velocity: 10 }, { id: 'b', velocity: 90 }]);
  assert.equal(ranked[0].id, 'b');
});

test('scene planner creates hook and CTA scenes with ordered timestamps', () => {
  const scenes = planScenes({
    topic: 'space', durationSeconds: 30, hook: 'A surprising hook about space.',
    body: ['First fact.', 'Second fact.'], payoff: 'The payoff.', cta: 'Follow.',
  });
  assert.equal(scenes[0].purpose, 'hook');
  assert.equal(scenes.at(-1).purpose, 'cta');
  assert.equal(scenes[0].realism.mode, 'photorealistic');
  assert.match(scenes[0].realism.referencePrompt, /real camera/i);
  assert.match(scenes[0].realism.motionPrompt, /continuous, seamless/i);
  assert.ok(scenes.every((scene, index) => index === 0 || scene.start >= scenes[index - 1].start));
});

test('pipeline enriches scenes with assets and retimes them to narration', async () => {
  const saved = [];
  const stock = {
    resolveScene: async (scene) => ({
      provider: 'fake-stock',
      localPath: `clip-${scene.index}.mp4`,
    }),
  };
  const voice = {
    synthesize: async () => ({
      provider: 'fake-voice',
      audioPath: 'voice.mp3',
      durationSeconds: 20,
      wordTimings: [],
    }),
  };
  const pipeline = new VideoPipeline({
    llm: new TemplateLlmProvider(),
    renderer: null,
    stock,
    voice,
    store: { saveProject: async (project) => saved.push(structuredClone(project)) },
  });

  const project = await pipeline.generate({
    topic: 'Why airplanes fly',
    durationSeconds: 35,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.ok(project.scenes.every((scene) => scene.asset?.provider === 'fake-stock'));
  assert.equal(project.voice.provider, 'fake-voice');
  const totalDuration = project.scenes.reduce((sum, scene) => sum + scene.duration, 0);
  assert.ok(Math.abs(totalDuration - 20) < 0.01);
  assert.equal(saved.length, 1);
});

test('OpenAI-compatible provider parses structured JSON scripts', async () => {
  const provider = new OpenAICompatibleLlmProvider({
    apiKey: 'test-key',
    baseUrl: 'https://llm.example/v1',
    model: 'test-model',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://llm.example/v1/chat/completions');
      assert.equal(options.method, 'POST');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                hook: 'This is a strong test hook.',
                body: ['First point.', 'Second point.', 'Third point.'],
                payoff: 'This is the payoff.',
                cta: 'Follow for more.',
              }),
            },
          }],
        }),
      };
    },
  });

  const script = await provider.generateStructuredScript({
    topic: 'test topic',
    audience: 'test audience',
    durationSeconds: 30,
  });

  assert.equal(script.source, 'openai-compatible');
  assert.equal(script.model, 'test-model');
  assert.equal(script.body.length, 3);
});

test('OpenAI-compatible provider retries without temperature when the model rejects it', async () => {
  const bodies = [];
  const provider = new OpenAICompatibleLlmProvider({
    apiKey: 'test-key',
    model: 'reasoning-model',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      if ('temperature' in body) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: "Unsupported value: 'temperature' does not support 0.7 with this model." } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
      };
    },
  });

  assert.deepEqual(await provider.generateJson({ system: 's', prompt: 'p', temperature: 0.7 }), { ok: true });
  assert.deepEqual(await provider.generateJson({ system: 's', prompt: 'p', temperature: 0.2 }), { ok: true });
  assert.equal(bodies.length, 3);
  assert.ok(!('temperature' in bodies[2]));
});

test('Pexels provider downloads and records attribution metadata', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-pexels-'));
  try {
    const provider = new PexelsStockProvider({
      apiKey: 'pexels-key',
      assetDir: dir,
      fetchImpl: async (url) => {
        if (String(url).includes('/v1/videos/search')) {
          assert.match(String(url), /orientation=portrait/);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              videos: [{
                id: 42,
                width: 1080,
                height: 1920,
                duration: 8,
                url: 'https://www.pexels.com/video/42',
                user: { name: 'Creator', url: 'https://www.pexels.com/@creator' },
                video_files: [{
                  width: 1080,
                  height: 1920,
                  file_type: 'video/mp4',
                  link: 'https://cdn.example/video.mp4',
                }],
              }],
            }),
          };
        }

        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new TextEncoder().encode('video-bytes').buffer,
        };
      },
    });

    const asset = await provider.resolveScene(
      { visualPrompt: 'vertical science laboratory', narration: 'science' },
      { projectId: 'vid_test' },
    );

    assert.equal(asset.provider, 'pexels');
    assert.equal(asset.creator, 'Creator');
    assert.equal(asset.license, 'Pexels');
    assert.equal(await readFile(asset.localPath, 'utf8'), 'video-bytes');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ElevenLabs alignment converts character timestamps into word timings', () => {
  const words = alignmentToWords({
    characters: ['H', 'i', ' ', 'a', 'l', 'l'],
    character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5],
    character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
  });

  assert.deepEqual(words, [
    { word: 'Hi', start: 0, end: 0.2 },
    { word: 'all', start: 0.3, end: 0.6 },
  ]);
});

test('ElevenLabs provider persists audio and timing metadata', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-voice-'));
  try {
    const provider = new ElevenLabsVoiceProvider({
      apiKey: 'voice-key',
      voiceId: 'voice-id',
      outputDir: dir,
      fetchImpl: async (url, options) => {
        assert.match(String(url), /with-timestamps/);
        assert.equal(options.method, 'POST');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            audio_base64: Buffer.from('fake-mp3').toString('base64'),
            normalized_alignment: {
              characters: ['H', 'i'],
              character_start_times_seconds: [0, 0.1],
              character_end_times_seconds: [0.1, 0.2],
            },
          }),
        };
      },
    });

    const voice = await provider.synthesize({ text: 'Hi', projectId: 'vid_voice' });
    assert.equal(voice.durationSeconds, 0.2);
    assert.deepEqual(voice.wordTimings, [{ word: 'Hi', start: 0, end: 0.2 }]);
    assert.equal(await readFile(voice.audioPath, 'utf8'), 'fake-mp3');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renderer builds one FFmpeg scene command per scene plus concat and audio stages', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-renderer-'));
  const commands = [];
  try {
    const renderer = new FfmpegRenderer({
      outputDir: dir,
      runCommand: async (command, args) => commands.push({ command, args }),
    });

    const result = await renderer.render({
      id: 'vid_render',
      topic: 'test',
      script: { durationSeconds: 2 },
      scenes: [
        { index: 0, duration: 1, overlay: 'HOOK', narration: 'hook', asset: null },
        { index: 1, duration: 1, overlay: 'PAYOFF', narration: 'payoff', asset: null },
      ],
      voice: null,
    });

    assert.equal(result.sceneCount, 2);
    assert.equal(commands.length, 4);
    assert.ok(commands[0].args.some((arg) => String(arg).includes('color=c=0x111827')));
    assert.ok(commands[2].args.includes('concat'));
    assert.ok(commands[3].args.some((arg) => String(arg).includes('anullsrc')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('Luma provider creates reference image, animates it and downloads the realistic clip', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-luma-'));
  const requests = [];
  try {
    const provider = new LumaRealisticVideoProvider({
      apiKey: 'luma-key',
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 3,
      sleepImpl: async () => {},
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const method = options.method || 'GET';
        requests.push({ target, method, body: options.body ? JSON.parse(options.body) : null });

        if (target.endsWith('/generations/image') && method === 'POST') {
          return jsonResponse({ id: 'image-gen-1', state: 'dreaming' }, 201);
        }
        if (target.endsWith('/generations/image-gen-1')) {
          return jsonResponse({
            id: 'image-gen-1',
            state: 'completed',
            assets: { image: 'https://cdn.example/reference.jpg' },
          });
        }
        if (target.endsWith('/generations/video') && method === 'POST') {
          const body = JSON.parse(options.body);
          assert.equal(body.aspect_ratio, '9:16');
          assert.equal(body.keyframes.frame0.type, 'image');
          assert.equal(body.keyframes.frame0.url, 'https://cdn.example/reference.jpg');
          assert.match(body.prompt, /photorealistic/i);
          return jsonResponse({ id: 'video-gen-1', state: 'dreaming' }, 201);
        }
        if (target.endsWith('/generations/video-gen-1')) {
          return jsonResponse({
            id: 'video-gen-1',
            state: 'completed',
            assets: { video: 'https://cdn.example/video.mp4' },
          });
        }
        if (target === 'https://cdn.example/video.mp4') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('luma-video').buffer,
          };
        }
        throw new Error(`unexpected request: ${method} ${target}`);
      },
    });

    const scene = planScenes({
      topic: 'commercial aviation',
      durationSeconds: 20,
      hook: 'A pilot looks through the cockpit window before takeoff.',
      body: ['The crew checks the instruments carefully.', 'The aircraft starts taxiing.'],
      payoff: 'Every step follows a precise sequence.',
      cta: 'Follow for more.',
    })[0];

    const asset = await provider.resolveScene(scene, { projectId: 'vid_luma' });

    assert.equal(asset.provider, 'luma');
    assert.equal(asset.type, 'ai-video');
    assert.equal(asset.generationId, 'video-gen-1');
    assert.equal(asset.referenceImageUrl, 'https://cdn.example/reference.jpg');
    assert.equal(await readFile(asset.localPath, 'utf8'), 'luma-video');
    assert.ok(requests.some((request) => request.target.endsWith('/generations/image')));
    assert.ok(requests.some((request) => request.target.endsWith('/generations/video')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Luma provider carries the previous reference image into the next still for continuity', async () => {
  const imageBodies = [];
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-luma-continuity-'));
  try {
    const provider = new LumaRealisticVideoProvider({
      apiKey: 'luma-key',
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 2,
      sleepImpl: async () => {},
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const method = options.method || 'GET';
        if (target.endsWith('/generations/image') && method === 'POST') {
          const body = JSON.parse(options.body);
          imageBodies.push(body);
          return jsonResponse({ id: 'image-gen-2' }, 201);
        }
        if (target.endsWith('/generations/image-gen-2')) {
          return jsonResponse({
            id: 'image-gen-2',
            state: 'completed',
            assets: { image: 'https://cdn.example/next-reference.jpg' },
          });
        }
        if (target.endsWith('/generations/video') && method === 'POST') {
          return jsonResponse({ id: 'video-gen-2' }, 201);
        }
        if (target.endsWith('/generations/video-gen-2')) {
          return jsonResponse({
            id: 'video-gen-2',
            state: 'completed',
            assets: { video: 'https://cdn.example/next-video.mp4' },
          });
        }
        if (target === 'https://cdn.example/next-video.mp4') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('next-video').buffer,
          };
        }
        throw new Error(`unexpected request: ${method} ${target}`);
      },
    });

    const scene = planScenes({
      topic: 'realistic office',
      durationSeconds: 20,
      hook: 'A woman walks into a bright modern office.',
      body: ['She sits at the same desk.'],
      payoff: 'The workspace remains consistent.',
      cta: 'Follow.',
    })[1];

    const asset = await provider.resolveScene(scene, {
      projectId: 'vid_continuity',
      previousAsset: {
        referenceGenerationId: 'image-gen-previous',
        referenceImageUrl: 'https://cdn.example/previous-reference.jpg',
      },
    });

    assert.equal(asset.continuityFrom, 'image-gen-previous');
    assert.equal(imageBodies.length, 1);
    assert.equal(imageBodies[0].image_ref[0].url, 'https://cdn.example/previous-reference.jpg');
    assert.equal(imageBodies[0].image_ref[0].weight, 0.62);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AI-first visual router falls back to stock when AI video generation fails', async () => {
  const router = new AiFirstVisualProvider({
    ai: {
      resolveScene: async () => {
        throw new Error('generation capacity unavailable');
      },
    },
    stock: {
      resolveScene: async () => ({
        provider: 'pexels',
        type: 'stock-video',
        localPath: 'fallback.mp4',
      }),
    },
  });

  const asset = await router.resolveScene({ index: 0 }, { projectId: 'vid_router' });

  assert.equal(asset.provider, 'pexels');
  assert.equal(asset.routing.selected, 'stock');
  assert.equal(asset.routing.fallbackUsed, true);
  assert.match(asset.routing.fallbackReason, /capacity unavailable/);
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    json: async () => payload,
  };
}


test('frame sampler extracts compact JPEG checkpoints across a scene', async () => {
  const sampler = new FrameSampler({
    frameCount: 3,
    maxWidth: 512,
    runCommand: async (_command, args) => {
      const outputPath = args.at(-1);
      await writeFile(outputPath, `frame-${args[2]}`);
    },
  });

  const frames = await sampler.sample('/fake/video.mp4', { durationSeconds: 4 });

  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((frame) => frame.timestamp), [1, 2, 3]);
  assert.ok(frames.every((frame) => frame.dataUrl.startsWith('data:image/jpeg;base64,')));
});

test('OpenRouter realism QC scores sampled frames and returns targeted guidance', async () => {
  const requests = [];
  const qc = new OpenRouterRealismQcProvider({
    apiKey: 'router-key',
    model: 'google/gemini-3.8-flash',
    threshold: 82,
    temporalEnabled: false,
    frameSampler: {
      sample: async () => [
        { index: 0, timestamp: 1, dataUrl: 'data:image/jpeg;base64,AAA=' },
        { index: 1, timestamp: 2, dataUrl: 'data:image/jpeg;base64,BBB=' },
        { index: 2, timestamp: 3, dataUrl: 'data:image/jpeg;base64,CCC=' },
      ],
    },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              overallScore: 71,
              scores: {
                photorealism: 72,
                anatomy: 45,
                geometry: 80,
                physics: 78,
                motionConsistency: 63,
                continuity: 77,
                sceneRelevance: 95,
                artifactFreedom: 58,
              },
              issues: [{
                code: 'hands',
                severity: 'high',
                evidence: 'fingers appear fused in the middle frame',
              }],
              summary: 'Scene is relevant but visibly synthetic.',
              regenerationGuidance: 'Keep hands outside frame and preserve realistic facial geometry.',
            }),
          },
        }],
        usage: { cost: 0.001 },
      });
    },
  });

  const result = await qc.evaluateScene(
    {
      narration: 'A pilot checks the aircraft controls.',
      duration: 5,
      realism: { motionPrompt: 'Photorealistic cockpit scene.' },
    },
    {
      type: 'ai-video',
      localPath: '/fake/scene.mp4',
      generatedDuration: '5s',
      prompt: 'Photorealistic cockpit scene.',
      generationId: 'gen-1',
    },
  );

  assert.equal(result.passed, false);
  assert.equal(result.overallScore, 71);
  assert.equal(result.issues[0].code, 'hands');
  assert.match(result.regenerationGuidance, /hands outside frame/i);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  const contentParts = requests[0].body.messages[1].content;
  assert.equal(contentParts.filter((part) => part.type === 'image_url').length, 3);
});

test('pipeline regenerates a failed AI scene using QC guidance and accepts the improved attempt', async () => {
  const visualCalls = [];
  const qcCallsByScene = new Map();

  const visual = {
    strategy: 'ai-first',
    resolveScene: async (scene, context) => {
      visualCalls.push({
        scene: scene.index,
        regeneration: context.regeneration || null,
      });
      return {
        provider: 'fake-ai',
        type: 'ai-video',
        localPath: `scene-${scene.index}-attempt-${context.regeneration?.attempt || 0}.mp4`,
        generationId: `gen-${scene.index}-${context.regeneration?.attempt || 0}`,
        referenceImageUrl: `https://example.test/ref-${scene.index}.jpg`,
      };
    },
  };

  const realismQc = {
    model: 'vision-test',
    threshold: 82,
    maxRegenerations: 1,
    evaluateScene: async (scene) => {
      const seen = qcCallsByScene.get(scene.index) || 0;
      qcCallsByScene.set(scene.index, seen + 1);

      if (scene.index === 0 && seen === 0) {
        return {
          passed: false,
          overallScore: 60,
          scores: {},
          issues: [{ code: 'face', severity: 'high', evidence: 'warped face' }],
          regenerationGuidance: 'Keep the face stable and anatomically correct.',
        };
      }

      return {
        passed: true,
        overallScore: 94,
        scores: {},
        issues: [],
        regenerationGuidance: '',
      };
    },
  };

  const pipeline = new VideoPipeline({
    llm: new TemplateLlmProvider(),
    renderer: null,
    visual,
    realismQc,
    voice: null,
    store: { saveProject: async () => {} },
  });

  const project = await pipeline.generate({
    topic: 'commercial aviation',
    durationSeconds: 30,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.equal(project.scenes[0].asset.qc.passed, true);
  assert.equal(project.scenes[0].asset.qcAttempts, 2);
  assert.equal(project.scenes[0].visualQcHistory.length, 2);

  const firstSceneCalls = visualCalls.filter((call) => call.scene === 0);
  assert.equal(firstSceneCalls.length, 2);
  assert.match(firstSceneCalls[1].regeneration.guidance, /face stable/i);
  assert.ok(project.warnings.some((warning) => warning.stage === 'visual-qc-regeneration'));
});

test('pipeline replaces repeatedly rejected AI with real stock footage when available', async () => {
  const visual = {
    strategy: 'ai-first',
    resolveScene: async (scene) => ({
      provider: 'fake-ai',
      type: 'ai-video',
      localPath: `ai-${scene.index}.mp4`,
      generationId: `ai-${scene.index}`,
      referenceImageUrl: `https://example.test/ref-${scene.index}.jpg`,
    }),
    resolveFallbackScene: async (scene, context) => ({
      provider: 'pexels',
      type: 'stock-video',
      localPath: `stock-${scene.index}.mp4`,
      routing: {
        selected: 'stock',
        fallbackUsed: true,
        fallbackReason: context.reason,
      },
    }),
  };

  const realismQc = {
    model: 'vision-test',
    threshold: 82,
    maxRegenerations: 1,
    evaluateScene: async () => ({
      passed: false,
      overallScore: 55,
      scores: {},
      issues: [{ code: 'geometry', severity: 'high', evidence: 'warped environment' }],
      regenerationGuidance: 'Keep all architecture geometrically stable.',
    }),
  };

  const pipeline = new VideoPipeline({
    llm: new TemplateLlmProvider(),
    renderer: null,
    visual,
    realismQc,
    voice: null,
    store: { saveProject: async () => {} },
  });

  const project = await pipeline.generate({
    topic: 'modern architecture',
    durationSeconds: 30,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.ok(project.scenes.every((scene) => scene.asset.provider === 'pexels'));
  assert.ok(project.scenes.every((scene) => scene.asset.rejectedAiQc.overallScore === 55));
  assert.ok(project.scenes.every((scene) => scene.visualQcHistory.length === 2));
});

test('pipeline stops instead of rendering when realism QC fails and no fallback exists', async () => {
  const visual = {
    strategy: 'ai-first',
    resolveScene: async (scene) => ({
      provider: 'fake-ai',
      type: 'ai-video',
      localPath: `ai-${scene.index}.mp4`,
      generationId: `ai-${scene.index}`,
      referenceImageUrl: `https://example.test/ref-${scene.index}.jpg`,
    }),
  };

  const realismQc = {
    model: 'vision-test',
    threshold: 82,
    maxRegenerations: 0,
    evaluateScene: async () => ({
      passed: false,
      overallScore: 40,
      scores: {},
      issues: [{ code: 'anatomy', severity: 'critical', evidence: 'impossible limb structure' }],
      regenerationGuidance: 'Use anatomically plausible human proportions.',
    }),
  };

  let rendered = false;
  const pipeline = new VideoPipeline({
    llm: new TemplateLlmProvider(),
    renderer: { render: async () => { rendered = true; } },
    visual,
    realismQc,
    voice: null,
    store: { saveProject: async () => {} },
  });

  const project = await pipeline.generate({
    topic: 'a person walking through an office',
    durationSeconds: 30,
    render: true,
  });

  assert.equal(project.status, 'VISUAL_QC_FAILED');
  assert.equal(rendered, false);
  assert.ok(project.visualQcFailures.length > 0);
});


test('story bible normalizes recurring entities and binds them to scenes', async () => {
  const generator = new StoryBibleGenerator({
    llm: {
      generateStoryBible: async () => ({
        characters: [{
          id: 'Pilot One',
          name: 'Pilot',
          description: 'A professional pilot in their late thirties.',
          wardrobe: 'White pilot shirt with navy epaulettes.',
          physicalTraits: 'Short dark hair, warm medium skin tone.',
        }],
        locations: [{
          id: 'Cockpit A',
          name: 'Airliner cockpit',
          description: 'Modern commercial aircraft cockpit with dark instrument panels.',
          lighting: 'Soft daylight through front windows.',
          fixedElements: ['two pilot seats', 'central throttle quadrant'],
        }],
        visualStyle: {
          description: 'Photorealistic documentary footage.',
          cameraRules: '50mm documentary lens feel.',
          lightingRules: 'Natural daylight only.',
        },
        sceneBindings: [
          { sceneIndex: 0, characterIds: ['Pilot One'], locationId: 'Cockpit A' },
        ],
      }),
    },
  });

  const script = {
    topic: 'aviation',
    durationSeconds: 20,
    hook: 'A pilot checks the cockpit before departure.',
    body: ['The instruments are reviewed.', 'The aircraft starts moving.'],
    payoff: 'Every step is deliberate.',
    cta: 'Follow for more.',
  };

  const bible = await generator.generate({ script });
  const scenes = planScenes(script, bible);

  assert.equal(bible.characters[0].id, 'pilot-one');
  assert.equal(bible.locations[0].id, 'cockpit-a');
  assert.deepEqual(scenes[0].continuity.characterIds, ['pilot-one']);
  assert.equal(scenes[0].continuity.locationId, 'cockpit-a');
  assert.equal(scenes[1].continuity.locationId, 'cockpit-a');
});

test('Luma prepares reusable canonical character and location references', async () => {
  const provider = new LumaRealisticVideoProvider({
    apiKey: 'luma-key',
    characterReferenceCount: 2,
    fetchImpl: async () => {
      throw new Error('network should not be called');
    },
  });

  let counter = 0;
  provider.createReferenceImage = async ({ prompt }) => {
    counter += 1;
    assert.match(prompt, /Photorealistic canonical/i);
    return {
      id: `ref-gen-${counter}`,
      url: `https://cdn.example/ref-${counter}.jpg`,
    };
  };

  const prepared = await provider.prepareStoryBible({
    characters: [{
      id: 'pilot',
      name: 'Pilot',
      description: 'Late-thirties airline pilot.',
      wardrobe: 'White shirt and navy epaulettes.',
      physicalTraits: 'Short dark hair.',
    }],
    locations: [{
      id: 'cockpit',
      name: 'Cockpit',
      description: 'Modern commercial cockpit.',
      lighting: 'Daylight.',
      fixedElements: ['two seats', 'throttle quadrant'],
    }],
    visualStyle: {
      description: 'Photorealistic documentary.',
      cameraRules: '50mm lens.',
      lightingRules: 'Natural light.',
    },
    sceneBindings: [],
  }, { projectId: 'vid_bible' });

  assert.equal(prepared.referenceStatus, 'ready');
  assert.equal(prepared.references.characters.pilot.images.length, 2);
  assert.equal(prepared.references.locations.cockpit.url, 'https://cdn.example/ref-3.jpg');
  assert.equal(counter, 3);
});

test('Luma scene combines character bible, location bible and previous accepted scene reference', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-bible-scene-'));
  try {
    const provider = new LumaRealisticVideoProvider({
      apiKey: 'luma-key',
      assetDir: dir,
      continuityWeight: 0.61,
      locationReferenceWeight: 0.84,
      fetchImpl: async () => {
        throw new Error('network should not be called');
      },
    });

    let captured = null;
    provider.createReferenceImage = async (input) => {
      captured = input;
      return { id: 'scene-ref-gen', url: 'https://cdn.example/scene-ref.jpg' };
    };
    provider.createVideo = async ({ prompt, referenceImageUrl }) => {
      assert.match(prompt, /Recurring character Pilot/i);
      assert.match(prompt, /Recurring location Cockpit/i);
      assert.equal(referenceImageUrl, 'https://cdn.example/scene-ref.jpg');
      return { id: 'video-gen', url: 'https://cdn.example/video.mp4' };
    };
    provider.download = async (_url, destination) => {
      await writeFile(destination, 'video');
    };

    const storyBible = {
      characters: [{
        id: 'pilot',
        name: 'Pilot',
        description: 'Late-thirties airline pilot.',
        wardrobe: 'White shirt and navy epaulettes.',
        physicalTraits: 'Short dark hair.',
      }],
      locations: [{
        id: 'cockpit',
        name: 'Cockpit',
        description: 'Modern commercial cockpit.',
        lighting: 'Soft daylight.',
        fixedElements: ['two seats', 'throttle quadrant'],
      }],
      visualStyle: {
        description: 'Photorealistic documentary.',
        cameraRules: '50mm lens family.',
        lightingRules: 'Natural daylight.',
      },
      references: {
        characters: {
          pilot: {
            images: [
              { url: 'https://cdn.example/pilot-portrait.jpg' },
              { url: 'https://cdn.example/pilot-body.jpg' },
            ],
          },
        },
        locations: {
          cockpit: { url: 'https://cdn.example/cockpit.jpg' },
        },
      },
    };

    const scene = {
      index: 1,
      narration: 'The pilot checks the instruments.',
      duration: 5,
      continuity: {
        characterIds: ['pilot'],
        locationId: 'cockpit',
      },
      realism: {
        referencePrompt: 'Photorealistic cockpit still.',
        motionPrompt: 'Continuous, seamless photorealistic cockpit shot.',
      },
    };

    const asset = await provider.resolveScene(scene, {
      projectId: 'vid_bible',
      storyBible,
      previousAsset: {
        referenceGenerationId: 'previous-gen',
        referenceImageUrl: 'https://cdn.example/previous-scene.jpg',
      },
    });

    assert.equal(captured.imageRefs.length, 2);
    assert.deepEqual(captured.imageRefs[0], {
      url: 'https://cdn.example/cockpit.jpg',
      weight: 0.84,
    });
    assert.deepEqual(captured.imageRefs[1], {
      url: 'https://cdn.example/previous-scene.jpg',
      weight: 0.61,
    });
    assert.deepEqual(captured.characterRef.identity0.images, [
      'https://cdn.example/pilot-portrait.jpg',
      'https://cdn.example/pilot-body.jpg',
    ]);
    assert.equal(asset.canonicalCharacterRefs, 1);
    assert.equal(asset.canonicalImageRefs, 2);
    assert.equal(asset.bibleBinding.locationId, 'cockpit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pipeline prepares the story bible before resolving scenes and persists the prepared references', async () => {
  let prepareCalls = 0;
  const seenBibles = [];

  const visual = {
    strategy: 'ai-first',
    prepareStoryBible: async (bible) => {
      prepareCalls += 1;
      return {
        ...bible,
        referenceStatus: 'ready',
        references: {
          provider: 'fake-ai',
          characters: {},
          locations: {
            'location-main': { url: 'https://example.test/location.jpg' },
          },
        },
      };
    },
    resolveScene: async (scene, context) => {
      seenBibles.push(context.storyBible);
      return {
        provider: 'fake-ai',
        type: 'ai-video',
        localPath: `scene-${scene.index}.mp4`,
        generationId: `gen-${scene.index}`,
        referenceImageUrl: `https://example.test/scene-${scene.index}.jpg`,
      };
    },
  };

  const pipeline = new VideoPipeline({
    llm: new TemplateLlmProvider(),
    renderer: null,
    visual,
    voice: null,
    store: { saveProject: async () => {} },
  });

  const project = await pipeline.generate({
    topic: 'aviation safety',
    durationSeconds: 30,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.equal(prepareCalls, 1);
  assert.equal(project.storyBible.referenceStatus, 'ready');
  assert.ok(seenBibles.length > 0);
  assert.ok(seenBibles.every((bible) => bible.references.locations['location-main'].url));
});


test('dense temporal timestamps cover the shot in chronological order', () => {
  const timestamps = denseTemporalTimestamps(5, 8);

  assert.equal(timestamps.length, 8);
  assert.ok(timestamps.every((value, index) => index === 0 || value > timestamps[index - 1]));
  assert.ok(timestamps[0] <= 0.2);
  assert.ok(timestamps.at(-1) >= 4.8);
});

test('frame sampler extracts a dense ordered temporal sequence', async () => {
  const sampler = new FrameSampler({
    temporalFrameCount: 6,
    temporalMaxWidth: 384,
    runCommand: async (_command, args) => {
      const outputPath = args.at(-1);
      await writeFile(outputPath, `temporal-${args[2]}`);
    },
  });

  const frames = await sampler.sampleTemporal('/fake/video.mp4', { durationSeconds: 5 });

  assert.equal(frames.length, 6);
  assert.ok(frames.every((frame, index) => index === 0 || frame.timestamp > frames[index - 1].timestamp));
  assert.ok(frames.every((frame) => frame.dataUrl.startsWith('data:image/jpeg;base64,')));
});

test('temporal QC rejects a scene that looks good in stills but morphs during motion', async () => {
  const requests = [];
  const qc = new OpenRouterRealismQcProvider({
    apiKey: 'router-key',
    model: 'vision-model',
    threshold: 82,
    temporalThreshold: 80,
    temporalEnabled: true,
    frameSampler: {
      sample: async () => [
        { index: 0, timestamp: 1, dataUrl: 'data:image/jpeg;base64,S1' },
        { index: 1, timestamp: 2.5, dataUrl: 'data:image/jpeg;base64,S2' },
        { index: 2, timestamp: 4, dataUrl: 'data:image/jpeg;base64,S3' },
      ],
      sampleTemporal: async () => Array.from({ length: 6 }, (_, index) => ({
        index,
        timestamp: 0.2 + (index * 0.8),
        dataUrl: `data:image/jpeg;base64,T${index}`,
      })),
    },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              overallScore: 93,
              temporalScore: 54,
              scores: {
                photorealism: 95,
                anatomy: 93,
                geometry: 94,
                physics: 91,
                motionConsistency: 86,
                continuity: 92,
                sceneRelevance: 96,
                artifactFreedom: 91,
              },
              temporalScores: {
                identityStability: 42,
                objectPersistence: 80,
                geometryStability: 67,
                motionPlausibility: 55,
                cameraContinuity: 83,
                flickerFreedom: 49,
                temporalArtifactFreedom: 41,
                actionContinuity: 72,
              },
              issues: [],
              temporalIssues: [
                {
                  code: 'face-morph',
                  severity: 'high',
                  evidence: 'facial geometry changes between temporal frames 3 and 4',
                },
                {
                  code: 'texture-flicker',
                  severity: 'medium',
                  evidence: 'skin texture pulses between adjacent frames',
                },
              ],
              summary: 'Individual frames are realistic.',
              temporalSummary: 'Motion contains visible identity morphing and flicker.',
              regenerationGuidance: 'Lock facial identity and eliminate frame-to-frame texture flicker while keeping the same action.',
            }),
          },
        }],
      });
    },
  });

  const result = await qc.evaluateScene(
    {
      narration: 'A pilot calmly checks the cockpit instruments.',
      duration: 5,
      continuity: { characterIds: ['pilot'], locationId: 'cockpit' },
      realism: { motionPrompt: 'Continuous photorealistic cockpit shot.' },
    },
    {
      type: 'ai-video',
      localPath: '/fake/scene.mp4',
      generatedDuration: '5s',
      prompt: 'Continuous photorealistic cockpit shot.',
      generationId: 'gen-temporal',
    },
    {
      storyBible: {
        characters: [{
          id: 'pilot',
          name: 'Pilot',
          description: 'Late-thirties airline pilot.',
          wardrobe: 'White pilot shirt.',
          physicalTraits: 'Short dark hair.',
        }],
        locations: [{
          id: 'cockpit',
          name: 'Cockpit',
          description: 'Commercial aircraft cockpit.',
          lighting: 'Daylight.',
          fixedElements: ['two seats'],
        }],
        visualStyle: {
          description: 'Photorealistic documentary.',
          cameraRules: 'Stable 50mm lens feel.',
          lightingRules: 'Natural daylight.',
        },
      },
    },
  );

  assert.equal(result.overallScore, 93);
  assert.equal(result.staticPassed, true);
  assert.equal(result.temporalScore, 54);
  assert.equal(result.temporalPassed, false);
  assert.equal(result.passed, false);
  assert.equal(result.temporalIssues[0].code, 'face-morph');
  assert.match(result.regenerationGuidance, /facial identity/i);

  const parts = requests[0].body.messages[1].content;
  assert.equal(parts.filter((part) => part.type === 'image_url').length, 9);
  assert.ok(parts.some((part) => part.type === 'text' && /strictly chronological/i.test(part.text)));
});

test('pipeline uses temporal QC guidance for targeted regeneration', async () => {
  const regenerations = [];
  const calls = new Map();

  const visual = {
    strategy: 'ai-first',
    resolveScene: async (scene, context) => {
      regenerations.push({
        sceneIndex: scene.index,
        regeneration: context.regeneration || null,
      });
      return {
        provider: 'fake-ai',
        type: 'ai-video',
        localPath: `temporal-${scene.index}-${context.regeneration?.attempt || 0}.mp4`,
        generationId: `temporal-${scene.index}-${context.regeneration?.attempt || 0}`,
        referenceImageUrl: `https://example.test/temporal-ref-${scene.index}.jpg`,
      };
    },
  };

  const realismQc = {
    model: 'vision-test',
    threshold: 82,
    temporalEnabled: true,
    temporalThreshold: 80,
    maxRegenerations: 1,
    evaluateScene: async (scene) => {
      const count = calls.get(scene.index) || 0;
      calls.set(scene.index, count + 1);

      if (scene.index === 0 && count === 0) {
        return {
          passed: false,
          staticPassed: true,
          temporalPassed: false,
          overallScore: 94,
          temporalScore: 48,
          scores: {},
          temporalScores: { identityStability: 35 },
          issues: [],
          temporalIssues: [{
            code: 'face-morph',
            severity: 'high',
            evidence: 'face changes during motion',
          }],
          regenerationGuidance: 'Preserve the exact same face in every frame and remove morphing.',
        };
      }

      return {
        passed: true,
        staticPassed: true,
        temporalPassed: true,
        overallScore: 94,
        temporalScore: 92,
        scores: {},
        temporalScores: {},
        issues: [],
        temporalIssues: [],
        regenerationGuidance: '',
      };
    },
  };

  const pipeline = new VideoPipeline({
    llm: new TemplateLlmProvider(),
    renderer: null,
    visual,
    realismQc,
    voice: null,
    store: { saveProject: async () => {} },
  });

  const project = await pipeline.generate({
    topic: 'a realistic pilot in a cockpit',
    durationSeconds: 30,
    render: false,
  });

  assert.equal(project.status, 'READY');
  const firstSceneCalls = regenerations.filter((entry) => entry.sceneIndex === 0);
  assert.equal(firstSceneCalls.length, 2);
  assert.match(firstSceneCalls[1].regeneration.guidance, /same face/i);
  assert.equal(project.scenes[0].visualQcHistory[0].temporalPassed, false);
  assert.equal(project.scenes[0].visualQcHistory[1].temporalPassed, true);
});


test('scene classifier distinguishes people, action, objects and environments', () => {
  assert.equal(classifyScene({
    narration: 'The pilot calmly checks the controls.',
    continuity: { characterIds: ['pilot'] },
  }), 'human');
  assert.equal(classifyScene({
    narration: 'The athlete starts running at full speed.',
    continuity: { characterIds: ['athlete'] },
  }), 'human-action');
  assert.equal(classifyScene({ narration: 'A smartphone rotates on the table.' }), 'object');
  assert.equal(classifyScene({ narration: 'A wide mountain landscape at sunrise.' }), 'environment');
});

test('Luma Agents provider uses current ray-3.2 image-to-video contract', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-luma-agents-'));
  const requests = [];
  try {
    const provider = new LumaAgentsVideoProvider({
      apiKey: 'agents-key',
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 2,
      sleepImpl: async () => {},
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ target, method: options.method || 'GET', body });

        if (target.endsWith('/generations') && options.method === 'POST') {
          if (body.type === 'image') return jsonResponse({ id: 'img-current', state: 'queued' }, 201);
          if (body.type === 'video') {
            assert.equal(body.model, 'ray-3.2');
            assert.equal(body.aspect_ratio, '9:16');
            assert.equal(body.video.resolution, '720p');
            assert.equal(body.video.duration, '5s');
            assert.equal(body.video.start_frame.url, 'https://cdn.example/current-ref.jpg');
            return jsonResponse({ id: 'vid-current', state: 'queued' }, 201);
          }
        }
        if (target.endsWith('/generations/img-current')) {
          return jsonResponse({
            id: 'img-current',
            state: 'completed',
            output: [{ type: 'image', url: 'https://cdn.example/current-ref.jpg' }],
          });
        }
        if (target.endsWith('/generations/vid-current')) {
          return jsonResponse({
            id: 'vid-current',
            state: 'completed',
            output: [{ type: 'video', url: 'https://cdn.example/current-video.mp4' }],
          });
        }
        if (target === 'https://cdn.example/current-video.mp4') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('ray-3.2-video').buffer,
          };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const scene = {
      index: 0,
      narration: 'A realistic pilot looks at the cockpit instruments.',
      continuity: { characterIds: [], locationId: null },
      realism: {
        referencePrompt: 'Photorealistic pilot cockpit still.',
        motionPrompt: 'Continuous realistic cockpit motion.',
      },
    };

    const asset = await provider.resolveScene(scene, { projectId: 'current' });

    assert.equal(asset.providerModelId, 'luma-ray-3.2');
    assert.equal(asset.model, 'ray-3.2');
    assert.equal(await readFile(asset.localPath, 'utf8'), 'ray-3.2-video');
    assert.equal(provider.estimateCostUsd(), 0.3);
    assert.ok(requests.some((request) => request.body?.type === 'video'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Runway provider creates and polls a Gen-4.5 image-to-video task', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-runway-'));
  const requests = [];
  try {
    const provider = new RunwayVideoProvider({
      apiKey: 'runway-key',
      model: 'gen4.5',
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 2,
      sleepImpl: async () => {},
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({
          target,
          method: options.method || 'GET',
          body,
          version: options.headers?.['x-runway-version'],
        });

        if (target.endsWith('/image_to_video') && options.method === 'POST') {
          assert.equal(body.model, 'gen4.5');
          assert.equal(body.promptImage, 'https://cdn.example/runway-ref.jpg');
          assert.equal(body.ratio, '720:1280');
          assert.equal(body.duration, 5);
          return jsonResponse({ id: 'runway-video-task' }, 200);
        }
        if (target.endsWith('/tasks/runway-video-task')) {
          return jsonResponse({
            id: 'runway-video-task',
            status: 'SUCCEEDED',
            output: ['https://cdn.example/runway-video.mp4'],
          });
        }
        if (target === 'https://cdn.example/runway-video.mp4') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('runway-video').buffer,
          };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const asset = await provider.animateReference(
      {
        index: 0,
        narration: 'A person walks naturally through a real office.',
        realism: { motionPrompt: 'Continuous photorealistic office shot.' },
      },
      { id: 'ref-task', url: 'https://cdn.example/runway-ref.jpg' },
    );

    assert.equal(asset.providerModelId, 'runway-gen4.5');
    assert.equal(asset.model, 'gen4.5');
    assert.equal(provider.estimateCostUsd(), 0.6);
    assert.equal(await readFile(asset.localPath, 'utf8'), 'runway-video');
    assert.ok(requests.every((request) => !request.target.includes('runwayml.com/v1') || request.version === '2024-11-06'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('video model router chooses stronger human model but cheap model for generic scenes', async () => {
  const calls = [];
  const referenceProvider = {
    prepareSceneReference: async () => ({ id: 'ref', url: 'https://example.test/ref.jpg' }),
  };

  const quality = {
    id: 'quality',
    profile: {
      id: 'quality',
      estimatedCostUsd5s: 0.6,
      strengths: {
        human: 0.98, action: 0.96, environment: 0.92, object: 0.9,
        general: 0.92, continuity: 0.95, temporal: 0.97,
      },
    },
    animateReference: async () => {
      calls.push('quality');
      return { type: 'ai-video', providerModelId: 'quality', localPath: 'quality.mp4' };
    },
  };

  const cheap = {
    id: 'cheap',
    profile: {
      id: 'cheap',
      estimatedCostUsd5s: 0.1,
      strengths: {
        human: 0.75, action: 0.77, environment: 0.86, object: 0.86,
        general: 0.9, continuity: 0.8, temporal: 0.82,
      },
    },
    animateReference: async () => {
      calls.push('cheap');
      return { type: 'ai-video', providerModelId: 'cheap', localPath: 'cheap.mp4' };
    },
  };

  const router = new VideoModelRouter({
    providers: [quality, cheap],
    referenceProvider,
    costWeight: 25,
    historyWeight: 0,
  });

  const human = await router.resolveScene({
    narration: 'A woman speaks naturally to the camera.',
    continuity: { characterIds: ['woman'] },
  });
  assert.equal(human.routing.providerId, 'quality');

  const generic = await router.resolveScene({
    narration: 'A simple abstract background slowly changes.',
    continuity: { characterIds: [] },
  });
  assert.equal(generic.routing.providerId, 'cheap');
  assert.deepEqual(calls, ['quality', 'cheap']);
});

test('router learns from QC history and can switch provider on regeneration', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-router-stats-'));
  try {
    const stats = new ProviderStatsStore(path.join(dir, 'stats.json'));
    for (let index = 0; index < 6; index += 1) {
      await stats.record('provider-a', {
        sceneClass: 'human',
        passed: false,
        overallScore: 62,
        temporalScore: 58,
      });
      await stats.record('provider-b', {
        sceneClass: 'human',
        passed: true,
        overallScore: 94,
        temporalScore: 92,
      });
    }

    const make = (id) => ({
      id,
      profile: {
        id,
        estimatedCostUsd5s: 0.3,
        strengths: {
          human: 0.9, action: 0.9, environment: 0.9, object: 0.9,
          general: 0.9, continuity: 0.9, temporal: 0.9,
        },
      },
      resolveScene: async () => ({
        type: 'ai-video',
        providerModelId: id,
        localPath: `${id}.mp4`,
      }),
    });

    const router = new VideoModelRouter({
      providers: [make('provider-a'), make('provider-b')],
      statsStore: stats,
      historyWeight: 35,
      costWeight: 0,
    });

    const chosen = await router.resolveScene({
      narration: 'A pilot speaks to camera.',
      continuity: { characterIds: ['pilot'] },
    });
    assert.equal(chosen.routing.providerId, 'provider-b');

    const switched = await router.resolveScene({
      narration: 'A pilot speaks to camera.',
      continuity: { characterIds: ['pilot'] },
    }, {
      regeneration: {
        previousProviderId: 'provider-b',
        issues: [{ code: 'face-morph', severity: 'high' }],
      },
    });

    assert.equal(switched.routing.providerId, 'provider-a');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('router records QC outcomes into persistent provider statistics', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-router-record-'));
  try {
    const stats = new ProviderStatsStore(path.join(dir, 'stats.json'));
    const router = new VideoModelRouter({
      providers: [],
      statsStore: stats,
    });

    await router.recordOutcome(
      { narration: 'A person smiles.', continuity: { characterIds: ['person'] } },
      {
        routing: { providerId: 'runway-gen4.5' },
        sceneClass: 'human',
        estimatedCostUsd: 0.6,
      },
      {
        passed: true,
        overallScore: 93,
        temporalScore: 91,
      },
    );

    const recorded = await stats.get('runway-gen4.5');
    assert.equal(recorded.attempts, 1);
    assert.equal(recorded.passes, 1);
    assert.equal(recorded.estimatedSpendUsd, 0.6);
    assert.equal(recorded.sceneClasses.human.attempts, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('subtitle cues follow script punctuation and never cross scene boundaries', () => {
  const words = punctuateWordsFromScript([
    { word: 'Those', start: 0, end: 0.3 },
    { word: 'facts', start: 0.3, end: 0.6 },
    { word: 'are', start: 0.6, end: 0.8 },
    { word: 'connected', start: 0.8, end: 1.3 },
    { word: 'Hemocyanin', start: 1.5, end: 2.1 },
    { word: 'a', start: 2.2, end: 2.3 },
    { word: 'copper', start: 2.3, end: 2.6 },
    { word: 'based', start: 2.6, end: 2.9 },
    { word: 'molecule', start: 2.9, end: 3.4 },
  ], 'Those facts are connected. Hemocyanin, a copper-based molecule.');

  assert.deepEqual(words.map((item) => item.word), [
    'Those', 'facts', 'are', 'connected.', 'Hemocyanin,', 'a', 'copper', 'based', 'molecule.',
  ]);

  const subtitles = buildSubtitles({
    voice: {
      wordTimings: [
        { word: 'blood', start: 0, end: 0.4 },
        { word: 'onward', start: 0.4, end: 0.9, boundary: true },
        { word: 'next', start: 1, end: 1.3 },
      ],
    },
    config: { maxWordsPerCue: 5, maxCharsPerCue: 40 },
  });
  assert.deepEqual(subtitles.cues.map((cue) => cue.text), ['blood onward', 'next']);

  const clauses = buildSubtitles({
    voice: { wordTimings: words },
    config: { maxWordsPerCue: 5, maxCharsPerCue: 40 },
  });
  assert.deepEqual(clauses.cues.map((cue) => cue.text), [
    'Those facts are connected.', 'Hemocyanin,', 'a copper based molecule.',
  ]);
});

test('subtitle builder keeps zero-length transcription words', () => {
  const subtitles = buildSubtitles({
    voice: {
      wordTimings: [
        { word: 'An', start: 0, end: 1.4 },
        { word: 'octopus', start: 1.4, end: 1.4 },
        { word: 'has', start: 1.4, end: 1.82 },
      ],
    },
    scenes: [],
    config: { maxWordsPerCue: 3, maxCharsPerCue: 40 },
  });

  assert.deepEqual(subtitles.cues.flatMap((cue) => cue.lines.flat().map((item) => item.word)), ['An', 'octopus', 'has']);
  assert.ok(subtitles.events.every((event) => event.end > event.start));
});

test('subtitle builder uses exact voice word timings and creates word-highlight events', () => {
  const subtitles = buildSubtitles({
    voice: {
      wordTimings: [
        { word: 'This', start: 0.0, end: 0.25 },
        { word: 'looks', start: 0.25, end: 0.52 },
        { word: 'real', start: 0.52, end: 0.82 },
        { word: 'because', start: 0.9, end: 1.2 },
        { word: 'timing', start: 1.2, end: 1.52 },
        { word: 'matters.', start: 1.52, end: 1.9 },
      ],
    },
    scenes: [],
    config: {
      maxWordsPerCue: 3,
      maxCharsPerCue: 40,
    },
  });

  assert.equal(subtitles.source, 'voice-word-timings');
  assert.equal(subtitles.cues.length, 2);
  assert.equal(subtitles.events.length, 6);
  assert.equal(subtitles.events[0].start, 0);
  assert.equal(subtitles.events[0].end, 0.25);
  assert.match(subtitles.events[0].assText, /&H0000FFFF/);
  assert.match(subtitles.events[0].assText, /This/);
  assert.match(subtitles.events[1].assText, /looks/);
});

test('subtitle builder falls back to scene-estimated timing without TTS word alignment', () => {
  const subtitles = buildSubtitles({
    voice: null,
    scenes: [
      {
        start: 0,
        duration: 2,
        narration: 'A realistic pilot checks the controls.',
      },
      {
        start: 2,
        duration: 2,
        narration: 'The aircraft starts moving.',
      },
    ],
    config: { maxWordsPerCue: 4 },
  });

  assert.equal(subtitles.source, 'scene-estimate');
  assert.ok(subtitles.cues.length >= 2);
  assert.ok(subtitles.events.length >= 9);
  assert.equal(subtitles.events[0].start, 0);
  assert.ok(subtitles.events.at(-1).end <= 4.001);
});

test('subtitle documents emit ASS styling and standard SRT sidecar', () => {
  const subtitles = buildSubtitles({
    voice: {
      wordTimings: [
        { word: 'Hello', start: 0, end: 0.5 },
        { word: 'world.', start: 0.5, end: 1.0 },
      ],
    },
  });

  const ass = renderAssDocument(subtitles);
  const srt = renderSrtDocument(subtitles);

  assert.match(ass, /\[V4\+ Styles\]/);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:00\.50/);
  assert.match(srt, /00:00:00,000 --> 00:00:01,000/);
  assert.match(srt, /Hello world\./);
});

test('renderer burns ASS subtitles after scene composition and writes ASS/SRT sidecars', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-subtitles-'));
  const commands = [];
  try {
    const renderer = new FfmpegRenderer({
      outputDir: dir,
      runCommand: async (command, args) => commands.push({ command, args }),
    });

    const subtitles = buildSubtitles({
      voice: {
        wordTimings: [
          { word: 'Realistic', start: 0, end: 0.5 },
          { word: 'subtitles.', start: 0.5, end: 1 },
        ],
      },
    });

    const result = await renderer.render({
      id: 'vid_subtitles',
      topic: 'test',
      scenes: [
        { index: 0, start: 0, duration: 1, narration: 'Realistic subtitles.', asset: null },
      ],
      voice: {
        audioPath: '/fake/voice.mp3',
        wordTimings: [],
      },
      subtitles,
    });

    assert.equal(result.subtitleSource, 'voice-word-timings');
    assert.equal(result.subtitleCueCount, 1);
    assert.match(await readFile(result.subtitleAssPath, 'utf8'), /Dialogue:/);
    assert.match(await readFile(result.subtitleSrtPath, 'utf8'), /Realistic subtitles\./);

    assert.equal(commands.length, 3);
    const sceneArgs = commands[0].args.join(' ');
    assert.doesNotMatch(sceneArgs, /drawtext|drawbox/);

    const finalArgs = commands[2].args;
    const filterIndex = finalArgs.indexOf('-vf');
    assert.ok(filterIndex >= 0);
    assert.match(finalArgs[filterIndex + 1], /ass=filename=/);
    assert.ok(finalArgs.includes('libx264'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pipeline always prepares subtitle metadata before render', async () => {
  const voice = {
    synthesize: async () => ({
      provider: 'fake-voice',
      audioPath: '/fake/voice.mp3',
      durationSeconds: 3,
      wordTimings: [
        { word: 'A', start: 0, end: 0.2 },
        { word: 'short', start: 0.2, end: 0.5 },
        { word: 'video', start: 0.5, end: 0.8 },
        { word: 'with', start: 0.8, end: 1.0 },
        { word: 'subtitles.', start: 1.0, end: 1.4 },
      ],
    }),
  };

  const pipeline = new VideoPipeline({
    llm: new TemplateLlmProvider(),
    renderer: null,
    visual: null,
    voice,
    store: { saveProject: async () => {} },
    subtitleConfig: { maxWordsPerCue: 4 },
  });

  const project = await pipeline.generate({
    topic: 'subtitles for short videos',
    durationSeconds: 20,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.equal(project.subtitles.source, 'voice-word-timings');
  assert.ok(project.subtitles.cues.length > 0);
  assert.ok(project.subtitles.events.length > 0);
});


test('production screenplay normalizes exact dialogue, characters, locations and <=15s acts', async () => {
  const generator = new ProductionScriptGenerator({
    llm: {
      generateProductionScript: async () => ({
        title: 'Training in your thirties',
        synopsis: 'A trainer explains why starting now matters.',
        characters: [{
          id: 'Coach Alex',
          name: 'Alex',
          description: 'A realistic 34-year-old trainer.',
          physicalTraits: 'Short dark hair, athletic build, light beard.',
          wardrobe: 'White training shirt and black shorts.',
          voice: {
            presetId: 'Bernard',
            description: 'warm male voice',
            delivery: 'confident and conversational',
            languageCode: 'en',
          },
        }],
        locations: [{
          id: 'Gym Main',
          name: 'Neighborhood gym',
          description: 'Brick-walled neighborhood gym.',
          lighting: 'Soft morning window light.',
          fixedElements: ['black dumbbell rack', 'large windows'],
        }],
        visualStyle: {
          description: 'Photorealistic documentary.',
          cameraRules: '50mm lens feel.',
          lightingRules: 'Natural light.',
        },
        audioDirection: {
          mix: 'Dialogue clear over realistic gym ambience.',
          musicPolicy: 'Music low under speech.',
        },
        segments: [{
          durationSeconds: 18,
          purpose: 'hook',
          speakerCharacterId: 'Coach Alex',
          characterIds: ['Coach Alex'],
          locationId: 'Gym Main',
          dialogue: 'Your thirties are not too late to start training.',
          action: 'Alex picks up a dumbbell and looks to camera.',
          camera: 'Medium close-up, subtle push-in.',
          ambience: 'Quiet working gym.',
          soundEffects: ['soft dumbbell rack contact'],
          music: 'restrained energetic pulse',
        }],
      }),
    },
  });

  const script = await generator.generate({
    topic: 'why your 30s are a great time to start training',
    audience: 'busy adults',
    durationSeconds: 30,
  });

  assert.equal(script.characters[0].id, 'coach-alex');
  assert.equal(script.locations[0].id, 'gym-main');
  assert.equal(script.segments[0].durationSeconds, 15);
  assert.equal(script.segments[0].speakerCharacterId, 'coach-alex');
  assert.equal(script.segments[0].editing.allowInternalCuts, false);
  assert.equal(script.segments[0].editing.allowDissolves, false);
  assert.equal(script.segments[0].editing.shotCount, 1);
  assert.match(script.fullDialogue, /not too late/i);

  const bible = productionScriptToStoryBible(script);
  assert.deepEqual(bible.sceneBindings[0].characterIds, ['coach-alex']);
  assert.equal(bible.sceneBindings[0].locationId, 'gym-main');
});

test('Runway audiovisual provider creates exact dialogue audio then WAN 3 native-audio video', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-av-provider-'));
  const requests = [];
  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 2,
      sleepImpl: async () => {},
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ target, method: options.method || 'GET', body });

        if (target.endsWith('/text_to_speech') && options.method === 'POST') {
          assert.equal(body.model, 'eleven_v3');
          assert.equal(body.promptText, 'Your thirties are a powerful time to start training.');
          assert.equal(body.voice.presetId, 'Bernard');
          return jsonResponse({ id: 'tts-task' }, 200);
        }
        if (target.endsWith('/tasks/tts-task')) {
          return jsonResponse({
            id: 'tts-task',
            status: 'SUCCEEDED',
            output: ['https://cdn.example/dialogue.mp3'],
          });
        }
        if (target.endsWith('/text_to_video') && options.method === 'POST') {
          assert.equal(body.model, 'wan3');
          assert.equal(body.audio, true);
          assert.equal(body.duration, 8);
          assert.equal(body.ratio, '720:1280');
          assert.equal(body.referenceAudio[0].type, 'audio');
          assert.equal(body.referenceAudio[0].uri, 'https://cdn.example/dialogue.mp3');
          assert.match(body.promptText, /EXACT SPOKEN DIALOGUE/);
          assert.match(body.promptText, /Preserve those words verbatim/i);
          return jsonResponse({ id: 'wan-task' }, 200);
        }
        if (target.endsWith('/tasks/wan-task')) {
          return jsonResponse({
            id: 'wan-task',
            status: 'SUCCEEDED',
            output: ['https://cdn.example/av.mp4'],
          });
        }
        if (target === 'https://cdn.example/av.mp4') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('native-av').buffer,
          };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const productionScript = {
      characters: [{
        id: 'alex',
        name: 'Alex',
        description: '34-year-old trainer',
        physicalTraits: 'short dark hair',
        wardrobe: 'white shirt and black shorts',
        voice: {
          presetId: 'Bernard',
          description: 'warm',
          delivery: 'natural',
          languageCode: 'en',
        },
      }],
      locations: [{
        id: 'gym',
        name: 'Gym',
        description: 'real neighborhood gym',
        lighting: 'morning light',
        fixedElements: ['dumbbell rack'],
      }],
      visualStyle: {
        description: 'Photorealistic documentary.',
        cameraRules: '50mm lens feel.',
        lightingRules: 'Natural daylight.',
      },
      audioDirection: {
        mix: 'Dialogue clear over ambience.',
        musicPolicy: 'Music below speech.',
      },
    };
    const segment = {
      index: 0,
      purpose: 'hook',
      durationSeconds: 8,
      dialogue: 'Your thirties are a powerful time to start training.',
      speakerCharacterId: 'alex',
      characterIds: ['alex'],
      locationId: 'gym',
      action: 'Alex picks up a dumbbell.',
      camera: 'Medium close-up.',
      ambience: 'Quiet gym ambience.',
      soundEffects: ['dumbbell contact'],
      music: 'subtle pulse',
    };

    const asset = await provider.generateSegment({
      segment,
      productionScript,
      projectId: 'vid-av',
    });

    assert.equal(asset.audioMode, 'locked-dialogue-native-mix');
    assert.equal(asset.model, 'wan3');
    assert.equal(asset.dialogueTrack.exactText, segment.dialogue);
    assert.equal(await readFile(asset.localPath, 'utf8'), 'native-av');
    assert.equal(requests.filter((request) => request.target.endsWith('/text_to_speech')).length, 1);
    assert.equal(requests.filter((request) => request.target.endsWith('/text_to_video')).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Runway audiovisual provider stretches a single-speaker act to fit measured dialogue audio', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-av-stretch-'));
  const requests = [];
  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      dialogueComposer: { ffprobeBin: 'ffprobe', probeDuration: async () => 9.4 },
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 2,
      sleepImpl: async () => {},
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ target, method: options.method || 'GET', body });

        if (target.endsWith('/text_to_speech') && options.method === 'POST') {
          assert.equal(body.model, 'eleven_v3');
          assert.equal(body.promptText, 'Your thirties are a powerful time to start training.');
          assert.equal(body.voice.presetId, 'Bernard');
          return jsonResponse({ id: 'tts-task' }, 200);
        }
        if (target.endsWith('/tasks/tts-task')) {
          return jsonResponse({
            id: 'tts-task',
            status: 'SUCCEEDED',
            output: ['https://cdn.example/dialogue.mp3'],
          });
        }
        if (target.endsWith('/text_to_video') && options.method === 'POST') {
          assert.equal(body.model, 'wan3');
          assert.equal(body.audio, true);
          assert.equal(body.duration, 10);
          assert.equal(body.ratio, '720:1280');
          assert.equal(body.referenceAudio[0].type, 'audio');
          assert.equal(body.referenceAudio[0].uri, 'https://cdn.example/dialogue.mp3');
          assert.match(body.promptText, /EXACT SPOKEN DIALOGUE/);
          assert.match(body.promptText, /Preserve those words verbatim/i);
          return jsonResponse({ id: 'wan-task' }, 200);
        }
        if (target.endsWith('/tasks/wan-task')) {
          return jsonResponse({
            id: 'wan-task',
            status: 'SUCCEEDED',
            output: ['https://cdn.example/av.mp4'],
          });
        }
        if (target === 'https://cdn.example/dialogue.mp3') {
          return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('voice').buffer };
        }
        if (target === 'https://cdn.example/av.mp4') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('native-av').buffer,
          };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const productionScript = {
      characters: [{
        id: 'alex',
        name: 'Alex',
        description: '34-year-old trainer',
        physicalTraits: 'short dark hair',
        wardrobe: 'white shirt and black shorts',
        voice: {
          presetId: 'Bernard',
          description: 'warm',
          delivery: 'natural',
          languageCode: 'en',
        },
      }],
      locations: [{
        id: 'gym',
        name: 'Gym',
        description: 'real neighborhood gym',
        lighting: 'morning light',
        fixedElements: ['dumbbell rack'],
      }],
      visualStyle: {
        description: 'Photorealistic documentary.',
        cameraRules: '50mm lens feel.',
        lightingRules: 'Natural daylight.',
      },
      audioDirection: {
        mix: 'Dialogue clear over ambience.',
        musicPolicy: 'Music below speech.',
      },
    };
    const segment = {
      index: 0,
      purpose: 'hook',
      durationSeconds: 8,
      dialogue: 'Your thirties are a powerful time to start training.',
      speakerCharacterId: 'alex',
      characterIds: ['alex'],
      locationId: 'gym',
      action: 'Alex picks up a dumbbell.',
      camera: 'Medium close-up.',
      ambience: 'Quiet gym ambience.',
      soundEffects: ['dumbbell contact'],
      music: 'subtle pulse',
    };

    const asset = await provider.generateSegment({
      segment,
      productionScript,
      projectId: 'vid-av',
    });

    assert.equal(asset.durationSeconds, 10);
    assert.equal(asset.dialogueTrack.durationSeconds, 9.4);
    assert.equal(asset.dialogueTrack.turns[0].end, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Runway audiovisual provider can use pure native speech mode without separate TTS', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-av-native-'));
  const requests = [];
  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      dialogueMode: 'native',
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 2,
      sleepImpl: async () => {},
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ target, body });
        if (target.endsWith('/text_to_video')) return jsonResponse({ id: 'native-task' });
        if (target.endsWith('/tasks/native-task')) {
          return jsonResponse({ id: 'native-task', status: 'SUCCEEDED', output: ['https://cdn.example/native.mp4'] });
        }
        if (target === 'https://cdn.example/native.mp4') {
          return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('native').buffer };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const segment = {
      index: 0,
      purpose: 'hook',
      durationSeconds: 6,
      dialogue: 'Say this exact sentence.',
      speakerCharacterId: 'person',
      characterIds: ['person'],
      locationId: 'room',
      action: 'Person speaks to camera.',
      camera: 'Medium close-up.',
      ambience: 'Room tone.',
      soundEffects: [],
      music: '',
    };
    const script = {
      characters: [{
        id: 'person', name: 'Person', description: 'adult presenter',
        physicalTraits: 'natural appearance', wardrobe: 'neutral clothes',
        voice: { presetId: 'Bernard', languageCode: 'en' },
      }],
      locations: [{
        id: 'room', name: 'Room', description: 'real room', lighting: 'daylight', fixedElements: [],
      }],
      visualStyle: { description: 'real', cameraRules: 'stable', lightingRules: 'natural' },
      audioDirection: { mix: 'clear speech', musicPolicy: 'low music' },
    };

    const asset = await provider.generateSegment({ segment, productionScript: script, projectId: 'native' });
    assert.equal(asset.audioMode, 'native');
    assert.equal(asset.dialogueTrack, null);
    assert.equal(requests.some((request) => request.target.endsWith('/text_to_speech')), false);
    const videoRequest = requests.find((request) => request.target.endsWith('/text_to_video'));
    assert.equal(videoRequest.body.audio, true);
    assert.equal(videoRequest.body.referenceAudio, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('audiovisual pipeline generates complete native-audio acts and subtitle timeline', async () => {
  const audiovisual = {
    generateSegment: async ({ segment, regeneration }) => ({
      provider: 'fake-av',
      providerModelId: 'fake-wan',
      type: 'ai-video',
      audioMode: 'locked-dialogue-native-mix',
      localPath: `/fake/act-${segment.index}-${regeneration?.attempt || 0}.mp4`,
      generationId: `act-${segment.index}-${regeneration?.attempt || 0}`,
      prompt: segment.dialogue,
    }),
  };

  const pipeline = new AudiovisualPipeline({
    llm: new TemplateLlmProvider(),
    audiovisual,
    renderer: null,
    store: { saveProject: async () => {} },
    visual: null,
    realismQc: null,
    subtitleConfig: { maxWordsPerCue: 4 },
  });

  const project = await pipeline.generate({
    topic: 'why training in your thirties matters',
    audience: 'busy adults',
    durationSeconds: 24,
    render: false,
  });

  assert.equal(project.mode, 'audiovisual-director');
  assert.equal(project.status, 'READY');
  assert.ok(project.productionScript.fullDialogue.length > 20);
  assert.ok(project.scenes.length >= 2);
  assert.ok(project.scenes.every((scene) => scene.asset.audioMode === 'locked-dialogue-native-mix'));
  assert.equal(project.subtitles.source, 'scene-estimate');
  assert.ok(project.subtitles.cues.length > 0);
});

test('audiovisual pipeline re-generates an act from realism QC feedback', async () => {
  const calls = [];
  const audiovisual = {
    generateSegment: async ({ segment, regeneration }) => {
      calls.push({ segment: segment.index, regeneration });
      return {
        type: 'ai-video',
        localPath: `/fake/${segment.index}-${regeneration?.attempt || 0}.mp4`,
        generationId: `g-${segment.index}-${regeneration?.attempt || 0}`,
        prompt: segment.dialogue,
      };
    },
  };
  const seen = new Map();
  const qc = {
    maxRegenerations: 1,
    evaluateScene: async (scene) => {
      const count = seen.get(scene.index) || 0;
      seen.set(scene.index, count + 1);
      if (scene.index === 0 && count === 0) {
        return {
          passed: false,
          overallScore: 70,
          temporalScore: 50,
          issues: [{ code: 'face', severity: 'high', evidence: 'face changed' }],
          temporalIssues: [{ code: 'lip-sync', severity: 'high', evidence: 'mouth motion unstable' }],
          regenerationGuidance: 'Preserve the same face and stabilize mouth motion.',
        };
      }
      return {
        passed: true,
        overallScore: 94,
        temporalScore: 92,
        issues: [],
        temporalIssues: [],
        regenerationGuidance: '',
      };
    },
  };

  const pipeline = new AudiovisualPipeline({
    llm: new TemplateLlmProvider(),
    audiovisual,
    renderer: null,
    store: { saveProject: async () => {} },
    realismQc: qc,
  });

  const project = await pipeline.generate({
    topic: 'realistic training advice',
    durationSeconds: 20,
    render: false,
  });

  assert.equal(project.status, 'READY');
  const first = calls.filter((call) => call.segment === 0);
  assert.equal(first.length, 2);
  assert.match(first[1].regeneration.guidance, /same face/i);
});

test('audiovisual renderer preserves native audio while composing acts and subtitles', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-av-render-'));
  const commands = [];
  try {
    let inspections = 0;
    const renderer = new AudiovisualRenderer({
      outputDir: dir,
      runCommand: async (command, args) => commands.push({ command, args }),
      audioInspector: {
        inspect: async () => {
          inspections += 1;
          return {
            passed: true,
            audible: true,
            integratedLufs: inspections === 1 ? -13.5 : -14,
            truePeakDbtp: inspections === 1 ? -0.1 : -1,
            issues: [],
          };
        },
      },
    });
    const subtitles = buildSubtitles({
      scenes: [{ start: 0, duration: 5, narration: 'Exact audiovisual dialogue.' }],
    });

    const result = await renderer.render({
      id: 'av-render',
      scenes: [{
        index: 0,
        start: 0,
        duration: 5,
        narration: 'Exact audiovisual dialogue.',
        asset: { localPath: '/fake/native-audio.mp4' },
      }],
      subtitles,
    });

    assert.equal(result.audioMode, 'native-audiovisual');
    assert.equal(commands.length, 3);
    const normalizeArgs = commands[0].args;
    assert.ok(normalizeArgs.includes('-c:a'));
    assert.ok(normalizeArgs.includes('aac'));
    assert.doesNotMatch(normalizeArgs.join(' '), /-an/);

    const finalArgs = commands[2].args;
    assert.ok(finalArgs.includes('-c:a'));
    assert.ok(finalArgs.includes('aac'));
    const audioFilterIndex = finalArgs.indexOf('-af');
    assert.ok(audioFilterIndex >= 0);
    assert.match(finalArgs[audioFilterIndex + 1], /loudnorm=I=-14:LRA=7:TP=-1/);
    assert.equal(inspections, 2);
    assert.equal(result.audioQuality.output.passed, true);
    assert.match(await readFile(result.subtitleSrtPath, 'utf8'), /Exact audiovisual dialogue/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('subtitle builder wraps by estimated pixel width and remains in two-line safe layout', () => {
  const subtitles = buildSubtitles({
    voice: {
      wordTimings: [
        { word: 'Start', start: 0, end: 0.2 },
        { word: 'smaller', start: 0.2, end: 0.4 },
        { word: 'than', start: 0.4, end: 0.6 },
        { word: 'your', start: 0.6, end: 0.8 },
        { word: 'excuses:', start: 0.8, end: 1.0 },
      ],
    },
    config: {
      maxWordsPerCue: 5,
      maxCharsPerCue: 60,
      fontSize: 64,
      maxWidthPx: 520,
      maxLines: 2,
    },
  });

  assert.equal(subtitles.layout.passed, true);
  assert.ok(subtitles.cues.some((cue) => cue.lines.length === 2));
  assert.ok(subtitles.events.some((event) => event.assText.includes('\\N')));
  for (const cue of subtitles.cues) {
    for (const line of cue.lines) {
      const width = estimateRenderedWidth(line.map((item) => item.word).join(' '), 64);
      assert.ok(width <= 520);
    }
  }
  assert.equal(evaluateSubtitleLayout(subtitles.cues, {
    fontSize: 64,
    maxWidthPx: 520,
    maxLines: 2,
  }).passed, true);
});

test('audio inspector can skip the true-peak ceiling for pre-normalization input', async () => {
  const inspector = new AudioQualityInspector({
    runCapture: async () => `
      Summary:
        I:         -16.0 LUFS
        Peak:       -0.4 dBFS
    `,
  });

  assert.equal((await inspector.inspect('raw.mp4')).passed, false);
  assert.equal((await inspector.inspect('raw.mp4', { checkTruePeak: false })).passed, true);
});

test('audio quality parser rejects silence and unsafe true peak while accepting social-ready audio', () => {
  const healthy = parseEbur128(`
    Summary:
      I:         -14.0 LUFS
      Peak:       -1.1 dBFS
  `);
  assert.equal(healthy.passed, true);
  assert.equal(healthy.integratedLufs, -14);
  assert.equal(healthy.truePeakDbtp, -1.1);

  const silent = parseEbur128(`
    Summary:
      I:         -70.0 LUFS
      Peak:      -55.0 dBFS
  `);
  assert.equal(silent.passed, false);
  assert.ok(silent.issues.some((issue) => issue.code === 'audio-silent'));

  const hot = parseEbur128(`
    Summary:
      I:         -13.5 LUFS
      Peak:       -0.1 dBFS
  `);
  assert.equal(hot.passed, false);
  assert.ok(hot.issues.some((issue) => issue.code === 'audio-true-peak'));
});

test('Runway audiovisual provider sends previous accepted act as WAN continuity video reference', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-av-continuity-'));
  const requests = [];
  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 2,
      sleepImpl: async () => {},
      dialogueMode: 'native',
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ target, body });
        if (target.endsWith('/text_to_video')) return jsonResponse({ id: 'continuity-task' });
        if (target.endsWith('/tasks/continuity-task')) {
          return jsonResponse({ id: 'continuity-task', status: 'SUCCEEDED', output: ['https://cdn.example/current.mp4'] });
        }
        if (target === 'https://cdn.example/current.mp4') {
          return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('current').buffer };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const segment = {
      index: 1,
      purpose: 'explain',
      durationSeconds: 6,
      dialogue: 'Keep moving for ten minutes.',
      speakerCharacterId: 'alex',
      characterIds: ['alex'],
      locationId: 'gym',
      action: 'Alex walks naturally through the gym.',
      camera: 'Medium tracking shot.',
      ambience: 'Gym ambience.',
      soundEffects: [],
      music: '',
      editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
    };
    const productionScript = {
      characters: [{
        id: 'alex', name: 'Alex', description: '34-year-old trainer',
        physicalTraits: 'short dark hair and light beard', wardrobe: 'black training shirt',
        voice: { presetId: 'Bernard', languageCode: 'en' },
      }],
      locations: [{
        id: 'gym', name: 'Gym', description: 'brick gym', lighting: 'morning daylight',
        fixedElements: ['black rack'],
      }],
      visualStyle: { description: 'photorealistic', cameraRules: 'natural lens', lightingRules: 'stable daylight' },
      audioDirection: { mix: 'clear dialogue', musicPolicy: 'music low' },
    };

    await provider.generateSegment({
      segment,
      productionScript,
      previousAsset: {
        generationId: 'previous-gen',
        sourceUrl: 'https://cdn.example/previous.mp4',
      },
      projectId: 'continuity',
    });

    const videoRequest = requests.find((request) => request.target.endsWith('/text_to_video'));
    assert.deepEqual(videoRequest.body.referenceVideos, [{
      type: 'video',
      uri: 'https://cdn.example/previous.mp4',
    }]);
    assert.match(videoRequest.body.promptText, /ONE continuous shot only/i);
    assert.match(videoRequest.body.promptText, /Dissolves and crossfades are forbidden/i);
    assert.match(videoRequest.body.promptText, /previous accepted act is supplied as a video reference/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cross-act QC rejects apparent-age or identity drift even when realism and motion pass', async () => {
  const qc = new OpenRouterRealismQcProvider({
    apiKey: 'router-key',
    model: 'vision-model',
    threshold: 82,
    temporalThreshold: 80,
    continuityThreshold: 85,
    temporalEnabled: true,
    frameSampler: {
      sample: async () => [
        { index: 0, timestamp: 1, dataUrl: 'data:image/jpeg;base64,CURRENT' },
      ],
      sampleTemporal: async () => [
        { index: 0, timestamp: 0.2, dataUrl: 'data:image/jpeg;base64,TEMP' },
      ],
      sampleComparison: async () => [
        { index: 0, timestamp: 1, dataUrl: 'data:image/jpeg;base64,PREVIOUS' },
      ],
    },
    fetchImpl: async () => jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            overallScore: 94,
            temporalScore: 92,
            scores: {
              photorealism: 95,
              anatomy: 94,
              geometry: 94,
              physics: 91,
              motionConsistency: 92,
              continuity: 80,
              identityContinuity: 62,
              locationContinuity: 93,
              sceneRelevance: 96,
              artifactFreedom: 93,
            },
            temporalScores: {
              identityStability: 93,
              objectPersistence: 92,
              geometryStability: 92,
              motionPlausibility: 90,
              cameraContinuity: 91,
              flickerFreedom: 94,
              temporalArtifactFreedom: 93,
              actionContinuity: 92,
            },
            issues: [{
              code: 'apparent-age-drift',
              severity: 'high',
              evidence: 'the recurring character appears substantially older than in the previous act',
            }],
            temporalIssues: [],
            regenerationGuidance: 'Restore the exact apparent age and face geometry from the previous accepted act.',
          }),
        },
      }],
    }),
  });

  const result = await qc.evaluateScene(
    {
      narration: 'Alex continues the workout.',
      duration: 5,
      continuity: { characterIds: ['alex'], locationId: 'gym' },
      realism: { motionPrompt: 'Realistic gym shot.' },
    },
    {
      type: 'ai-video',
      localPath: '/fake/current.mp4',
      generatedDuration: '5s',
      prompt: 'Realistic gym shot.',
    },
    {
      previousAsset: {
        localPath: '/fake/previous.mp4',
        generatedDuration: '5s',
        generationId: 'previous',
      },
      storyBible: {
        characters: [{ id: 'alex', name: 'Alex', description: '34-year-old trainer', physicalTraits: 'short dark hair', wardrobe: 'black shirt' }],
        locations: [{ id: 'gym', name: 'Gym', description: 'brick gym', lighting: 'daylight', fixedElements: ['rack'] }],
        visualStyle: { description: 'photorealistic', cameraRules: 'natural', lightingRules: 'daylight' },
      },
    },
  );

  assert.equal(result.staticPassed, true);
  assert.equal(result.temporalPassed, true);
  assert.equal(result.identityContinuityPassed, false);
  assert.equal(result.continuityPassed, false);
  assert.equal(result.passed, false);
  assert.equal(result.previousFrames.length, 1);
});

test('publishability gate blocks meta-script leakage and unsafe subtitles', () => {
  const result = evaluateAudiovisualPublishability({
    productionScript: {
      fullDialogue: 'A strong short-form explanation should give one concrete example.',
      segments: [{ index: 0, locationId: 'gym', editing: { allowInternalCuts: false } }],
    },
    scenes: [{ index: 0, asset: { localPath: '/fake/act.mp4' }, visualQcHistory: [] }],
    subtitles: {
      enabled: true,
      layout: {
        passed: false,
        violations: [{ code: 'line-overflow', widthPx: 930, maxWidthPx: 840 }],
      },
    },
  });

  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'script-meta-language'));
  assert.ok(result.blockers.some((blocker) => blocker.code === 'subtitle-layout'));
});


test('dialogue comparison measures word-level fidelity and edit types', () => {
  const exact = compareDialogue(
    "Your thirties are a powerful time to start training.",
    "Your thirties are a powerful time to start training.",
  );
  assert.equal(exact.wer, 0);
  assert.deepEqual(exact.edits, []);

  const drifted = compareDialogue(
    "Your thirties are a powerful time to start training.",
    "Your thirties are a good time to train today.",
  );
  assert.ok(drifted.wer > 0.2);
  assert.ok(drifted.edits.some((edit) => ['substitute', 'delete', 'insert'].includes(edit.type)));
});

test('OpenAI transcription provider requests verbose word timestamps and passes exact dialogue', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-transcription-'));
  try {
    const filePath = path.join(dir, 'act.mp4');
    await writeFile(filePath, 'fake-video');
    let capturedForm = null;

    const provider = new OpenAiTranscriptionProvider({
      apiKey: 'openai-key',
      model: 'gpt-transcribe',
      maxWer: 0.12,
      fetchImpl: async (url, options) => {
        assert.equal(String(url), 'https://api.openai.com/v1/audio/transcriptions');
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.authorization, 'Bearer openai-key');
        capturedForm = options.body;
        return jsonResponse({
          text: 'Your thirties are a powerful time to start training.',
          language: 'en',
          duration: 4.2,
          words: [
            { word: 'Your', start: 0.1, end: 0.3 },
            { word: 'thirties', start: 0.3, end: 0.7 },
            { word: 'are', start: 0.7, end: 0.85 },
            { word: 'a', start: 0.85, end: 0.95 },
            { word: 'powerful', start: 0.95, end: 1.35 },
            { word: 'time', start: 1.35, end: 1.6 },
            { word: 'to', start: 1.6, end: 1.75 },
            { word: 'start', start: 1.75, end: 2.0 },
            { word: 'training.', start: 2.0, end: 2.45 },
          ],
          segments: [{
            text: 'Your thirties are a powerful time to start training.',
            start: 0.1,
            end: 2.45,
          }],
        });
      },
    });

    const result = await provider.evaluate(
      { localPath: filePath },
      {
        expectedText: 'Your thirties are a powerful time to start training.',
        language: 'en',
      },
    );

    assert.equal(capturedForm.get('model'), 'gpt-transcribe');
    assert.equal(capturedForm.get('response_format'), 'verbose_json');
    assert.deepEqual(
      capturedForm.getAll('timestamp_granularities[]'),
      ['word', 'segment'],
    );
    assert.equal(capturedForm.get('language'), 'en');
    assert.equal(result.passed, true);
    assert.equal(result.wer, 0);
    assert.equal(result.transcription.words.length, 9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OpenAI transcription provider falls back to json when the model rejects verbose_json', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-transcription-json-'));
  try {
    const filePath = path.join(dir, 'act.mp4');
    await writeFile(filePath, 'fake-video');
    const formats = [];

    const provider = new OpenAiTranscriptionProvider({
      apiKey: 'openai-key',
      model: 'gpt-transcribe',
      fetchImpl: async (url, options) => {
        const format = options.body.get('response_format');
        formats.push(format);
        if (format === 'verbose_json') {
          return {
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({ error: { message: "response_format 'verbose_json' is not compatible with model 'gpt-transcribe'. Use 'json' or 'text' instead." } }),
          };
        }
        assert.equal(options.body.getAll('timestamp_granularities[]').length, 0);
        return jsonResponse({ text: 'Octopuses have three hearts.' });
      },
    });

    const first = await provider.evaluate({ localPath: filePath }, { expectedText: 'Octopuses have three hearts.' });
    await provider.evaluate({ localPath: filePath }, { expectedText: 'Octopuses have three hearts.' });

    assert.equal(first.passed, true);
    assert.deepEqual(first.transcription.words, []);
    assert.deepEqual(formats, ['verbose_json', 'json', 'json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dialogue QC rejects paraphrased generated speech and returns targeted guidance', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-transcription-drift-'));
  try {
    const filePath = path.join(dir, 'act.mp4');
    await writeFile(filePath, 'fake-video');

    const provider = new OpenAiTranscriptionProvider({
      apiKey: 'openai-key',
      maxWer: 0.1,
      maxWordCountDelta: 0.1,
      fetchImpl: async () => jsonResponse({
        text: 'Starting exercise now is probably a pretty good idea.',
        language: 'en',
        duration: 4,
        words: [
          { word: 'Starting', start: 0.1, end: 0.4 },
          { word: 'exercise', start: 0.4, end: 0.8 },
          { word: 'now', start: 0.8, end: 1.0 },
          { word: 'is', start: 1.0, end: 1.1 },
          { word: 'probably', start: 1.1, end: 1.5 },
          { word: 'a', start: 1.5, end: 1.6 },
          { word: 'pretty', start: 1.6, end: 1.9 },
          { word: 'good', start: 1.9, end: 2.1 },
          { word: 'idea.', start: 2.1, end: 2.4 },
        ],
      }),
    });

    const result = await provider.evaluate(
      { localPath: filePath },
      { expectedText: 'Your thirties are a powerful time to start training.' },
    );

    assert.equal(result.passed, false);
    assert.ok(result.wer > 0.1);
    assert.ok(result.issues.some((issue) => issue.code === 'dialogue-word-error-rate'));
    assert.match(result.regenerationGuidance, /verbatim/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('lip-sync sample plan combines speech-active word timestamps and true pauses', () => {
  const samples = buildLipSyncSamples([
    { word: 'Hello', start: 0.4, end: 0.8 },
    { word: 'there', start: 0.8, end: 1.1 },
    { word: 'this', start: 1.6, end: 1.9 },
    { word: 'works', start: 1.9, end: 2.3 },
  ], {
    durationSeconds: 3,
    maxFrames: 8,
  });

  assert.ok(samples.some((sample) => sample.kind === 'speech' && sample.word === 'Hello'));
  assert.ok(samples.some((sample) => sample.kind === 'pause' && sample.timestamp < 0.4));
  assert.ok(samples.some((sample) => sample.kind === 'pause' && sample.timestamp > 1.1 && sample.timestamp < 1.6));
  assert.ok(samples.some((sample) => sample.kind === 'pause' && sample.timestamp > 2.3));
  assert.ok(samples.every((sample, index) => index === 0 || sample.timestamp >= samples[index - 1].timestamp));
});

test('lip-sync QC judges visual mouth activity using independent word timestamps', async () => {
  const requestedTimestamps = [];
  let requestBody = null;

  const provider = new OpenRouterLipSyncQcProvider({
    apiKey: 'router-key',
    model: 'vision-model',
    threshold: 80,
    frameSampler: {
      sampleAt: async (_localPath, timestamps) => {
        requestedTimestamps.push(...timestamps);
        return timestamps.map((timestamp, index) => ({
          index,
          timestamp,
          dataUrl: `data:image/jpeg;base64,LIP${index}`,
        }));
      },
    },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              score: 91,
              scores: {
                speakerVisibility: 95,
                mouthActivityDuringSpeech: 91,
                mouthStillnessDuringPauses: 88,
                faceStability: 94,
                timingPlausibility: 89,
              },
              issues: [],
              summary: 'Visible speaking activity broadly follows the speech timing.',
              regenerationGuidance: '',
            }),
          },
        }],
      });
    },
  });

  const result = await provider.evaluate(
    { localPath: '/fake/act.mp4' },
    {
      expectedText: 'Hello there this works.',
      transcription: {
        text: 'Hello there this works.',
        duration: 3,
        words: [
          { word: 'Hello', start: 0.4, end: 0.8 },
          { word: 'there', start: 0.8, end: 1.1 },
          { word: 'this', start: 1.6, end: 1.9 },
          { word: 'works', start: 1.9, end: 2.3 },
        ],
      },
      speakerDescription: 'Alex, adult presenter.',
    },
  );

  assert.equal(result.passed, true);
  assert.equal(result.score, 91);
  assert.ok(requestedTimestamps.length >= 4);
  const userContent = requestBody.messages[1].content;
  assert.ok(userContent.some((part) => part.type === 'text' && /SPEECH ACTIVE/.test(part.text)));
  assert.ok(userContent.some((part) => part.type === 'text' && /EXPECTED PAUSE/.test(part.text)));
  assert.match(result.limitation, /not phoneme-level/i);
});

test('audiovisual pipeline regenerates paraphrased dialogue and uses verified timestamps for subtitles', async () => {
  const calls = [];
  let dialogueAttempt = 0;
  const audiovisual = {
    generateSegment: async ({ segment, regeneration }) => {
      calls.push({ segment: segment.index, regeneration });
      return {
        type: 'ai-video',
        localPath: `/fake/dialogue-${segment.index}-${regeneration?.attempt || 0}.mp4`,
        generationId: `dialogue-${segment.index}-${regeneration?.attempt || 0}`,
        prompt: segment.dialogue,
      };
    },
  };
  const dialogueQc = {
    maxRegenerations: 1,
    evaluate: async (_asset, { expectedText }) => {
      dialogueAttempt += 1;
      if (dialogueAttempt === 1) {
        return {
          passed: false,
          wer: 0.4,
          issues: [{
            code: 'dialogue-word-error-rate',
            severity: 'high',
            evidence: 'paraphrased wording',
          }],
          regenerationGuidance: 'Speak the screenplay dialogue verbatim.',
          transcription: {
            text: 'Paraphrased wording.',
            duration: 2,
            words: [
              { word: 'Paraphrased', start: 0.1, end: 0.7 },
              { word: 'wording.', start: 0.7, end: 1.2 },
            ],
          },
        };
      }

      const words = String(expectedText).split(/\s+/).slice(0, 4).map((word, index) => ({
        word,
        start: 0.1 + (index * 0.25),
        end: 0.3 + (index * 0.25),
      }));
      return {
        passed: true,
        wer: 0,
        issues: [],
        regenerationGuidance: '',
        transcription: {
          text: expectedText,
          duration: 2,
          words,
        },
      };
    },
  };

  const pipeline = new AudiovisualPipeline({
    llm: new TemplateLlmProvider(),
    audiovisual,
    renderer: null,
    store: { saveProject: async () => {} },
    realismQc: null,
    dialogueQc,
    lipSyncQc: null,
  });

  const project = await pipeline.generate({
    topic: 'why consistency matters',
    durationSeconds: 20,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.ok(calls.some((call) => call.regeneration?.guidance?.includes('verbatim')));
  assert.ok(project.scenes.every((scene) => scene.dialogueVerification?.passed));
  assert.equal(project.subtitles.source, 'voice-word-timings');
});

test('audiovisual pipeline blocks an act that fails lip-sync timing after retry budget', async () => {
  const audiovisual = {
    generateSegment: async ({ segment }) => ({
      type: 'ai-video',
      localPath: `/fake/lipsync-${segment.index}.mp4`,
      generationId: `lipsync-${segment.index}`,
      prompt: segment.dialogue,
    }),
  };
  const dialogueQc = {
    maxRegenerations: 0,
    evaluate: async (_asset, { expectedText }) => ({
      passed: true,
      wer: 0,
      issues: [],
      regenerationGuidance: '',
      transcription: {
        text: expectedText,
        duration: 2,
        words: [
          { word: 'Exact', start: 0.1, end: 0.5 },
          { word: 'dialogue.', start: 0.5, end: 1.1 },
        ],
      },
    }),
  };
  const lipSyncQc = {
    maxRegenerations: 0,
    evaluate: async () => ({
      passed: false,
      score: 44,
      issues: [{
        code: 'frozen-mouth',
        severity: 'high',
        evidence: 'mouth remains closed during speech-active samples',
      }],
      regenerationGuidance: 'Synchronize visible mouth activity with the supplied dialogue audio.',
    }),
  };

  const pipeline = new AudiovisualPipeline({
    llm: new TemplateLlmProvider(),
    audiovisual,
    renderer: null,
    store: { saveProject: async () => {} },
    dialogueQc,
    lipSyncQc,
  });

  const project = await pipeline.generate({
    topic: 'exact dialogue',
    durationSeconds: 20,
    render: false,
  });

  assert.equal(project.status, 'LIPSYNC_QC_FAILED');
  assert.match(project.error, /failed QC/i);
});

test('audiovisual pipeline skips visual speech QC for an off-screen voiceover narrator', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-voiceover-'));
  const prompts = [];
  const audiovisual = new RunwayAudiovisualProvider({
    apiKey: 'runway-key',
    assetDir: dir,
    dialogueMode: 'native',
    pollIntervalMs: 0,
    maxPolls: 2,
    sleepImpl: async () => {},
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith('/text_to_video')) {
        prompts.push(JSON.parse(options.body).promptText);
        return jsonResponse({ id: 'wan-task' });
      }
      if (target.endsWith('/tasks/wan-task')) {
        return jsonResponse({ id: 'wan-task', status: 'SUCCEEDED', output: ['https://cdn.example/av.mp4'] });
      }
      if (target === 'https://cdn.example/av.mp4') {
        return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('native-av').buffer };
      }
      throw new Error(`unexpected request: ${target}`);
    },
  });
  const llm = {
    generateProductionScript: async (input) => {
      const script = await new TemplateLlmProvider().generateProductionScript(input);
      return {
        ...script,
        characters: [{
          id: 'narrator',
          name: 'Science Narrator',
          description: 'An unseen documentary narrator.',
          onScreen: false,
          voice: { presetId: 'Bernard' },
        }],
        segments: [{
          durationSeconds: 6,
          purpose: 'hook',
          speakerCharacterId: 'narrator',
          characterIds: ['narrator'],
          dialogue: 'An octopus has three hearts.',
          action: 'An octopus rests beside reef rock.',
        }],
      };
    },
  };
  let lipSyncCalls = 0;
  const pipeline = new AudiovisualPipeline({
    llm,
    audiovisual,
    renderer: null,
    store: { saveProject: async () => {} },
    lipSyncQc: {
      maxRegenerations: 0,
      evaluate: async () => {
        lipSyncCalls += 1;
        return { passed: false, score: 52, issues: [], regenerationGuidance: '' };
      },
    },
  });

  try {
    const project = await pipeline.generate({ topic: 'octopus hearts', durationSeconds: 6, render: false });

    assert.equal(project.status, 'READY');
    assert.equal(lipSyncCalls, 0);
    assert.equal(project.productionScript.characters[0].onScreen, false);
    assert.equal(project.scenes[0].qcApplicability.lipSync.applicable, false);
    assert.equal(project.scenes[0].qcApplicability.lipSync.reason, 'offscreen-voiceover');
    assert.equal(project.scenes[0].qcApplicability.poseMotion.reason, 'no-visible-human');
    assert.match(prompts[0], /VOICEOVER: all dialogue is off-screen narration/);
    assert.doesNotMatch(prompts[0], /synchronize the visible speaker/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('Runway mixed visible and off-screen dialogue prompt keeps voice ownership non-contradictory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-mixed-voiceover-'));
  let prompt = '';
  const provider = new RunwayAudiovisualProvider({
    apiKey: 'runway-key',
    assetDir: dir,
    dialogueMode: 'native',
    pollIntervalMs: 0,
    maxPolls: 2,
    sleepImpl: async () => {},
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith('/text_to_video')) {
        prompt = JSON.parse(options.body).promptText;
        return jsonResponse({ id: 'mixed-task' });
      }
      if (target.endsWith('/tasks/mixed-task')) {
        return jsonResponse({
          id: 'mixed-task',
          status: 'SUCCEEDED',
          output: ['https://cdn.example/mixed.mp4'],
        });
      }
      if (target === 'https://cdn.example/mixed.mp4') {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new TextEncoder().encode('mixed').buffer,
        };
      }
      throw new Error(`unexpected request: ${target}`);
    },
  });

  const productionScript = {
    characters: [
      {
        id: 'host',
        name: 'Host',
        description: 'Visible presenter.',
        physicalTraits: 'Natural appearance.',
        wardrobe: 'Neutral shirt.',
        onScreen: true,
        voice: { description: 'clear host', delivery: 'natural' },
      },
      {
        id: 'narrator',
        name: 'Narrator',
        description: 'Unseen narrator.',
        physicalTraits: '',
        wardrobe: '',
        onScreen: false,
        voice: { description: 'documentary voice', delivery: 'calm' },
      },
    ],
    locations: [{
      id: 'room',
      name: 'Room',
      description: 'A real room.',
      lighting: 'Daylight.',
      fixedElements: ['table'],
    }],
    visualStyle: {
      description: 'Photorealistic.',
      cameraRules: 'Natural camera.',
      lightingRules: 'Stable exposure.',
    },
    audioDirection: {
      mix: 'Clear dialogue.',
      musicPolicy: 'No music.',
    },
  };
  const segment = {
    index: 0,
    purpose: 'explain',
    durationSeconds: 6,
    speakerCharacterId: 'host',
    characterIds: ['host', 'narrator'],
    locationId: 'room',
    dialogue: 'Look here. Notice what changes next.',
    dialogueTurns: [
      { turnIndex: 0, speakerCharacterId: 'host', text: 'Look here.' },
      { turnIndex: 1, speakerCharacterId: 'narrator', text: 'Notice what changes next.' },
    ],
    action: 'The host gestures, then the camera stays on the demonstration.',
    camera: 'Medium shot.',
    ambience: 'Quiet room.',
    soundEffects: [],
    music: '',
    editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
  };

  try {
    await provider.generateSegment({ segment, productionScript, projectId: 'mixed-voiceover' });

    assert.match(prompt, /MIXED DIALOGUE:/);
    assert.match(prompt, /Off-screen narrator turns must remain disembodied voiceover/i);
    assert.doesNotMatch(prompt, /assign each audible voice to the matching visible character/i);
    assert.doesNotMatch(prompt, /ONLY the named active visible speaker talks/i);
    assert.doesNotMatch(prompt, /VOICEOVER: all dialogue is off-screen narration/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('deep lip-sync normalization converts frame offset to milliseconds and passes stable sync', () => {
  const result = normalizeDeepLipSyncResult({
    offsetFrames: 1,
    frameRate: 25,
    confidence: 8.5,
    segments: [
      { offsetFrames: 1, confidence: 8.1 },
      { offsetFrames: 0, confidence: 7.8 },
      { offsetFrames: -1, confidence: 8.4 },
    ],
    evaluator: {
      name: 'syncnet-python',
      version: '0.2.2',
      mode: 'frame-level-av-sync',
    },
  }, {
    maxOffsetMs: 80,
    minConfidence: 5,
    minSegmentPassRate: 0.8,
  });

  assert.equal(result.passed, true);
  assert.equal(result.offsetMs, 40);
  assert.equal(result.segmentPassRate, 1);
  assert.equal(result.evaluator.name, 'syncnet-python');
});

test('deep lip-sync normalization rejects large offset, weak confidence and unstable segments', () => {
  const result = normalizeDeepLipSyncResult({
    offsetFrames: 4,
    frameRate: 25,
    confidence: 3.2,
    segments: [
      { offsetFrames: 4, confidence: 3.2 },
      { offsetFrames: 3, confidence: 4.0 },
      { offsetFrames: 0, confidence: 7.5 },
    ],
  }, {
    maxOffsetMs: 80,
    minConfidence: 5,
    minSegmentPassRate: 0.8,
  });

  assert.equal(result.passed, false);
  assert.equal(result.offsetMs, 160);
  assert.ok(result.issues.some((issue) => issue.code === 'deep-sync-offset'));
  assert.ok(result.issues.some((issue) => issue.code === 'deep-sync-confidence'));
  assert.ok(result.issues.some((issue) => issue.code === 'deep-sync-segment-instability'));
  assert.match(result.regenerationGuidance, /160ms/i);
});

test('deep lip-sync normalization consumes optional phoneme and viseme alignment metrics', () => {
  const result = normalizeDeepLipSyncResult({
    offsetFrames: 0,
    frameRate: 25,
    confidence: 8.2,
    phonemeAlignmentScore: 0.91,
    visemeAlignmentScore: 0.72,
  }, {
    maxOffsetMs: 80,
    minConfidence: 5,
    minSegmentPassRate: 0.8,
    minPhonemeAlignment: 0.85,
    minVisemeAlignment: 0.8,
  });

  assert.equal(result.passed, false);
  assert.equal(result.phonemeAlignment, 0.91);
  assert.equal(result.visemeAlignment, 0.72);
  assert.ok(result.issues.some((issue) => issue.code === 'viseme-alignment'));
});

test('deep lip-sync provider executes a configured evaluator without a shell and replaces placeholders', async () => {
  const calls = [];
  const provider = new DeepLipSyncQcProvider({
    command: 'python3',
    args: [
      'scripts/syncnet_qc.py',
      '--video', '{video}',
      '--expected', '{expected}',
      '--transcript', '{transcript}',
    ],
    maxOffsetMs: 80,
    minConfidence: 5,
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: JSON.stringify({
          offsetFrames: 1,
          frameRate: 25,
          confidence: 8.8,
          segments: [
            { offsetFrames: 1, confidence: 8.8 },
          ],
          evaluator: { name: 'syncnet-test', mode: 'frame-level-av-sync' },
        }),
      };
    },
  });

  const result = await provider.evaluate(
    { localPath: '/tmp/generated act.mp4' },
    {
      expectedText: 'Say this exactly.',
      transcription: { text: 'Say this exactly.' },
    },
  );

  assert.equal(result.passed, true);
  assert.equal(calls[0].command, 'python3');
  assert.deepEqual(calls[0].args, [
    'scripts/syncnet_qc.py',
    '--video', '/tmp/generated act.mp4',
    '--expected', 'Say this exactly.',
    '--transcript', 'Say this exactly.',
  ]);
  assert.equal(calls[0].options.timeoutMs, 120000);
});

test('audiovisual pipeline regenerates a deeply out-of-sync act and records the final deep score', async () => {
  const calls = [];
  let deepAttempt = 0;

  const audiovisual = {
    generateSegment: async ({ segment, regeneration }) => {
      calls.push({ segment: segment.index, regeneration });
      return {
        type: 'ai-video',
        localPath: `/fake/deep-${segment.index}-${regeneration?.attempt || 0}.mp4`,
        generationId: `deep-${segment.index}-${regeneration?.attempt || 0}`,
        prompt: segment.dialogue,
      };
    },
  };

  const deepLipSyncQc = {
    maxRegenerations: 1,
    evaluate: async () => {
      deepAttempt += 1;
      if (deepAttempt === 1) {
        return {
          passed: false,
          offsetMs: 160,
          confidence: 3.5,
          issues: [{
            code: 'deep-sync-offset',
            severity: 'high',
            evidence: 'visual mouth motion lags audio by 160ms',
          }],
          regenerationGuidance: 'Correct the measured 160ms lag and follow the dialogue audio as the timing master.',
        };
      }

      return {
        passed: true,
        offsetMs: 40,
        confidence: 8.4,
        issues: [],
        regenerationGuidance: '',
      };
    },
  };

  const pipeline = new AudiovisualPipeline({
    llm: new TemplateLlmProvider(),
    audiovisual,
    renderer: null,
    store: { saveProject: async () => {} },
    realismQc: null,
    dialogueQc: null,
    lipSyncQc: null,
    deepLipSyncQc,
  });

  const project = await pipeline.generate({
    topic: 'synchronized dialogue',
    durationSeconds: 20,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.ok(calls.some((call) => call.regeneration?.guidance?.includes('160ms')));
  assert.ok(project.scenes.every((scene) => scene.deepLipSyncQc?.passed));
});

test('audiovisual pipeline returns DEEP_LIPSYNC_QC_FAILED when deep sync never passes', async () => {
  const audiovisual = {
    generateSegment: async ({ segment }) => ({
      type: 'ai-video',
      localPath: `/fake/deep-fail-${segment.index}.mp4`,
      generationId: `deep-fail-${segment.index}`,
      prompt: segment.dialogue,
    }),
  };

  const deepLipSyncQc = {
    maxRegenerations: 0,
    evaluate: async () => ({
      passed: false,
      offsetMs: 200,
      confidence: 2.5,
      issues: [{
        code: 'deep-sync-offset',
        severity: 'critical',
        evidence: 'A/V offset 200ms',
      }],
      regenerationGuidance: 'Correct audiovisual synchronization.',
    }),
  };

  const pipeline = new AudiovisualPipeline({
    llm: new TemplateLlmProvider(),
    audiovisual,
    renderer: null,
    store: { saveProject: async () => {} },
    deepLipSyncQc,
  });

  const project = await pipeline.generate({
    topic: 'deep sync failure',
    durationSeconds: 20,
    render: false,
  });

  assert.equal(project.status, 'DEEP_LIPSYNC_QC_FAILED');
  assert.match(project.error, /failed QC/i);
});

test('publishability gate blocks a scene with failed deep audiovisual sync', () => {
  const result = evaluateAudiovisualPublishability({
    productionScript: {
      fullDialogue: 'This is the actual spoken script.',
      segments: [
        { index: 0, locationId: 'room', editing: { allowInternalCuts: false } },
      ],
    },
    scenes: [{
      index: 0,
      asset: { localPath: '/fake/act.mp4' },
      visualQcHistory: [],
      deepLipSyncQc: {
        passed: false,
        offsetMs: 160,
        confidence: 3.2,
      },
    }],
    subtitles: {
      enabled: true,
      layout: { passed: true, violations: [] },
    },
  });

  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'deep-lip-sync'));
});


test('phoneme-viseme normalization passes aligned visible speech', () => {
  const result = normalizePhonemeVisemeResult({
    phonemeAlignmentScore: 0.84,
    visemeAlignmentScore: 0.76,
    coverage: 0.91,
    evaluatedPhonemes: 42,
    totalPhonemes: 46,
    familyAccuracy: {
      closed: 0.9,
      narrow: 0.73,
      rounded: 0.8,
      wide: 0.77,
      open: 0.81,
    },
    confusion: {
      'closed->closed': 9,
      'wide->wide': 7,
    },
    evaluator: {
      name: 'tiktokmoney-mouth-landmark-viseme-v1',
      version: '1',
    },
  }, {
    minPhonemeAlignment: 0.72,
    minVisemeAlignment: 0.68,
    minCoverage: 0.72,
  });

  assert.equal(result.passed, true);
  assert.equal(result.phonemeAlignmentScore, 0.84);
  assert.equal(result.visemeAlignmentScore, 0.76);
  assert.equal(result.coverage, 0.91);
  assert.equal(result.evaluator.name, 'tiktokmoney-mouth-landmark-viseme-v1');
});

test('phoneme-viseme normalization rejects wrong mouth families and low visible-face coverage', () => {
  const result = normalizePhonemeVisemeResult({
    phonemeAlignmentScore: 0.48,
    visemeAlignmentScore: 0.41,
    coverage: 0.52,
    evaluatedPhonemes: 21,
    totalPhonemes: 45,
    worstMismatches: [
      {
        start: 1.2,
        end: 1.34,
        phoneme: 'P',
        viseme: 'PP',
        expectedFamily: 'closed',
        observedFamily: 'open',
        confidence: 0.11,
      },
      {
        start: 2.4,
        end: 2.61,
        phoneme: 'OW',
        viseme: 'oh',
        expectedFamily: 'rounded',
        observedFamily: 'wide',
        confidence: 0.18,
      },
    ],
  }, {
    minPhonemeAlignment: 0.72,
    minVisemeAlignment: 0.68,
    minCoverage: 0.72,
  });

  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => issue.code === 'phoneme-mouth-alignment'));
  assert.ok(result.issues.some((issue) => issue.code === 'viseme-classification-alignment'));
  assert.ok(result.issues.some((issue) => issue.code === 'viseme-face-coverage'));
  assert.match(result.regenerationGuidance, /P\/closed->open/);
  assert.match(result.regenerationGuidance, /OW\/rounded->wide/);
});

test('phoneme-viseme provider passes independent word timings to the bundled classifier safely', async () => {
  const calls = [];
  const provider = new PhonemeVisemeQcProvider({
    command: 'python3',
    args: [
      'scripts/phoneme_viseme_qc.py',
      '--video', '{video}',
      '--transcription-json', '{transcription_json}',
    ],
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: JSON.stringify({
          phonemeAlignmentScore: 0.86,
          visemeAlignmentScore: 0.78,
          coverage: 0.93,
          evaluatedPhonemes: 12,
          totalPhonemes: 13,
          evaluator: {
            name: 'tiktokmoney-mouth-landmark-viseme-v1',
            version: '1',
          },
        }),
      };
    },
  });

  const result = await provider.evaluate(
    { localPath: '/tmp/generated act.mp4' },
    {
      expectedText: 'Put on your shoes.',
      transcription: {
        text: 'Put on your shoes.',
        language: 'en',
        duration: 2.2,
        words: [
          { word: 'Put', start: 0.1, end: 0.45 },
          { word: 'on', start: 0.45, end: 0.72 },
          { word: 'your', start: 0.72, end: 1.05 },
          { word: 'shoes.', start: 1.05, end: 1.55 },
        ],
      },
    },
  );

  assert.equal(result.passed, true);
  assert.equal(calls[0].command, 'python3');
  assert.equal(calls[0].args[0], 'scripts/phoneme_viseme_qc.py');
  assert.equal(calls[0].args[2], '/tmp/generated act.mp4');
  const payload = JSON.parse(calls[0].args[4]);
  assert.equal(payload.words.length, 4);
  assert.equal(payload.words[0].word, 'Put');
  assert.equal(calls[0].options.timeoutMs, 120000);
});

test('audiovisual pipeline regenerates a phoneme-viseme mismatch and records the accepted score', async () => {
  const calls = [];
  let visemeAttempt = 0;

  const audiovisual = {
    generateSegment: async ({ segment, regeneration }) => {
      calls.push({ segment: segment.index, regeneration });
      return {
        type: 'ai-video',
        localPath: `/fake/viseme-${segment.index}-${regeneration?.attempt || 0}.mp4`,
        generationId: `viseme-${segment.index}-${regeneration?.attempt || 0}`,
        prompt: segment.dialogue,
      };
    },
  };
  const dialogueQc = {
    maxRegenerations: 0,
    evaluate: async (_asset, { expectedText }) => ({
      passed: true,
      issues: [],
      regenerationGuidance: '',
      transcription: {
        text: expectedText,
        duration: 2.5,
        words: [
          { word: 'Put', start: 0.1, end: 0.45 },
          { word: 'on', start: 0.45, end: 0.75 },
          { word: 'your', start: 0.75, end: 1.1 },
          { word: 'shoes.', start: 1.1, end: 1.65 },
        ],
      },
    }),
  };
  const phonemeVisemeQc = {
    maxRegenerations: 1,
    evaluate: async () => {
      visemeAttempt += 1;
      if (visemeAttempt === 1) {
        return {
          passed: false,
          phonemeAlignmentScore: 0.48,
          visemeAlignmentScore: 0.42,
          coverage: 0.94,
          issues: [{
            code: 'viseme-classification-alignment',
            severity: 'high',
            evidence: 'rounded vowel was classified as wide mouth',
          }],
          regenerationGuidance: 'At 1.2s make the lips visibly rounded for the spoken vowel.',
        };
      }
      return {
        passed: true,
        phonemeAlignmentScore: 0.82,
        visemeAlignmentScore: 0.74,
        coverage: 0.95,
        issues: [],
        regenerationGuidance: '',
      };
    },
  };

  const pipeline = new AudiovisualPipeline({
    llm: new TemplateLlmProvider(),
    audiovisual,
    renderer: null,
    store: { saveProject: async () => {} },
    realismQc: null,
    dialogueQc,
    lipSyncQc: null,
    deepLipSyncQc: null,
    phonemeVisemeQc,
  });

  const project = await pipeline.generate({
    topic: 'visible articulation',
    durationSeconds: 20,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.ok(calls.some((call) => call.regeneration?.guidance?.includes('visibly rounded')));
  assert.ok(project.scenes.every((scene) => scene.phonemeVisemeQc?.passed));
});

test('audiovisual pipeline returns PHONEME_VISEME_QC_FAILED when articulation never passes', async () => {
  const audiovisual = {
    generateSegment: async ({ segment }) => ({
      type: 'ai-video',
      localPath: `/fake/viseme-fail-${segment.index}.mp4`,
      generationId: `viseme-fail-${segment.index}`,
      prompt: segment.dialogue,
    }),
  };
  const dialogueQc = {
    maxRegenerations: 0,
    evaluate: async (_asset, { expectedText }) => ({
      passed: true,
      issues: [],
      regenerationGuidance: '',
      transcription: {
        text: expectedText,
        duration: 2,
        words: [
          { word: 'Exact', start: 0.1, end: 0.6 },
          { word: 'speech.', start: 0.6, end: 1.2 },
        ],
      },
    }),
  };
  const phonemeVisemeQc = {
    maxRegenerations: 0,
    evaluate: async () => ({
      passed: false,
      phonemeAlignmentScore: 0.31,
      visemeAlignmentScore: 0.29,
      coverage: 0.88,
      issues: [{
        code: 'phoneme-mouth-alignment',
        severity: 'critical',
        evidence: 'mouth shapes do not follow expected speech units',
      }],
      regenerationGuidance: 'Match visible mouth shapes to the exact spoken sounds.',
    }),
  };

  const pipeline = new AudiovisualPipeline({
    llm: new TemplateLlmProvider(),
    audiovisual,
    renderer: null,
    store: { saveProject: async () => {} },
    dialogueQc,
    phonemeVisemeQc,
  });

  const project = await pipeline.generate({
    topic: 'phoneme viseme failure',
    durationSeconds: 20,
    render: false,
  });

  assert.equal(project.status, 'PHONEME_VISEME_QC_FAILED');
  assert.match(project.error, /failed QC/i);
});

test('publishability gate blocks a scene with failed phoneme-viseme alignment', () => {
  const result = evaluateAudiovisualPublishability({
    productionScript: {
      fullDialogue: 'This is real spoken dialogue.',
      segments: [
        { index: 0, locationId: 'room', editing: { allowInternalCuts: false } },
      ],
    },
    scenes: [{
      index: 0,
      asset: { localPath: '/fake/act.mp4' },
      visualQcHistory: [],
      phonemeVisemeQc: {
        passed: false,
        phonemeAlignmentScore: 0.4,
        visemeAlignmentScore: 0.35,
      },
    }],
    subtitles: {
      enabled: true,
      layout: { passed: true, violations: [] },
    },
  });

  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'phoneme-viseme'));
});


test('production screenplay normalizes multi-speaker dialogue turns and distinct valid voices', async () => {
  const generator = new ProductionScriptGenerator({
    llm: {
      generateProductionScript: async () => ({
        title: 'Two-person explanation',
        characters: [
          {
            id: 'Alex',
            name: 'Alex',
            description: 'A 34-year-old trainer.',
            physicalTraits: 'Short dark hair.',
            wardrobe: 'Black training shirt.',
            voice: { presetId: 'Bernard', languageCode: 'en' },
          },
          {
            id: 'Maya',
            name: 'Maya',
            description: 'A 32-year-old physiotherapist.',
            physicalTraits: 'Long dark hair.',
            wardrobe: 'Blue athletic jacket.',
            voice: { presetId: 'Bernard', languageCode: 'en' },
          },
        ],
        locations: [{
          id: 'gym',
          name: 'Gym',
          description: 'A realistic neighborhood gym.',
          lighting: 'Soft daylight.',
          fixedElements: ['dumbbell rack'],
        }],
        segments: [{
          durationSeconds: 10,
          purpose: 'explain',
          characterIds: ['Alex', 'Maya'],
          locationId: 'gym',
          dialogueTurns: [
            {
              speakerCharacterId: 'Alex',
              text: 'I thought starting in my thirties was too late.',
              delivery: 'skeptical',
              pauseAfterSeconds: 0.2,
            },
            {
              speakerCharacterId: 'Maya',
              text: 'It is not. Consistency matters much more than the starting age.',
              delivery: 'calm and reassuring',
              pauseAfterSeconds: 0,
            },
          ],
          action: 'Alex and Maya face each other naturally.',
          camera: 'Two-shot at eye level.',
          ambience: 'Quiet gym ambience.',
          soundEffects: [],
          music: '',
        }],
      }),
    },
  });

  const script = await generator.generate({
    topic: 'training in your thirties',
    audience: 'adults',
    durationSeconds: 10,
  });

  const segment = script.segments[0];
  assert.equal(segment.speakerMode, 'multi-speaker');
  assert.equal(segment.dialogueTurns.length, 2);
  assert.equal(segment.dialogueTurns[0].speakerCharacterId, 'alex');
  assert.equal(segment.dialogueTurns[1].speakerCharacterId, 'maya');
  assert.deepEqual(segment.characterIds, ['alex', 'maya']);
  assert.match(segment.dialogue, /too late.*Consistency matters/s);
  assert.equal(script.characters[0].voice.presetId, 'Bernard');
  assert.notEqual(script.characters[1].voice.presetId, 'Bernard');
  assert.equal(script.characters[1].voice.presetId, 'Maya');
});

test('dialogue audio composer creates a timed master with per-turn pauses', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-dialogue-master-'));
  try {
    const first = path.join(dir, 'first.mp3');
    const second = path.join(dir, 'second.mp3');
    await writeFile(first, 'first');
    await writeFile(second, 'second');

    const commands = [];
    const composer = new DialogueAudioComposer({
      assetDir: dir,
      turnGapSeconds: 0.16,
      probeDuration: async (_bin, localPath) => localPath === first ? 1.0 : 1.5,
      runCommand: async (command, args) => {
        commands.push({ command, args });
        await writeFile(args.at(-1), 'master-audio');
      },
    });

    const result = await composer.compose({
      projectId: 'vid-dialogue',
      segmentIndex: 2,
      tracks: [
        {
          turnIndex: 0,
          speakerCharacterId: 'alex',
          exactText: 'First line.',
          voicePresetId: 'Bernard',
          localPath: first,
          pauseAfterSeconds: 0.25,
        },
        {
          turnIndex: 1,
          speakerCharacterId: 'maya',
          exactText: 'Second line.',
          voicePresetId: 'Maya',
          localPath: second,
          pauseAfterSeconds: 0,
        },
      ],
    });

    assert.equal(result.turns[0].start, 0);
    assert.equal(result.turns[0].end, 1);
    assert.equal(result.turns[1].start, 1.25);
    assert.equal(result.turns[1].end, 2.75);
    assert.equal(result.durationSeconds, 2.75);
    assert.match(result.dataUri, /^data:audio\/mpeg;base64,/);
    assert.equal(commands.length, 1);
    assert.match(commands[0].args.join(' '), /adelay=1250\|1250/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Runway audiovisual provider composes distinct speaker voices into one WAN dialogue master', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-multi-speaker-runway-'));
  const requests = [];
  let ttsIndex = 0;
  let composedTracks = null;

  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 2,
      sleepImpl: async () => {},
      dialogueComposer: {
        compose: async ({ tracks }) => {
          composedTracks = tracks;
          return {
            provider: 'local-ffmpeg',
            type: 'dialogue-master',
            localPath: path.join(dir, 'master.mp3'),
            dataUri: 'data:audio/mpeg;base64,TUFTVEVS',
            durationSeconds: 5.4,
            turns: [
              {
                turnIndex: 0,
                speakerCharacterId: 'alex',
                text: 'Is starting now too late?',
                start: 0,
                end: 2.1,
                duration: 2.1,
                voicePresetId: 'Bernard',
              },
              {
                turnIndex: 1,
                speakerCharacterId: 'maya',
                text: 'No. Starting consistently matters more.',
                start: 2.3,
                end: 5.4,
                duration: 3.1,
                voicePresetId: 'Maya',
              },
            ],
          };
        },
      },
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ target, method: options.method || 'GET', body });

        if (target.endsWith('/text_to_speech') && options.method === 'POST') {
          ttsIndex += 1;
          return jsonResponse({ id: `tts-${ttsIndex}` });
        }
        if (target.endsWith('/tasks/tts-1')) {
          return jsonResponse({ id: 'tts-1', status: 'SUCCEEDED', output: ['https://cdn.example/alex.mp3'] });
        }
        if (target.endsWith('/tasks/tts-2')) {
          return jsonResponse({ id: 'tts-2', status: 'SUCCEEDED', output: ['https://cdn.example/maya.mp3'] });
        }
        if (target === 'https://cdn.example/alex.mp3' || target === 'https://cdn.example/maya.mp3') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('voice').buffer,
          };
        }
        if (target.endsWith('/text_to_video') && options.method === 'POST') {
          assert.equal(body.referenceAudio.length, 1);
          assert.equal(body.referenceAudio[0].uri, 'data:audio/mpeg;base64,TUFTVEVS');
          assert.match(body.promptText, /MULTI-SPEAKER DIALOGUE BLOCKING/);
          assert.match(body.promptText, /ALEX says exactly/);
          assert.match(body.promptText, /MAYA says exactly/);
          assert.match(body.promptText, /ONLY the named active visible speaker talks/i);
          return jsonResponse({ id: 'video-task' });
        }
        if (target.endsWith('/tasks/video-task')) {
          return jsonResponse({ id: 'video-task', status: 'SUCCEEDED', output: ['https://cdn.example/dialogue.mp4'] });
        }
        if (target === 'https://cdn.example/dialogue.mp4') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('video').buffer,
          };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const productionScript = {
      characters: [
        {
          id: 'alex', name: 'Alex', description: 'adult trainer',
          physicalTraits: 'short dark hair', wardrobe: 'black shirt',
          voice: { presetId: 'Bernard', description: 'warm male voice', delivery: 'natural', languageCode: 'en' },
        },
        {
          id: 'maya', name: 'Maya', description: 'adult physiotherapist',
          physicalTraits: 'long dark hair', wardrobe: 'blue jacket',
          voice: { presetId: 'Maya', description: 'clear female voice', delivery: 'calm', languageCode: 'en' },
        },
      ],
      locations: [{
        id: 'gym', name: 'Gym', description: 'real gym', lighting: 'daylight', fixedElements: ['rack'],
      }],
      visualStyle: { description: 'photorealistic', cameraRules: 'natural', lightingRules: 'stable' },
      audioDirection: { mix: 'clear dialogue', musicPolicy: 'music below dialogue' },
    };
    const segment = {
      index: 0,
      purpose: 'hook',
      durationSeconds: 8,
      speakerCharacterId: 'alex',
      speakerMode: 'multi-speaker',
      characterIds: ['alex', 'maya'],
      locationId: 'gym',
      dialogue: 'Is starting now too late? No. Starting consistently matters more.',
      dialogueTurns: [
        {
          turnIndex: 0,
          speakerCharacterId: 'alex',
          text: 'Is starting now too late?',
          delivery: 'skeptical',
          pauseAfterSeconds: 0.2,
        },
        {
          turnIndex: 1,
          speakerCharacterId: 'maya',
          text: 'No. Starting consistently matters more.',
          delivery: 'reassuring',
          pauseAfterSeconds: 0,
        },
      ],
      action: 'Alex asks Maya a question; Maya answers while Alex listens.',
      camera: 'Natural two-shot.',
      ambience: 'Quiet gym.',
      soundEffects: [],
      music: '',
      editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
    };

    const asset = await provider.generateSegment({
      segment,
      productionScript,
      projectId: 'multi',
    });

    const ttsRequests = requests.filter((request) => request.target.endsWith('/text_to_speech'));
    assert.equal(ttsRequests.length, 2);
    assert.equal(ttsRequests[0].body.voice.presetId, 'Bernard');
    assert.equal(ttsRequests[1].body.voice.presetId, 'Maya');
    assert.equal(composedTracks.length, 2);
    assert.equal(composedTracks[0].speakerCharacterId, 'alex');
    assert.equal(composedTracks[1].speakerCharacterId, 'maya');
    assert.equal(asset.audioMode, 'locked-multi-speaker-native-mix');
    assert.equal(asset.dialogueTrack.turns.length, 2);
    assert.deepEqual(asset.speakerCharacterIds, ['alex', 'maya']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Runway audiovisual provider stretches an act to fit a longer multi-speaker dialogue master', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-multi-speaker-stretch-'));
  const requests = [];
  let ttsIndex = 0;
  let composedTracks = null;
  let videoDuration = null;

  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 2,
      sleepImpl: async () => {},
      dialogueComposer: {
        compose: async ({ tracks }) => {
          composedTracks = tracks;
          return {
            provider: 'local-ffmpeg',
            type: 'dialogue-master',
            localPath: path.join(dir, 'master.mp3'),
            dataUri: 'data:audio/mpeg;base64,TUFTVEVS',
            durationSeconds: 5.4,
            turns: [
              {
                turnIndex: 0,
                speakerCharacterId: 'alex',
                text: 'Is starting now too late?',
                start: 0,
                end: 2.1,
                duration: 2.1,
                voicePresetId: 'Bernard',
              },
              {
                turnIndex: 1,
                speakerCharacterId: 'maya',
                text: 'No. Starting consistently matters more.',
                start: 2.3,
                end: 5.4,
                duration: 3.1,
                voicePresetId: 'Maya',
              },
            ],
          };
        },
      },
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ target, method: options.method || 'GET', body });

        if (target.endsWith('/text_to_speech') && options.method === 'POST') {
          ttsIndex += 1;
          return jsonResponse({ id: `tts-${ttsIndex}` });
        }
        if (target.endsWith('/tasks/tts-1')) {
          return jsonResponse({ id: 'tts-1', status: 'SUCCEEDED', output: ['https://cdn.example/alex.mp3'] });
        }
        if (target.endsWith('/tasks/tts-2')) {
          return jsonResponse({ id: 'tts-2', status: 'SUCCEEDED', output: ['https://cdn.example/maya.mp3'] });
        }
        if (target === 'https://cdn.example/alex.mp3' || target === 'https://cdn.example/maya.mp3') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('voice').buffer,
          };
        }
        if (target.endsWith('/text_to_video') && options.method === 'POST') {
          videoDuration = body.duration;
          assert.equal(body.referenceAudio.length, 1);
          assert.equal(body.referenceAudio[0].uri, 'data:audio/mpeg;base64,TUFTVEVS');
          assert.match(body.promptText, /MULTI-SPEAKER DIALOGUE BLOCKING/);
          assert.match(body.promptText, /ALEX says exactly/);
          assert.match(body.promptText, /MAYA says exactly/);
          assert.match(body.promptText, /ONLY the named active visible speaker talks/i);
          return jsonResponse({ id: 'video-task' });
        }
        if (target.endsWith('/tasks/video-task')) {
          return jsonResponse({ id: 'video-task', status: 'SUCCEEDED', output: ['https://cdn.example/dialogue.mp4'] });
        }
        if (target === 'https://cdn.example/dialogue.mp4') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('video').buffer,
          };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const productionScript = {
      characters: [
        {
          id: 'alex', name: 'Alex', description: 'adult trainer',
          physicalTraits: 'short dark hair', wardrobe: 'black shirt',
          voice: { presetId: 'Bernard', description: 'warm male voice', delivery: 'natural', languageCode: 'en' },
        },
        {
          id: 'maya', name: 'Maya', description: 'adult physiotherapist',
          physicalTraits: 'long dark hair', wardrobe: 'blue jacket',
          voice: { presetId: 'Maya', description: 'clear female voice', delivery: 'calm', languageCode: 'en' },
        },
      ],
      locations: [{
        id: 'gym', name: 'Gym', description: 'real gym', lighting: 'daylight', fixedElements: ['rack'],
      }],
      visualStyle: { description: 'photorealistic', cameraRules: 'natural', lightingRules: 'stable' },
      audioDirection: { mix: 'clear dialogue', musicPolicy: 'music below dialogue' },
    };
    const segment = {
      index: 0,
      purpose: 'hook',
      durationSeconds: 4,
      speakerCharacterId: 'alex',
      speakerMode: 'multi-speaker',
      characterIds: ['alex', 'maya'],
      locationId: 'gym',
      dialogue: 'Is starting now too late? No. Starting consistently matters more.',
      dialogueTurns: [
        {
          turnIndex: 0,
          speakerCharacterId: 'alex',
          text: 'Is starting now too late?',
          delivery: 'skeptical',
          pauseAfterSeconds: 0.2,
        },
        {
          turnIndex: 1,
          speakerCharacterId: 'maya',
          text: 'No. Starting consistently matters more.',
          delivery: 'reassuring',
          pauseAfterSeconds: 0,
        },
      ],
      action: 'Alex asks Maya a question; Maya answers while Alex listens.',
      camera: 'Natural two-shot.',
      ambience: 'Quiet gym.',
      soundEffects: [],
      music: '',
      editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
    };

    const asset = await provider.generateSegment({
      segment,
      productionScript,
      projectId: 'multi',
    });

    const ttsRequests = requests.filter((request) => request.target.endsWith('/text_to_speech'));
    assert.equal(ttsRequests.length, 2);
    assert.equal(ttsRequests[0].body.voice.presetId, 'Bernard');
    assert.equal(ttsRequests[1].body.voice.presetId, 'Maya');
    assert.equal(composedTracks.length, 2);
    assert.equal(composedTracks[0].speakerCharacterId, 'alex');
    assert.equal(composedTracks[1].speakerCharacterId, 'maya');
    assert.equal(videoDuration, 6);
    assert.equal(asset.durationSeconds, 6);
    assert.equal(asset.generatedDuration, '6s');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('speaker-turn QC samples each active speaker and accepts clear turn taking', async () => {
  const sampled = [];
  let requestBody = null;
  const provider = new OpenRouterSpeakerTurnQcProvider({
    apiKey: 'router-key',
    model: 'vision-model',
    threshold: 82,
    frameSampler: {
      sampleAt: async (_path, timestamps) => {
        sampled.push(...timestamps);
        return timestamps.map((timestamp, index) => ({
          index,
          timestamp,
          dataUrl: `data:image/jpeg;base64,SPEAKER${index}`,
        }));
      },
    },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              score: 93,
              scores: {
                speakerAttribution: 96,
                activeSpeakerMouthMotion: 92,
                listenerStillness: 91,
                castIdentityStability: 94,
                turnTakingClarity: 93,
              },
              issues: [],
              summary: 'Each character speaks only during their assigned turn.',
              regenerationGuidance: '',
            }),
          },
        }],
      });
    },
  });

  const turns = [
    { turnIndex: 0, speakerCharacterId: 'alex', text: 'Question?', start: 0, end: 1.4 },
    { turnIndex: 1, speakerCharacterId: 'maya', text: 'Answer.', start: 1.6, end: 3.2 },
  ];
  const result = await provider.evaluate(
    { localPath: '/fake/dialogue.mp4' },
    {
      dialogueTurns: turns,
      characters: [
        { id: 'alex', name: 'Alex', description: 'trainer', physicalTraits: 'dark hair', wardrobe: 'black shirt' },
        { id: 'maya', name: 'Maya', description: 'physio', physicalTraits: 'long hair', wardrobe: 'blue jacket' },
      ],
    },
  );

  assert.equal(result.passed, true);
  assert.equal(result.score, 93);
  assert.ok(sampled.length >= 4);
  const userContent = requestBody.messages[1].content;
  assert.ok(userContent.some((part) => part.type === 'text' && /ACTIVE SPEAKER alex/.test(part.text)));
  assert.ok(userContent.some((part) => part.type === 'text' && /ACTIVE SPEAKER maya/.test(part.text)));
  assert.ok(buildSpeakerSamples(turns).every((sample) => ['alex', 'maya'].includes(sample.speakerCharacterId)));
});

test('audiovisual pipeline regenerates when the wrong character speaks a dialogue turn', async () => {
  const generationCalls = [];
  let speakerAttempt = 0;
  const llm = {
    generateProductionScript: async () => ({
      title: 'Dialogue test',
      characters: [
        {
          id: 'alex', name: 'Alex', description: 'trainer', physicalTraits: 'dark hair',
          wardrobe: 'black shirt', voice: { presetId: 'Bernard', languageCode: 'en' },
        },
        {
          id: 'maya', name: 'Maya', description: 'physio', physicalTraits: 'long hair',
          wardrobe: 'blue jacket', voice: { presetId: 'Maya', languageCode: 'en' },
        },
      ],
      locations: [{
        id: 'room', name: 'Room', description: 'real room', lighting: 'daylight', fixedElements: ['table'],
      }],
      segments: [{
        durationSeconds: 8,
        purpose: 'hook',
        characterIds: ['alex', 'maya'],
        locationId: 'room',
        dialogueTurns: [
          { speakerCharacterId: 'alex', text: 'Did you know this?', pauseAfterSeconds: 0.2 },
          { speakerCharacterId: 'maya', text: 'Yes, and here is why.', pauseAfterSeconds: 0 },
        ],
        action: 'Alex asks; Maya answers.',
        camera: 'Two-shot.',
        ambience: 'Room tone.',
        soundEffects: [],
        music: '',
      }],
    }),
  };
  const audiovisual = {
    generateSegment: async ({ segment, regeneration }) => {
      generationCalls.push(regeneration);
      return {
        type: 'ai-video',
        localPath: `/fake/speaker-${regeneration?.attempt || 0}.mp4`,
        generationId: `speaker-${regeneration?.attempt || 0}`,
        prompt: segment.dialogue,
        dialogueTrack: {
          turns: [
            { speakerCharacterId: 'alex', text: 'Did you know this?', start: 0, end: 1.2 },
            { speakerCharacterId: 'maya', text: 'Yes, and here is why.', start: 1.4, end: 2.9 },
          ],
        },
      };
    },
  };
  const speakerTurnQc = {
    maxRegenerations: 1,
    evaluate: async () => {
      speakerAttempt += 1;
      if (speakerAttempt === 1) {
        return {
          passed: false,
          score: 48,
          issues: [{
            code: 'wrong-speaker',
            severity: 'high',
            evidence: 'Alex visibly speaks Maya line.',
          }],
          regenerationGuidance: 'Maya must visibly speak the second line while Alex listens silently.',
        };
      }
      return {
        passed: true,
        score: 93,
        issues: [],
        regenerationGuidance: '',
      };
    },
  };

  const pipeline = new AudiovisualPipeline({
    llm,
    audiovisual,
    renderer: null,
    store: { saveProject: async () => {} },
    speakerTurnQc,
  });

  const project = await pipeline.generate({
    topic: 'dialogue test',
    durationSeconds: 8,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.equal(generationCalls.length, 2);
  assert.match(generationCalls[1].guidance, /Maya must visibly speak/i);
  assert.equal(project.scenes[0].speakerTurnQc.passed, true);
});

test('publishability gate blocks failed multi-speaker attribution', () => {
  const result = evaluateAudiovisualPublishability({
    productionScript: {
      fullDialogue: 'Question. Answer.',
      segments: [{ index: 0, locationId: 'room', editing: { allowInternalCuts: false } }],
    },
    scenes: [{
      index: 0,
      asset: { localPath: '/fake/dialogue.mp4' },
      visualQcHistory: [],
      speakerTurnQc: {
        passed: false,
        score: 45,
      },
    }],
    subtitles: {
      enabled: true,
      layout: { passed: true, violations: [] },
    },
  });

  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'speaker-turn'));
});


test('creative tournament hard-rejects unsafe concepts even with strong raw scores', () => {
  const candidates = [
    {
      id: 'safe',
      hook: 'Here is the mechanism that makes this topic surprising.',
      angle: 'mechanism reveal',
      format: 'direct explainer',
      retentionDevice: 'open loop',
      visualOpportunity: 'simple demonstration',
      riskNotes: [],
    },
    {
      id: 'unsafe',
      hook: 'A shocking claim that sounds irresistible.',
      angle: 'sensational unsupported claim',
      format: 'direct explainer',
      retentionDevice: 'shock',
      visualOpportunity: 'dramatic',
      riskNotes: ['unsupported factual claim'],
    },
  ];
  const ranking = rankCandidates({
    candidates,
    judgments: [
      {
        candidateId: 'safe',
        scores: {
          hookStrength: 84,
          retentionPotential: 86,
          clarity: 90,
          novelty: 78,
          productionFeasibility: 92,
          monetizationFit: 80,
          factualSafety: 96,
          platformFit: 90,
        },
      },
      {
        candidateId: 'unsafe',
        hardReject: true,
        scores: {
          hookStrength: 99,
          retentionPotential: 98,
          clarity: 90,
          novelty: 92,
          productionFeasibility: 90,
          monetizationFit: 95,
          factualSafety: 15,
          platformFit: 92,
        },
      },
    ],
  });

  assert.equal(ranking[0].candidateId, 'safe');
  assert.equal(ranking[1].candidateId, 'unsafe');
  assert.equal(ranking[1].score, 0);
  assert.equal(ranking[1].hardReject, true);
});

test('creative tournament selects the independently judged winner and exposes margin', async () => {
  const llm = {
    generateCreativeCandidates: async () => ({
      candidates: [
        {
          id: 'generic',
          angle: 'generic explainer',
          hook: 'Here is something about the topic.',
          format: 'direct explainer',
          emotionalDriver: 'curiosity',
          retentionDevice: 'basic open loop',
          payoff: 'explain it',
          visualOpportunity: 'presenter',
          dialogueStyle: 'direct',
          monetizationFit: 'general interest',
          productionNotes: 'simple',
          riskNotes: [],
        },
        {
          id: 'dialogue',
          angle: 'skeptic versus expert',
          hook: '“That cannot be true.” “It is—watch what happens next.”',
          format: 'dialogue',
          emotionalDriver: 'tension',
          retentionDevice: 'objection followed by visual proof',
          payoff: 'resolve the disagreement with mechanism',
          visualOpportunity: 'two-person demonstration',
          dialogueStyle: 'skeptic and expert',
          monetizationFit: 'repeatable series format',
          productionNotes: 'two actors one location',
          riskNotes: [],
        },
      ],
    }),
    judgeCreativeCandidates: async () => ({
      source: 'test-judge',
      model: 'judge-model',
      judgments: [
        {
          candidateId: 'generic',
          scores: {
            hookStrength: 65,
            retentionPotential: 66,
            clarity: 82,
            novelty: 50,
            productionFeasibility: 95,
            monetizationFit: 67,
            factualSafety: 95,
            platformFit: 72,
          },
          rationale: 'Safe but generic.',
        },
        {
          candidateId: 'dialogue',
          scores: {
            hookStrength: 92,
            retentionPotential: 94,
            clarity: 90,
            novelty: 87,
            productionFeasibility: 86,
            monetizationFit: 84,
            factualSafety: 94,
            platformFit: 93,
          },
          rationale: 'Strong tension, clear payoff and executable dialogue.',
        },
      ],
    }),
  };

  const tournament = new CreativeTournament({
    llm,
    candidateCount: 2,
    minWinnerScore: 68,
    minMargin: 2,
  });

  const result = await tournament.run({
    topic: 'why habits compound',
    audience: 'curious adults',
    durationSeconds: 30,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.winner.id, 'dialogue');
  assert.equal(result.ranking[0].candidateId, 'dialogue');
  assert.equal(result.judge.model, 'judge-model');
  assert.ok(result.margin > 2);
  assert.equal(result.confidence, 'clear');
});

test('audiovisual pipeline passes winning creative brief into screenplay generation', async () => {
  let receivedBrief = null;
  let audiovisualCalls = 0;
  const winningBrief = {
    id: 'winner',
    angle: 'skeptic versus expert',
    hook: 'That sounds wrong—until you see the mechanism.',
    format: 'dialogue',
    retentionDevice: 'objection then proof',
    payoff: 'resolve the objection',
    score: 91,
  };

  const llm = {
    generateProductionScript: async ({ topic, creativeBrief }) => {
      receivedBrief = creativeBrief;
      return {
        title: topic,
        synopsis: 'A dialogue-led explanation.',
        characters: [{
          id: 'presenter',
          name: 'Presenter',
          description: 'A credible adult presenter.',
          physicalTraits: 'Natural realistic appearance.',
          wardrobe: 'Neutral clothing.',
          voice: { presetId: 'Bernard', languageCode: 'en' },
        }],
        locations: [{
          id: 'room',
          name: 'Room',
          description: 'A realistic room.',
          lighting: 'Daylight.',
          fixedElements: ['table'],
        }],
        segments: [{
          durationSeconds: 6,
          purpose: 'hook',
          speakerCharacterId: 'presenter',
          characterIds: ['presenter'],
          locationId: 'room',
          dialogue: creativeBrief.hook,
          action: 'Presenter demonstrates the idea.',
          camera: 'Medium close-up.',
          ambience: 'Room tone.',
          soundEffects: [],
          music: '',
        }],
      };
    },
  };

  const pipeline = new AudiovisualPipeline({
    llm,
    audiovisual: {
      generateSegment: async ({ segment }) => {
        audiovisualCalls += 1;
        return {
          type: 'ai-video',
          localPath: '/fake/winner.mp4',
          generationId: 'winner-video',
          prompt: segment.dialogue,
        };
      },
    },
    renderer: null,
    store: { saveProject: async () => {} },
    creativeTournament: {
      run: async () => ({
        enabled: true,
        accepted: true,
        winner: winningBrief,
        winnerScore: 91,
        minimumWinnerScore: 68,
        candidates: [winningBrief],
        ranking: [{ candidateId: 'winner', score: 91 }],
      }),
    },
  });

  const project = await pipeline.generate({
    topic: 'why habits compound',
    durationSeconds: 6,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.equal(audiovisualCalls, 1);
  assert.deepEqual(receivedBrief, winningBrief);
  assert.equal(project.creativeBrief.id, 'winner');
  assert.equal(project.productionScript.segments[0].dialogue, winningBrief.hook);
});

test('audiovisual pipeline stops before media generation when no creative clears the quality floor', async () => {
  let scriptCalls = 0;
  let audiovisualCalls = 0;
  const saved = [];
  const pipeline = new AudiovisualPipeline({
    llm: {
      generateProductionScript: async () => {
        scriptCalls += 1;
        throw new Error('should not generate production script');
      },
    },
    audiovisual: {
      generateSegment: async () => {
        audiovisualCalls += 1;
        throw new Error('should not generate video');
      },
    },
    renderer: null,
    store: { saveProject: async (project) => saved.push(structuredClone(project)) },
    creativeTournament: {
      run: async () => ({
        enabled: true,
        accepted: false,
        winner: { id: 'weak', hook: 'weak hook' },
        winnerScore: 54,
        minimumWinnerScore: 68,
        candidates: [{ id: 'weak', hook: 'weak hook' }],
        ranking: [{ candidateId: 'weak', score: 54 }],
      }),
    },
  });

  const project = await pipeline.generate({
    topic: 'weak creative',
    durationSeconds: 20,
    render: false,
  });

  assert.equal(project.status, 'CREATIVE_REJECTED');
  assert.equal(scriptCalls, 0);
  assert.equal(audiovisualCalls, 0);
  assert.equal(saved.length, 1);
  assert.match(project.error, /minimum score of 68/i);
});

test('OpenAI creative judge can use a separate model from candidate generation', async () => {
  const bodies = [];
  const responses = [
    {
      candidates: [
        {
          id: 'a',
          angle: 'angle a',
          hook: 'A specific useful hook.',
          format: 'direct explainer',
          emotionalDriver: 'curiosity',
          retentionDevice: 'open loop',
          payoff: 'payoff',
          visualOpportunity: 'demonstration',
          dialogueStyle: 'direct',
          monetizationFit: 'evergreen',
          productionNotes: 'simple',
          riskNotes: [],
        },
        {
          id: 'b',
          angle: 'angle b',
          hook: 'A second specific useful hook.',
          format: 'dialogue',
          emotionalDriver: 'tension',
          retentionDevice: 'debate',
          payoff: 'resolution',
          visualOpportunity: 'two-person scene',
          dialogueStyle: 'conversation',
          monetizationFit: 'repeatable',
          productionNotes: 'simple',
          riskNotes: [],
        },
      ],
    },
    {
      judgments: [
        {
          candidateId: 'a',
          scores: {
            hookStrength: 80,
            retentionPotential: 80,
            clarity: 85,
            novelty: 75,
            productionFeasibility: 90,
            monetizationFit: 80,
            factualSafety: 95,
            platformFit: 85,
          },
        },
        {
          candidateId: 'b',
          scores: {
            hookStrength: 90,
            retentionPotential: 92,
            clarity: 88,
            novelty: 85,
            productionFeasibility: 85,
            monetizationFit: 84,
            factualSafety: 95,
            platformFit: 90,
          },
        },
      ],
    },
  ];

  const provider = new OpenAICompatibleLlmProvider({
    apiKey: 'test-key',
    model: 'generator-model',
    judgeModel: 'judge-model',
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      const body = responses.shift();
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(body) } }],
        }),
      };
    },
  });

  const generated = await provider.generateCreativeCandidates({
    topic: 'topic',
    audience: 'audience',
    durationSeconds: 30,
    count: 2,
  });
  await provider.judgeCreativeCandidates({
    topic: 'topic',
    audience: 'audience',
    durationSeconds: 30,
    candidates: generated.candidates,
  });

  assert.equal(bodies[0].model, 'generator-model');
  assert.equal(bodies[1].model, 'judge-model');
  assert.match(bodies[1].messages[0].content, /independent short-form creative judge/i);
});


test('trend clustering merges near-duplicate stories across independent sources', () => {
  const clusters = clusterTrendSignals([
    {
      id: 'yt-1',
      source: 'youtube',
      topic: 'AI video model launches new real-time generation feature',
      title: 'AI video model launches new real-time generation feature',
      strength: 84,
      publishedAt: new Date().toISOString(),
    },
    {
      id: 'reddit-1',
      source: 'reddit',
      topic: 'New real time AI video generation feature just launched',
      title: 'New real time AI video generation feature just launched',
      strength: 76,
      publishedAt: new Date().toISOString(),
    },
    {
      id: 'other',
      source: 'rss:tech',
      topic: 'Space telescope finds unusual exoplanet atmosphere',
      title: 'Space telescope finds unusual exoplanet atmosphere',
      strength: 71,
      publishedAt: new Date().toISOString(),
    },
  ], { threshold: 0.42 });

  assert.equal(clusters.length, 2);
  const ai = clusters.find((cluster) => /AI video/i.test(cluster.topic));
  assert.ok(ai);
  assert.equal(ai.sourceCount, 2);
  assert.equal(ai.signals.length, 2);
  assert.ok(ai.strength > 70);
});

test('trend history persists snapshots and turns rising strength into positive acceleration', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-trend-history-'));
  const filePath = path.join(dir, 'history.json');
  try {
    const store = new TrendHistoryStore(filePath);
    const base = {
      clusterKey: 'abc',
      topic: 'AI video',
      sourceCount: 1,
      signals: [{ source: 'youtube' }],
    };

    const first = await store.enrich([
      { ...base, strength: 45 },
    ], { observedAt: '2026-10-01T10:00:00.000Z' });
    const second = await store.enrich([
      { ...base, strength: 70 },
    ], { observedAt: '2026-10-01T11:00:00.000Z' });

    assert.equal(first[0].acceleration, 50);
    assert.ok(second[0].acceleration > 50);
    assert.ok(second[0].velocity > first[0].velocity);
    assert.equal(second[0].history.samples, 2);

    const saved = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(saved.abc.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('YouTube trend provider combines search results with current video statistics', async () => {
  const calls = [];
  const provider = new YouTubeTrendProvider({
    apiKey: 'youtube-key',
    regionCode: 'FR',
    maxResults: 5,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/search?')) {
        return jsonResponse({
          items: [{
            id: { videoId: 'abc123' },
            snippet: {
              title: 'AI video update | Example Channel',
              publishedAt: new Date(Date.now() - 2 * 3600000).toISOString(),
            },
          }],
        });
      }
      if (String(url).includes('/videos?')) {
        return jsonResponse({
          items: [{
            id: 'abc123',
            snippet: {
              title: 'AI video update | Example Channel',
              description: 'A concrete description of the update.',
              publishedAt: new Date(Date.now() - 2 * 3600000).toISOString(),
              channelTitle: 'Example Channel',
            },
            statistics: {
              viewCount: '200000',
              likeCount: '12000',
              commentCount: '900',
            },
          }],
        });
      }
      throw new Error('unexpected YouTube request');
    },
  });

  const signals = await provider.search('AI video');
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'youtube');
  assert.equal(signals[0].sourceId, 'abc123');
  assert.equal(signals[0].engagement.views, 200000);
  assert.equal(signals[0].sourceMetrics.regionCode, 'FR');
  assert.ok(signals[0].strength > 50);
  assert.ok(calls[0].includes('q=AI+video'));
  assert.ok(calls[1].includes('part=snippet%2Cstatistics'));
});

test('Reddit trend provider uses OAuth listing data and engagement rate', async () => {
  let captured = null;
  const provider = new RedditTrendProvider({
    accessToken: 'reddit-token',
    subreddit: 'technology',
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return jsonResponse({
        data: {
          children: [{
            data: {
              id: 'post1',
              title: 'A new AI video system is spreading quickly',
              selftext: 'People are testing the new release.',
              permalink: '/r/technology/comments/post1/example/',
              score: 4200,
              num_comments: 650,
              upvote_ratio: 0.93,
              created_utc: Math.floor(Date.now() / 1000) - 3600,
              subreddit: 'technology',
            },
          }],
        },
      });
    },
  });

  const signals = await provider.list();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'reddit');
  assert.equal(signals[0].engagement.score, 4200);
  assert.equal(signals[0].sourceMetrics.subreddit, 'technology');
  assert.match(captured.url, /\/r\/technology\/hot/);
  assert.equal(captured.options.headers.authorization, 'Bearer reddit-token');
});

test('RSS trend provider parses RSS evidence without runtime dependencies', async () => {
  const provider = new RssTrendProvider({
    feeds: [{ name: 'tech', url: 'https://example.com/feed.xml' }],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => `<?xml version="1.0"?>
        <rss><channel>
          <item>
            <title>New AI video generation system launches</title>
            <link>https://example.com/story</link>
            <description><![CDATA[The release adds faster realistic video generation.]]></description>
            <pubDate>Thu, 01 Oct 2026 10:00:00 GMT</pubDate>
          </item>
        </channel></rss>`,
    }),
  });

  const signals = await provider.list();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'rss:tech');
  assert.equal(signals[0].url, 'https://example.com/story');
  assert.match(signals[0].snippet, /faster realistic video/i);
});

test('trend intelligence ranks clustered live signals and attaches source-grounded research packets', async () => {
  const history = {
    enrich: async (clusters) => clusters.map((cluster) => ({
      ...cluster,
      velocity: 88,
      acceleration: 74,
      history: { samples: 3, delta: 8 },
    })),
  };
  const intelligence = new TrendIntelligence({
    providers: [
      {
        id: 'youtube',
        list: async () => [{
          id: 'yt',
          source: 'youtube',
          topic: 'AI video generation gets faster',
          title: 'AI video generation gets faster',
          snippet: 'A new release improves generation speed.',
          url: 'https://youtube.example/video',
          strength: 86,
          publishedAt: new Date().toISOString(),
        }],
        search: async () => [],
      },
      {
        id: 'rss',
        list: async () => [{
          id: 'rss',
          source: 'rss:tech',
          topic: 'Faster AI video generation arrives',
          title: 'Faster AI video generation arrives',
          snippet: 'The same release is covered by a technology publication.',
          url: 'https://news.example/story',
          strength: 75,
          publishedAt: new Date().toISOString(),
        }],
        search: async () => [],
      },
    ],
    historyStore: history,
    clusterThreshold: 0.4,
  });

  const opportunities = await intelligence.list();
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].sourceCount, 2);
  assert.equal(opportunities[0].velocity, 88);
  assert.equal(opportunities[0].acceleration, 74);
  assert.equal(opportunities[0].researchPacket.evidence.length, 2);
  assert.deepEqual(
    opportunities[0].researchPacket.sourceNames.sort(),
    ['rss:tech', 'youtube'],
  );
  assert.ok(opportunities[0].opportunityScore > 0);
});

test('research packet preserves URLs and warns creative stages not to treat snippets as verified facts', () => {
  const packet = buildResearchPacket({
    topic: 'AI video',
    signals: [{
      source: 'rss:tech',
      title: 'AI video story',
      snippet: 'Reported details from the source.',
      url: 'https://example.com/article',
      publishedAt: '2026-10-01T10:00:00.000Z',
      strength: 75,
    }],
  });

  assert.equal(packet.evidence[0].url, 'https://example.com/article');
  assert.ok(packet.provenancePolicy.some((line) => /not automatically verified facts/i.test(line)));
});

test('audiovisual creative tournament receives live research before any media generation', async () => {
  let tournamentResearch = null;
  let screenplayResearch = null;
  const packet = {
    topic: 'AI video',
    evidence: [{
      source: 'rss:tech',
      title: 'A sourced trend',
      url: 'https://example.com/source',
      snippet: 'Evidence snippet.',
    }],
  };
  const llm = {
    generateProductionScript: async ({ topic, researchPacket }) => {
      screenplayResearch = researchPacket;
      return {
        title: topic,
        synopsis: 'Grounded production.',
        characters: [{
          id: 'presenter',
          name: 'Presenter',
          description: 'A credible adult presenter.',
          physicalTraits: 'Natural appearance.',
          wardrobe: 'Neutral clothing.',
          voice: { presetId: 'Bernard', languageCode: 'en' },
        }],
        locations: [{
          id: 'room',
          name: 'Room',
          description: 'A real room.',
          lighting: 'Daylight.',
          fixedElements: ['table'],
        }],
        segments: [{
          durationSeconds: 6,
          purpose: 'hook',
          speakerCharacterId: 'presenter',
          characterIds: ['presenter'],
          locationId: 'room',
          dialogue: 'A grounded opening line.',
          action: 'Presenter speaks.',
          camera: 'Medium close-up.',
          ambience: 'Room tone.',
          soundEffects: [],
          music: '',
        }],
      };
    },
  };

  const pipeline = new AudiovisualPipeline({
    llm,
    audiovisual: {
      generateSegment: async ({ segment }) => ({
        type: 'ai-video',
        localPath: '/fake/grounded.mp4',
        generationId: 'grounded-video',
        prompt: segment.dialogue,
      }),
    },
    renderer: null,
    store: { saveProject: async () => {} },
    trendIntelligence: {
      research: async () => packet,
    },
    creativeTournament: {
      run: async ({ researchPacket }) => {
        tournamentResearch = researchPacket;
        return {
          enabled: true,
          accepted: true,
          winner: { id: 'grounded', hook: 'A grounded opening line.' },
          winnerScore: 88,
          minimumWinnerScore: 68,
          candidates: [],
          ranking: [],
        };
      },
    },
  });

  const project = await pipeline.generate({
    topic: 'AI video',
    durationSeconds: 6,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.deepEqual(tournamentResearch, packet);
  assert.deepEqual(screenplayResearch, packet);
  assert.equal(project.researchPacket.evidence[0].url, 'https://example.com/source');
});


test('daily planner allocates high-conviction opportunities without exceeding budget or video limit', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-daily-plan-'));
  try {
    const store = new DailyPlanStore(path.join(dir, 'plans.json'));
    const planner = new DailyContentPlanner({
      opportunitySource: {
        list: async () => [
          {
            id: 'top',
            topic: 'AI video agents are accelerating',
            opportunityScore: 88,
            velocity: 91,
            acceleration: 80,
            sourceCount: 3,
            researchPacket: { evidence: [{ url: 'a' }, { url: 'b' }] },
          },
          {
            id: 'second',
            topic: 'New battery chemistry explained',
            opportunityScore: 74,
            velocity: 72,
            acceleration: 58,
            sourceCount: 2,
            researchPacket: { evidence: [{ url: 'c' }] },
          },
        ],
      },
      store,
      dailyBudgetUsd: 4.5,
      maxVideos: 3,
      estimatedVideoCostUsd: 1.5,
      minOpportunityScore: 52,
      minEvidenceCount: 1,
      highConvictionScore: 78,
      highConvictionAcceleration: 62,
      maxVideosPerOpportunity: 2,
    });

    const plan = await planner.createPlan({
      date: '2026-10-01',
      budgetUsd: 4.5,
      maxVideos: 3,
      render: false,
    });

    assert.equal(plan.status, 'PLANNED');
    assert.equal(plan.jobs.length, 3);
    assert.equal(plan.jobs[0].opportunityId, 'top');
    assert.equal(plan.jobs[1].opportunityId, 'top');
    assert.equal(plan.jobs[0].variantCount, 2);
    assert.equal(plan.jobs[0].creativeCandidateCount, 8);
    assert.equal(plan.jobs[2].opportunityId, 'second');
    assert.equal(plan.budget.committedUsd, 4.5);
    assert.equal(plan.budget.remainingUsd, 0);
    assert.ok(plan.jobs.every((job) => job.estimatedCostUsd === 1.5));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('daily planner skips recent near-duplicate topics during cooldown', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-topic-cooldown-'));
  try {
    const store = new DailyPlanStore(path.join(dir, 'plans.json'));
    await store.savePlan({
      id: 'plan_old',
      date: '2026-09-30',
      createdAt: '2026-09-30T10:00:00.000Z',
      jobs: [{
        id: 'job_old',
        topic: 'New real-time AI video generation model launches',
        status: 'COMPLETED',
      }],
    });

    const planner = new DailyContentPlanner({
      opportunitySource: {
        list: async () => [
          {
            id: 'repeat',
            topic: 'Real time AI video generation model just launched',
            opportunityScore: 92,
            velocity: 94,
            acceleration: 88,
            sourceCount: 3,
            researchPacket: { evidence: [{ url: 'a' }] },
          },
          {
            id: 'fresh',
            topic: 'Ocean robot maps a newly discovered deep-sea ecosystem',
            opportunityScore: 71,
            velocity: 70,
            acceleration: 55,
            sourceCount: 2,
            researchPacket: { evidence: [{ url: 'b' }] },
          },
        ],
      },
      store,
      dailyBudgetUsd: 3,
      maxVideos: 2,
      estimatedVideoCostUsd: 1.5,
      topicSimilarityThreshold: 0.4,
      recentTopicDays: 7,
    });

    const plan = await planner.createPlan({ date: '2026-10-01' });

    assert.equal(plan.jobs.length, 1);
    assert.equal(plan.jobs[0].opportunityId, 'fresh');
    const skipped = plan.skipped.find((item) => item.opportunityId === 'repeat');
    assert.ok(skipped);
    assert.ok(skipped.reasons.some((reason) => /recent-topic similarity/i.test(reason)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('daily plan store persists queue state and exposes recent topics', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-plan-store-'));
  try {
    const store = new DailyPlanStore(path.join(dir, 'plans.json'));
    const plan = {
      id: 'plan_1',
      date: '2026-10-01',
      createdAt: '2026-10-01T08:00:00.000Z',
      status: 'PLANNED',
      jobs: [{
        id: 'job_1',
        topic: 'A persistent topic',
        status: 'QUEUED',
      }],
    };
    await store.savePlan(plan);

    const loaded = await store.getPlan('plan_1');
    const recent = await store.recentTopics({
      days: 7,
      now: new Date('2026-10-01T12:00:00.000Z'),
    });

    assert.equal(loaded.id, 'plan_1');
    assert.equal(recent.length, 1);
    assert.equal(recent[0].topic, 'A persistent topic');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('daily planner execution reuses planned research and creative budget for every queued job', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-plan-execution-'));
  try {
    const store = new DailyPlanStore(path.join(dir, 'plans.json'));
    const planner = new DailyContentPlanner({
      opportunitySource: { list: async () => [] },
      store,
    });
    const packet = {
      topic: 'AI video',
      evidence: [{ source: 'rss:tech', url: 'https://example.com/evidence' }],
    };
    await store.savePlan({
      id: 'plan_exec',
      date: '2026-10-01',
      createdAt: '2026-10-01T08:00:00.000Z',
      status: 'PLANNED',
      jobs: [
        {
          id: 'job_a',
          status: 'QUEUED',
          opportunityId: 'op_a',
          topic: 'AI video',
          audience: 'curious adults',
          durationSeconds: 30,
          render: false,
          variantIndex: 0,
          creativeCandidateCount: 7,
          estimatedCostUsd: 1.5,
          researchPacket: packet,
        },
        {
          id: 'job_b',
          status: 'QUEUED',
          opportunityId: 'op_a',
          topic: 'AI video',
          audience: 'curious adults',
          durationSeconds: 30,
          render: false,
          variantIndex: 1,
          creativeCandidateCount: 7,
          estimatedCostUsd: 1.5,
          researchPacket: packet,
        },
      ],
    });

    const calls = [];
    const result = await planner.executePlan('plan_exec', {
      pipeline: {
        generate: async (input) => {
          calls.push(input);
          return {
            id: `project_${input.productionVariantIndex}`,
            status: 'READY',
          };
        },
      },
    });

    assert.equal(result.status, 'COMPLETED');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].creativeCandidateCount, 7);
    assert.equal(calls[1].productionVariantIndex, 1);
    assert.deepEqual(calls[0].researchPacket, packet);
    assert.ok(result.jobs.every((job) => job.status === 'COMPLETED'));
    assert.equal(result.jobs[1].projectId, 'project_1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('daily planner records rejected generation without treating it as successful production', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-plan-rejected-'));
  try {
    const store = new DailyPlanStore(path.join(dir, 'plans.json'));
    const planner = new DailyContentPlanner({
      opportunitySource: { list: async () => [] },
      store,
    });
    await store.savePlan({
      id: 'plan_reject',
      date: '2026-10-01',
      createdAt: '2026-10-01T08:00:00.000Z',
      status: 'PLANNED',
      jobs: [{
        id: 'job_reject',
        status: 'QUEUED',
        topic: 'Weak concept',
        audience: 'curious adults',
        durationSeconds: 30,
        render: false,
        variantIndex: 0,
        creativeCandidateCount: 5,
        estimatedCostUsd: 1.5,
        researchPacket: null,
      }],
    });

    const result = await planner.executePlan('plan_reject', {
      pipeline: {
        generate: async () => ({
          id: 'project_rejected',
          status: 'CREATIVE_REJECTED',
          error: 'quality floor',
        }),
      },
    });

    assert.equal(result.status, 'FAILED');
    assert.equal(result.jobs[0].status, 'REJECTED');
    assert.equal(result.jobs[0].resultStatus, 'CREATIVE_REJECTED');
    assert.equal(result.jobs[0].error, 'quality floor');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('daily planner helper scales creative search depth with opportunity conviction', () => {
  assert.equal(chooseCreativeCandidateCount({
    opportunityScore: 88,
    acceleration: 80,
  }, true), 8);
  assert.equal(chooseCreativeCandidateCount({
    opportunityScore: 80,
    acceleration: 65,
  }, true), 7);
  assert.equal(chooseCreativeCandidateCount({
    opportunityScore: 72,
    acceleration: 40,
  }, false), 6);
  assert.equal(chooseCreativeCandidateCount({
    opportunityScore: 60,
    acceleration: 40,
  }, false), 5);

  const recent = closestRecentTopic('AI video model launch', [
    { topic: 'New AI video model launches today', planId: 'x' },
    { topic: 'Deep sea robotics discovery', planId: 'y' },
  ]);
  assert.equal(recent.planId, 'x');
  assert.ok(recent.similarity > 0.4);
});

test('creative tournament accepts planner candidate-count and variant overrides', async () => {
  let generatedInput = null;
  let judgedInput = null;
  const llm = {
    generateCreativeCandidates: async (input) => {
      generatedInput = input;
      return {
        candidates: Array.from({ length: input.count }, (_, index) => ({
          id: `candidate-${index}`,
          angle: `angle ${index}`,
          hook: `Specific hook number ${index} because it matters`,
          format: 'direct explainer',
          retentionDevice: 'open loop',
          payoff: 'payoff',
          visualOpportunity: 'demonstration',
          monetizationFit: 'evergreen',
          riskNotes: [],
        })),
      };
    },
    judgeCreativeCandidates: async (input) => {
      judgedInput = input;
      return {
        judgments: input.candidates.map((candidate, index) => ({
          candidateId: candidate.id,
          scores: {
            hookStrength: 80 + index,
            retentionPotential: 80,
            clarity: 85,
            novelty: 75,
            productionFeasibility: 90,
            monetizationFit: 80,
            factualSafety: 95,
            platformFit: 85,
          },
        })),
      };
    },
  };
  const tournament = new CreativeTournament({
    llm,
    candidateCount: 5,
    minWinnerScore: 60,
  });

  const result = await tournament.run({
    topic: 'planned variant',
    audience: 'adults',
    durationSeconds: 30,
    candidateCount: 7,
    variantIndex: 1,
  });

  assert.equal(generatedInput.count, 7);
  assert.equal(generatedInput.variantIndex, 1);
  assert.equal(judgedInput.variantIndex, 1);
  assert.equal(result.requestedCandidateCount, 7);
  assert.equal(result.variantIndex, 1);
});


test('realism director assigns action-aware capture profile and high-risk shot budget', () => {
  const director = new RealismDirector({
    enabled: true,
    defaultProfile: 'auto',
    maxShotsPerAct: 3,
  });

  const result = director.direct({
    topic: 'strength training in your thirties',
    synopsis: 'A gym explanation.',
    visualStyle: {
      description: 'hyperrealistic 4K masterpiece documentary',
      cameraRules: 'smooth cinematic movement',
      lightingRules: 'perfect lighting',
    },
    segments: [{
      index: 0,
      durationSeconds: 9,
      speakerMode: 'single-speaker',
      dialogueTurns: [{ speakerCharacterId: 'alex', text: 'Train consistently.' }],
      characterIds: ['alex'],
      action: 'Alex picks up a dumbbell and performs a squat while talking.',
      camera: '360 orbit with rapid zoom around Alex.',
      ambience: 'real gym with daylight window',
      editing: { allowInternalCuts: false, allowDissolves: true, shotCount: 1 },
    }],
  });

  assert.equal(result.realismDirection.profile, 'fitness-action');
  assert.equal(result.realismDirection.outputFrameRate, 30);
  assert.doesNotMatch(result.visualStyle.description, /hyperrealistic|4K|masterpiece/i);

  const scene = result.segments[0];
  assert.equal(scene.realismDirection.complexInteraction, true);
  assert.equal(scene.realismDirection.complexCamera, true);
  assert.equal(scene.realismDirection.actionHeavy, true);
  assert.ok(scene.realismDirection.riskScore >= 70);
  assert.equal(scene.realismDirection.stableShotSeconds, 2.2);
  assert.equal(scene.editing.allowInternalCuts, true);
  assert.equal(scene.editing.allowDissolves, false);
  assert.equal(scene.editing.shotCount, 3);
  assert.ok(scene.realismDirection.soundscape.foley.some((item) => /foot|weight|object/i.test(item)));
});

test('realism director keeps simple talking scene restrained instead of over-editing it', () => {
  const scene = directSegment({
    index: 0,
    durationSeconds: 5,
    speakerMode: 'single-speaker',
    dialogueTurns: [{ speakerCharacterId: 'maya', text: 'Here is the key point.' }],
    characterIds: ['maya'],
    action: 'Maya stands naturally and turns her head slightly toward camera.',
    camera: 'medium close-up, subtle push in',
    ambience: 'quiet indoor room with window light',
    editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
  });

  assert.ok(scene.realismDirection.riskScore < 50);
  assert.equal(scene.editing.allowInternalCuts, false);
  assert.equal(scene.editing.shotCount, 1);
  assert.match(scene.realismDirection.camera.movement, /push-in/i);
  assert.ok(scene.realismDirection.microMotion.some((item) => /breathing/i.test(item)));
});

test('anti-plastic prompt block adds physical camera, micro-motion and psychoacoustic sound cues', () => {
  const scene = directSegment({
    durationSeconds: 5,
    characterIds: ['alex'],
    action: 'Alex walks through a city street.',
    camera: 'follow shot',
    ambience: 'outdoor city street with traffic and light wind',
    editing: { allowInternalCuts: false, shotCount: 1 },
  }, {
    profile: 'organic-smartphone',
  });

  const block = buildRealismPromptBlock(scene);
  assert.match(block, /Physical camera/i);
  assert.match(block, /Environmental micro-motion/i);
  assert.match(block, /ROOM TONE/i);
  assert.match(block, /SYNCED FOLEY/i);
  assert.match(block, /waxy texture/i);
  assert.match(block, /perfect stabilization/i);
});

test('anti-plastic post processor applies only bounded optical degradation', () => {
  const post = new AntiPlasticPostProcessor({
    enabled: true,
    softnessMaxSigma: 0.35,
    grainMaxStrength: 2.2,
  });

  const filter = post.buildVideoFilter({
    baseFilter: 'scale=1080:1920,setsar=1',
    profile: {
      opticalSoftness: 0.9,
      saturation: 0.4,
      contrast: 1.8,
      grainStrength: 9,
    },
    frameRate: 24,
  });

  assert.match(filter, /gblur=sigma=0.35/);
  assert.match(filter, /eq=saturation=0.85:contrast=1.06/);
  assert.match(filter, /noise=alls=2.2/);
  assert.match(filter, /fps=24/);
  assert.doesNotMatch(filter, /rgbashift|tmix|minterpolate/i);
});

test('synthetic motion blur is rejected for morphing but can be considered for pure judder', () => {
  assert.equal(shouldApplySyntheticMotionBlur({
    temporalIssues: [{
      code: 'face-morph',
      evidence: 'face geometry melts between frames',
    }],
  }), false);

  assert.equal(shouldApplySyntheticMotionBlur({
    temporalIssues: [{
      code: 'judder',
      evidence: 'otherwise stable motion has visible frame skip',
    }],
  }), true);
});

test('audiovisual renderer respects realism-selected project frame rate and optical post filter', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-antiplastic-render-'));
  const calls = [];
  try {
    const renderer = new AudiovisualRenderer({
      outputDir: dir,
      runCommand: async (_command, args) => {
        calls.push(args);
      },
      audioInspector: {
        inspect: async () => ({
          passed: true,
          issues: [],
          integratedLufs: -14,
          truePeakDbtp: -1.5,
        }),
      },
      antiPlasticPostProcessor: new AntiPlasticPostProcessor({ enabled: true }),
    });

    const result = await renderer.render({
      id: 'anti-plastic-test',
      productionScript: {
        realismDirection: {
          profile: 'organic-documentary',
          outputFrameRate: 24,
          postProfile: {
            opticalSoftness: 0.22,
            saturation: 0.95,
            contrast: 0.99,
            grainStrength: 1.4,
          },
        },
      },
      scenes: [{
        index: 0,
        duration: 3,
        production: {
          realismDirection: {
            post: {
              opticalSoftness: 0.22,
              saturation: 0.95,
              contrast: 0.99,
              grainStrength: 1.4,
            },
          },
        },
        asset: { localPath: '/fake/act.mp4' },
      }],
      subtitles: { enabled: false, events: [], layout: { passed: true, violations: [] } },
    });

    const normalizeCall = calls.find((args) => args.includes('/fake/act.mp4'));
    const vfIndex = normalizeCall.indexOf('-vf');
    const filter = normalizeCall[vfIndex + 1];

    assert.match(filter, /gblur=sigma=0.22/);
    assert.match(filter, /noise=alls=1.4/);
    assert.match(filter, /fps=24/);
    assert.equal(result.frameRate, 24);
    assert.equal(result.antiPlasticPost.profile, 'organic-documentary');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('keyframe director scales endpoint locking with realism risk', () => {
  assert.equal(selectKeyframePolicy({
    riskScore: 20,
    firstFrameRiskThreshold: 32,
    lastFrameRiskThreshold: 50,
  }), 'off');
  assert.equal(selectKeyframePolicy({
    riskScore: 38,
    firstFrameRiskThreshold: 32,
    lastFrameRiskThreshold: 50,
  }), 'first');
  assert.equal(selectKeyframePolicy({
    riskScore: 72,
    firstFrameRiskThreshold: 32,
    lastFrameRiskThreshold: 50,
  }), 'first-last');

  const director = new KeyframeDirector({
    enabled: true,
    mode: 'auto',
    firstFrameRiskThreshold: 32,
    lastFrameRiskThreshold: 50,
  });
  const directed = director.direct({
    segments: [
      { index: 0, action: 'Person talks.', realismDirection: { riskScore: 18 } },
      {
        index: 1,
        action: 'Person walks.',
        startState: 'Alex stands beside the rack with both hands empty.',
        realismDirection: { riskScore: 40 },
      },
      {
        index: 2,
        action: 'Alex picks up one dumbbell and finishes standing upright.',
        startState: 'Alex stands with the dumbbell on the rack.',
        endState: 'Alex stands upright holding exactly one dumbbell at his side.',
        realismDirection: { riskScore: 75 },
      },
    ],
  });

  assert.equal(directed.segments[0].keyframeDirection.policy, 'off');
  assert.equal(directed.segments[1].keyframeDirection.policy, 'first');
  assert.equal(directed.segments[2].keyframeDirection.policy, 'first-last');
  assert.match(directed.segments[2].keyframeDirection.lastFrame.state, /exactly one dumbbell/i);
  assert.equal(directed.keyframeDirection.firstLastFrameActs, 1);
});

test('keyframe prompt preserves canonical identity and physically reachable endpoint', () => {
  const segment = {
    index: 0,
    characterIds: ['alex'],
    locationId: 'gym',
    action: 'Alex lifts one dumbbell from the rack and settles upright.',
    camera: 'Medium shot.',
    startState: 'Alex stands beside the rack with both hands visible and the dumbbell on the rack.',
    endState: 'Alex stands upright holding the same dumbbell at his right side.',
    keyframeDirection: {
      enabled: true,
      policy: 'first-last',
      firstFrame: { state: 'Alex stands beside the rack with both hands visible and the dumbbell on the rack.' },
      lastFrame: { state: 'Alex stands upright holding the same dumbbell at his right side.' },
    },
    realismDirection: {
      camera: {
        fieldOfView: '35mm field of view',
        apertureLook: 'moderate depth of field',
        support: 'handheld camera',
      },
    },
  };
  const script = {
    characters: [{
      id: 'alex',
      name: 'Alex',
      description: '34-year-old trainer',
      physicalTraits: 'short dark hair and light beard',
      wardrobe: 'white shirt and black shorts',
    }],
    locations: [{
      id: 'gym',
      name: 'Gym',
      description: 'brick neighborhood gym',
      lighting: 'morning window light',
      fixedElements: ['black dumbbell rack'],
    }],
    visualStyle: {
      description: 'natural documentary image',
      cameraRules: 'human-operated camera',
      lightingRules: 'motivated daylight',
    },
  };

  const prompts = buildKeyframePrompts({ segment, productionScript: script });
  assert.match(prompts.first, /FIRST FRAME/i);
  assert.match(prompts.first, /white shirt and black shorts/i);
  assert.match(prompts.first, /black dumbbell rack/i);
  assert.match(prompts.last, /LAST FRAME/i);
  assert.match(prompts.last, /same dumbbell at his right side/i);
  assert.match(prompts.last, /physically reachable/i);
});

test('Runway audiovisual provider uses WAN first-last keyframes while preserving locked reference audio', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-wan-keyframes-'));
  const requests = [];
  let imageTask = 0;
  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 2,
      sleepImpl: async () => {},
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ target, method: options.method || 'GET', body });

        if (target.endsWith('/text_to_speech') && options.method === 'POST') {
          return jsonResponse({ id: 'tts-keyframe' });
        }
        if (target.endsWith('/tasks/tts-keyframe')) {
          return jsonResponse({
            id: 'tts-keyframe',
            status: 'SUCCEEDED',
            output: ['https://cdn.example/keyframe-dialogue.mp3'],
          });
        }
        if (target.endsWith('/text_to_image') && options.method === 'POST') {
          imageTask += 1;
          assert.equal(body.model, 'gen4_image');
          assert.equal(body.ratio, '720:1280');
          return jsonResponse({ id: imageTask === 1 ? 'first-image' : 'last-image' });
        }
        if (target.endsWith('/tasks/first-image')) {
          return jsonResponse({
            id: 'first-image',
            status: 'SUCCEEDED',
            output: ['https://cdn.example/first.jpg'],
          });
        }
        if (target.endsWith('/tasks/last-image')) {
          return jsonResponse({
            id: 'last-image',
            status: 'SUCCEEDED',
            output: ['https://cdn.example/last.jpg'],
          });
        }
        if (target.endsWith('/image_to_video') && options.method === 'POST') {
          assert.equal(body.model, 'wan3');
          assert.equal(body.ratio, 'auto_720p');
          assert.deepEqual(body.promptImage, [
            { uri: 'https://cdn.example/first.jpg', position: 'first' },
            { uri: 'https://cdn.example/last.jpg', position: 'last' },
          ]);
          assert.equal(body.referenceAudio[0].uri, 'https://cdn.example/keyframe-dialogue.mp3');
          assert.equal(body.references, undefined);
          return jsonResponse({ id: 'wan-keyframe-video' });
        }
        if (target.endsWith('/tasks/wan-keyframe-video')) {
          return jsonResponse({
            id: 'wan-keyframe-video',
            status: 'SUCCEEDED',
            output: ['https://cdn.example/keyframe-video.mp4'],
          });
        }
        if (target === 'https://cdn.example/keyframe-video.mp4') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('keyframe-video').buffer,
          };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const script = {
      characters: [{
        id: 'alex',
        name: 'Alex',
        description: '34-year-old trainer',
        physicalTraits: 'short dark hair',
        wardrobe: 'white shirt',
        voice: { presetId: 'Bernard', languageCode: 'en' },
      }],
      locations: [{
        id: 'gym',
        name: 'Gym',
        description: 'real gym',
        lighting: 'window daylight',
        fixedElements: ['black rack'],
      }],
      visualStyle: {
        description: 'documentary realism',
        cameraRules: 'natural camera',
        lightingRules: 'motivated daylight',
      },
      audioDirection: { mix: 'clear dialogue', musicPolicy: 'low music' },
    };
    const segment = {
      index: 0,
      purpose: 'hook',
      durationSeconds: 7,
      speakerCharacterId: 'alex',
      characterIds: ['alex'],
      locationId: 'gym',
      dialogue: 'Start with one controlled movement.',
      action: 'Alex lifts one dumbbell from the rack.',
      camera: 'Medium shot.',
      ambience: 'Gym room tone.',
      soundEffects: ['dumbbell contact'],
      music: '',
      editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
      keyframeDirection: {
        enabled: true,
        policy: 'first-last',
        firstFrame: { state: 'Alex stands with the dumbbell on the rack.' },
        lastFrame: { state: 'Alex stands holding the same dumbbell at his side.' },
      },
    };

    const asset = await provider.generateSegment({
      segment,
      productionScript: script,
      storyBible: {
        visualStyle: script.visualStyle,
        references: {
          characters: {
            alex: {
              images: [{ url: 'https://cdn.example/alex-reference.jpg' }],
            },
          },
          locations: {
            gym: { url: 'https://cdn.example/gym-reference.jpg' },
          },
        },
      },
      projectId: 'keyframe-project',
    });

    assert.equal(asset.keyframeMode, 'first-last');
    assert.equal(asset.keyframes.first.url, 'https://cdn.example/first.jpg');
    assert.equal(asset.keyframes.last.url, 'https://cdn.example/last.jpg');
    assert.equal(asset.referenceImageUrl, 'https://cdn.example/first.jpg');
    assert.equal(asset.referenceEndImageUrl, 'https://cdn.example/last.jpg');
    assert.equal(await readFile(asset.localPath, 'utf8'), 'keyframe-video');

    const lastImageRequest = requests
      .filter((request) => request.target.endsWith('/text_to_image'))[1];
    assert.ok(lastImageRequest.body.referenceImages.some(
      (reference) => reference.uri === 'https://cdn.example/first.jpg'
        && reference.tag === 'firstframe',
    ));
    assert.equal(
      requests.filter((request) => request.target.endsWith('/text_to_video')).length,
      0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Runway keyframe generation fails open to text-to-video when image generation fails', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-keyframe-fail-open-'));
  const requests = [];
  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      dialogueMode: 'native',
      keyframeFailOpen: true,
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 1,
      sleepImpl: async () => {},
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ target, body });

        if (target.endsWith('/text_to_image')) {
          return jsonResponse({ error: 'image generation unavailable' }, 500);
        }
        if (target.endsWith('/text_to_video')) {
          return jsonResponse({ id: 'fallback-video' });
        }
        if (target.endsWith('/tasks/fallback-video')) {
          return jsonResponse({
            id: 'fallback-video',
            status: 'SUCCEEDED',
            output: ['https://cdn.example/fallback-video.mp4'],
          });
        }
        if (target === 'https://cdn.example/fallback-video.mp4') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('fallback-video').buffer,
          };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const segment = {
      index: 0,
      purpose: 'hook',
      durationSeconds: 5,
      dialogue: 'A short line.',
      speakerCharacterId: 'p',
      characterIds: ['p'],
      locationId: 'room',
      action: 'Person reaches toward a cup.',
      camera: 'Medium shot.',
      ambience: 'Room tone.',
      soundEffects: [],
      music: '',
      keyframeDirection: {
        enabled: true,
        policy: 'first-last',
        firstFrame: { state: 'Hand beside cup.' },
        lastFrame: { state: 'Hand holds cup.' },
      },
    };
    const script = {
      characters: [{
        id: 'p',
        name: 'Person',
        description: 'adult',
        physicalTraits: 'natural',
        wardrobe: 'neutral',
        voice: { presetId: 'Bernard', languageCode: 'en' },
      }],
      locations: [{
        id: 'room',
        name: 'Room',
        description: 'real room',
        lighting: 'daylight',
        fixedElements: ['table'],
      }],
      visualStyle: { description: 'real', cameraRules: 'natural', lightingRules: 'daylight' },
      audioDirection: { mix: 'clear', musicPolicy: 'low' },
    };

    const asset = await provider.generateSegment({
      segment,
      productionScript: script,
      projectId: 'fail-open',
    });

    assert.equal(asset.keyframeMode, 'off');
    assert.match(asset.keyframeError, /Runway request failed/i);
    assert.equal(requests.some((request) => request.target.endsWith('/text_to_video')), true);
    assert.equal(requests.some((request) => request.target.endsWith('/image_to_video')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('realism QC rejects a generated act that misses its explicit last keyframe', async () => {
  const requests = [];
  const qc = new OpenRouterRealismQcProvider({
    apiKey: 'router-key',
    model: 'vision-model',
    temporalEnabled: false,
    keyframeThreshold: 84,
    frameSampler: {
      sample: async () => [
        { index: 0, timestamp: 0.1, dataUrl: 'data:image/jpeg;base64,OPEN' },
        { index: 1, timestamp: 4.9, dataUrl: 'data:image/jpeg;base64,CLOSE' },
      ],
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              overallScore: 92,
              temporalScore: 100,
              scores: {
                photorealism: 94,
                anatomy: 94,
                geometry: 94,
                physics: 92,
                motionConsistency: 92,
                continuity: 94,
                identityContinuity: 94,
                locationContinuity: 94,
                sceneRelevance: 92,
                artifactFreedom: 94,
                materialRealism: 92,
                cameraPhysics: 91,
                lightingNaturalism: 93,
                keyframeStartMatch: 91,
                keyframeEndMatch: 61,
              },
              temporalScores: {},
              issues: [{
                code: 'last-keyframe-drift',
                severity: 'high',
                evidence: 'Ending pose does not reach the supplied final keyframe.',
              }],
              temporalIssues: [],
              regenerationGuidance: 'Reach the supplied final pose without changing identity or location.',
            }),
          },
        }],
      });
    },
  });

  const result = await qc.evaluateScene(
    {
      narration: 'Person completes one movement.',
      duration: 5,
      continuity: { characterIds: ['p'], locationId: 'room' },
    },
    {
      localPath: '/fake/keyframed.mp4',
      generatedDuration: '5s',
      prompt: 'move naturally',
      keyframes: {
        first: { url: 'https://cdn.example/first.jpg' },
        last: { url: 'https://cdn.example/last.jpg' },
      },
    },
  );

  assert.equal(result.staticPassed, true);
  assert.equal(result.keyframeStartPassed, true);
  assert.equal(result.keyframeEndPassed, false);
  assert.equal(result.keyframeAdherencePassed, false);
  assert.equal(result.passed, false);

  const content = requests[0].messages[1].content;
  assert.ok(content.some(
    (part) => part.type === 'image_url'
      && part.image_url.url === 'https://cdn.example/first.jpg',
  ));
  assert.ok(content.some(
    (part) => part.type === 'image_url'
      && part.image_url.url === 'https://cdn.example/last.jpg',
  ));
});


test('motion region director isolates speech motion and stabilizes face/body/background', () => {
  const directed = directMotionRegions({
    index: 0,
    dialogue: 'Here is the key point.',
    dialogueTurns: [{
      speakerCharacterId: 'maya',
      text: 'Here is the key point.',
    }],
    speakerMode: 'single-speaker',
    characterIds: ['maya'],
    action: 'Maya stands naturally and speaks to camera.',
    realismDirection: {
      complexInteraction: false,
      actionHeavy: false,
      camera: { axis: 'locked' },
      microMotion: ['subtle breathing and posture micro-adjustments'],
    },
  });

  assert.equal(directed.motionRegionDirection.enabled, true);
  assert.equal(directed.motionRegionDirection.nativeSpatialMask, false);
  assert.equal(directed.motionRegionDirection.cameraMoving, false);
  assert.ok(directed.motionRegionDirection.allowedRegionIds.includes('speech-mouth-jaw'));
  assert.ok(directed.motionRegionDirection.allowedRegionIds.includes('posture-micro-motion'));
  assert.ok(directed.motionRegionDirection.lockedRegionIds.includes('face-identity'));
  assert.ok(directed.motionRegionDirection.lockedRegionIds.includes('environment-anchors'));

  const background = directed.motionRegionDirection.lockedRegions
    .find((item) => item.id === 'environment-anchors');
  assert.equal(background.tolerance, 'locked');
  assert.match(background.rule, /screen-space position stable/i);
});

test('motion region director allows only hands and primary prop for object interaction', () => {
  const directed = directMotionRegions({
    index: 0,
    dialogue: '',
    dialogueTurns: [],
    speakerMode: 'single-speaker',
    characterIds: ['alex'],
    action: 'Alex picks up one dumbbell from the rack.',
    realismDirection: {
      complexInteraction: true,
      actionHeavy: false,
      camera: { axis: 'locked' },
      microMotion: ['clothing settles naturally'],
    },
  });

  const handRegion = directed.motionRegionDirection.allowedMotion
    .find((item) => item.id === 'hands-primary-prop');
  assert.ok(handRegion);
  assert.match(handRegion.region, /hands, wrists, forearms/i);
  assert.match(handRegion.behavior, /single planned object interaction/i);

  const bodyLock = directed.motionRegionDirection.lockedRegions
    .find((item) => item.id === 'body-shape');
  assert.ok(bodyLock);
  assert.match(bodyLock.region, /torso, hips and legs/i);
});

test('motion region director preserves camera parallax for tracking shots instead of freezing pixels', () => {
  const directed = directMotionRegions({
    index: 0,
    dialogue: '',
    characterIds: ['runner'],
    action: 'Runner moves through the gym.',
    realismDirection: {
      complexInteraction: false,
      actionHeavy: true,
      camera: { axis: 'tracking' },
      microMotion: [],
    },
  });

  assert.equal(directed.motionRegionDirection.cameraMoving, true);
  assert.ok(directed.motionRegionDirection.allowedRegionIds.includes('body-action-chain'));

  const environment = directed.motionRegionDirection.lockedRegions
    .find((item) => item.id === 'environment-anchors');
  assert.equal(environment.tolerance, 'parallax-only');
  assert.match(environment.rule, /correct camera parallax/i);
});

test('motion region prompt block explicitly separates allowed motion from locked regions', () => {
  const directed = directMotionRegions({
    dialogue: 'Move carefully.',
    characterIds: ['alex'],
    action: 'Alex picks up a cup.',
    realismDirection: {
      complexInteraction: true,
      actionHeavy: false,
      camera: { axis: 'locked' },
      microMotion: ['light wind affects loose hair and fabric'],
    },
  });

  const block = buildMotionRegionPromptBlock(directed);
  assert.match(block, /MOTION REGION CONTROL/i);
  assert.match(block, /ALLOWED TO MOVE/i);
  assert.match(block, /active speaker mouth and jaw/i);
  assert.match(block, /hands, wrists, forearms/i);
  assert.match(block, /LOCKED \/ STABILIZE/i);
  assert.match(block, /walls, doors, windows, furniture/i);
  assert.match(block, /Do not animate the entire image/i);

  const contract = buildMotionRegionQcContract(directed);
  assert.equal(contract.cameraMoving, false);
  assert.ok(contract.allowedMotion.length >= 2);
  assert.ok(contract.lockedRegions.length >= 2);
});

test('motion region director handles multi-speaker blocking by locking inactive speakers', () => {
  const director = new MotionRegionDirector({
    enabled: true,
    mode: 'semantic',
  });
  const script = director.direct({
    segments: [{
      index: 0,
      speakerMode: 'multi-speaker',
      dialogue: 'Question. Answer.',
      dialogueTurns: [
        { speakerCharacterId: 'host', text: 'Question.' },
        { speakerCharacterId: 'expert', text: 'Answer.' },
      ],
      characterIds: ['host', 'expert'],
      action: 'Host asks a question; expert answers.',
      realismDirection: {
        camera: { axis: 'locked' },
        microMotion: [],
        complexInteraction: false,
        actionHeavy: false,
      },
    }],
  });

  const plan = script.segments[0].motionRegionDirection;
  assert.ok(plan.lockedRegionIds.includes('inactive-speakers'));
  const inactive = plan.lockedRegions.find((item) => item.id === 'inactive-speakers');
  assert.match(inactive.rule, /mouth closed\/resting/i);
  assert.equal(script.motionRegionDirection.actsControlled, 1);
});

test('Runway audiovisual prompt records semantic region control without inventing a native mask field', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-motion-region-provider-'));
  const requests = [];
  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      dialogueMode: 'native',
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 1,
      sleepImpl: async () => {},
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ target, body });

        if (target.endsWith('/text_to_video')) {
          return jsonResponse({ id: 'motion-region-video' });
        }
        if (target.endsWith('/tasks/motion-region-video')) {
          return jsonResponse({
            id: 'motion-region-video',
            status: 'SUCCEEDED',
            output: ['https://cdn.example/motion-region.mp4'],
          });
        }
        if (target === 'https://cdn.example/motion-region.mp4') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('motion-region').buffer,
          };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const segment = directMotionRegions({
      index: 0,
      purpose: 'hook',
      durationSeconds: 5,
      dialogue: 'Only my mouth should move while I speak.',
      dialogueTurns: [{
        speakerCharacterId: 'p',
        text: 'Only my mouth should move while I speak.',
      }],
      speakerCharacterId: 'p',
      speakerMode: 'single-speaker',
      characterIds: ['p'],
      locationId: 'room',
      action: 'Presenter stands and speaks.',
      camera: 'Locked medium shot.',
      ambience: 'Quiet room tone.',
      soundEffects: [],
      music: '',
      editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
      realismDirection: {
        camera: { axis: 'locked' },
        microMotion: [],
        complexInteraction: false,
        actionHeavy: false,
      },
      keyframeDirection: { enabled: false, policy: 'off' },
    });

    const script = {
      characters: [{
        id: 'p',
        name: 'Presenter',
        description: 'adult presenter',
        physicalTraits: 'stable natural face',
        wardrobe: 'neutral shirt',
        voice: { presetId: 'Bernard', languageCode: 'en' },
      }],
      locations: [{
        id: 'room',
        name: 'Room',
        description: 'real room',
        lighting: 'window daylight',
        fixedElements: ['desk', 'window'],
      }],
      visualStyle: {
        description: 'natural documentary',
        cameraRules: 'locked physical camera',
        lightingRules: 'motivated daylight',
      },
      audioDirection: { mix: 'clear speech', musicPolicy: 'none' },
    };

    const asset = await provider.generateSegment({
      segment,
      productionScript: script,
      projectId: 'motion-region',
    });

    const request = requests.find((item) => item.target.endsWith('/text_to_video'));
    assert.match(request.body.promptText, /MOTION REGION CONTROL/i);
    assert.match(request.body.promptText, /ALLOWED TO MOVE/i);
    assert.match(request.body.promptText, /LOCKED \/ STABILIZE/i);
    assert.equal(request.body.motionMask, undefined);
    assert.equal(request.body.mask, undefined);
    assert.equal(asset.motionControlMode, 'semantic-region-prompt');
    assert.equal(asset.nativeMotionMask, false);
    assert.equal(asset.motionRegionDirection.enabled, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('realism QC rejects background drift even when overall realism and temporal score are high', async () => {
  const qc = new OpenRouterRealismQcProvider({
    apiKey: 'router-key',
    model: 'vision-model',
    threshold: 82,
    temporalThreshold: 80,
    motionRegionThreshold: 84,
    temporalEnabled: true,
    frameSampler: {
      sample: async () => [
        { index: 0, timestamp: 1, dataUrl: 'data:image/jpeg;base64,STATIC' },
      ],
      sampleTemporal: async () => [
        { index: 0, timestamp: 0.2, dataUrl: 'data:image/jpeg;base64,T0' },
        { index: 1, timestamp: 1.0, dataUrl: 'data:image/jpeg;base64,T1' },
      ],
    },
    fetchImpl: async () => jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            overallScore: 94,
            temporalScore: 92,
            scores: {
              photorealism: 94,
              anatomy: 94,
              geometry: 92,
              physics: 92,
              motionConsistency: 92,
              continuity: 94,
              identityContinuity: 94,
              locationContinuity: 94,
              sceneRelevance: 94,
              artifactFreedom: 94,
              materialRealism: 94,
              cameraPhysics: 92,
              lightingNaturalism: 93,
              keyframeStartMatch: 100,
              keyframeEndMatch: 100,
            },
            temporalScores: {
              identityStability: 93,
              objectPersistence: 92,
              geometryStability: 91,
              motionPlausibility: 92,
              cameraContinuity: 94,
              flickerFreedom: 92,
              temporalArtifactFreedom: 91,
              actionContinuity: 93,
            },
            motionRegionScores: {
              motionRegionCompliance: 62,
              lockedRegionStability: 58,
              intendedMotionCompliance: 91,
              backgroundDriftFreedom: 49,
            },
            issues: [],
            temporalIssues: [{
              code: 'background-breathing',
              severity: 'high',
              evidence: 'Desk edge and wall subtly warp while the locked camera remains static.',
            }],
            summary: 'Looks realistic in isolated frames.',
            temporalSummary: 'Unintended background drift violates the motion plan.',
            regenerationGuidance: '',
          }),
        },
      }],
    }),
  });

  const scene = {
    narration: 'Presenter speaks to camera.',
    duration: 5,
    continuity: { characterIds: ['p'], locationId: 'room' },
    motionRegionDirection: directMotionRegions({
      dialogue: 'Presenter speaks.',
      action: 'Presenter stands and speaks.',
      realismDirection: {
        camera: { axis: 'locked' },
        complexInteraction: false,
        actionHeavy: false,
        microMotion: [],
      },
    }).motionRegionDirection,
  };

  const result = await qc.evaluateScene(scene, {
    localPath: '/fake/motion-regions.mp4',
    generatedDuration: '5s',
    prompt: 'locked presenter shot',
    motionControlMode: 'semantic-region-prompt',
  });

  assert.equal(result.staticPassed, true);
  assert.equal(result.temporalPassed, true);
  assert.equal(result.motionRegionVerified, true);
  assert.equal(result.motionRegionPassed, false);
  assert.equal(result.passed, false);
  assert.equal(result.motionRegionScores.backgroundDriftFreedom, 49);
  assert.match(result.regenerationGuidance, /MOTION REGION CORRECTION/i);
  assert.match(result.regenerationGuidance, /background|walls|furniture/i);
});

test('realism QC does not require motion-region scores when provider did not apply region control', async () => {
  const qc = new OpenRouterRealismQcProvider({
    apiKey: 'router-key',
    model: 'vision-model',
    temporalEnabled: true,
    frameSampler: {
      sample: async () => [
        { index: 0, timestamp: 1, dataUrl: 'data:image/jpeg;base64,STATIC' },
      ],
      sampleTemporal: async () => [
        { index: 0, timestamp: 0.2, dataUrl: 'data:image/jpeg;base64,T0' },
      ],
    },
    fetchImpl: async () => jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            overallScore: 93,
            temporalScore: 91,
            scores: {
              photorealism: 93,
              anatomy: 93,
              geometry: 93,
              physics: 93,
              motionConsistency: 93,
              continuity: 93,
              identityContinuity: 93,
              locationContinuity: 93,
              sceneRelevance: 93,
              artifactFreedom: 93,
              materialRealism: 93,
              cameraPhysics: 93,
              lightingNaturalism: 93,
              keyframeStartMatch: 100,
              keyframeEndMatch: 100,
            },
            temporalScores: {
              identityStability: 91,
              objectPersistence: 91,
              geometryStability: 91,
              motionPlausibility: 91,
              cameraContinuity: 91,
              flickerFreedom: 91,
              temporalArtifactFreedom: 91,
              actionContinuity: 91,
            },
            issues: [],
            temporalIssues: [],
          }),
        },
      }],
    }),
  });

  const result = await qc.evaluateScene({
    narration: 'Legacy provider scene.',
    duration: 5,
    continuity: { characterIds: [], locationId: null },
    motionRegionDirection: {
      enabled: true,
      allowedMotion: [],
      lockedRegions: [],
    },
  }, {
    localPath: '/fake/legacy-provider.mp4',
    generatedDuration: '5s',
    prompt: 'legacy',
    motionControlMode: 'off',
  });

  assert.equal(result.motionRegionVerified, false);
  assert.equal(result.motionRegionPassed, true);
  assert.equal(result.passed, true);
});

test('audiovisual pipeline persists project-wide motion-region provenance', async () => {
  const pipeline = new AudiovisualPipeline({
    llm: new TemplateLlmProvider(),
    audiovisual: {
      generateSegment: async ({ segment }) => ({
        type: 'ai-video',
        localPath: `/fake/motion-plan-${segment.index}.mp4`,
        generationId: `motion-plan-${segment.index}`,
        prompt: segment.dialogue,
        audioMode: 'native',
        motionControlMode: segment.motionRegionDirection?.enabled
          ? 'semantic-region-prompt'
          : 'off',
      }),
    },
    renderer: null,
    store: { saveProject: async () => {} },
    realismQc: null,
  });

  const project = await pipeline.generate({
    topic: 'natural speaking and movement',
    durationSeconds: 20,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.equal(project.motionRegionDirection.enabled, true);
  assert.ok(project.productionScript.segments.every(
    (segment) => segment.motionRegionDirection?.enabled,
  ));
});


test('motion reference store validates URL/duration and preserves rights metadata', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-motion-ref-store-'));
  const file = path.join(dir, 'motion-references.json');
  try {
    await writeFile(file, JSON.stringify({
      references: [
        {
          id: 'licensed-walk',
          actionClass: 'walking',
          tags: ['full body', 'weight transfer'],
          cameraMode: 'locked',
          people: 1,
          durationSeconds: 6,
          url: 'https://cdn.example/walk.mp4',
          license: 'owned recording',
          rightsConfirmed: true,
          verifiedHumanMotion: true,
        },
        {
          id: 'invalid-local',
          actionClass: 'walking',
          durationSeconds: 6,
          url: '/tmp/walk.mp4',
          rightsConfirmed: true,
        },
        {
          id: 'too-long',
          actionClass: 'walking',
          durationSeconds: 20,
          url: 'https://cdn.example/too-long.mp4',
          rightsConfirmed: true,
        },
      ],
    }));

    const store = new MotionReferenceStore(file);
    const refs = await store.list();

    assert.equal(refs.length, 1);
    assert.equal(refs[0].id, 'licensed-walk');
    assert.equal(refs[0].rightsConfirmed, true);
    assert.equal(refs[0].actionClass, 'walking');
    assert.ok(refs[0].tags.includes('full-body'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('motion guide director selects a rights-confirmed human reference for high-risk action', async () => {
  const refs = [
    {
      id: 'wrong-run',
      actionClass: 'running',
      tags: ['running', 'full-body'],
      cameraMode: 'locked',
      people: 1,
      durationSeconds: 6,
      url: 'https://cdn.example/run.mp4',
      verifiedHumanMotion: true,
      rightsConfirmed: true,
    },
    {
      id: 'walk-good',
      actionClass: 'walking',
      tags: ['walking', 'natural', 'full-body', 'weight-transfer'],
      cameraMode: 'tracking',
      people: 1,
      durationSeconds: 5,
      url: 'https://cdn.example/walk.mp4',
      verifiedHumanMotion: true,
      rightsConfirmed: true,
    },
    {
      id: 'walk-unlicensed',
      actionClass: 'walking',
      tags: ['walking', 'natural'],
      cameraMode: 'tracking',
      people: 1,
      durationSeconds: 5,
      url: 'https://cdn.example/unlicensed.mp4',
      verifiedHumanMotion: true,
      rightsConfirmed: false,
    },
  ];
  const director = new MotionGuideDirector({
    store: { list: async () => refs },
    enabled: true,
    mode: 'auto',
    minRiskScore: 50,
    minSelectionScore: 0.55,
    requireRightsConfirmed: true,
  });

  const result = await director.direct({
    segments: [{
      index: 0,
      durationSeconds: 5,
      characterIds: ['alex'],
      action: 'Alex walks naturally across the gym floor.',
      startState: 'Alex stands at the left edge.',
      endState: 'Alex reaches the rack.',
      realismDirection: {
        riskScore: 62,
        camera: { axis: 'tracking' },
      },
    }],
  });

  const plan = result.segments[0].motionGuideDirection;
  assert.equal(plan.eligible, true);
  assert.equal(plan.actionClass, 'walking');
  assert.equal(plan.selectedReference.id, 'walk-good');
  assert.ok(plan.selectedReference.selectionScore >= 0.55);
  assert.equal(result.motionGuideDirection.selectedActs, 1);
  assert.equal(result.motionGuideDirection.usableLibrarySize, 2);
});

test('motion guide director skips low-risk talking scene and classifies physical actions', () => {
  assert.equal(classifyMotionAction({
    action: 'Alex lifts one dumbbell from the rack.',
  }), 'lifting');
  assert.equal(classifyMotionAction({
    action: 'Maya walks toward the window.',
  }), 'walking');

  const segment = directMotionGuide({
    durationSeconds: 5,
    dialogue: 'This is the point.',
    action: 'Presenter stands naturally.',
    realismDirection: { riskScore: 18, camera: { axis: 'locked' } },
  }, [{
    id: 'unused',
    actionClass: 'walking',
    durationSeconds: 5,
    url: 'https://cdn.example/walk.mp4',
    rightsConfirmed: true,
    verifiedHumanMotion: true,
  }]);

  assert.equal(segment.motionGuideDirection.eligible, false);
  assert.equal(segment.motionGuideDirection.actionClass, 'talking');
  assert.equal(segment.motionGuideDirection.selectedReference, null);
});

test('motion guide reference scoring rewards matching action, camera and duration', () => {
  const segment = {
    durationSeconds: 6,
    characterIds: ['runner'],
    action: 'Runner sprints forward with natural foot plants.',
    realismDirection: { camera: { axis: 'tracking' } },
  };
  const good = scoreReference(segment, {
    actionClass: 'running',
    tags: ['running', 'sprint', 'foot-plants'],
    cameraMode: 'tracking',
    people: 1,
    durationSeconds: 6,
  }, 'running');
  const weak = scoreReference(segment, {
    actionClass: 'walking',
    tags: ['walking'],
    cameraMode: 'locked',
    people: 2,
    durationSeconds: 12,
  }, 'running');

  assert.ok(good > weak);
  assert.ok(good >= 0.75);
});

test('motion guide prompt treats reference as mechanics only, never identity/style authority', () => {
  const block = buildMotionGuidePromptBlock({
    motionGuideDirection: {
      actionClass: 'walking',
      selectedReference: { id: 'walk-1' },
    },
  });

  assert.match(block, /VIDEO MOTION REFERENCE GUIDANCE/i);
  assert.match(block, /temporal rhythm/i);
  assert.match(block, /body mechanics/i);
  assert.match(block, /Do NOT copy the reference performer identity/i);
  assert.match(block, /Canonical character identity/i);
});

test('video reference planner prioritizes motion guide and never exceeds 15 seconds', () => {
  const plan = buildVideoReferencePlan({
    motionGuide: {
      selectedReference: {
        id: 'walk',
        url: 'https://cdn.example/walk.mp4',
        durationSeconds: 7,
      },
    },
    previousAsset: {
      sourceUrl: 'https://cdn.example/previous.mp4',
      generatedDuration: '9s',
    },
    maxCombinedSeconds: 15,
  });

  assert.deepEqual(plan.references, [
    { type: 'video', uri: 'https://cdn.example/walk.mp4' },
  ]);
  assert.deepEqual(plan.metadata.roles, ['motion-guide']);
  assert.deepEqual(plan.metadata.droppedRoles, ['previous-act']);
  assert.equal(plan.metadata.totalDurationSeconds, 7);

  const fits = buildVideoReferencePlan({
    motionGuide: {
      selectedReference: {
        id: 'walk',
        url: 'https://cdn.example/walk.mp4',
        durationSeconds: 6,
      },
    },
    previousAsset: {
      sourceUrl: 'https://cdn.example/previous.mp4',
      generatedDuration: '5s',
    },
  });
  assert.equal(fits.references.length, 2);
  assert.equal(fits.metadata.totalDurationSeconds, 11);
});

test('Runway audiovisual provider sends real-motion guide with locked dialogue and caches it for QC', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-motion-guide-provider-'));
  const requests = [];
  let guideDownloads = 0;
  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      dialogueMode: 'locked',
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 1,
      sleepImpl: async () => {},
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ target, method: options.method || 'GET', body });

        if (target === 'https://cdn.example/walk-guide.mp4') {
          guideDownloads += 1;
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('real-motion-guide').buffer,
          };
        }
        if (target.endsWith('/text_to_speech') && options.method === 'POST') {
          return jsonResponse({ id: 'tts-motion-guide' });
        }
        if (target.endsWith('/tasks/tts-motion-guide')) {
          return jsonResponse({
            id: 'tts-motion-guide',
            status: 'SUCCEEDED',
            output: ['https://cdn.example/dialogue.mp3'],
          });
        }
        if (target.endsWith('/text_to_video') && options.method === 'POST') {
          assert.deepEqual(body.referenceVideos, [{
            type: 'video',
            uri: 'https://cdn.example/walk-guide.mp4',
          }]);
          assert.equal(body.referenceAudio[0].uri, 'https://cdn.example/dialogue.mp3');
          assert.match(body.promptText, /VIDEO MOTION REFERENCE GUIDANCE/i);
          assert.match(body.promptText, /Do NOT copy the reference performer identity/i);
          return jsonResponse({ id: 'motion-guided-video' });
        }
        if (target.endsWith('/tasks/motion-guided-video')) {
          return jsonResponse({
            id: 'motion-guided-video',
            status: 'SUCCEEDED',
            output: ['https://cdn.example/generated.mp4'],
          });
        }
        if (target === 'https://cdn.example/generated.mp4') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('generated-video').buffer,
          };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const segment = {
      index: 0,
      purpose: 'demo',
      durationSeconds: 6,
      dialogue: 'Watch how the weight shifts naturally.',
      dialogueTurns: [{
        turnIndex: 0,
        speakerCharacterId: 'alex',
        text: 'Watch how the weight shifts naturally.',
      }],
      speakerCharacterId: 'alex',
      speakerMode: 'single-speaker',
      characterIds: ['alex'],
      locationId: 'gym',
      action: 'Alex walks naturally toward the rack.',
      camera: 'Tracking medium shot.',
      ambience: 'Gym room tone.',
      soundEffects: ['footsteps'],
      music: '',
      editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
      realismDirection: {
        riskScore: 62,
        camera: { axis: 'tracking' },
      },
      keyframeDirection: { enabled: false, policy: 'off' },
      motionGuideDirection: {
        enabled: true,
        eligible: true,
        actionClass: 'walking',
        selectedReference: {
          id: 'walk-guide',
          actionClass: 'walking',
          tags: ['walking'],
          cameraMode: 'tracking',
          people: 1,
          durationSeconds: 6,
          url: 'https://cdn.example/walk-guide.mp4',
          rightsConfirmed: true,
          verifiedHumanMotion: true,
          selectionScore: 0.9,
        },
      },
    };
    const script = {
      characters: [{
        id: 'alex',
        name: 'Alex',
        description: 'adult trainer',
        physicalTraits: 'short dark hair',
        wardrobe: 'white shirt',
        voice: {
          presetId: 'Bernard',
          languageCode: 'en',
          description: 'natural male voice',
          delivery: 'calm',
        },
      }],
      locations: [{
        id: 'gym',
        name: 'Gym',
        description: 'real neighborhood gym',
        lighting: 'window daylight',
        fixedElements: ['rack'],
      }],
      visualStyle: {
        description: 'natural documentary',
        cameraRules: 'physical tracking camera',
        lightingRules: 'motivated daylight',
      },
      audioDirection: { mix: 'clear dialogue', musicPolicy: 'low' },
    };

    const asset = await provider.generateSegment({
      segment,
      productionScript: script,
      projectId: 'motion-guide-project',
    });

    assert.equal(asset.motionGuideMode, 'reference-video');
    assert.equal(asset.motionGuide.selectedReference.id, 'walk-guide');
    assert.equal(asset.referenceVideoPlan.totalDurationSeconds, 6);
    assert.deepEqual(asset.referenceVideoPlan.roles, ['motion-guide']);
    assert.equal(asset.motionGuideError, null);
    assert.equal(guideDownloads, 1);
    assert.equal(await readFile(asset.motionGuide.localPath, 'utf8'), 'real-motion-guide');
    assert.equal(await readFile(asset.localPath, 'utf8'), 'generated-video');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('motion guide failure can fail open without lying in the generation prompt', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-motion-guide-fail-open-'));
  const requests = [];
  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      dialogueMode: 'native',
      motionGuideFailOpen: true,
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 1,
      sleepImpl: async () => {},
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ target, body });

        if (target === 'https://cdn.example/broken-guide.mp4') {
          return {
            ok: false,
            status: 403,
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        if (target.endsWith('/text_to_video')) {
          assert.equal(body.referenceVideos, undefined);
          assert.doesNotMatch(body.promptText, /VIDEO MOTION REFERENCE GUIDANCE/i);
          return jsonResponse({ id: 'fallback-no-guide' });
        }
        if (target.endsWith('/tasks/fallback-no-guide')) {
          return jsonResponse({
            id: 'fallback-no-guide',
            status: 'SUCCEEDED',
            output: ['https://cdn.example/fallback-no-guide.mp4'],
          });
        }
        if (target === 'https://cdn.example/fallback-no-guide.mp4') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('fallback').buffer,
          };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const asset = await provider.generateSegment({
      segment: {
        index: 0,
        purpose: 'action',
        durationSeconds: 5,
        dialogue: '',
        dialogueTurns: [],
        characterIds: ['p'],
        locationId: 'room',
        action: 'Person walks.',
        camera: 'Locked shot.',
        ambience: 'room',
        soundEffects: [],
        music: '',
        editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
        realismDirection: { riskScore: 60, camera: { axis: 'locked' } },
        keyframeDirection: { enabled: false, policy: 'off' },
        motionGuideDirection: {
          enabled: true,
          eligible: true,
          actionClass: 'walking',
          selectedReference: {
            id: 'broken',
            url: 'https://cdn.example/broken-guide.mp4',
            durationSeconds: 5,
            selectionScore: 0.8,
          },
        },
      },
      productionScript: {
        characters: [{
          id: 'p',
          name: 'Person',
          description: 'adult',
          physicalTraits: 'natural',
          wardrobe: 'neutral',
          voice: { presetId: 'Bernard', languageCode: 'en' },
        }],
        locations: [{
          id: 'room',
          name: 'Room',
          description: 'real room',
          lighting: 'daylight',
          fixedElements: [],
        }],
        visualStyle: { description: 'real', cameraRules: 'natural', lightingRules: 'daylight' },
        audioDirection: { mix: 'natural', musicPolicy: 'none' },
      },
      projectId: 'fail-open-guide',
    });

    assert.equal(asset.motionGuideMode, 'off');
    assert.match(asset.motionGuideError, /download failed/i);
    assert.equal(asset.referenceVideoCount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('realism QC rejects motion that looks plausible but misses real-motion guide mechanics', async () => {
  const sampledPaths = [];
  const qc = new OpenRouterRealismQcProvider({
    apiKey: 'router-key',
    model: 'vision-model',
    temporalEnabled: true,
    motionGuideThreshold: 80,
    frameSampler: {
      sample: async () => [
        { index: 0, timestamp: 1, dataUrl: 'data:image/jpeg;base64,STATIC' },
      ],
      sampleTemporal: async (localPath) => {
        sampledPaths.push(localPath);
        return localPath.includes('guide')
          ? [
            { index: 0, timestamp: 0.1, dataUrl: 'data:image/jpeg;base64,G0' },
            { index: 1, timestamp: 2.5, dataUrl: 'data:image/jpeg;base64,G1' },
          ]
          : [
            { index: 0, timestamp: 0.1, dataUrl: 'data:image/jpeg;base64,T0' },
            { index: 1, timestamp: 2.5, dataUrl: 'data:image/jpeg;base64,T1' },
          ];
      },
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const content = body.messages[1].content;
      assert.ok(content.some(
        (part) => part.type === 'text' && /REAL-MOTION REFERENCE SEQUENCE/i.test(part.text),
      ));
      assert.ok(content.some(
        (part) => part.type === 'image_url'
          && part.image_url.url === 'data:image/jpeg;base64,G0',
      ));

      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              overallScore: 93,
              temporalScore: 91,
              scores: {
                photorealism: 93,
                anatomy: 93,
                geometry: 93,
                physics: 92,
                motionConsistency: 91,
                continuity: 93,
                identityContinuity: 93,
                locationContinuity: 93,
                sceneRelevance: 92,
                artifactFreedom: 93,
                materialRealism: 92,
                cameraPhysics: 92,
                lightingNaturalism: 92,
                keyframeStartMatch: 100,
                keyframeEndMatch: 100,
              },
              temporalScores: {
                identityStability: 91,
                objectPersistence: 91,
                geometryStability: 91,
                motionPlausibility: 90,
                cameraContinuity: 92,
                flickerFreedom: 92,
                temporalArtifactFreedom: 91,
                actionContinuity: 91,
              },
              motionRegionScores: {
                motionRegionCompliance: 100,
                lockedRegionStability: 100,
                intendedMotionCompliance: 100,
                backgroundDriftFreedom: 100,
              },
              motionGuideScores: {
                motionGuideAdherence: 58,
                poseTrajectoryMatch: 62,
                timingRhythmMatch: 55,
                contactMechanicsMatch: 49,
              },
              issues: [],
              temporalIssues: [],
              regenerationGuidance: '',
            }),
          },
        }],
      });
    },
  });

  const result = await qc.evaluateScene({
    narration: 'Person walks naturally.',
    duration: 5,
    continuity: { characterIds: ['p'], locationId: 'room' },
  }, {
    localPath: '/fake/generated.mp4',
    generatedDuration: '5s',
    prompt: 'walk naturally',
    motionControlMode: 'off',
    motionGuideMode: 'reference-video',
    motionGuide: {
      actionClass: 'walking',
      localPath: '/fake/guide.mp4',
      selectedReference: {
        id: 'walk-guide',
        durationSeconds: 5,
        selectionScore: 0.9,
      },
    },
  });

  assert.equal(result.staticPassed, true);
  assert.equal(result.temporalPassed, true);
  assert.equal(result.motionGuideVerified, true);
  assert.equal(result.motionGuidePassed, false);
  assert.equal(result.passed, false);
  assert.equal(result.motionGuideScores.contactMechanicsMatch, 49);
  assert.match(result.regenerationGuidance, /MOTION GUIDE CORRECTION/i);
  assert.ok(sampledPaths.includes('/fake/guide.mp4'));
});

test('audiovisual pipeline persists selected motion-guide provenance when library matches', async () => {
  const motionGuideDirector = new MotionGuideDirector({
    enabled: true,
    mode: 'always',
    minSelectionScore: 0.5,
    requireRightsConfirmed: true,
    store: {
      list: async () => [{
        id: 'lift-guide',
        actionClass: 'lifting',
        tags: ['lifting', 'dumbbell'],
        cameraMode: 'any',
        people: 1,
        durationSeconds: 5,
        url: 'https://cdn.example/lift.mp4',
        verifiedHumanMotion: true,
        rightsConfirmed: true,
      }],
    },
  });

  const pipeline = new AudiovisualPipeline({
    llm: {
      generateCreativeCandidates: async () => ({
        candidates: [{
          id: 'c1',
          angle: 'demo',
          hook: 'Watch the movement.',
          format: 'demo',
          retentionDevice: 'open loop',
          payoff: 'show form',
          visualOpportunity: 'gym action',
          monetizationFit: 'evergreen',
          riskNotes: [],
        }],
      }),
      judgeCreativeCandidates: async ({ candidates }) => ({
        judgments: candidates.map((candidate) => ({
          candidateId: candidate.id,
          scores: {
            hookStrength: 90,
            retentionPotential: 90,
            clarity: 90,
            novelty: 80,
            productionFeasibility: 90,
            monetizationFit: 80,
            factualSafety: 95,
            platformFit: 90,
          },
        })),
      }),
      generateProductionScript: async () => ({
        title: 'Lift',
        topic: 'lift',
        synopsis: 'A lifting demo',
        characters: [{
          id: 'alex',
          name: 'Alex',
          description: 'trainer',
          physicalTraits: 'natural',
          wardrobe: 'white shirt',
          voice: { presetId: 'Bernard', languageCode: 'en' },
        }],
        locations: [{
          id: 'gym',
          name: 'Gym',
          description: 'real gym',
          lighting: 'daylight',
          fixedElements: ['rack'],
        }],
        visualStyle: {
          description: 'natural',
          cameraRules: 'locked',
          lightingRules: 'daylight',
        },
        audioDirection: { mix: 'natural', musicPolicy: 'none' },
        segments: [{
          index: 0,
          start: 0,
          durationSeconds: 5,
          purpose: 'demo',
          speakerCharacterId: 'alex',
          characterIds: ['alex'],
          locationId: 'gym',
          dialogue: 'Lift with control.',
          dialogueTurns: [{
            speakerCharacterId: 'alex',
            text: 'Lift with control.',
          }],
          action: 'Alex lifts one dumbbell from the rack.',
          camera: 'Locked medium shot.',
          ambience: 'gym',
          soundEffects: [],
          music: '',
          transition: '',
        }],
      }),
    },
    audiovisual: {
      generateSegment: async ({ segment }) => ({
        type: 'ai-video',
        localPath: '/fake/lift.mp4',
        generationId: 'lift',
        prompt: segment.action,
        audioMode: 'native',
        motionGuideMode: segment.motionGuideDirection?.selectedReference
          ? 'reference-video'
          : 'off',
        motionGuide: segment.motionGuideDirection?.selectedReference
          ? {
            actionClass: segment.motionGuideDirection.actionClass,
            localPath: '/fake/guide.mp4',
            selectedReference: segment.motionGuideDirection.selectedReference,
          }
          : null,
      }),
    },
    renderer: null,
    store: { saveProject: async () => {} },
    realismQc: null,
    motionGuideDirector,
  });

  const project = await pipeline.generate({
    topic: 'lifting form',
    durationSeconds: 5,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.equal(project.motionGuideDirection.selectedActs, 1);
  assert.equal(
    project.productionScript.segments[0].motionGuideDirection.selectedReference.id,
    'lift-guide',
  );
});


test('pose normalization is invariant to actor translation and scale', () => {
  const reference = makePoseSequence({
    offsetX: 0.2,
    offsetY: 0.1,
    scale: 0.8,
    kneeBend: [0.02, 0.1, 0.18, 0.1, 0.02],
  });
  const transformed = makePoseSequence({
    offsetX: 2.7,
    offsetY: -1.4,
    scale: 2.4,
    kneeBend: [0.02, 0.1, 0.18, 0.1, 0.02],
  });

  const result = comparePoseSequences(reference, transformed);

  assert.ok(result.coverage > 0.9);
  assert.ok(result.poseTrajectoryScore >= 94);
  assert.ok(result.bodyMechanicsScore >= 94);
  assert.ok(result.overallScore >= 90);
});

test('pose comparison rejects different joint mechanics despite similar duration', () => {
  const reference = makePoseSequence({
    kneeBend: [0.02, 0.12, 0.28, 0.12, 0.02],
    wristLift: [0, 0.05, 0.1, 0.05, 0],
  });
  const bad = makePoseSequence({
    kneeBend: [0.02, 0.02, 0.02, 0.02, 0.02],
    wristLift: [0, 0.35, 0.55, 0.35, 0],
  });

  const result = comparePoseSequences(reference, bad);

  assert.ok(result.poseTrajectoryScore < 90);
  assert.ok(result.bodyMechanicsScore < 90);
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => /trajectory|mechanics/i.test(issue)));
});

test('pose summary emits compact provider-safe skeleton beats', () => {
  const summary = summarizePoseSequence(makePoseSequence({
    kneeBend: [0.02, 0.12, 0.24, 0.12, 0.02],
  }), { maxBeats: 5 });
  const prompt = poseSummaryToPrompt(summary);

  assert.equal(summary.beats.length, 5);
  assert.match(prompt, /Normalized skeleton timing/i);
  assert.match(prompt, /knee=/i);
  assert.doesNotMatch(prompt, /face|shirt|background/i);
});

test('motion reference store normalizes embedded pose sequence without appearance data', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-pose-store-'));
  const file = path.join(dir, 'motion-references.json');
  try {
    await writeFile(file, JSON.stringify({
      references: [{
        id: 'squat-owned',
        actionClass: 'squat',
        tags: ['squat', 'full-body'],
        cameraMode: 'locked',
        people: 1,
        durationSeconds: 4,
        url: 'https://cdn.example/squat.mp4',
        source: 'internal capture',
        license: 'owned',
        verifiedHumanMotion: true,
        rightsConfirmed: true,
        poseSequence: makePoseSequence({
          kneeBend: [0.02, 0.18, 0.32, 0.18, 0.02],
        }),
      }],
    }));

    const store = new MotionReferenceStore(file);
    const refs = await store.list();

    assert.equal(refs.length, 1);
    assert.equal(refs[0].poseSequence.coordinateSpace, 'body-normalized-2d');
    assert.ok(refs[0].poseSequence.frames.length >= 5);
    assert.equal(refs[0].poseSequence.frames[0].appearance, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pose motion extractor can use embedded pose without external command', async () => {
  const extractor = new PoseMotionExtractor({ command: '' });
  const result = await extractor.extract('/not-needed.mp4', {
    embeddedPoseSequence: makePoseSequence({
      kneeBend: [0.02, 0.1, 0.2, 0.1, 0.02],
    }),
  });

  assert.equal(result.source, 'embedded');
  assert.equal(result.extractor, 'precomputed');
  assert.ok(result.sequence.frames.length >= 5);
});

test('pose motion extractor executes configurable command contract and parses JSON', async () => {
  const calls = [];
  const extractor = new PoseMotionExtractor({
    command: 'pose-tool',
    args: ['--input', '{video}', '--out', '{output_json}', '--fps', '{fps}'],
    sampleFps: 9,
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      const outputPath = args[args.indexOf('--out') + 1];
      await writeFile(outputPath, JSON.stringify(makePoseSequence({
        kneeBend: [0.02, 0.1, 0.2, 0.1, 0.02],
      })));
    },
  });

  const result = await extractor.extract('/fake/generated.mp4', {
    durationSeconds: 4,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'pose-tool');
  assert.ok(calls[0].args.includes('/fake/generated.mp4'));
  assert.ok(calls[0].args.includes('9'));
  assert.equal(result.source, 'external-command');
  assert.ok(result.sequence.frames.length >= 5);
});

test('motion guide prompt includes skeleton abstraction when pose summary is available', () => {
  const summary = summarizePoseSequence(makePoseSequence({
    kneeBend: [0.02, 0.18, 0.3, 0.18, 0.02],
  }), { maxBeats: 5 });

  const block = buildMotionGuidePromptBlock({
    motionGuideDirection: {
      actionClass: 'squat',
      selectedReference: { id: 'squat-guide' },
      poseSummary: summary,
    },
  });

  assert.match(block, /POSE\/SKELETON ABSTRACTION/i);
  assert.match(block, /Normalized skeleton timing/i);
  assert.match(block, /knee=/i);
});

test('Runway motion guide extracts pose summary before building generation prompt', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-pose-prompt-'));
  const requests = [];
  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      dialogueMode: 'native',
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 1,
      sleepImpl: async () => {},
      poseExtractor: {
        available: true,
        command: 'fake-pose',
        extract: async () => ({
          source: 'external-command',
          extractor: 'fake-pose',
          sequence: normalizePoseSequence(makePoseSequence({
            kneeBend: [0.02, 0.18, 0.3, 0.18, 0.02],
          })),
        }),
      },
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ target, body });

        if (target === 'https://cdn.example/squat-guide.mp4') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('guide').buffer,
          };
        }
        if (target.endsWith('/text_to_video')) {
          assert.match(body.promptText, /POSE\/SKELETON ABSTRACTION/i);
          assert.match(body.promptText, /Normalized skeleton timing/i);
          return jsonResponse({ id: 'pose-prompt-video' });
        }
        if (target.endsWith('/tasks/pose-prompt-video')) {
          return jsonResponse({
            id: 'pose-prompt-video',
            status: 'SUCCEEDED',
            output: ['https://cdn.example/pose-output.mp4'],
          });
        }
        if (target === 'https://cdn.example/pose-output.mp4') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('video').buffer,
          };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const asset = await provider.generateSegment({
      segment: {
        index: 0,
        purpose: 'demo',
        durationSeconds: 5,
        dialogue: '',
        dialogueTurns: [],
        characterIds: ['alex'],
        locationId: 'gym',
        action: 'Alex performs one controlled squat.',
        camera: 'Locked shot.',
        ambience: 'gym',
        soundEffects: [],
        music: '',
        editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
        realismDirection: { riskScore: 70, camera: { axis: 'locked' } },
        keyframeDirection: { enabled: false, policy: 'off' },
        motionGuideDirection: {
          enabled: true,
          eligible: true,
          actionClass: 'squat',
          selectedReference: {
            id: 'squat-guide',
            url: 'https://cdn.example/squat-guide.mp4',
            durationSeconds: 5,
            selectionScore: 0.91,
          },
        },
      },
      productionScript: {
        characters: [{
          id: 'alex',
          name: 'Alex',
          description: 'trainer',
          physicalTraits: 'natural',
          wardrobe: 'white shirt',
          voice: { presetId: 'Bernard', languageCode: 'en' },
        }],
        locations: [{
          id: 'gym',
          name: 'Gym',
          description: 'real gym',
          lighting: 'daylight',
          fixedElements: ['rack'],
        }],
        visualStyle: { description: 'natural', cameraRules: 'locked', lightingRules: 'daylight' },
        audioDirection: { mix: 'natural', musicPolicy: 'none' },
      },
      projectId: 'pose-prompt',
    });

    assert.equal(asset.motionGuide.poseSource, 'external-command');
    assert.ok(asset.motionGuide.poseSummary?.beats?.length >= 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pose motion QC passes translation/scale-equivalent skeleton motion', async () => {
  const extractor = {
    available: true,
    extract: async (pathName, options = {}) => ({
      source: options.embeddedPoseSequence ? 'embedded' : 'external-command',
      extractor: 'fake',
      sequence: normalizePoseSequence(
        options.embeddedPoseSequence
        || (pathName.includes('generated')
          ? makePoseSequence({
            offsetX: 2.5,
            offsetY: -1.2,
            scale: 2.1,
            kneeBend: [0.02, 0.1, 0.2, 0.1, 0.02],
          })
          : makePoseSequence({
            kneeBend: [0.02, 0.1, 0.2, 0.1, 0.02],
          })),
      ),
    }),
  };
  const qc = new PoseMotionQcProvider({
    extractor,
    threshold: 78,
    minCoverage: 0.55,
  });

  const result = await qc.evaluate({
    localPath: '/fake/generated.mp4',
    generatedDuration: '4s',
    motionGuideMode: 'reference-video',
    motionGuide: {
      localPath: '/fake/reference.mp4',
      selectedReference: {
        id: 'squat',
        durationSeconds: 4,
        poseSequence: makePoseSequence({
          kneeBend: [0.02, 0.1, 0.2, 0.1, 0.02],
        }),
      },
    },
  }, {
    segment: { durationSeconds: 4 },
  });

  assert.equal(result.applied, true);
  assert.equal(result.passed, true);
  assert.ok(result.overallScore >= 90);
  assert.ok(result.coverage >= 0.9);
});

test('pose motion QC rejects wrong biomechanics and produces targeted regeneration guidance', async () => {
  const qc = new PoseMotionQcProvider({
    extractor: {
      available: true,
      extract: async (pathName, options = {}) => ({
        source: options.embeddedPoseSequence ? 'embedded' : 'external-command',
        extractor: 'fake',
        sequence: normalizePoseSequence(
          options.embeddedPoseSequence
          || (pathName.includes('generated')
            ? makePoseSequence({
              kneeBend: [0.02, 0.02, 0.02, 0.02, 0.02],
              wristLift: [0, 0.45, 0.6, 0.45, 0],
            })
            : makePoseSequence({
              kneeBend: [0.02, 0.18, 0.32, 0.18, 0.02],
            })),
        ),
      }),
    },
    threshold: 82,
    minCoverage: 0.55,
    failClosed: true,
  });

  const result = await qc.evaluate({
    localPath: '/fake/generated.mp4',
    generatedDuration: '4s',
    motionGuideMode: 'reference-video',
    motionGuide: {
      localPath: '/fake/reference.mp4',
      selectedReference: {
        id: 'squat',
        durationSeconds: 4,
        poseSequence: makePoseSequence({
          kneeBend: [0.02, 0.18, 0.32, 0.18, 0.02],
        }),
      },
    },
  }, {
    segment: { durationSeconds: 4 },
  });

  assert.equal(result.passed, false);
  assert.ok(result.overallScore < 82);
  assert.match(result.regenerationGuidance, /POSE MOTION CORRECTION/i);
  assert.match(result.regenerationGuidance, /skeleton trajectory/i);
});

test('pose motion QC stays inactive when no generated-video extractor is configured', async () => {
  const qc = new PoseMotionQcProvider({
    extractor: {
      available: false,
    },
  });

  const result = await qc.evaluate({
    localPath: '/fake/generated.mp4',
    motionGuideMode: 'reference-video',
    motionGuide: {
      localPath: '/fake/reference.mp4',
      selectedReference: {
        id: 'walk',
        durationSeconds: 4,
        poseSequence: makePoseSequence({}),
      },
    },
  }, {
    segment: { durationSeconds: 4 },
  });

  assert.equal(result.enabled, false);
  assert.equal(result.applied, false);
  assert.equal(result.passed, true);
});

test('audiovisual pipeline regenerates pose-motion mismatch then accepts corrected biomechanics', async () => {
  const calls = [];
  let qcAttempt = 0;
  const pipeline = new AudiovisualPipeline({
    llm: new TemplateLlmProvider(),
    audiovisual: {
      generateSegment: async ({ segment, regeneration }) => {
        calls.push(regeneration);
        return {
          type: 'ai-video',
          localPath: `/fake/pose-${segment.index}-${regeneration?.attempt || 0}.mp4`,
          generationId: `pose-${segment.index}-${regeneration?.attempt || 0}`,
          prompt: segment.action,
          audioMode: 'native',
          motionGuideMode: 'reference-video',
          motionGuide: {
            localPath: '/fake/reference.mp4',
            selectedReference: { id: 'ref', durationSeconds: 5 },
          },
        };
      },
    },
    renderer: null,
    store: { saveProject: async () => {} },
    realismQc: null,
    poseMotionQc: {
      maxRegenerations: 1,
      evaluate: async () => {
        qcAttempt += 1;
        if (qcAttempt === 1) {
          return {
            passed: false,
            issues: ['body mechanics / joint angles diverge'],
            regenerationGuidance: 'POSE MOTION CORRECTION: match knee flexion and weight transfer.',
          };
        }
        return {
          passed: true,
          issues: [],
          regenerationGuidance: '',
        };
      },
    },
  });

  const project = await pipeline.generate({
    topic: 'controlled lifting movement',
    durationSeconds: 20,
    render: false,
  });

  assert.equal(project.status, 'READY');
  assert.ok(calls.some((item) => item?.guidance?.includes('POSE MOTION CORRECTION')));
  assert.ok(project.scenes.every((scene) => scene.poseMotionQc?.passed));
});

test('audiovisual pipeline returns POSE_MOTION_QC_FAILED when skeleton gate never passes', async () => {
  const pipeline = new AudiovisualPipeline({
    llm: new TemplateLlmProvider(),
    audiovisual: {
      generateSegment: async ({ segment }) => ({
        type: 'ai-video',
        localPath: `/fake/pose-fail-${segment.index}.mp4`,
        generationId: `pose-fail-${segment.index}`,
        prompt: segment.action,
        audioMode: 'native',
        motionGuideMode: 'reference-video',
        motionGuide: {
          localPath: '/fake/reference.mp4',
          selectedReference: { id: 'ref', durationSeconds: 5 },
        },
      }),
    },
    renderer: null,
    store: { saveProject: async () => {} },
    poseMotionQc: {
      maxRegenerations: 0,
      evaluate: async () => ({
        passed: false,
        issues: ['pose trajectory diverges from reference'],
        regenerationGuidance: 'POSE MOTION CORRECTION: follow the reference trajectory.',
      }),
    },
  });

  const project = await pipeline.generate({
    topic: 'pose failure',
    durationSeconds: 20,
    render: false,
  });

  assert.equal(project.status, 'POSE_MOTION_QC_FAILED');
  assert.match(project.error, /failed QC/i);
});

function makePoseSequence({
  offsetX = 0,
  offsetY = 0,
  scale = 1,
  kneeBend = [0.02, 0.1, 0.2, 0.1, 0.02],
  wristLift = [0, 0.04, 0.08, 0.04, 0],
} = {}) {
  const frames = kneeBend.map((bend, index) => {
    const t = index;
    const wrist = wristLift[index] ?? 0;
    const p = (x, y) => ({
      x: offsetX + (x * scale),
      y: offsetY + (y * scale),
      confidence: 0.98,
    });
    return {
      time: t,
      joints: {
        nose: p(0.5, 0.12 + (bend * 0.1)),
        left_shoulder: p(0.42, 0.3 + bend),
        right_shoulder: p(0.58, 0.3 + bend),
        left_elbow: p(0.36, 0.46 + (bend * 0.8)),
        right_elbow: p(0.64, 0.46 + (bend * 0.8)),
        left_wrist: p(0.32, 0.62 - wrist + (bend * 0.5)),
        right_wrist: p(0.68, 0.62 - wrist + (bend * 0.5)),
        left_hip: p(0.45, 0.62 + bend),
        right_hip: p(0.55, 0.62 + bend),
        left_knee: p(0.44 - (bend * 0.22), 0.82 + (bend * 0.45)),
        right_knee: p(0.56 + (bend * 0.22), 0.82 + (bend * 0.45)),
        left_ankle: p(0.43, 1.02),
        right_ankle: p(0.57, 1.02),
      },
    };
  });

  return {
    durationSeconds: Math.max(1, frames.at(-1)?.time || 0),
    frames,
    contacts: [
      { type: 'left-foot-plant', time: 0.2 },
      { type: 'right-foot-plant', time: 2.2 },
    ],
  };
}


test('pose extractor auto-discovers repository-local MediaPipe sidecar', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-pose-discovery-'));
  try {
    const script = path.join(dir, 'scripts', 'mediapipe_pose_extractor.py');
    const python = path.join(
      dir,
      '.venv-pose',
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python',
    );
    await import('node:fs/promises').then(({ mkdir }) => Promise.all([
      mkdir(path.dirname(script), { recursive: true }),
      mkdir(path.dirname(python), { recursive: true }),
    ]));
    await writeFile(script, '# test sidecar');
    await writeFile(python, '');

    const resolved = resolveExtractor({
      cwd: dir,
      platform: process.platform,
      modelPath: path.join(dir, 'models', 'pose.task'),
    });

    assert.equal(resolved.kind, 'bundled-mediapipe');
    assert.equal(resolved.command, python);
    assert.equal(resolved.args[0], script);
    assert.ok(resolved.args.includes('{video}'));
    assert.ok(resolved.args.includes('{output_json}'));
    assert.ok(resolved.args.includes(path.join(dir, 'models', 'pose.task')));

    const candidates = bundledPythonCandidates(dir, process.platform);
    assert.equal(candidates[0], python);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit pose extractor command keeps the generic command contract', () => {
  const resolved = resolveExtractor({
    command: 'custom-pose',
    cwd: '/not-used',
  });

  assert.equal(resolved.kind, 'external-command');
  assert.equal(resolved.command, 'custom-pose');
  assert.deepEqual(resolved.args, [
    '--video',
    '{video}',
    '--output-json',
    '{output_json}',
    '--fps',
    '{fps}',
  ]);
});

test('pose extractor caches normalized sequence by video fingerprint', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-pose-cache-'));
  const video = path.join(dir, 'video.mp4');
  const cache = path.join(dir, 'cache');
  await writeFile(video, 'fake-video-bytes');
  let calls = 0;

  try {
    const extractor = new PoseMotionExtractor({
      command: 'fake-pose',
      args: ['--video', '{video}', '--output-json', '{output_json}', '--fps', '{fps}'],
      sampleFps: 8,
      cacheDir: cache,
      cwd: dir,
      runCommand: async (_command, args) => {
        calls += 1;
        const outputPath = args[args.indexOf('--output-json') + 1];
        await writeFile(outputPath, JSON.stringify(makePoseSequence({
          kneeBend: [0.02, 0.1, 0.2, 0.1, 0.02],
        })));
      },
    });

    const first = await extractor.extract(video, { durationSeconds: 4 });
    const second = await extractor.extract(video, { durationSeconds: 4 });

    assert.equal(calls, 1);
    assert.equal(first.source, 'external-command');
    assert.equal(first.cached, false);
    assert.equal(second.source, 'cache');
    assert.equal(second.cached, true);
    assert.ok(second.sequence.frames.length >= 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pose extractor cache invalidates when source video changes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-pose-cache-invalidate-'));
  const video = path.join(dir, 'video.mp4');
  const cache = path.join(dir, 'cache');
  await writeFile(video, 'v1');
  let calls = 0;

  try {
    const extractor = new PoseMotionExtractor({
      command: 'fake-pose',
      args: ['--video', '{video}', '--output-json', '{output_json}'],
      cacheDir: cache,
      cwd: dir,
      runCommand: async (_command, args) => {
        calls += 1;
        const outputPath = args[args.indexOf('--output-json') + 1];
        await writeFile(outputPath, JSON.stringify(makePoseSequence({})));
      },
    });

    await extractor.extract(video, { durationSeconds: 4 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(video, 'v2-with-different-size');
    await extractor.extract(video, { durationSeconds: 4 });

    assert.equal(calls, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('motion-library segmentation finds bounded active windows', () => {
  const sequence = makePoseSequence({
    kneeBend: [0.01, 0.08, 0.22, 0.34, 0.22, 0.08, 0.01],
    wristLift: [0, 0.03, 0.07, 0.1, 0.07, 0.03, 0],
  });
  const windows = detectMotionSegments(sequence, {
    minSegmentSeconds: 2,
    maxSegmentSeconds: 4,
    maxSegments: 3,
  });

  assert.ok(windows.length >= 1);
  assert.ok(windows.every((window) => window.end > window.start));
  assert.ok(windows.every((window) => window.end - window.start <= 4.001));
});

test('motion-library classifier detects a squat-like bilateral knee pattern', () => {
  const sequence = makePoseSequence({
    kneeBend: [0.01, 0.12, 0.36, 0.52, 0.36, 0.12, 0.01],
    wristLift: [0, 0, 0, 0, 0, 0, 0],
  });
  const classification = classifyPoseSequence(sequence);

  assert.equal(classification.actionClass, 'squat');
  assert.ok(classification.confidence >= 0.55);
});

test('motion-library quality rewards complete visible human motion', () => {
  const quality = scoreMotionReferenceQuality(makePoseSequence({
    kneeBend: [0.02, 0.12, 0.28, 0.12, 0.02],
  }), {
    classificationConfidence: 0.9,
    durationSeconds: 4,
  });

  assert.ok(quality.coverage >= 0.95);
  assert.ok(quality.score >= 60);
  assert.ok(quality.motionEnergy > 0);
});

test('motion-library dedupe recognizes identical normalized biomechanics', () => {
  const pose = normalizePoseSequence(makePoseSequence({
    kneeBend: [0.02, 0.14, 0.32, 0.14, 0.02],
  }));
  const candidate = {
    id: 'candidate',
    actionClass: 'squat',
    poseSequence: pose,
  };
  const existing = [{
    id: 'existing',
    actionClass: 'squat',
    poseSequence: pose,
    qualityScore: 88,
  }];

  const duplicate = findDuplicate(candidate, existing, 0.9);
  assert.equal(duplicate.reference.id, 'existing');
  assert.ok(duplicate.similarity >= 0.95);
});

test('motion reference store writes and reloads local auto-built references', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-motion-store-write-'));
  const file = path.join(dir, 'motion-references.json');
  try {
    const store = new MotionReferenceStore(file);
    await store.write([{
      id: 'local-squat',
      actionClass: 'squat',
      tags: ['squat'],
      cameraMode: 'locked',
      people: 1,
      durationSeconds: 4,
      localPath: path.join(dir, 'local-squat.mp4'),
      source: 'owned capture',
      license: 'owned footage',
      verifiedHumanMotion: true,
      rightsConfirmed: true,
      qualityScore: 87,
      classificationConfidence: 0.91,
      autoGenerated: true,
      poseSequence: makePoseSequence({}),
    }]);

    const refs = await store.list();
    assert.equal(refs.length, 1);
    assert.equal(refs[0].id, 'local-squat');
    assert.equal(refs[0].url, '');
    assert.match(refs[0].localPath, /local-squat\.mp4$/);
    assert.equal(refs[0].qualityScore, 87);
    assert.equal(refs[0].autoGenerated, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('automatic motion-library builder creates reusable local segments and is idempotent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-motion-builder-'));
  const source = path.join(dir, 'owned-squat.mp4');
  const libraryDir = path.join(dir, 'library');
  const store = new MotionReferenceStore(path.join(dir, 'motion-references.json'));
  await writeFile(source, 'owned-source-video');

  let ffmpegCalls = 0;
  const runCommand = async (command, args, options = {}) => {
    if (command === 'ffprobe') return { stdout: '6.0\n', stderr: '' };
    if (command === 'ffmpeg') {
      ffmpegCalls += 1;
      const destination = args.at(-1);
      await writeFile(destination, Buffer.alloc(1200, 7));
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected command: ${command}`);
  };

  const builder = new MotionLibraryBuilder({
    store,
    extractor: {
      available: true,
      extract: async () => ({
        source: 'fake',
        sequence: normalizePoseSequence(makePoseSequence({
          kneeBend: [0.02, 0.12, 0.28, 0.4, 0.28, 0.12, 0.02],
        })),
      }),
    },
    libraryDir,
    minSegmentSeconds: 2,
    maxSegmentSeconds: 6,
    minQualityScore: 45,
    dedupeThreshold: 0.9,
    runCommand,
  });

  const first = await builder.build({
    clips: [{ localPath: source }],
    source: 'internal capture session',
    license: 'owned footage',
    rightsConfirmed: true,
    actionHint: 'squat',
    cameraMode: 'locked',
  });

  assert.ok(first.accepted.length >= 1);
  assert.equal(first.errors.length, 0);
  assert.ok(first.accepted.every((reference) => reference.localPath));
  assert.ok(first.accepted.every((reference) => reference.url === undefined || reference.url === ''));
  assert.ok(first.accepted.every((reference) => reference.rightsConfirmed === true));

  const afterFirst = await store.list();
  assert.equal(afterFirst.length, first.librarySize);
  assert.ok(afterFirst.every((reference) => reference.poseSequence?.frames?.length));

  const second = await builder.build({
    clips: [{ localPath: source }],
    source: 'internal capture session',
    license: 'owned footage',
    rightsConfirmed: true,
    actionHint: 'squat',
    cameraMode: 'locked',
  });

  assert.equal(second.errors.length, 0);
  assert.ok(second.duplicates.length >= 1);
  const afterSecond = await store.list();
  assert.equal(afterSecond.length, afterFirst.length);
  assert.ok(ffmpegCalls >= 1);

  await rm(dir, { recursive: true, force: true });
});

test('motion-library builder refuses ingestion without confirmed rights', async () => {
  const builder = new MotionLibraryBuilder({
    store: { list: async () => [], write: async () => [] },
    extractor: { available: true },
  });

  await assert.rejects(
    builder.build({
      clips: [{ localPath: '/fake/clip.mp4' }],
      license: 'unknown',
      rightsConfirmed: false,
    }),
    /rightsConfirmed=true/i,
  );
});

test('Runway provider converts local motion reference to bounded video data URI', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-local-motion-guide-'));
  const localGuide = path.join(dir, 'guide.mp4');
  await writeFile(localGuide, Buffer.from('local-motion-video'));
  const requests = [];

  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      dialogueMode: 'native',
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 1,
      poseExtractor: { available: false },
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ target, body });

        if (target.endsWith('/text_to_video')) {
          assert.equal(body.referenceVideos.length, 1);
          assert.match(body.referenceVideos[0].uri, /^data:video\/mp4;base64,/);
          const encoded = body.referenceVideos[0].uri.split(',')[1];
          assert.equal(Buffer.from(encoded, 'base64').toString(), 'local-motion-video');
          return jsonResponse({ id: 'local-guide-video' });
        }
        if (target.endsWith('/tasks/local-guide-video')) {
          return jsonResponse({
            id: 'local-guide-video',
            status: 'SUCCEEDED',
            output: ['https://cdn.example/local-guide-output.mp4'],
          });
        }
        if (target === 'https://cdn.example/local-guide-output.mp4') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('generated').buffer,
          };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const segment = {
      index: 0,
      purpose: 'demo',
      durationSeconds: 5,
      dialogue: '',
      dialogueTurns: [],
      characterIds: ['alex'],
      locationId: 'gym',
      action: 'Alex performs one squat.',
      camera: 'Locked shot.',
      ambience: 'gym',
      soundEffects: [],
      music: '',
      editing: { allowInternalCuts: false, allowDissolves: false, shotCount: 1 },
      realismDirection: { riskScore: 70, camera: { axis: 'locked' } },
      keyframeDirection: { enabled: false, policy: 'off' },
      motionGuideDirection: {
        enabled: true,
        eligible: true,
        actionClass: 'squat',
        selectedReference: {
          id: 'local-squat',
          localPath: localGuide,
          durationSeconds: 5,
          qualityScore: 90,
          selectionScore: 0.9,
        },
      },
    };

    const script = {
      characters: [{
        id: 'alex',
        name: 'Alex',
        description: 'trainer',
        physicalTraits: 'natural',
        wardrobe: 'white shirt',
        voice: { presetId: 'Bernard', languageCode: 'en' },
      }],
      locations: [{
        id: 'gym',
        name: 'Gym',
        description: 'real gym',
        lighting: 'daylight',
        fixedElements: ['rack'],
      }],
      visualStyle: { description: 'natural', cameraRules: 'locked', lightingRules: 'daylight' },
      audioDirection: { mix: 'natural', musicPolicy: 'none' },
    };

    const asset = await provider.generateSegment({
      segment,
      productionScript: script,
      projectId: 'local-motion',
    });

    assert.equal(asset.motionGuideMode, 'reference-video');
    assert.equal(asset.motionGuide.localPath, localGuide);
    assert.match(asset.motionGuide.providerUri, /^data:video\/mp4;base64,/);
    assert.deepEqual(asset.referenceVideoPlan.roles, ['motion-guide']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
