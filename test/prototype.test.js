import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
