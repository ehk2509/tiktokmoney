import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  LocalLocationSet, LocationApprovalRequiredError, approveLocationCandidate, buildAngleWorkflow,
  buildLocationMasterPrompt, buildPlacementWorkflow, listMasterProblems, planLocationAngles, roomLockFilter,
} from '../src/providers/localLocationSet.js';
import { LocalComfyUiAudiovisualProvider } from '../src/providers/localComfyUiAudiovisualProvider.js';

const seg = (index, locationId, shotType) => ({ index, locationId, shotType });
const clean = { person_or_hand_visible: false, frame_intruding_at_edge: false, object_blocking_foreground: false, text_or_watermark_visible: false, duplicated_main_object: false, unnatural_animal_or_object: false, looks_like_real_photo: true, required_items_missing: [] };
const location = { id: 'room', name: 'Living room', description: 'A small room', fixedElements: ['sofa', 'cat'] };

async function makeSet(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'location-set-'));
  const calls = { generated: 0, workflows: [], imported: 0 };
  const comfy = {
    generateFirstFrame: async () => { calls.generated += 1; return `master-${calls.generated}.png`; },
    downloadInputFile: async (_, file) => writeFile(file, 'png'),
    downloadMedia: async (_, file) => writeFile(file, 'video'),
    uploadImage: async (_, name) => name,
    runCommand: async () => '',
    importOutputImage: async (media) => { calls.imported += 1; return `imported-${calls.imported}-${media.filename}`; },
    runWorkflow: async (workflow) => {
      calls.workflows.push(workflow);
      if (options.failAngles && workflow.angle) throw new Error('angle lora missing');
      if (workflow.saveStart) return { a: { images: [{ filename: 'location-start_1.png' }] }, b: { images: [{ filename: 'location-mask_1.png' }] } };
      if (workflow.video) return { s: { images: [{ filename: 'location-matte_1.mp4' }] } };
      return { s: { images: [{ filename: 'location-plate_1.png' }] } };
    },
  };
  const set = new LocalLocationSet({ comfy, dir, visionModel: 'vl', requireApproval: options.requireApproval, candidates: options.candidates || 2, maxRounds: options.maxRounds || 2, fetchImpl: async () => { throw new Error('unused'); } });
  set.inspectMaster = options.inspect || (async () => clean);
  return { set, calls, dir, done: () => rm(dir, { recursive: true, force: true }) };
}

test('camera angles are only planned for a location revisited with different shots', () => {
  const plan = planLocationAngles({ segments: [seg(0, 'a', 'wide'), seg(1, 'a', 'medium'), seg(2, 'b', 'wide'), seg(3, 'a', 'close-up')] });
  assert.deepEqual([...plan.keys()], [0, 1, 3]);
  assert.deepEqual([0, 1, 3].map((i) => plan.get(i).angle), ['front', '45left', 'front']);
  assert.equal(planLocationAngles({ segments: [seg(0, 'a', 'medium'), seg(1, 'a', 'medium')] }).size, 0);
  assert.equal(planLocationAngles({ segments: [seg(0, 'a', 'wide')] }).size, 0);
  assert.equal(planLocationAngles({ segments: [seg(0, null, 'wide'), seg(1, null, 'medium')] }).size, 0);
});

test('master prompt uses the scene details and forbids known errors', () => {
  const prompt = buildLocationMasterPrompt({ ...location, lighting: 'Soft window light' });
  assert.match(prompt, /A small room/);
  assert.match(prompt, /Clearly visible: sofa, cat/);
  assert.match(prompt, /well inside the place/);
  assert.doesNotMatch(prompt, /door/i);
  assert.match(prompt, /no people/);
});

test('every failed check is reported', () => {
  assert.deepEqual(listMasterProblems(clean), []);
  const problems = listMasterProblems({ ...clean, person_or_hand_visible: true, frame_intruding_at_edge: true, looks_like_real_photo: false, required_items_missing: ['cat'] });
  assert.equal(problems.length, 4);
  assert.ok(problems.includes('missing: cat'));
});

