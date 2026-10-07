import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductionScriptGenerator, stripTextDirections } from '../src/core/productionScriptGenerator.js';
import { collectSceneLabels } from '../src/core/audiovisualPipeline.js';
import { buildSubtitles, renderAssDocument } from '../src/core/subtitleBuilder.js';
import { shotTypeDirective } from '../src/providers/runwayAudiovisualProvider.js';

function generatorFor(segments) {
  return new ProductionScriptGenerator({
    llm: {
      async generateProductionScript() {
        return {
          title: 'Octopus',
          characters: [{ id: 'narrator', name: 'Narrator', description: 'Unseen narrator.', onScreen: false }],
          segments,
        };
      },
    },
  });
}

test('scene directions drop requests for model-rendered text', () => {
  assert.equal(
    stripTextDirections('The octopus rests on sand. Two labeled HEARTS glow. A small label appears: HEMOCYANIN. Blue light pulses.'),
    'The octopus rests on sand. Blue light pulses.',
  );
  assert.equal(stripTextDirections('Soft context lighting falls on the reef.'), 'Soft context lighting falls on the reef.');
});

test('production script keeps only labels that repeat spoken words', async () => {
  const script = await generatorFor([{
    durationSeconds: 6,
    speakerCharacterId: 'narrator',
    dialogue: 'The two branchial hearts pump blood through the gills.',
    action: 'Glowing vessels pulse. A label reads GILLS.',
    onScreenLabels: [
      { text: 'Branchial hearts', atSeconds: 1, durationSeconds: 2 },
      { text: 'Systemic heart', atSeconds: 3 },
      { text: 'Gills', atSeconds: 9, durationSeconds: 10 },
    ],
  }]).generate({ topic: 'octopus', durationSeconds: 6 });

  const [segment] = script.segments;
  assert.equal(segment.action, 'Glowing vessels pulse.');
  assert.deepEqual(segment.onScreenLabels, [
    { text: 'Branchial hearts', atSeconds: 1, durationSeconds: 2 },
    { text: 'Gills', atSeconds: 5, durationSeconds: 4 },
  ]);
});

test('weak one-word labels expand to a more specific spoken phrase', async () => {
  const script = await generatorFor([{
    durationSeconds: 6,
    speakerCharacterId: 'narrator',
    dialogue: 'Watch what happens when the angle increases sharply.',
    action: 'The wing rotates upward.',
    onScreenLabels: [
      { text: 'Angle', atSeconds: 1, durationSeconds: 2 },
    ],
  }]).generate({ topic: 'wing stall', durationSeconds: 6 });

  assert.equal(script.segments[0].onScreenLabels[0].text, 'angle increases');
});

test('labels preserve nearby semantic polarity instead of reversing the narration', async () => {
  const script = await generatorFor([{
    durationSeconds: 7,
    speakerCharacterId: 'narrator',
    dialogue: 'That loss of attached flow is a stall, not engine failure.',
    action: 'Separated airflow peels away from the wing.',
    onScreenLabels: [
      { text: 'Attached flow', atSeconds: 2, durationSeconds: 2 },
      { text: 'Engine failure', atSeconds: 4, durationSeconds: 2 },
    ],
  }]).generate({ topic: 'wing stall', durationSeconds: 7 });

  assert.deepEqual(
    script.segments[0].onScreenLabels.map((label) => label.text),
    ['loss of attached flow', 'not engine failure'],
  );
});

test('ordinary spoken labels stay unchanged when no polarity context is present', async () => {
  const script = await generatorFor([{
    durationSeconds: 6,
    speakerCharacterId: 'narrator',
    dialogue: 'Separated airflow forms above the wing.',
    action: 'Smoke peels away from the surface.',
    onScreenLabels: [{ text: 'Separated airflow', atSeconds: 1, durationSeconds: 2 }],
  }]).generate({ topic: 'wing stall', durationSeconds: 6 });

  assert.equal(script.segments[0].onScreenLabels[0].text, 'Separated airflow');
});

test('subtitle grouping does not strand weak connector words at cue endings', () => {
  const words = [
    ['At', 0, 0.2],
    ['a', 0.2, 0.35],
    ['moderate', 0.35, 0.7],
    ['angle', 0.7, 0.95],
    ['of', 0.95, 1.05],
    ['attack', 1.05, 1.35],
    ['lift', 1.35, 1.6],
    ['increases.', 1.6, 2],
  ].map(([word, start, end]) => ({ word, start, end }));

  const subtitles = buildSubtitles({
    voice: { wordTimings: words },
    config: {
      maxWordsPerCue: 5,
      maxCharsPerCue: 34,
      maxWidthPx: 840,
      maxLines: 2,
    },
  });

  assert.equal(subtitles.cues[0].text, 'At a moderate angle of attack');
  assert.ok(!subtitles.cues.some((cue) => /\b(?:of|the|a|an|to|and)$/i.test(cue.text)));
});

