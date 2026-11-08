import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInfiniteTalkWorkflow, infiniteTalkPassCount, infiniteTalkFrameCount, buildInfiniteTalkPrompt,
} from '../src/providers/localInfiniteTalk.js';

const models = {
  unet: 'wan.safetensors', lora: 'lora.safetensors', textEncoder: 'umt5.safetensors',
  vae: 'vae.safetensors', patch: 'it.safetensors', audioEncoder: 'w2v.safetensors',
};

test('InfiniteTalk passes cover the whole clip at 25 fps', () => {
  assert.equal(infiniteTalkPassCount(3), 1); // 76 frames fit one 81-frame chunk
  assert.equal(infiniteTalkPassCount(6), 2); // 151 frames -> 81 + 72
  assert.equal(infiniteTalkPassCount(8), 3); // 201 frames -> 81 + 72 + 72
  for (const seconds of [3, 6, 7, 8, 12, 15]) {
    assert.ok(infiniteTalkFrameCount(infiniteTalkPassCount(seconds)) >= seconds * 25 + 1);
  }
});

test('extension passes reuse all earlier frames and drop the overlap', () => {
  const w = buildInfiniteTalkWorkflow({
    startImage: 'a.png', drivingAudio: 'pad.wav', outputAudio: 'voice.wav', prompt: 'talk',
    seed: 5, passes: 3, width: 480, height: 832, models,
  });
  assert.equal(w.p0talk.inputs.previous_frames, undefined);
  assert.deepEqual(w.p1talk.inputs.previous_frames, ['p0decode', 0]);
  assert.deepEqual(w.p2talk.inputs.previous_frames, ['p1all', 0]);
  assert.equal(w.p1trim.inputs.batch_index, 9);
  assert.deepEqual(w.video.inputs.images, ['p2all', 0]);
  assert.deepEqual(w.video.inputs.audio, ['outAudio', 0]);
  assert.equal(w.p0talk.inputs.mode, 'single_speaker');
  assert.equal(w.p2noise.inputs.noise_seed, 7);
});

test('InfiniteTalk prompt names the speaker and setting without dialogue text', () => {
  const prompt = buildInfiniteTalkPrompt({
    segment: { dialogueTurns: [{ speakerCharacterId: 'h', text: 'Secret line' }], locationId: 'l' },
    productionScript: { characters: [{ id: 'h', name: 'Dr. Ada', description: 'woman, 40s' }],
      locations: [{ id: 'l', description: 'snowy airstrip' }] },
  });
  assert.match(prompt, /Dr\. Ada, woman, 40s/);
  assert.match(prompt, /snowy airstrip/);
  assert.doesNotMatch(prompt, /Secret line/);
});

test('each character keeps one voice and one portrait for the whole video', async () => {
  const { LocalComfyUiAudiovisualProvider, apparentGender } = await import('../src/providers/localComfyUiAudiovisualProvider.js');
  const provider = new LocalComfyUiAudiovisualProvider({
    workflowPath: 'x.json', fetchImpl: async () => { throw new Error('no network'); },
    voicePools: { female: ['f1', 'f2'], male: ['m1', 'm2'] },
  });
  const ada = { id: 'ada', name: 'Dr. Ada', description: 'A 40-year-old woman' };
  const ben = { id: 'ben', name: 'Ben', description: 'young man in a hoodie' };
  const cara = { id: 'cara', name: 'Cara', description: 'she is a pilot' };
  assert.equal(apparentGender(ada), 'female');
  assert.equal(apparentGender(ben), 'male');
  assert.equal(provider.castVoice('p', ada), 'f1');
  assert.equal(provider.castVoice('p', ben), 'm1');
  assert.equal(provider.castVoice('p', cara), 'f2');
  assert.equal(provider.castVoice('p', ada), 'f1');
  let portraits = 0;
  provider.generateFirstFrame = async () => { portraits += 1; return 'portrait-' + portraits + '.png'; };
  const first = await provider.castPortrait('p', ada);
  assert.equal(await provider.castPortrait('p', ada), first);
  assert.equal(portraits, 1);
});

test('a cast clip ends shortly after its last word', async () => {
  const { LocalComfyUiAudiovisualProvider, speakingActSeconds } = await import('../src/providers/localComfyUiAudiovisualProvider.js');
  assert.equal(speakingActSeconds(2.2, 6), 2.4);
  assert.equal(speakingActSeconds(1, 6), 2); // never a blink-length clip
  assert.equal(speakingActSeconds(5.9, 6), 6); // never longer than planned
  assert.equal(speakingActSeconds(0, 6), 6); // unknown speech length keeps the plan

  const provider = new LocalComfyUiAudiovisualProvider({
    workflowPath: 'x.json', fetchImpl: async () => { throw new Error('no network'); },
    voicePools: { female: ['f1'], male: ['m1'] },
  });
  const commands = [];
  provider.runCommand = async (bin, args) => { commands.push([bin, args]); return bin === 'ffprobe' ? '2.2\n' : ''; };
  provider.localTts = { synthesize: async () => ({ localPath: 'turn.wav' }) };
  provider.generateFirstFrame = async () => 'still.png';
  provider.infiniteTalk = { width: 576, height: 1024 };
  let talkSeconds = null;
  provider.applyInfiniteTalk = async ({ seconds }) => { talkSeconds = seconds; return 'out.mp4'; };
  const speaker = { id: 'ada', name: 'Ada', description: 'a woman' };
  const asset = await provider.generateCastSpeakingAct({
    segment: { index: 0, dialogueTurns: [{ speakerCharacterId: 'ada', text: 'Hello there' }] },
    productionScript: { characters: [speaker] }, projectId: 'p', speaker, seconds: 6,
  });
  assert.equal(asset.durationSeconds, 2.4);
  assert.equal(asset.generatedDuration, '2.4s');
  assert.equal(talkSeconds, 2.4);
  const fitting = commands.find(([, args]) => args.some((arg) => String(arg).endsWith('-voice-fitted.wav')));
  assert.equal(fitting[1][fitting[1].indexOf('-t') + 1], '2.4');
});
