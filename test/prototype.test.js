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
  renderAssDocument,
  renderSrtDocument,
} from '../src/core/subtitleBuilder.js';
import {
  ProductionScriptGenerator,
  productionScriptToStoryBible,
} from '../src/core/productionScriptGenerator.js';
import { RunwayAudiovisualProvider } from '../src/providers/runwayAudiovisualProvider.js';
import { AudiovisualPipeline } from '../src/core/audiovisualPipeline.js';
import { AudiovisualRenderer } from '../src/renderers/audiovisualRenderer.js';

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
    const renderer = new AudiovisualRenderer({
      outputDir: dir,
      runCommand: async (command, args) => commands.push({ command, args }),
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
    assert.ok(finalArgs.includes('copy'));
    assert.match(await readFile(result.subtitleSrtPath, 'utf8'), /Exact audiovisual dialogue/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