test('subtitle grouping completes a short dependent clause instead of splitting before its verb', () => {
  const words = [
    ['but', 0, 0.15],
    ['only', 0.15, 0.35],
    ['until', 0.35, 0.6],
    ['the', 0.6, 0.75],
    ['flow', 0.75, 1.0],
    ['separates.', 1.0, 1.4],
    ['Then', 1.5, 1.7],
    ['lift', 1.7, 1.95],
    ['drops.', 1.95, 2.3],
  ].map(([word, start, end]) => ({ word, start, end }));

  const subtitles = buildSubtitles({
    voice: { wordTimings: words },
    config: {
      maxWordsPerCue: 5,
      maxCharsPerCue: 34,
      maxWidthPx: 840,
      maxLines: 2,
    },
  });

  assert.equal(subtitles.cues[0].text, 'but only until the flow separates.');
  assert.equal(subtitles.cues[1].text, 'Then lift drops.');
});

test('shot types expand into materially different framing contracts', () => {
  assert.match(shotTypeDirective('macro-detail'), /Exclude most of the wider environment/i);
  assert.match(shotTypeDirective('overhead'), /top-down|high-angle/i);
  assert.match(shotTypeDirective('tracking'), /parallax|camera travel/i);
  assert.match(shotTypeDirective('wide-establishing'), /complete primary subject/i);
});

test('consecutive segments never repeat a shot type', async () => {
  const line = { speakerCharacterId: 'narrator', dialogue: 'Octopuses have three hearts.' };
  const script = await generatorFor([
    { ...line, shotType: 'close-up' },
    { ...line, shotType: 'close-up' },
    { ...line, shotType: 'not-a-shot' },
  ]).generate({ topic: 'octopus', durationSeconds: 24 });

  const shots = script.segments.map((segment) => segment.shotType);
  assert.equal(shots[0], 'close-up');
  assert.notEqual(shots[1], 'close-up');
  assert.notEqual(shots[2], shots[1]);
});

test('scene labels become timed title cards in the burned-in subtitle track', () => {
  const labels = collectSceneLabels([
    { start: 0, duration: 7, production: { onScreenLabels: [] } },
    { start: 7, duration: 8, production: { onScreenLabels: [{ text: 'Gills', atSeconds: 6, durationSeconds: 4 }] } },
  ]);
  assert.deepEqual(labels, [{ text: 'Gills', start: 13, end: 15 }]);

  const ass = renderAssDocument({ events: [], labels });
  assert.match(ass, /^Style: Label,/m);
  assert.match(ass, /^Dialogue: 1,0:00:13\.00,0:00:15\.00,Label,.*GILLS$/m);
});

test('close shots describe the setting as out of frame instead of the full location', async () => {
  const { describeLocationForShot, buildKeyframePrompts } = await import('../src/core/keyframeDirector.js');
  const location = {
    id: 'tunnel',
    name: 'Wind tunnel lab',
    description: 'A glass test chamber on a steel bench',
    lighting: 'Cool overhead strips',
    fixedElements: ['glass chamber', 'wing stand'],
  };

  const wide = describeLocationForShot(location, 'wide-establishing');
  assert.match(wide, /glass test chamber/);
  assert.match(wide, /Fixed elements: glass chamber, wing stand/);

  const close = describeLocationForShot(location, 'close-up');
  assert.doesNotMatch(close, /glass test chamber|Fixed elements/);
  assert.match(close, /out of frame/);
  assert.match(close, /Cool overhead strips/);

  const prompts = buildKeyframePrompts({
    segment: {
      shotType: 'macro-detail',
      locationId: 'tunnel',
      keyframeDirection: { enabled: true, policy: 'first', firstFrame: { state: 'The upper wing surface fills the frame.' } },
    },
    productionScript: { characters: [], locations: [location] },
  });
  assert.doesNotMatch(prompts.first, /glass test chamber|wing stand/);
  assert.match(prompts.first, /upper wing surface fills the frame/);
});

test('preflight accepts a cast whose players are named by position or as teammates', async () => {
  const { roleMatcher, validateProductionScriptPreflight } = await import('../src/core/productionScriptGenerator.js');
  assert.ok(roleMatcher('player').test('Maya, the team captain'));
  assert.ok(roleMatcher('player').test('a starting point guard'));
  assert.ok(!roleMatcher('player').test('a guardian at the door'));
  assert.ok(!roleMatcher('coach').test('an old stagecoach'));

  const result = validateProductionScriptPreflight({
    directorialContract: { expectedRoleHints: ['coach', 'player'], requiredVisibleCharacterIds: [] },
    characters: [
      { id: 'coach', name: 'Coach Ellis', description: 'Head coach', onScreen: true },
      { id: 'maya', name: 'Maya', description: 'Team captain and point guard', onScreen: true },
    ],
    segments: [],
  }, { topic: 'A coach motivates his players' });
  const violations = Array.isArray(result) ? result : (result?.violations || []);
  assert.ok(!violations.some((item) => /visible (?:coach|player)/.test(String(item))), JSON.stringify(violations));
});

