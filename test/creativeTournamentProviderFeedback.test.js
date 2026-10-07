import test from 'node:test';
import assert from 'node:assert/strict';

import { CreativeTournament } from '../src/core/creativeTournament.js';

test('creative tournament feeds independent candidate quality back to routed generator', async () => {
  const feedback = [];
  const generated = {
    candidates: [
      {
        id: 'a',
        angle: 'angle a',
        hook: 'Why this works',
        format: 'direct explainer',
        emotionalDriver: 'curiosity',
        retentionDevice: 'open loop',
        payoff: 'answer',
        visualOpportunity: 'demo',
        dialogueStyle: 'clear',
        monetizationFit: 'useful',
        productionNotes: 'simple',
        riskNotes: [],
      },
      {
        id: 'b',
        angle: 'angle b',
        hook: 'What most people miss',
        format: 'micro-story',
        emotionalDriver: 'surprise',
        retentionDevice: 'reveal',
        payoff: 'resolution',
        visualOpportunity: 'story',
        dialogueStyle: 'natural',
        monetizationFit: 'repeatable',
        productionNotes: 'simple',
        riskNotes: [],
      },
    ],
    providerRouting: {
      capability: 'llm',
      providerId: 'llm:openrouter:model-a',
    },
  };

  const llm = {
    async generateCreativeCandidates() {
      return generated;
    },
    async judgeCreativeCandidates() {
      return {
        judgments: [
          {
            candidateId: 'a',
            scores: {
              hookStrength: 90,
              retentionPotential: 90,
              clarity: 90,
              novelty: 90,
              productionFeasibility: 90,
              monetizationFit: 90,
              factualSafety: 90,
              platformFit: 90,
            },
            hardReject: false,
          },
          {
            candidateId: 'b',
            scores: {
              hookStrength: 70,
              retentionPotential: 70,
              clarity: 70,
              novelty: 70,
              productionFeasibility: 70,
              monetizationFit: 70,
              factualSafety: 70,
              platformFit: 70,
            },
            hardReject: false,
          },
        ],
      };
    },
    async recordOutcome(result, outcome) {
      feedback.push({ result, outcome });
    },
  };

  const tournament = new CreativeTournament({
    llm,
    candidateCount: 2,
    minWinnerScore: 60,
    minMargin: 0,
  });

  const result = await tournament.run({
    topic: 'topic',
    audience: 'audience',
    durationSeconds: 30,
  });

  assert.equal(result.accepted, true);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].result.providerRouting.providerId, 'llm:openrouter:model-a');
  assert.equal(feedback[0].outcome.passed, true);
  assert.equal(feedback[0].outcome.qualityScore, 80);
});
