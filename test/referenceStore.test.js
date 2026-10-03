import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReferenceStore } from '../src/services/referenceStore.js';
import { AudiovisualPipeline } from '../src/core/audiovisualPipeline.js';

function storyBible() {
  return {
    references: {
      characters: { coach: { images: [{ url: 'https://refs.example/coach.png' }] } },
      locations: { gym: { url: 'https://refs.example/gym.png' } },
    },
  };
}

test('reference images are saved locally and expired links are swapped for compact local copies', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-refstore-'));
  let expired = false;
  try {
    const store = new ReferenceStore({
      assetDir: dir,
      fetchImpl: async (url, options = {}) => {
        if (expired) return { ok: false, status: 403 };
        if (options.headers?.range) return { ok: true, status: 206 };
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'image/png' },
          arrayBuffer: async () => new TextEncoder().encode(`png:${url}`).buffer,
        };
      },
      runCommand: async (_bin, args) => writeFile(args.at(-1), 'compact-jpeg'),
    });

    const bible = storyBible();
    assert.equal(await store.persist(bible, { projectId: 'vid-1' }), 2);
    const coach = bible.references.characters.coach.images[0];
    assert.match(coach.localPath, /reference-vid-1-character-coach-0\.png$/);
    assert.equal(await readFile(coach.localPath, 'utf8'), 'png:https://refs.example/coach.png');

    assert.equal(await store.withFreshReferences(bible), bible);

    expired = true;
    const fresh = await store.withFreshReferences(bible);
    assert.notEqual(fresh, bible);
    assert.equal(fresh.references.characters.coach.images[0].url, `data:image/jpeg;base64,${Buffer.from('compact-jpeg').toString('base64')}`);
    assert.equal(bible.references.characters.coach.images[0].url, 'https://refs.example/coach.png');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pipeline persists prepared references and hands each act a refreshed copy', async () => {
  const calls = { persisted: 0, refreshed: 0 };
  const seen = [];
  const pipeline = new AudiovisualPipeline({
    llm: {
      async generateProductionScript() {
        return {
          title: 'Refs',
          characters: [{ id: 'coach', name: 'Coach', description: 'Head coach', onScreen: false }],
          segments: [{ durationSeconds: 6, speakerCharacterId: 'coach', dialogue: 'Together.', action: 'The team waits.' }],
        };
      },
    },
    visual: { prepareStoryBible: async (bible) => ({ ...bible, ...storyBible() }) },
    referenceStore: {
      async persist() { calls.persisted += 1; return 2; },
      async withFreshReferences(bible) { calls.refreshed += 1; return { ...bible, refreshed: true }; },
    },
    audiovisual: {
      async generateSegment({ storyBible: bible }) {
        seen.push(bible.refreshed);
        return { type: 'ai-video', localPath: '/fake/act.mp4', generationId: 'g1' };
      },
    },
    renderer: null,
    store: { saveProject: async () => {} },
  });

  const project = await pipeline.generate({ topic: 'refs', durationSeconds: 6, render: false });
  assert.equal(project.status, 'READY');
  assert.deepEqual(calls, { persisted: 1, refreshed: 1 });
  assert.deepEqual(seen, [true]);
  assert.equal(project.storyBible.refreshed, undefined);
});
