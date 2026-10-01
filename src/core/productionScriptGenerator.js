export class ProductionScriptGenerator {
  constructor({ llm }) {
    this.llm = llm;
  }

  async generate({ topic, audience, durationSeconds }) {
    const raw = this.llm?.generateProductionScript
      ? await this.llm.generateProductionScript({ topic, audience, durationSeconds })
      : fallbackProductionScript({ topic, audience, durationSeconds });

    return normalizeProductionScript(raw, { topic, audience, durationSeconds });
  }
}

export function productionScriptToStoryBible(script) {
  return {
    characters: script.characters.map((character) => ({
      id: character.id,
      name: character.name,
      description: character.description,
      wardrobe: character.wardrobe,
      physicalTraits: character.physicalTraits,
    })),
    locations: script.locations.map((location) => ({
      id: location.id,
      name: location.name,
      description: location.description,
      lighting: location.lighting,
      fixedElements: location.fixedElements,
    })),
    visualStyle: script.visualStyle,
    sceneBindings: script.segments.map((segment, sceneIndex) => ({
      sceneIndex,
      characterIds: segment.characterIds,
      locationId: segment.locationId,
    })),
    source: script.source,
  };
}

function normalizeProductionScript(value, context) {
  if (!value || typeof value !== 'object') throw new Error('production script must be an object');

  const characters = normalizeCharacters(value.characters);
  const locations = normalizeLocations(value.locations, context.topic);
  const characterIds = new Set(characters.map((item) => item.id));
  const locationIds = new Set(locations.map((item) => item.id));

  const rawSegments = Array.isArray(value.segments) ? value.segments : [];
  if (!rawSegments.length) throw new Error('production script requires at least one audiovisual segment');

  let cursor = 0;
  const segments = rawSegments.slice(0, 8).map((segment, index) => {
    const duration = clamp(Number(segment.durationSeconds) || 8, 4, 15);
    const speakerCharacterId = characterIds.has(safeId(segment.speakerCharacterId))
      ? safeId(segment.speakerCharacterId)
      : null;
    const boundCharacters = Array.isArray(segment.characterIds)
      ? segment.characterIds.map(safeId).filter((id) => characterIds.has(id)).slice(0, 3)
      : [];
    if (speakerCharacterId && !boundCharacters.includes(speakerCharacterId)) {
      boundCharacters.unshift(speakerCharacterId);
    }

    const normalized = {
      index,
      start: round(cursor),
      duration: round(duration),
      durationSeconds: round(duration),
      purpose: clean(segment.purpose || (index === 0 ? 'hook' : 'explain'), 80),
      speakerCharacterId,
      characterIds: boundCharacters,
      locationId: locationIds.has(safeId(segment.locationId))
        ? safeId(segment.locationId)
        : locations[0].id,
      dialogue: clean(segment.dialogue || '', 1400),
      action: clean(segment.action || '', 1000),
      camera: clean(segment.camera || '', 700),
      ambience: clean(segment.ambience || '', 500),
      soundEffects: Array.isArray(segment.soundEffects)
        ? segment.soundEffects.map((item) => clean(item, 180)).filter(Boolean).slice(0, 8)
        : [],
      music: clean(segment.music || '', 350),
      transition: clean(segment.transition || (index === 0 ? 'none' : 'hard cut'), 120),
    };
    cursor += duration;
    return normalized;
  });

  if (!segments.some((segment) => segment.dialogue)) {
    throw new Error('production script must contain spoken dialogue');
  }

  return {
    title: clean(value.title || context.topic, 180),
    topic: context.topic,
    audience: context.audience,
    targetDurationSeconds: Number(context.durationSeconds) || round(cursor),
    generatedDurationSeconds: round(cursor),
    synopsis: clean(value.synopsis || '', 800),
    characters,
    locations,
    visualStyle: {
      description: clean(value.visualStyle?.description || 'Photorealistic documentary realism with real-camera texture.', 500),
      cameraRules: clean(value.visualStyle?.cameraRules || 'Consistent natural lens language and restrained camera movement.', 500),
      lightingRules: clean(value.visualStyle?.lightingRules || 'Natural motivated lighting with stable color temperature.', 500),
    },
    audioDirection: {
      mix: clean(value.audioDirection?.mix || 'Dialogue clear in front; ambience and effects natural and restrained.', 400),
      musicPolicy: clean(value.audioDirection?.musicPolicy || 'Music must never mask dialogue.', 300),
    },
    segments,
    fullDialogue: segments.map((segment) => segment.dialogue).filter(Boolean).join(' '),
    source: clean(value.source || 'llm', 80),
    model: clean(value.model || '', 120),
  };
}

