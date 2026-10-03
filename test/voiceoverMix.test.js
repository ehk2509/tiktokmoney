import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunwayAudiovisualProvider } from '../src/providers/runwayAudiovisualProvider.js';
import { DialogueAudioComposer } from '../src/services/dialogueAudioComposer.js';

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test('off-screen narration is mixed in after generation instead of re-spoken by the video model', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-voiceover-'));
  let videoBody = null;
  let mixed = null;
  try {
    const provider = new RunwayAudiovisualProvider({
      apiKey: 'runway-key',
      assetDir: dir,
      pollIntervalMs: 0,
      maxPolls: 2,
      sleepImpl: async () => {},
      dialogueComposer: {
        ffprobeBin: 'ffprobe',
        probeDuration: async () => 5.2,
        mixVoiceover: async (args) => {
          mixed = args;
          return path.join(dir, 'voiceover-mixed.mp4');
        },
      },
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        if (target.endsWith('/text_to_speech')) return jsonResponse({ id: 'tts' });
        if (target.endsWith('/tasks/tts')) {
          return jsonResponse({ id: 'tts', status: 'SUCCEEDED', output: ['https://cdn.example/narration.mp3'] });
        }
        if (target.endsWith('/text_to_video')) {
          videoBody = JSON.parse(options.body);
          return jsonResponse({ id: 'video' });
        }
        if (target.endsWith('/tasks/video')) {
          return jsonResponse({ id: 'video', status: 'SUCCEEDED', output: ['https://cdn.example/act.mp4'] });
        }
        if (target.startsWith('https://cdn.example/')) {
          return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('bytes').buffer };
        }
        throw new Error(`unexpected request: ${target}`);
      },
    });

    const asset = await provider.generateSegment({
      projectId: 'vid-lift',
      productionScript: {
        characters: [{ id: 'narrator', name: 'Narrator', description: 'Unseen narrator.', onScreen: false }],
        locations: [],
        visualStyle: { description: 'Photoreal.', cameraRules: 'Stable.', lightingRules: 'Natural.' },
        audioDirection: { mix: 'Clear narration.', musicPolicy: 'None.' },
      },
      segment: {
        index: 3,
        purpose: 'payoff',
        durationSeconds: 6,
        dialogue: 'A stall is loss of lift from separated airflow.',
        speakerCharacterId: 'narrator',
        characterIds: ['narrator'],
        action: 'Smoke separates from the wing.',
        camera: 'Overhead.',
        ambience: 'Wind tunnel hum.',
        soundEffects: [],
        music: '',
      },
    });

    assert.equal(videoBody.referenceAudio, undefined);
    assert.match(videoBody.promptText, /No speech, voices, narration/);
    assert.doesNotMatch(videoBody.promptText, /says exactly/);
    assert.equal(mixed.voicePath, asset.dialogueTrack.localPath);
    assert.equal(mixed.videoPath, asset.rawLocalPath);
    assert.equal(asset.localPath, path.join(dir, 'voiceover-mixed.mp4'));
    assert.equal(asset.audioMode, 'voiceover-post-mix');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('opted-in voiceover ambience falls back to narration-only when the generated clip is silent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-voiceover-mix-'));
  const calls = [];
  try {
    const composer = new DialogueAudioComposer({
      assetDir: dir,
      voiceoverGeneratedAmbienceGain: 0.2,
      runCommand: async (_bin, args) => {
        calls.push(args);
        if (calls.length === 1) throw new Error('Stream specifier :a matches no streams');
      },
    });

    const output = await composer.mixVoiceover({
      videoPath: 'clip.mp4',
      voicePath: 'voice.mp3',
      projectId: 'vid',
      segmentIndex: 2,
      generationId: 'task',
    });

    assert.equal(output, path.join(dir, 'voiceover-vid-2-task.mp4'));
    assert.ok(calls[0].join(' ').includes('volume=0.2'));
    assert.ok(calls[0].join(' ').includes('amix=inputs=2:duration=first'));
    assert.ok(calls[1].includes('apad') && calls[1].includes('-shortest'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
