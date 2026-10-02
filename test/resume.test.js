import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AudiovisualPipeline } from '../src/core/audiovisualPipeline.js';

function memoryStore() {
  const projects = new Map();
  return {
    projects,
    async saveProject(project) {
      projects.set(project.id, structuredClone(project));
    },
    async getProject(id) {
      if (!projects.has(id)) throw new Error(`missing ${id}`);
      return structuredClone(projects.get(id));
    },
  };
}

const llm = {
  async generateProductionScript() {
    return {
      title: 'Lift',
      characters: [{ id: 'narrator', name: 'Narrator', description: 'Unseen narrator.', onScreen: false }],
      segments: [0, 1, 2].map((index) => ({
        durationSeconds: 6,
        speakerCharacterId: 'narrator',
        dialogue: `Act ${index} explains lift.`,
        action: 'Smoke flows over a wing.',
      })),
    };
  },
};

function pipelineWith({ dir, store, failAct = null, throwAct = null, generated }) {
  return new AudiovisualPipeline({
    llm,
    store,
    renderer: null,
    audiovisual: {
      async generateSegment({ segment }) {
        if (segment.index === throwAct) throw new Error('Runway request failed (400): not enough credits');
        generated.push(segment.index);
        const localPath = path.join(dir, `act-${segment.index}-${generated.length}.mp4`);
        await writeFile(localPath, 'clip');
        return { type: 'ai-video', localPath, generationId: `g${generated.length}` };
      },
    },
    dialogueQc: {
      maxRegenerations: 0,
      async evaluate(asset, { expectedText }) {
        const failed = failAct !== null && asset.localPath.includes(`act-${failAct}-`);
        return failed
          ? { passed: false, wer: 0.5, issues: [{ code: 'drift', severity: 'high' }], regenerationGuidance: '' }
          : { passed: true, wer: 0, issues: [], regenerationGuidance: '', transcription: { text: expectedText, words: [] } };
      },
    },
  });
}

test('resume continues a QC-failed project without regenerating accepted acts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-resume-qc-'));
  try {
    const store = memoryStore();
    const firstRun = [];
    const failed = await pipelineWith({ dir, store, failAct: 2, generated: firstRun })
      .generate({ topic: 'lift', durationSeconds: 18, render: false });

    assert.equal(failed.status, 'DIALOGUE_QC_FAILED');
    assert.deepEqual(firstRun, [0, 1, 2]);

    const secondRun = [];
    const resumed = await pipelineWith({ dir, store, generated: secondRun }).resume(failed.id, { render: false });

    assert.deepEqual(secondRun, [2]);
    assert.equal(resumed.status, 'READY');
    assert.equal(resumed.resumedFromAct, 2);
    assert.deepEqual(resumed.scenes.map((scene) => scene.start), [0, 6, 12]);
    assert.equal(resumed.scenes[0].asset.generationId, 'g1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a provider error checkpoints accepted acts so the run can resume', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-resume-crash-'));
  try {
    const store = memoryStore();
    const firstRun = [];
    await assert.rejects(
      pipelineWith({ dir, store, throwAct: 1, generated: firstRun })
        .generate({ topic: 'lift', durationSeconds: 18, render: false }),
      /not enough credits/,
    );

    const [saved] = store.projects.values();
    assert.equal(saved.status, 'GENERATION_INTERRUPTED');
    assert.equal(saved.scenes.length, 1);

    const secondRun = [];
    const resumed = await pipelineWith({ dir, store, generated: secondRun }).resume(saved.id, { render: false });
    assert.deepEqual(secondRun, [1, 2]);
    assert.equal(resumed.status, 'READY');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resume regenerates from the first act whose clip file is missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-resume-missing-'));
  try {
    const store = memoryStore();
    const firstRun = [];
    const failed = await pipelineWith({ dir, store, failAct: 2, generated: firstRun })
      .generate({ topic: 'lift', durationSeconds: 18, render: false });
    await rm(failed.scenes[1].asset.localPath);

    const secondRun = [];
    await pipelineWith({ dir, store, generated: secondRun }).resume(failed.id, { render: false });
    assert.deepEqual(secondRun, [1, 2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