test('everyday body movement is not locked to breathing micro-motion', async () => {
  const { directMotionRegions } = await import('../src/core/motionRegionDirector.js');
  const plan = (action) => {
    const result = directMotionRegions({ action, dialogue: 'Together.' });
    return result.motionRegionDirection || result;
  };

  const walking = plan('The coach walks between the benches and turns to face the team.');
  assert.ok(walking.allowedMotion.some((item) => item.id === 'body-movement'));
  assert.ok(!walking.lockedRegions.some((item) => item.id === 'body-shape'));

  const standing = plan('The coach speaks calmly with his hands on his hips.');
  assert.ok(standing.lockedRegions.some((item) => item.id === 'body-shape'));
});

test('the whole cast and every character in a segment are kept', async () => {
  const team = ['coach', 'jalen', 'malik', 'owen', 'devon', 'andre', 'samir'];
  const script = await new ProductionScriptGenerator({
    llm: {
      async generateProductionScript() {
        return {
          title: 'Huddle',
          characters: team.map((id) => ({ id, name: id, description: id === 'coach' ? 'Head coach' : 'Team player' })),
          segments: [{
            durationSeconds: 8,
            speakerCharacterId: 'coach',
            characterIds: team,
            dialogue: 'Hands in. Together.',
            action: 'The team huddles and stacks hands.',
          }],
        };
      },
    },
  }).generate({ topic: 'coach and team', durationSeconds: 8 });

  assert.equal(script.characters.length, 7);
  assert.deepEqual(script.segments[0].characterIds, team);
});

test('segments without dialogue are marked no-dialogue rather than single-speaker', async () => {
  const script = await generatorFor([
    { durationSeconds: 6, speakerCharacterId: 'narrator', dialogue: 'Hands in.' },
    { durationSeconds: 6, action: 'The team runs out of the locker room.' },
  ]).generate({ topic: 'team', durationSeconds: 12 });

  assert.equal(script.segments[0].speakerMode, 'single-speaker');
  assert.equal(script.segments[1].speakerMode, 'no-dialogue');
  assert.equal(script.segments[1].speakerCharacterId, null);
});

test('screenplay prompt states the per-shot action limit the realism director enforces', async () => {
  const { OpenAICompatibleLlmProvider } = await import('../src/providers/openaiCompatibleLlmProvider.js');
  let prompt = '';
  const llm = new OpenAICompatibleLlmProvider({
    apiKey: 'key',
    model: 'model',
    fetchImpl: async (_url, options) => {
      prompt = JSON.parse(options.body).messages.map((message) => message.content).join('\n');
      return { ok: false, status: 500, json: async () => ({ error: { message: 'stop' } }) };
    },
  });
  await llm.generateProductionScript({ topic: 'coach and team', audience: 'fans', durationSeconds: 40 }).catch(() => {});
  assert.match(prompt, /at most two physical actions/);
  assert.match(prompt, /Handle at most one object per segment/);
});

test('keyframe prompts follow the current start/end state, not a stale planned copy', async () => {
  const { buildKeyframePrompts } = await import('../src/core/keyframeDirector.js');
  const segment = {
    shotType: 'medium',
    startState: 'Waist-up: four people in a tight semicircle; shoes out of frame.',
    endState: 'Hands joined at chest height, faces visible.',
    keyframeDirection: {
      enabled: true,
      policy: 'first-last',
      firstFrame: { state: 'Vertical wide frontal shot of the whole room.' },
      lastFrame: { state: 'Old ending.' },
    },
  };
  const prompts = buildKeyframePrompts({ segment, productionScript: { characters: [], locations: [] } });
  assert.match(prompts.first, /Waist-up: four people/);
  assert.doesNotMatch(prompts.first, /wide frontal shot/);
  assert.match(prompts.last, /Hands joined at chest height/);

  const forced = buildKeyframePrompts({
    segment: { ...segment, keyframeDirection: { enabled: true, policy: 'first', firstFrame: { state: 'FRAMING CONTRACT: close.', explicit: true } } },
    productionScript: { characters: [], locations: [] },
  });
  assert.match(forced.first, /FRAMING CONTRACT: close\./);
});

test('keyframe prompts refer to people by position so names are not printed on clothing', async () => {
  const { buildKeyframePrompts } = await import('../src/core/keyframeDirector.js');
  const prompts = buildKeyframePrompts({
    segment: {
      characterIds: ['coach', 'jalen'],
      startState: 'Coach Rivera faces Jalen in the locker room.',
      endState: 'Jalen nods at Coach Rivera.',
      keyframeDirection: { enabled: true, policy: 'first-last', firstFrame: {}, lastFrame: {} },
    },
    productionScript: {
      characters: [
        { id: 'coach', name: 'Coach Rivera', description: 'Head coach in a dark jacket' },
        { id: 'jalen', name: 'Jalen', description: 'Young guard' },
      ],
      locations: [],
    },
  });
  for (const prompt of [prompts.first, prompts.last]) {
    assert.doesNotMatch(prompt, /Rivera|Jalen/);
    assert.match(prompt, /Person 1/);
    assert.match(prompt, /^Photorealistic\. No text, letters, numbers, names or logos/);
  }
});
