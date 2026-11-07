import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  LocalComfyUiAudiovisualProvider, bindWorkflow, selectVideoOutput, buildLocalVideoPrompt,
} from '../src/providers/localComfyUiAudiovisualProvider.js';
import { assertLocalEndpoint } from '../src/providers/localEndpoints.js';
import { createLlmProvider, createAudiovisualProvider, createVisualProvider,
  createRealismQcProvider, createDialogueQcProvider } from '../src/providers/providerFactory.js';

test('local endpoints accept loopback/private LAN and refuse hosted model APIs', () => {
  assert.equal(assertLocalEndpoint('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
  assert.equal(assertLocalEndpoint('http://192.168.1.20:8188/'), 'http://192.168.1.20:8188');
  assert.equal(assertLocalEndpoint('http://comfyui:8188'), 'http://comfyui:8188');
  assert.throws(() => assertLocalEndpoint('https://api.openai.com/v1'), /local\/private/);
  assert.throws(() => assertLocalEndpoint('http://8.8.8.8:8188'), /local\/private/);
  assert.throws(() => assertLocalEndpoint('file:///tmp/video'), /local\/private/);
});

test('workflow placeholders preserve ComfyUI numeric input types', () => {
  const source = { '1': { inputs: { text: '{{PROMPT}}',
    seed: '{{SEED}}', frames: '{{FRAMES}}', title: 'Scene: {{PROMPT}}' } } };
  const bound = bindWorkflow(source, { PROMPT: 'a scene', SEED: 42, FRAMES: 121 });
  assert.deepEqual(bound['1'].inputs, {
    text: 'a scene', seed: 42, frames: 121, title: 'Scene: a scene',
  });
  assert.deepEqual(source['1'].inputs.seed, '{{SEED}}');
  assert.throws(() => bindWorkflow('{{UNKNOWN}}', {}), /Unknown/);
});

test('video discovery supports VHS VideoCombine and native SaveVideo history', () => {
  assert.equal(selectVideoOutput({ '9': { gifs: [{ filename: 'movie.mp4' }] } }).filename, 'movie.mp4');
  assert.equal(selectVideoOutput({ '8': { videos: [{ filename: 'movie.webm' }] } }).filename, 'movie.webm');
  assert.equal(selectVideoOutput({ '8': { images: [{ filename: 'still.png' }] } }), null);
});

test('ComfyUI provider submits workflow, polls history, downloads audiovisual file locally', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-comfy-test-'));
  try {
    const workflowPath = path.join(dir, 'api.json');
    await writeFile(workflowPath, JSON.stringify({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{PROMPT}}' } },
      '2': { class_type: 'VideoSampler', inputs: { seed: '{{SEED}}',
        frames: '{{FRAMES}}', width: '{{WIDTH}}', height: '{{HEIGHT}}' } },
    }));
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      const target = new URL(url);
      requests.push(target.pathname);
      if (target.pathname === '/prompt') {
        const data = JSON.parse(options.body);
        assert.match(data.prompt['1'].inputs.text, /photorealistic/);
        assert.match(data.prompt['1'].inputs.text, /exact spoken dialogue/i);
        assert.equal(typeof data.prompt['2'].inputs.seed, 'number');
        assert.equal(data.prompt['2'].inputs.frames, 121);
        return new Response(JSON.stringify({ prompt_id: 'test-12345' }), { status: 200 });
      }
      if (target.pathname === '/history/test-12345') {
        return new Response(JSON.stringify({ 'test-12345': {
          outputs: { '20': { gifs: [{ filename: 'render.mp4', type: 'output', subfolder: '' }] } },
        } }), { status: 200 });
      }
      if (target.pathname === '/view') {
        assert.equal(target.searchParams.get('filename'), 'render.mp4');
        return new Response('mock-video-data', { status: 200 });
      }
      throw new Error('Unexpected outbound request ' + target);
    };
    const provider = new LocalComfyUiAudiovisualProvider({
      workflowPath, assetDir: dir, requireAudio: false, fetchImpl,
    });
    const asset = await provider.generateSegment({
      segment: { index: 0, durationSeconds: 5, action: 'A cafe scene',
        dialogue: 'Hello there!', dialogueTurns: [{ speakerCharacterId: 'actor', text: 'Hello there!' }] },
      productionScript: { characters: [{ id: 'actor', name: 'Actor' }] },
      projectId: 'test_project',
    });
    assert.equal(asset.provider, 'comfyui-local');
    assert.equal(asset.durationSeconds, 5);
    assert.equal(asset.audioMode, 'unknown');
    assert.equal(await readFile(asset.localPath, 'utf8'), 'mock-video-data');
    assert.deepEqual(requests, ['/prompt', '/history/test-12345', '/view']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ComfyUI requires prompt placeholder and rejects cloud endpoint even when keys are configured', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-workflow-test-'));
  try {
    const workflowPath = path.join(dir, 'api.json');
    await writeFile(workflowPath, JSON.stringify({ 1: { inputs: { text: 'no prompt here' } } }));
    const local = new LocalComfyUiAudiovisualProvider({
      workflowPath, assetDir: dir, requireAudio: false, fetchImpl: async () => {
        throw new Error('Should not reach network');
      },
    });
    await assert.rejects(local.generateSegment({
      segment: { index: 0, durationSeconds: 5 }, productionScript: {}, projectId: 'p',
    }), /PROMPT/);
    assert.throws(() => new LocalComfyUiAudiovisualProvider({
      baseUrl: 'https://my-public-comfy-service.example', workflowPath,
    }), /local\/private/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('local factory never chooses cloud LLM, video, stock or QC providers', () => {
  const env = {
    AI_RUNTIME: 'local',
    LOCAL_LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
    LOCAL_LLM_MODEL: 'qwen3:8b',
    COMFYUI_WORKFLOW_PATH: './comfyui/workflow.json',
    OPENAI_API_KEY: 'cloud-key',
    OPENROUTER_API_KEY: 'cloud-key',
    RUNWAYML_API_SECRET: 'cloud-key',
    LUMA_AGENTS_API_KEY: 'cloud-key',
    PEXELS_API_KEY: 'cloud-key',
    LLM_PROVIDER: 'openai',
    REALISM_QC_ENABLED: 'false',
    DIALOGUE_QC_ENABLED: 'true',
  };
  const llm = createLlmProvider(env);
  assert.equal(llm.providerName, 'local');
  assert.equal(llm.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(createAudiovisualProvider(env).baseUrl, 'http://127.0.0.1:8188');
  assert.equal(createVisualProvider(env), null);
  assert.equal(createRealismQcProvider(env), null);
  assert.equal(createDialogueQcProvider(env), null);
});

test('local video prompt includes concrete actions, dialogue and regeneration feedback', () => {
  const prompt = buildLocalVideoPrompt({
    segment: { action: 'Walk into the store', dialogue: 'Good morning', camera: 'medium shot',
      characterIds: ['c1'], locationId: 'l1' },
    productionScript: { characters: [{ id: 'c1', name: 'Ava' }],
      locations: [{ id: 'l1', description: 'Book shop' }] },
    regeneration: { guidance: 'Avoid flicker' },
  });
  assert.match(prompt, /Walk into the store/);
  assert.match(prompt, /Good morning/);
  assert.match(prompt, /Avoid flicker/);
});

test('image-to-video workflow bootstraps first frame using a second local ComfyUI workflow', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-i2v-test-'));
  try {
    const workflowPath = path.join(dir, 'video.json');
    const firstFrameWorkflowPath = path.join(dir, 'image.json');
    await writeFile(workflowPath, JSON.stringify({
      '1': { class_type: 'LoadImage', inputs: { image: '{{FIRST_FRAME}}' } },
      '2': { class_type: 'TextEncode', inputs: { text: '{{PROMPT}}' } },
    }));
    await writeFile(firstFrameWorkflowPath, JSON.stringify({
      '1': { class_type: 'TextEncode', inputs: { text: '{{PROMPT}}' } },
    }));
    const calls = [];
    const fetchImpl = async (input, opts = {}) => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname === '/prompt') {
        const job = calls.filter(p => p === '/prompt').length === 1 ? 'image-1' : 'video-1';
        if (job === 'video-1') {
          const request = JSON.parse(opts.body);
          assert.equal(request.prompt['1'].inputs.image, 'reference.png');
        }
        return Response.json({ prompt_id: job });
      }
      if (url.pathname === '/history/image-1') {
        return Response.json({ 'image-1': { outputs: {
          '12': { images: [{ filename: 'first.png', type: 'output' }] },
        } } });
      }
      if (url.pathname === '/history/video-1') {
        return Response.json({ 'video-1': { outputs: {
          '20': { videos: [{ filename: 'clip.mp4', type: 'output' }] },
        } } });
      }
      if (url.pathname === '/view') return new Response('local-bytes');
      if (url.pathname === '/upload/image') {
        assert.equal(opts.method, 'POST');
        return Response.json({ name: 'reference.png' });
      }
      throw new Error('Unexpected route ' + url.pathname);
    };
    const provider = new LocalComfyUiAudiovisualProvider({
      workflowPath, firstFrameWorkflowPath, assetDir: dir, requireAudio: false, fetchImpl,
    });
    const asset = await provider.generateSegment({
      segment: { index: 0, durationSeconds: 5, action: 'Morning coffee', dialogue: 'Hi' },
      productionScript: { characters: [] }, projectId: 'with-image',
    });
    assert.equal(asset.referenceImageCount, 1);
    assert.equal(await readFile(asset.localPath, 'utf8'), 'local-bytes');
    assert.deepEqual(calls, ['/prompt', '/history/image-1', '/view', '/upload/image',
      '/prompt', '/history/video-1', '/view']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