test('angle and placement graphs use the intended references', () => {
  const angle = buildAngleWorkflow({ master: 'm.png', angle: '45left', seed: 1 });
  assert.match(angle.pos.inputs.prompt, /<sks> front-left quarter view/);
  assert.deepEqual(angle.shift.inputs.model, ['angle', 0]);
  const place = buildPlacementWorkflow({ portrait: 'p.png', plate: 'r.png', seed: 1 });
  assert.equal(place.img0.inputs.image, 'p.png');
  assert.equal(place.img1.inputs.image, 'r.png');
  assert.deepEqual(place.comp.inputs.destination, ['img1', 0]);
  assert.deepEqual(place.comp.inputs.mask, ['matte', 0]);
  assert.match(roomLockFilter(), /alphamerge/);
  assert.match(roomLockFilter(), /blend=all_mode=darken/);
});

test('the first passing master is saved and never regenerated', async () => {
  const replies = [{ ...clean, person_or_hand_visible: true }, clean];
  const { set, calls, done } = await makeSet({ inspect: async () => replies.shift() });
  try {
    const first = await set.ensureMaster('p', location);
    assert.equal(first.master, 'master-2.png');
    assert.equal(first.rejected[0].problems[0], 'person or hand visible');
    const second = await set.ensureMaster('p', location);
    assert.equal(second.master, 'master-2.png');
    assert.equal(calls.generated, 2);
  } finally { await done(); }
});

test('the run stops rather than using a master that fails every check', async () => {
  const { set, calls, done } = await makeSet({ inspect: async () => ({ ...clean, looks_like_real_photo: false }) });
  try {
    await assert.rejects(set.ensureMaster('p', location), /passed the check after 4 tries/);
    assert.equal(calls.generated, 4);
  } finally { await done(); }
});

test('approval pauses the run and the chosen candidate is reused without regenerating', async () => {
  const { set, calls, dir, done } = await makeSet({ requireApproval: true });
  try {
    await assert.rejects(set.ensureMaster('p', location), LocationApprovalRequiredError);
    assert.equal(calls.generated, 2);
    await assert.rejects(set.ensureMaster('p', location), LocationApprovalRequiredError);
    assert.equal(calls.generated, 2);
    await approveLocationCandidate({ dir, projectId: 'p', locationId: 'room', candidate: 2 });
    assert.equal((await set.ensureMaster('p', location)).master, 'master-2.png');
    assert.equal(calls.generated, 2);
    await assert.rejects(approveLocationCandidate({ dir, projectId: 'p', locationId: 'room', candidate: 9 }), /not found/);
  } finally { await done(); }
});

test('views and placements are saved once and survive a new provider', async () => {
  const { set, calls, done } = await makeSet();
  try {
    const args = { projectId: 'p', location, angle: 'front', characterId: 'ada', portrait: 'p.png' };
    const a = await set.placeCharacter(args);
    const count = calls.workflows.length;
    assert.deepEqual(await set.placeCharacter(args), a);
    assert.equal(calls.workflows.length, count);
    const fresh = new LocalLocationSet({ comfy: set.comfy, dir: set.dir, visionModel: 'vl' });
    assert.deepEqual(await fresh.placeCharacter(args), a);
    assert.equal(calls.workflows.length, count);
    assert.notDeepEqual(await set.placeCharacter({ ...args, regeneration: { reason: 'bad' } }), a);
    assert.equal(calls.workflows.length, count + 1);
  } finally { await done(); }
});

test('a failed camera angle falls back to the saved front view', async () => {
  const { set, done } = await makeSet({ failAngles: true });
  try {
    const front = await set.ensureView('p', location, 'front');
    assert.equal(await set.ensureView('p', location, '45left'), front);
    const state = JSON.parse(await readFile(path.join(set.dir, 'p', 'room.json'), 'utf8'));
    assert.match(state.angleFallbacks['45left'], /angle lora missing/);
  } finally { await done(); }
});

