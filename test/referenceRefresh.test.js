import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunwayAudiovisualProvider } from '../src/providers/runwayAudiovisualProvider.js';

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test('expired reference images are replaced by a still from the previous act and the task is retried', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-refresh-'));
  const videoBodies = [];
  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      assetDir: dir,
      dialogueMode: 'native',
      pollIntervalMs: 0,
      maxPolls: 2,
      sleepImpl: async () => {},
      frameSampler: {
        sampleAt: async (localPath, timestamps) => {
          assert.equal(localPath, '/clips/act-0.mp4');
          assert.deepEqual(timestamps, [6.5]);
          return [{ timestamp: 6.5, dataUrl: 'data:image/jpeg;base64,STILL' }];
        },
      },
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        if (target === 'https://expired.example/location.png') return { ok: false, status: 403 };
        if (target.endsWith('/text_to_video')) {
          const body = JSON.parse(options.body);
          videoBodies.push(body);
          if (body.references[0].uri.startsWith('https://')) {
            return jsonResponse({
              error: 'Validation of body failed',
              issues: [{ code: 'custom', message: 'Failed to fetch asset. Received HTTP response code "403".', path: ['references', '[0]', '.uri'] }],
            }, 400);
          }
          return jsonResponse({ id: 'video' });
        }
        if (target.endsWith('/tasks/video')) {
          return jsonResponse({ id: 'video', status: 'SUCCEEDED', output: ['https://cdn.example/act.mp4'] });
        }
        if (target === 'https://cdn.example/act.mp4') {
          return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('clip').buffer };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    await provider.generateSegment({
      projectId: 'vid-refresh',
      productionScript: {
        characters: [{ id: 'narrator', name: 'Narrator', description: 'Unseen narrator.', onScreen: false }],
        locations: [{ id: 'tunnel', name: 'Tunnel', description: 'Wind tunnel.', lighting: 'Even.', fixedElements: [] }],
        visualStyle: { description: 'Photoreal.', cameraRules: 'Stable.', lightingRules: 'Natural.' },
        audioDirection: { mix: 'Clear.', musicPolicy: 'None.' },
      },
      storyBible: { references: { locations: { tunnel: { url: 'https://expired.example/location.png' } } } },
      previousAsset: { localPath: '/clips/act-0.mp4', durationSeconds: 7 },
      segment: {
        index: 1,
        durationSeconds: 6,
        dialogue: 'Lift needs attached airflow.',
        speakerCharacterId: 'narrator',
        characterIds: ['narrator'],
        locationId: 'tunnel',
        action: 'Smoke flows over the wing.',
        camera: 'Side tracking.',
        ambience: 'Fan hum.',
        soundEffects: [],
        music: '',
      },
    });

    assert.equal(videoBodies.length, 2);
    assert.deepEqual(videoBodies[1].references, [{ uri: 'data:image/jpeg;base64,STILL' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a third take after repeated-framing failures animates from a forced opening frame', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-forced-keyframe-'));
  const requests = [];
  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      assetDir: dir,
      dialogueMode: 'native',
      pollIntervalMs: 0,
      maxPolls: 2,
      sleepImpl: async () => {},
      frameSampler: {
        sampleAt: async () => [{ timestamp: 7.5, dataUrl: 'data:image/jpeg;base64,PREV' }],
      },
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        if (body) requests.push({ target, body });
        if (target.endsWith('/text_to_image')) return jsonResponse({ id: 'frame' });
        if (target.endsWith('/tasks/frame')) {
          return jsonResponse({ id: 'frame', status: 'SUCCEEDED', output: ['https://cdn.example/opening.png'] });
        }
        if (target.endsWith('/image_to_video')) return jsonResponse({ id: 'video' });
        if (target.endsWith('/tasks/video')) {
          return jsonResponse({ id: 'video', status: 'SUCCEEDED', output: ['https://cdn.example/act.mp4'] });
        }
        if (target === 'https://cdn.example/act.mp4') {
          return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('clip').buffer };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const asset = await provider.generateSegment({
      projectId: 'vid-forced',
      productionScript: {
        characters: [{ id: 'narrator', name: 'Narrator', description: 'Unseen narrator.', onScreen: false }],
        locations: [{ id: 'tunnel', name: 'Tunnel', description: 'Wind tunnel.', lighting: 'Even.', fixedElements: [] }],
        visualStyle: { description: 'Photoreal.', cameraRules: 'Stable.', lightingRules: 'Natural.' },
        audioDirection: { mix: 'Clear.', musicPolicy: 'None.' },
      },
      previousAsset: { localPath: '/clips/act-1.mp4', durationSeconds: 8 },
      regeneration: {
        attempt: 2,
        guidance: 'Move much closer.',
        triggeredBy: ['editorialVariety'],
        retryUsage: { editorialVariety: 2 },
      },
      segment: {
        index: 2,
        shotType: 'close-up',
        durationSeconds: 8,
        dialogue: 'Separated flow kills lift.',
        speakerCharacterId: 'narrator',
        characterIds: ['narrator'],
        locationId: 'tunnel',
        startState: 'The upper surface of the wing fills the frame.',
        action: 'Smoke peels away from the wing.',
        camera: 'Close-up.',
        ambience: 'Fan hum.',
        soundEffects: [],
        music: '',
      },
    });

    const image = requests.find((request) => request.target.endsWith('/text_to_image'));
    assert.deepEqual(image.body.referenceImages, [{ uri: 'data:image/jpeg;base64,PREV', tag: 'previousact' }]);
    assert.match(image.body.promptText, /FRAMING CONTRACT/);
    assert.match(image.body.promptText, /upper surface of the wing fills the frame/);
    const video = requests.find((request) => request.target.endsWith('/image_to_video'));
    assert.deepEqual(video.body.promptImage, [{ uri: 'https://cdn.example/opening.png', position: 'first' }]);
    assert.equal(asset.keyframes.policy, 'forced-first');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keyframe image requests stay within Runway text_to_image limits', async () => {
  const { fitPrompt } = await import('../src/providers/runwayAudiovisualProvider.js');
  const long = `FIRST FRAME / STARTING STATE: waist-up huddle. ${'shared identity text '.repeat(120)}`;
  const fitted = fitPrompt(long, 1000);
  assert.ok(fitted.length <= 1000);
  assert.match(fitted, /^FIRST FRAME \/ STARTING STATE: waist-up huddle\./);

  let body = null;
  const provider = new RunwayAudiovisualProvider({
    apiKey: 'runway-key',
    pollIntervalMs: 0,
    maxPolls: 2,
    sleepImpl: async () => {},
    fetchImpl: async (url, options = {}) => {
      if (String(url).endsWith('/text_to_image')) {
        body = JSON.parse(options.body);
        return jsonResponse({ id: 'img' });
      }
      return jsonResponse({ id: 'img', status: 'SUCCEEDED', output: ['https://cdn.example/frame.png'] });
    },
  });
  await provider.generateKeyframeImage({
    prompt: long,
    references: [1, 2, 3, 4, 5].map((n) => ({ uri: `https://ref.example/${n}.png`, tag: `ref${n}` })),
  });
  assert.ok(body.promptText.length <= 1000);
  assert.equal(body.referenceImages.length, 3);
});

