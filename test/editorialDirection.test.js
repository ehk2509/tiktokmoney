import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductionScriptGenerator, stripTextDirections } from '../src/core/productionScriptGenerator.js';
import { collectSceneLabels } from '../src/core/audiovisualPipeline.js';
import { renderAssDocument } from '../src/core/subtitleBuilder.js';

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