function castProvider(locationAngles, overrides = {}) {
  const provider = new LocalComfyUiAudiovisualProvider({
    workflowPath: 'x.json', firstFrameWorkflowPath: 'f.json', locationAngles,
    fetchImpl: async () => { throw new Error('no network'); }, voicePools: { female: ['f1'], male: ['m1'] },
  });
  provider.runCommand = async (bin) => (bin === 'ffprobe' ? '3\n' : '');
  provider.localTts = { synthesize: async () => ({ localPath: 'turn.wav' }) };
  provider.infiniteTalk = { width: 576, height: 1024 };
  const seen = { stills: 0, animated: [] };
  provider.generateFirstFrame = async () => { seen.stills += 1; return `still-${seen.stills}.png`; };
  provider.applyInfiniteTalk = async ({ startImageName }) => { seen.animated.push(startImageName); return 'out.mp4'; };
  if (locationAngles) {
    provider.locationSet = {
      placeCharacter: async ({ angle }) => ({ image: `placed-${angle}.png`, mask: 'm.png', plate: 'p.png', angle }),
      lockRoom: async ({ clipPath }) => { seen.locked = clipPath; if (overrides.failLock) throw new Error('matte failed'); return 'locked.mp4'; },
    };
  }
  return { provider, seen };
}

const speaker = { id: 'ada', name: 'Ada', description: 'a woman' };
const script = (shots) => ({
  characters: [speaker], locations: [location],
  segments: shots.map((shotType, index) => ({ index, locationId: 'room', shotType, durationSeconds: 6, characterIds: ['ada'], dialogueTurns: [{ speakerCharacterId: 'ada', text: 'Hello' }] })),
});
const act = (provider, productionScript, index) => provider.generateCastSpeakingAct({ segment: productionScript.segments[index], productionScript, projectId: 'p', speaker, seconds: 6 });

test('scenes at one location with different shots use saved angles and the room lock', async () => {
  const { provider, seen } = castProvider(true);
  const productionScript = script(['wide', 'medium']);
  const first = await act(provider, productionScript, 0);
  const second = await act(provider, productionScript, 1);
  assert.deepEqual(seen.animated, ['placed-front.png', 'placed-45left.png']);
  assert.equal(first.cameraAngle, 'front');
  assert.equal(second.cameraAngle, '45left');
  assert.equal(first.localPath, 'locked.mp4');
  assert.deepEqual(first.roomLock, { passed: true });
});

test('a failed room lock keeps the animated clip', async () => {
  const { provider } = castProvider(true, { failLock: true });
  const asset = await act(provider, script(['wide', 'medium']), 0);
  assert.equal(asset.localPath, 'out.mp4');
  assert.equal(asset.roomLock.passed, false);
});

test('scenes with the same shot keep the single-still behaviour', async () => {
  const { provider, seen } = castProvider(true);
  const productionScript = script(['medium', 'medium']);
  const asset = await act(provider, productionScript, 0);
  await act(provider, productionScript, 1);
  assert.equal(asset.cameraAngle, null);
  assert.equal(asset.roomLock, null);
  assert.equal(seen.locked, undefined);
  assert.equal(seen.animated[0], seen.animated[1]);
  assert.match(seen.animated[0], /^still-/);
});

