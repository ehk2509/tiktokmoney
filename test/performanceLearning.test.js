import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PerformanceLearningStore } from '../src/storage/performanceLearningStore.js';
import { PerformanceLearningService } from '../src/services/performanceLearningService.js';
import { applyPerformanceEvidence } from '../src/core/creativeTournament.js';

test('publication metrics become cost-aware creative outcome evidence', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-learning-'));
  try {
    const store = new PerformanceLearningStore(path.join(dir, 'learning.json'));
    const projectStore = {
      async getProject() {
        return {
          id: 'vid-1',
          topic: 'basketball coaching',
          audience: 'sports fans',
          creativeBrief: {
            id: 'dialogue-1',
            format: 'two-person dialogue',
            emotionalDriver: 'tension',
            angle: 'coach challenges captain',
            hook: 'You have one timeout left.',
            retentionDevice: 'conflict then resolution',
          },
          costLedger: {
            costUsdComplete: true,
            costUsd: 2.5,
            costUsdObserved: 2.5,
            source: 'provider-reported-complete',
          },
        };
      },
    };
    const service = new PerformanceLearningService({ store, projectStore, minSamples: 2 });

    const outcome = await service.recordPublication({
      id: 'pub-1',
      projectId: 'vid-1',
      postIds: ['post-1'],
      metricsSnapshots: [{
        capturedAt: '2026-10-07T10:00:00.000Z',
        videos: [{
          viewCount: 1000,
          likeCount: 80,
          commentCount: 10,
          shareCount: 10,
        }],
      }],
    });

    assert.equal(outcome.metrics.viewCount, 1000);
    assert.equal(outcome.metrics.engagementRate, 0.1);
    assert.equal(outcome.cost.actualCostUsd, 2.5);
    assert.equal(outcome.cost.costPerThousandViewsUsd, 2.5);

    const context = await service.contextFor({ audience: 'sports fans' });
    assert.equal(context.sampleCount, 1);
    assert.equal(context.format['two-person dialogue'].eligible, false);
    assert.equal(context.format['two-person dialogue'].score, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('learning evidence becomes eligible after minimum sample count', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tiktokmoney-learning-'));
  try {
    const store = new PerformanceLearningStore(path.join(dir, 'learning.json'));
    let projectId = 'vid-1';
    const projectStore = {
      async getProject() {
        return {
          id: projectId,
          audience: 'general',
          creativeBrief: {
            format: 'dialogue',
            emotionalDriver: 'tension',
          },
          costLedger: { costUsdComplete: false, costUsdObserved: 1 },
        };
      },
    };
    const service = new PerformanceLearningService({ store, projectStore, minSamples: 2 });

    for (let index = 1; index <= 2; index += 1) {
      projectId = `vid-${index}`;
      await service.recordPublication({
        id: `pub-${index}`,
        projectId,
        metricsSnapshots: [{
          capturedAt: `2026-10-07T10:0${index}:00.000Z`,
          videos: [{
            viewCount: 1000 * index,
            likeCount: 100,
            commentCount: 10,
            shareCount: 10,
          }],
        }],
      });
    }

    const context = await service.contextFor({ audience: 'general' });
    assert.equal(context.format.dialogue.samples, 2);
    assert.equal(context.format.dialogue.eligible, true);
    assert.ok(Number.isFinite(context.format.dialogue.score));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('performance evidence only applies a bounded adjustment to creative ranking', () => {
  const candidates = [
    { id: 'a', format: 'dialogue', emotionalDriver: 'tension' },
    { id: 'b', format: 'explainer', emotionalDriver: 'utility' },
  ];
  const ranking = [
    { candidateId: 'a', score: 78 },
    { candidateId: 'b', score: 80 },
  ];
  const adjusted = applyPerformanceEvidence({
    candidates,
    ranking,
    maxAdjustment: 4,
    evidence: {
      format: {
        dialogue: { eligible: true, score: 5 },
        explainer: { eligible: true, score: 2 },
      },
      emotionalDriver: {
        tension: { eligible: true, score: 5 },
        utility: { eligible: true, score: 2 },
      },
    },
  });

  const a = adjusted.find((row) => row.candidateId === 'a');
  const b = adjusted.find((row) => row.candidateId === 'b');
  assert.ok(a.learningAdjustment <= 4 && a.learningAdjustment >= -4);
  assert.ok(b.learningAdjustment <= 4 && b.learningAdjustment >= -4);
  assert.equal(a.baseScore, 78);
  assert.equal(b.baseScore, 80);
  assert.ok(a.score > 78);
  assert.ok(b.score < 80);
});
