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