test('an internal failure on first+last keyframes retries with the opening frame only', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-keyframe-fallback-'));
  const videoBodies = [];
  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      assetDir: dir,
      dialogueMode: 'native',
      pollIntervalMs: 0,
      maxPolls: 2,
      sleepImpl: async () => {},
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        if (target.endsWith('/text_to_image')) {
          const position = JSON.parse(options.body).promptText.includes('LAST FRAME') ? 'last' : 'first';
          return jsonResponse({ id: `img-${position}` });
        }
        if (target.endsWith('/tasks/img-first')) return jsonResponse({ id: 'img-first', status: 'SUCCEEDED', output: ['https://cdn.example/first.png'] });
        if (target.endsWith('/tasks/img-last')) return jsonResponse({ id: 'img-last', status: 'SUCCEEDED', output: ['https://cdn.example/last.png'] });
        if (target.endsWith('/image_to_video')) {
          videoBodies.push(JSON.parse(options.body));
          return jsonResponse({ id: `video-${videoBodies.length}` });
        }
        if (target.endsWith('/tasks/video-1')) return jsonResponse({ id: 'video-1', status: 'FAILED', failure: 'Generation failed.', failureCode: 'INTERNAL' });
        if (target.endsWith('/tasks/video-2')) return jsonResponse({ id: 'video-2', status: 'SUCCEEDED', output: ['https://cdn.example/act.mp4'] });
        if (target === 'https://cdn.example/act.mp4') {
          return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('clip').buffer };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const asset = await provider.generateSegment({
      projectId: 'vid-fallback',
      productionScript: {
        characters: [{ id: 'coach', name: 'Coach', description: 'Head coach', onScreen: true }],
        locations: [],
        visualStyle: { description: 'Photoreal.', cameraRules: 'Stable.', lightingRules: 'Natural.' },
        audioDirection: { mix: 'Clear.', musicPolicy: 'None.' },
      },
      segment: {
        index: 4,
        shotType: 'medium',
        durationSeconds: 8,
        dialogue: 'Together.',
        speakerCharacterId: 'coach',
        characterIds: ['coach'],
        startState: 'Waist-up huddle.',
        endState: 'Hands joined.',
        action: 'The team joins hands.',
        camera: 'Medium.',
        ambience: 'Quiet.',
        soundEffects: [],
        music: '',
        keyframeDirection: { enabled: true, policy: 'first-last', firstFrame: {}, lastFrame: {} },
      },
    });

    assert.equal(videoBodies.length, 2);
    assert.deepEqual(videoBodies[0].promptImage.map((image) => image.position), ['first', 'last']);
    assert.deepEqual(videoBodies[1].promptImage.map((image) => image.position), ['first']);
    assert.equal(asset.keyframeMode, 'first');
    assert.match(asset.keyframeError, /retried with first frame only/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
