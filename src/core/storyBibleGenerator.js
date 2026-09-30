export class StoryBibleGenerator {
  constructor({ llm }) {
    this.llm = llm;
  }

  async generate({ script }) {
    if (this.llm?.generateStoryBible) {
      return normalizeBible(await this.llm.generateStoryBible({ script }), script);
    }

    return normalizeBible(fallbackBible(script), script);
  }
}

function fallbackBible(script) {
  const parts = scriptParts(script);
  return {
    characters: [],
    locations: [{
      id: 'location-main',
      name: 'Primary real-world environment',
      description: `A believable real-world environment appropriate for ${script.topic}, with stable architecture, objects and lighting across shots.`,
    }],
    visualStyle: {
      description: 'Photorealistic documentary footage, natural light, restrained cinematic movement, real-camera texture.',
      cameraRules: 'Eye-level documentary framing, 35mm-50mm lens feel, subtle handheld or controlled dolly motion.',
      lightingRules: 'Natural motivated lighting, consistent color temperature, no artificial CGI glow.',
    },
    sceneBindings: parts.map((_, index) => ({
      sceneIndex: index,
      characterIds: [],
      locationId: 'location-main',
    })),
    source: 'fallback',
  };
}

function normalizeBible(value, script) {
  const parts = scriptParts(script);
  const characters = Array.isArray(value?.characters)
    ? value.characters.slice(0, 3).map((character, index) => ({
      id: safeId(character.id || `character-${index + 1}`),
      name: clean(character.name || `Character ${index + 1}`),
      description: clean(character.description || ''),
      wardrobe: clean(character.wardrobe || ''),
      physicalTraits: clean(character.physicalTraits || ''),
    })).filter((character) => character.description)
    : [];

  const locations = Array.isArray(value?.locations)
    ? value.locations.slice(0, 3).map((location, index) => ({
      id: safeId(location.id || `location-${index + 1}`),
      name: clean(location.name || `Location ${index + 1}`),
      description: clean(location.description || ''),
      lighting: clean(location.lighting || ''),
      fixedElements: Array.isArray(location.fixedElements)
        ? location.fixedElements.slice(0, 8).map(clean).filter(Boolean)
        : [],
    })).filter((location) => location.description)
    : [];

  if (!locations.length) {
    locations.push({
      id: 'location-main',
      name: 'Primary real-world environment',
      description: `A believable real-world environment appropriate for ${script.topic}.`,
      lighting: 'Natural motivated lighting.',
      fixedElements: [],
    });
  }

  const characterIds = new Set(characters.map((character) => character.id));
  const locationIds = new Set(locations.map((location) => location.id));
  const rawBindings = Array.isArray(value?.sceneBindings) ? value.sceneBindings : [];

  const sceneBindings = parts.map((_, sceneIndex) => {
    const source = rawBindings.find((binding) => Number(binding?.sceneIndex) === sceneIndex) || {};
    const ids = Array.isArray(source.characterIds)
      ? source.characterIds.map(safeId).filter((id) => characterIds.has(id)).slice(0, 2)
      : [];

    return {
      sceneIndex,
      characterIds: ids,
      locationId: locationIds.has(safeId(source.locationId))
        ? safeId(source.locationId)
        : locations[0].id,
    };
  });

  return {
    characters,
    locations,
    visualStyle: {
      description: clean(value?.visualStyle?.description || 'Photorealistic documentary footage with real-camera texture.'),
      cameraRules: clean(value?.visualStyle?.cameraRules || 'Consistent documentary lens family and restrained camera motion.'),
      lightingRules: clean(value?.visualStyle?.lightingRules || 'Natural motivated lighting with stable color temperature.'),
    },
    sceneBindings,
    source: clean(value?.source || 'llm'),
  };
}

function scriptParts(script) {
  return [script.hook, ...(script.body || []), script.payoff, script.cta].filter(Boolean);
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 700);
}

function safeId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
