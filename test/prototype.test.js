import test from 'node:test';
import assert from 'node:assert/strict';
import { rankOpportunities, scoreOpportunity } from '../src/core/opportunityScorer.js';
import { planScenes } from '../src/core/scenePlanner.js';
import { VideoPipeline } from '../src/core/pipeline.js';
import { TemplateLlmProvider } from '../src/providers.js';

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

test('pipeline generates a quality-gated project without rendering', async () => {
  const saved = [];
  const pipeline = new VideoPipeline({
    llm: new TemplateLlmProvider(),
    renderer: null,
    store: { saveProject: async (project) => saved.push(project) },
  });
  const project = await pipeline.generate({ topic: 'Why airplanes fly', render: false });
  assert.equal(project.status, 'QC_PASSED');
  assert.ok(project.scenes.length >= 4);
  assert.equal(saved.length, 1);
});