function normalizeCharacters(items) {
  const list = Array.isArray(items) ? items : [];
  const normalized = list.slice(0, 4).map((character, index) => ({
    id: safeId(character.id || `character-${index + 1}`),
    name: clean(character.name || `Character ${index + 1}`, 100),
    description: clean(character.description || '', 600),
    physicalTraits: clean(character.physicalTraits || '', 500),
    wardrobe: clean(character.wardrobe || '', 400),
    voice: {
      presetId: clean(character.voice?.presetId || 'Bernard', 80),
      description: clean(character.voice?.description || 'natural conversational voice', 250),
      delivery: clean(character.voice?.delivery || 'clear, warm, realistic', 250),
      languageCode: clean(character.voice?.languageCode || 'en', 12),
    },
  })).filter((character) => character.description);

  if (!normalized.length) {
    normalized.push({
      id: 'narrator',
      name: 'Narrator',
      description: 'A believable adult presenter appropriate for the topic.',
      physicalTraits: 'Natural realistic appearance and proportions.',
      wardrobe: 'Simple neutral clothing appropriate for the location.',
      voice: {
        presetId: 'Bernard',
        description: 'natural conversational narrator',
        delivery: 'clear and warm',
        languageCode: 'en',
      },
    });
  }
  return normalized;
}

function normalizeLocations(items, topic) {
  const list = Array.isArray(items) ? items : [];
  const normalized = list.slice(0, 4).map((location, index) => ({
    id: safeId(location.id || `location-${index + 1}`),
    name: clean(location.name || `Location ${index + 1}`, 120),
    description: clean(location.description || '', 700),
    lighting: clean(location.lighting || 'Natural motivated lighting.', 350),
    fixedElements: Array.isArray(location.fixedElements)
      ? location.fixedElements.map((item) => clean(item, 180)).filter(Boolean).slice(0, 10)
      : [],
  })).filter((location) => location.description);

  if (!normalized.length) {
    normalized.push({
      id: 'location-main',
      name: 'Primary environment',
      description: `A believable real-world environment appropriate for ${topic}.`,
      lighting: 'Natural motivated lighting.',
      fixedElements: ['Stable architecture and object placement'],
    });
  }
  return normalized;
}

function fallbackProductionScript({ topic, audience, durationSeconds }) {
  const duration = Math.max(12, Number(durationSeconds) || 30);
  const segmentCount = Math.max(2, Math.min(4, Math.ceil(duration / 10)));
  const each = Math.min(12, Math.max(5, duration / segmentCount));

  return {
    title: topic,
    synopsis: `A concise photorealistic explainer about ${topic} for ${audience}.`,
    characters: [{
      id: 'presenter',
      name: 'Presenter',
      description: 'A credible adult presenter speaking naturally to camera.',
      physicalTraits: 'Natural realistic face, hands and body proportions.',
      wardrobe: 'Simple neutral smart-casual clothing.',
      voice: {
        presetId: 'Bernard',
        description: 'warm conversational adult voice',
        delivery: 'confident, natural, concise',
        languageCode: 'en',
      },
    }],
    locations: [{
      id: 'location-main',
      name: 'Primary environment',
      description: `A realistic location directly relevant to ${topic}.`,
      lighting: 'Soft natural motivated light.',
      fixedElements: ['Stable environment layout'],
    }],
    visualStyle: {
      description: 'Photorealistic documentary short-form video.',
      cameraRules: 'Natural 35mm-50mm lens feel, restrained handheld movement.',
      lightingRules: 'Natural motivated lighting, stable exposure and color temperature.',
    },
    audioDirection: {
      mix: 'Presenter voice clear and close; realistic room ambience underneath.',
      musicPolicy: 'Very light music only if it supports the scene and never masks speech.',
    },
    segments: Array.from({ length: segmentCount }, (_, index) => ({
      durationSeconds: each,
      purpose: index === 0 ? 'hook' : index === segmentCount - 1 ? 'payoff' : 'explain',
      speakerCharacterId: 'presenter',
      characterIds: ['presenter'],
      locationId: 'location-main',
      dialogue: index === 0
        ? `Here is the most important thing to understand about ${topic}.`
        : index === segmentCount - 1
          ? `That is why ${topic} matters in practice, not just in theory.`
          : `The key is to connect one concrete mechanism in ${topic} to a result the viewer can recognize.`,
      action: 'The presenter demonstrates the point naturally in the environment.',
      camera: index % 2 ? 'medium documentary shot, subtle lateral movement' : 'medium close-up, gentle push-in',
      ambience: 'Natural room ambience appropriate to the location.',
      soundEffects: [],
      music: 'Subtle low-volume documentary music bed.',
      transition: index === 0 ? 'none' : 'clean hard cut',
    })),
    source: 'template-provider',
  };
}

function safeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