test('two people talking get one shot per line with their own face, voice and angle', async () => {
  const { conversationTurns } = await import('../src/providers/localComfyUiAudiovisualProvider.js');
  const ben = { id: 'ben', name: 'Ben', description: 'a man' };
  const { provider, seen } = castProvider(true);
  const placed = [];
  provider.locationSet.placeCharacter = async ({ angle, characterId, gaze }) => { placed.push([characterId, angle, gaze]); return { image: `placed-${characterId}.png`, mask: 'm', plate: 'p', angle }; };
  const portraits = [];
  provider.generateFirstFrame = async (prompt) => { portraits.push(prompt); return `portrait-${portraits.length}.png`; };
  const voices = [];
  provider.localTts = { synthesize: async ({ voice }) => { voices.push(voice); return { localPath: 'turn.wav' }; } };
  const commands = [];
  provider.runCommand = async (bin, args) => { commands.push(args); return bin === 'ffprobe' ? '3\n' : ''; };
  const segment = { index: 0, locationId: 'room', dialogue: 'Hi there. Hello you. And more.', dialogueTurns: [
    { speakerCharacterId: 'ada', text: 'Hi there.' }, { speakerCharacterId: 'ben', text: 'Hello you.' }, { speakerCharacterId: 'ben', text: 'Nice day.' }, { speakerCharacterId: 'ada', text: 'And more.' },
  ], characterIds: ['ada', 'ben'], durationSeconds: 9 };
  const productionScript = { characters: [speaker, ben], locations: [location], segments: [segment] };
  assert.equal(conversationTurns({ segment, productionScript }).turns.length, 3);
  const asset = await provider.generateCastConversationAct({ segment, productionScript, projectId: 'p', conversation: conversationTurns({ segment, productionScript }), seconds: 9 });
  assert.deepEqual(placed, [['ada', 'front', 'right'], ['ben', '45left', 'left'], ['ada', 'front', 'right']]);
  assert.deepEqual(seen.animated, ['placed-ada.png', 'placed-ben.png', 'placed-ada.png']);
  assert.deepEqual(voices, ['f1', 'm1', 'f1']);
  assert.equal(portraits.length, 2);
  assert.deepEqual(Object.keys(asset.castReferences).sort(), ['ada', 'ben']);
  assert.deepEqual(asset.speakerCharacterIds, ['ada', 'ben']);
  assert.equal(asset.conversationShots, 3);
  assert.equal(asset.dialogueTrack.turns.length, 4);
  assert.ok(asset.durationSeconds > 0);
  assert.ok(commands.some((args) => args.join(' ').includes('concat=n=3:v=1:a=1')));
});

test('one on-screen speaker or an unseen narrator is not a conversation', async () => {
  const { conversationTurns } = await import('../src/providers/localComfyUiAudiovisualProvider.js');
  const voiceover = { id: 'vo', name: 'Narrator', onScreen: false };
  const one = { dialogueTurns: [{ speakerCharacterId: 'ada', text: 'One.' }, { speakerCharacterId: 'ada', text: 'Two.' }] };
  const mixed = { dialogueTurns: [{ speakerCharacterId: 'ada', text: 'One.' }, { speakerCharacterId: 'vo', text: 'Two.' }] };
  assert.equal(conversationTurns({ segment: one, productionScript: { characters: [speaker] } }), null);
  assert.equal(conversationTurns({ segment: mixed, productionScript: { characters: [speaker, voiceover] } }), null);
});

test('resuming keeps each speaker portrait instead of the previous clip speaker', async () => {
  const ben = { id: 'ben', name: 'Ben', description: 'a man' };
  const { provider } = castProvider(false);
  let generated = 0;
  provider.generateFirstFrame = async () => { generated += 1; return 'new.png'; };
  const productionScript = { characters: [speaker, ben], locations: [location], segments: [] };
  const asset = await provider.generateCastSpeakingAct({
    segment: { index: 2, dialogueTurns: [{ speakerCharacterId: 'ben', text: 'Hi' }], characterIds: ['ben'] },
    productionScript, projectId: 'p', speaker: ben, seconds: 6,
    previousAsset: { castReference: 'ada.png', castReferences: { ada: 'ada.png', ben: 'ben.png' }, castVoices: { ada: 'f1', ben: 'm1' } },
  });
  assert.equal(asset.castReference, 'ben.png');
  assert.equal(generated, 1); // only the scene still, not a new portrait
});

test('the feature is off unless enabled', async () => {
  const { provider, seen } = castProvider(false);
  const asset = await act(provider, script(['wide', 'medium']), 0);
  assert.equal(provider.locationSet, null);
  assert.equal(asset.cameraAngle, null);
  assert.match(seen.animated[0], /^still-/);
});
