import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rankOpportunities, scoreOpportunity } from '../src/core/opportunityScorer.js';
import { planScenes } from '../src/core/scenePlanner.js';
import { VideoPipeline } from '../src/core/pipeline.js';
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
import { FrameSampler } from '../src/services/frameSampler.js';
import { OpenRouterRealismQcProvider } from '../src/providers/openRouterRealismQcProvider.js';

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
    assert.equal(imageBodies[0].image_ref[0].weight, 0.72);
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
