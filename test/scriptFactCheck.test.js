import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductionScriptGenerator } from '../src/core/productionScriptGenerator.js';
import { ObservabilityService } from '../src/services/observabilityService.js';

const RAW_SCRIPT = {
  title: 'Antarctica flights',
  characters: [{ id: 'narrator', name: 'Narrator', description: 'Unseen narrator.', onScreen: false }],
  segments: [
    { durationSeconds: 10, speakerCharacterId: 'narrator', dialogue: 'Why do planes avoid Antarctica?', action: 'Wide shot of an icy plain.' },
    { durationSeconds: 10, speakerCharacterId: 'narrator', dialogue: 'A treaty bans all flights.', action: 'A plane crosses the sky.' },
    { durationSeconds: 10, speakerCharacterId: 'narrator', dialogue: 'That is why routes go around it.', action: 'Snow drifts over a runway.' },
  ],
};

function llmWithFactCheck(verdicts) {
  const calls = [];
  let check = 0;
  return {
    calls,
    async generateProductionScript(args) {
      calls.push(args);
      return RAW_SCRIPT;
    },
    async factCheckProductionScript() {
      const verdict = verdicts[Math.min(check, verdicts.length - 1)];
      check += 1;
      return { claims: [{ text: 'A treaty bans all flights.', verdict, confidence: 0.9,
        correction: 'No treaty bans flights; the lack of diversion airports is the main reason.' }] };
    },
  };
}

test('a false spoken claim triggers a corrected rewrite', async () => {
  const llm = llmWithFactCheck(['false', 'true']);
  const script = await new ProductionScriptGenerator({ llm, preflightMaxRetries: 1 })
    .generate({ topic: 'Why planes avoid Antarctica', audience: 'general', durationSeconds: 30 });
  assert.equal(script.preflight.passed, true);
  assert.equal(script.preflight.attempt, 2);
  assert.match(llm.calls[1].preflightFeedback, /No treaty bans flights/);
  assert.equal(script.factCheck.passed, true);
});

test('a script that stays false after all retries is rejected', async () => {
  const llm = llmWithFactCheck(['false']);
  llm.generateProductionScript = async () => RAW_SCRIPT;
  await assert.rejects(
    new ProductionScriptGenerator({ llm, preflightMaxRetries: 1 })
      .generate({ topic: 'Why planes avoid Antarctica', audience: 'general', durationSeconds: 30 }),
    /Factually wrong claim/,
  );
});

test('low-confidence or uncertain claims do not block, and checker errors fail open', async () => {
  const llm = llmWithFactCheck(['uncertain']);
  llm.generateProductionScript = async () => RAW_SCRIPT;
  const ok = await new ProductionScriptGenerator({ llm, preflightMaxRetries: 0 })
    .generate({ topic: 'Antarctica', audience: 'general', durationSeconds: 30 });
  assert.equal(ok.factCheck.passed, true);

  llm.factCheckProductionScript = async () => { throw new Error('ollama down'); };
  const open = await new ProductionScriptGenerator({ llm, preflightMaxRetries: 0 })
    .generate({ topic: 'Antarctica', audience: 'general', durationSeconds: 30 });
  assert.equal(open.factCheck.checked, false);
});

test('one failed project does not open the generation failure breaker', async () => {
  const service = new ObservabilityService({
    projectStore: { async listProjects() {
      return [{ id: 'aborted', status: 'RENDER_FAILED', createdAt: '2026-11-07T10:00:00.000Z' }];
    } },
  });
  const result = await service.snapshot();
  assert.equal(result.metrics.projects.failureRate, 1);
  assert.ok(!result.incidents.some((item) => item.code.startsWith('project_failure_rate')));
});

test('local LLM retries a looping/aborted completion at a higher temperature', async () => {
  const { OpenAICompatibleLlmProvider } = await import('../src/providers/openaiCompatibleLlmProvider.js');
  const temperatures = [];
  const llm = new OpenAICompatibleLlmProvider({
    apiKey: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:14b', providerName: 'local',
    fetchImpl: async (_url, opts) => {
      temperatures.push(JSON.parse(opts.body).temperature);
      if (temperatures.length === 1) {
        return Response.json({ error: { message: 'prediction aborted, token repeat limit reached' } }, { status: 500 });
      }
      return Response.json({ choices: [{ message: { content: '{"facts":["ok"]}' } }] });
    },
  });
  const result = await llm.generateFactSheet({ topic: 'x' });
  assert.deepEqual(result.facts, ['ok']);
  assert.deepEqual(temperatures, [0, 0.2]);
});
