const RUNWAY_VOICE_PRESETS = [
  'Maya', 'Arjun', 'Serene', 'Bernard', 'Billy', 'Mark', 'Clint', 'Mabel',
  'Chad', 'Leslie', 'Eleanor', 'Elias', 'Elliot', 'Grungle', 'Brodie',
  'Sandra', 'Kirk', 'Kylie', 'Lara', 'Lisa', 'Malachi', 'Marlene', 'Martin',
  'Miriam', 'Monster', 'Paula', 'Pip', 'Rusty', 'Ragnar', 'Xylar', 'Maggie',
  'Jack', 'Katie', 'Noah', 'James', 'Rina', 'Ella', 'Mariah', 'Frank',
  'Claudia', 'Niki', 'Vincent', 'Kendrick', 'Myrna', 'Tom', 'Wanda',
  'Benjamin', 'Kiana', 'Rachel',
];
const RUNWAY_VOICE_BY_LOWER = new Map(
  RUNWAY_VOICE_PRESETS.map((preset) => [preset.toLowerCase(), preset]),
);
const FALLBACK_VOICES = ['Bernard', 'Maya', 'Arjun', 'Serene', 'Eleanor', 'Vincent'];
const SHOT_TYPES = ['wide-establishing', 'close-up', 'medium', 'macro-detail', 'tracking', 'overhead', 'pov'];

export class ProductionScriptGenerator {
  constructor({
    llm,
    preflightMaxRetries = Number(process.env.PRODUCTION_SCRIPT_PREFLIGHT_MAX_RETRIES || 1),
  }) {
    this.llm = llm;
    this.preflightMaxRetries = Math.max(0, Math.min(3, Number(preflightMaxRetries) || 0));
  }

  async generate({
    topic,
    audience,
    durationSeconds,
    creativeBrief = null,
    researchPacket = null,
  }) {
    let preflightFeedback = '';

    for (let attempt = 0; attempt <= this.preflightMaxRetries; attempt += 1) {
      const raw = this.llm?.generateProductionScript
        ? await this.llm.generateProductionScript({
          topic,
          audience,
          durationSeconds,
          creativeBrief,
          researchPacket,
          preflightFeedback,
        })
        : fallbackProductionScript({ topic, audience, durationSeconds, creativeBrief });

      const script = normalizeProductionScript(raw, {
        topic,
        audience,
        durationSeconds,
        creativeBrief,
      });
      const preflight = validateProductionScriptPreflight(script, {
        topic,
        creativeBrief,
        durationSeconds,
      });
      script.preflight = {
        ...preflight,
        attempt: attempt + 1,
      };
      if (preflight.passed) return script;

      preflightFeedback = preflight.violations.join(' ');
    }

    throw new Error(`Production script failed preflight: ${preflightFeedback}`);
  }
}

export function productionScriptToStoryBible(script) {
  return {
    characters: script.characters.filter((character) => character.onScreen !== false).map((character) => ({
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
  let previousShotType = null;
  const segments = rawSegments.slice(0, 8).map((segment, index) => {
    const duration = clamp(Number(segment.durationSeconds) || 8, 4, 15);
    const legacySpeakerId = characterIds.has(safeId(segment.speakerCharacterId))
      ? safeId(segment.speakerCharacterId)
      : null;
    const dialogueTurns = normalizeDialogueTurns(segment, {
      characterIds,
      fallbackSpeakerId: legacySpeakerId || characters[0]?.id || null,
    });
    const turnSpeakerIds = unique(
      dialogueTurns.map((turn) => turn.speakerCharacterId).filter(Boolean),
    );
    const boundCharacters = unique([
      ...turnSpeakerIds,
      ...(Array.isArray(segment.characterIds)
        ? segment.characterIds.map(safeId).filter((id) => characterIds.has(id))
        : []),
    ]).slice(0, 3);
    const speakerCharacterId = dialogueTurns[0]?.speakerCharacterId || legacySpeakerId;
    if (speakerCharacterId && !boundCharacters.includes(speakerCharacterId)) {
      boundCharacters.unshift(speakerCharacterId);
    }
    const dialogue = dialogueTurns.map((turn) => turn.text).filter(Boolean).join(' ').trim();
    const shotType = distinctShotType(segment.shotType, previousShotType, index);
    previousShotType = shotType;

    const normalized = {
      index,
      start: round(cursor),
      duration: round(duration),
      durationSeconds: round(duration),
      purpose: clean(segment.purpose || (index === 0 ? 'hook' : 'explain'), 80),
      speakerCharacterId,
      speakerMode: turnSpeakerIds.length > 1 ? 'multi-speaker' : 'single-speaker',
      dialogueTurns,
      characterIds: boundCharacters,
      locationId: locationIds.has(safeId(segment.locationId))
        ? safeId(segment.locationId)
        : locations[0].id,
      dialogue,
      startState: stripTextDirections(clean(segment.startState || '', 900)),
      endState: stripTextDirections(clean(segment.endState || '', 900)),
      action: stripTextDirections(clean(segment.action || '', 1000)),
      shotType,
      camera: stripTextDirections(clean(segment.camera || '', 700)),
      onScreenLabels: normalizeLabels(segment.onScreenLabels, { dialogue, duration }),
      ambience: clean(segment.ambience || '', 500),
      soundEffects: Array.isArray(segment.soundEffects)
        ? segment.soundEffects.map((item) => clean(item, 180)).filter(Boolean).slice(0, 8)
        : [],
      music: clean(segment.music || '', 350),
      transition: clean(segment.transition || (index === 0 ? 'none' : 'hard cut'), 120),
      editing: {
        allowInternalCuts: Boolean(segment.editing?.allowInternalCuts),
        allowDissolves: Boolean(segment.editing?.allowDissolves),
        shotCount: clamp(Math.round(Number(segment.editing?.shotCount) || 1), 1, 3),
      },
    };
    cursor += duration;
    return normalized;
  });

  if (!segments.some((segment) => segment.dialogueTurns.length)) {
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
    directorialContract: normalizeDirectorialContract(value.directorialContract, {
      topic: context.topic,
      creativeBrief: context.creativeBrief,
      durationSeconds: Number(context.durationSeconds) || round(cursor),
      characters,
    }),
    segments,
    fullDialogue: segments.map((segment) => segment.dialogue).filter(Boolean).join(' '),
    source: clean(value.source || 'llm', 80),
    model: clean(value.model || '', 120),
  };
}

const ROLE_HINTS = [
  'coach', 'trainer', 'teacher', 'doctor', 'nurse', 'waiter', 'waitress',
  'barista', 'chef', 'manager', 'interviewer', 'parent', 'mother', 'father',
  'customer', 'patient', 'player', 'athlete', 'mechanic', 'pilot', 'firefighter',
];

const INTERPERSONAL_PATTERN = /\b(motivat(?:e|es|ing)|coach(?:es|ing)?|teach(?:es|ing)?|consult(?:s|ing)?|interview(?:s|ing)?|serve(?:s|ing)?|help(?:s|ing)?|hand(?:s|ing)?|give(?:s|ing)?|argu(?:e|es|ing)|hug(?:s|ging)?|shake hands|high[- ]five|team huddle|addresses? (?:his|her|the) team)\b/i;

function normalizeDirectorialContract(value, {
  topic,
  creativeBrief,
  durationSeconds,
  characters,
}) {
  const raw = value && typeof value === 'object' ? value : {};
  const premise = [
    topic,
    creativeBrief?.angle,
    creativeBrief?.hook,
    creativeBrief?.format,
    creativeBrief?.visualOpportunity,
    creativeBrief?.productionNotes,
  ].filter(Boolean).join(' ');

  const roleHints = ROLE_HINTS.filter((role) => new RegExp(`\\b${role}\\b`, 'i').test(premise));
  const rawIds = Array.isArray(raw.requiredVisibleCharacterIds)
    ? raw.requiredVisibleCharacterIds.map(safeId)
    : [];
  const roleIds = roleHints.flatMap((role) => {
    const character = characters.find((item) => (
      item.onScreen !== false
      && new RegExp(`\\b${role}\\b`, 'i').test([
        item.name,
        item.description,
        item.physicalTraits,
        item.wardrobe,
      ].filter(Boolean).join(' '))
    ));
    return character ? [character.id] : [];
  });
  const requiredVisibleCharacterIds = unique([...rawIds, ...roleIds])
    .filter((id) => characters.some((character) => character.id === id))
    .slice(0, 4);

  const defaultDeadline = Math.min(8, Math.max(1, Number(durationSeconds) * 0.2));
  const requiresInteraction = INTERPERSONAL_PATTERN.test(premise);

  return {
    primaryVisibleRole: clean(raw.primaryVisibleRole || roleHints[0] || '', 80),
    expectedRoleHints: roleHints,
    requiredVisibleCharacterIds,
    requiredInteraction: clean(
      raw.requiredInteraction || (requiresInteraction ? premise : ''),
      500,
    ),
    interactionMustBeginBySeconds: round(clamp(
      Number(raw.interactionMustBeginBySeconds) || defaultDeadline,
      0,
      Math.max(1, Number(durationSeconds) || defaultDeadline),
    )),
    allowMontage: Boolean(raw.allowMontage),
    brandPolicy: {
      mode: raw.brandPolicy?.mode === 'allow-list' ? 'allow-list' : 'unbranded',
      allowedBrands: Array.isArray(raw.brandPolicy?.allowedBrands)
        ? raw.brandPolicy.allowedBrands.map((item) => clean(item, 80)).filter(Boolean).slice(0, 8)
        : [],
    },
  };
}

export function validateProductionScriptPreflight(script, {
  topic = '',
  creativeBrief = null,
  durationSeconds = null,
} = {}) {
  const violations = [];
  const contract = script?.directorialContract || {};
  const characters = Array.isArray(script?.characters) ? script.characters : [];
  const segments = Array.isArray(script?.segments) ? script.segments : [];
  const duration = Number(durationSeconds) || Number(script?.generatedDurationSeconds) || 0;
  const premise = [
    topic,
    creativeBrief?.angle,
    creativeBrief?.hook,
    creativeBrief?.format,
    creativeBrief?.visualOpportunity,
    creativeBrief?.productionNotes,
  ].filter(Boolean).join(' ');

  for (const role of contract.expectedRoleHints || []) {
    const found = characters.some((character) => (
      character.onScreen !== false
      && new RegExp(`\\b${role}\\b`, 'i').test([
        character.name,
        character.description,
        character.physicalTraits,
        character.wardrobe,
      ].filter(Boolean).join(' '))
    ));
    if (!found) {
      violations.push(`The premise explicitly requires a visible ${role}, but no on-screen character is defined as that role.`);
    }
  }

  for (const id of contract.requiredVisibleCharacterIds || []) {
    const character = characters.find((item) => item.id === id);
    if (!character || character.onScreen === false) {
      violations.push(`Required visible character "${id}" is missing or off-screen.`);
    }
  }

  const deadline = Number(contract.interactionMustBeginBySeconds)
    || Math.min(8, Math.max(1, duration * 0.2));
  const earlySegments = segments.filter((segment) => Number(segment.start) < deadline + 0.001);

  if ((contract.requiredVisibleCharacterIds || []).length) {
    const roleEstablished = earlySegments.some((segment) => (
      (segment.characterIds || []).some((id) => contract.requiredVisibleCharacterIds.includes(id))
    ));
    if (!roleEstablished) {
      violations.push(`Required primary role is not visibly established before ${round(deadline)}s.`);
    }
  }

  if (contract.requiredInteraction) {
    const interpersonalEarly = earlySegments.some((segment) => (
      (segment.characterIds || []).length >= 2
      || INTERPERSONAL_PATTERN.test([segment.action, segment.purpose, segment.dialogue].filter(Boolean).join(' '))
    ));
    if (!interpersonalEarly) {
      violations.push(`Required human interaction does not begin before ${round(deadline)}s; do not open with solitary preparation B-roll.`);
    }
  }

  if (!contract.allowMontage) {
    const montageActs = segments.filter((segment) => (
      segment.editing?.allowInternalCuts
      || segment.editing?.allowDissolves
      || Number(segment.editing?.shotCount) > 1
    ));
    if (montageActs.length) {
      violations.push(`Internal montage/editing is not allowed, but act(s) ${montageActs.map((segment) => segment.index).join(', ')} request multiple shots or dissolves.`);
    }
  }

  if (contract.brandPolicy?.mode === 'unbranded') {
    const brandedWardrobe = characters.filter((character) => /\b(nike|adidas|puma|reebok|under armour|jordan|new balance|converse)\b/i.test(character.wardrobe || ''));
    if (brandedWardrobe.length) {
      violations.push(`Unbranded production policy conflicts with branded wardrobe for: ${brandedWardrobe.map((character) => character.id).join(', ')}.`);
    }
  }

  if (!premise.trim()) {
    violations.push('Production premise is empty.');
  }

  return {
    passed: violations.length === 0,
    violations,
    checkedAt: 'pre-generation',
  };
}

function normalizeDialogueTurns(segment, {
  characterIds,
  fallbackSpeakerId,
}) {
  const rawTurns = Array.isArray(segment.dialogueTurns)
    ? segment.dialogueTurns
    : [];

  const normalized = rawTurns
    .slice(0, 5)
    .map((turn, index) => {
      const candidate = safeId(turn?.speakerCharacterId || turn?.speakerId || '');
      const speakerCharacterId = characterIds.has(candidate)
        ? candidate
        : index === 0 && fallbackSpeakerId
          ? fallbackSpeakerId
          : null;
      const text = clean(turn?.text || turn?.dialogue || '', 650);
      if (!speakerCharacterId || !text) return null;
      return {
        turnIndex: index,
        speakerCharacterId,
        text,
        delivery: clean(turn?.delivery || '', 220),
        pauseAfterSeconds: clamp(
          Number(turn?.pauseAfterSeconds ?? turn?.pauseAfter ?? 0.16),
          0,
          0.8,
        ),
      };
    })
    .filter(Boolean);

  if (normalized.length) return normalized;

  const legacyText = clean(segment.dialogue || '', 1400);
  if (!legacyText || !fallbackSpeakerId) return [];

  return [{
    turnIndex: 0,
    speakerCharacterId: fallbackSpeakerId,
    text: legacyText,
    delivery: '',
    pauseAfterSeconds: 0,
  }];
}

function normalizeCharacters(items) {
  const list = Array.isArray(items) ? items : [];
  const usedVoices = new Set();
  const normalized = list.slice(0, 4).map((character, index) => {
    const requested = clean(character.voice?.presetId || '', 80);
    const canonical = RUNWAY_VOICE_BY_LOWER.get(requested.toLowerCase()) || null;
    let presetId = canonical;
    if (!presetId || usedVoices.has(presetId)) {
      presetId = FALLBACK_VOICES.find((preset) => !usedVoices.has(preset))
        || FALLBACK_VOICES[index % FALLBACK_VOICES.length];
    }
    usedVoices.add(presetId);

    return {
      id: safeId(character.id || `character-${index + 1}`),
      name: clean(character.name || `Character ${index + 1}`, 100),
      description: clean(character.description || '', 600),
      physicalTraits: clean(character.physicalTraits || '', 500),
      wardrobe: clean(character.wardrobe || '', 400),
      onScreen: character.onScreen !== false,
      voice: {
        presetId,
        description: clean(character.voice?.description || 'natural conversational voice', 250),
        delivery: clean(character.voice?.delivery || 'clear, warm, realistic', 250),
        languageCode: clean(character.voice?.languageCode || 'en', 12),
      },
    };
  }).filter((character) => character.description);

  if (!normalized.length) {
    normalized.push({
      id: 'narrator',
      name: 'Narrator',
      description: 'A believable adult presenter appropriate for the topic.',
      physicalTraits: 'Natural realistic appearance and proportions.',
      wardrobe: 'Simple neutral clothing appropriate for the location.',
      onScreen: true,
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

function fallbackProductionScript({ topic, audience, durationSeconds, creativeBrief = null }) {
  const duration = Math.max(12, Number(durationSeconds) || 30);
  const segmentCount = Math.max(2, Math.min(4, Math.ceil(duration / 10)));
  const each = Math.min(12, Math.max(5, duration / segmentCount));

  return {
    title: topic,
    synopsis: creativeBrief?.angle
      ? `${creativeBrief.angle} A concise photorealistic explainer about ${topic} for ${audience}.`
      : `A concise photorealistic explainer about ${topic} for ${audience}.`,
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
        ? (creativeBrief?.hook || `Here is the most important thing to understand about ${topic}.`)
        : index === segmentCount - 1
          ? `That is why ${topic} matters in practice, not just in theory.`
          : `The key is to connect one concrete mechanism in ${topic} to a result the viewer can recognize.`,
      action: 'The presenter demonstrates the point naturally in the environment.',
      camera: index % 2 ? 'medium documentary shot, subtle lateral movement' : 'medium close-up, gentle push-in',
      ambience: 'Natural room ambience appropriate to the location.',
      soundEffects: [],
      music: 'Subtle low-volume documentary music bed.',
      transition: index === 0 ? 'none' : 'clean hard cut',
      editing: {
        allowInternalCuts: false,
        allowDissolves: false,
        shotCount: 1,
      },
    })),
    source: 'template-provider',
  };
}

function safeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function distinctShotType(requested, previous, index) {
  const value = String(requested || '').toLowerCase().trim();
  const wanted = SHOT_TYPES.includes(value) ? value : SHOT_TYPES[index % SHOT_TYPES.length];
  if (wanted !== previous) return wanted;
  return SHOT_TYPES.find((type) => type !== previous && type !== wanted);
}

// Video models render requested labels as garbled, unverifiable text; drop any
// sentence that asks for written content. Labels go through onScreenLabels instead.
const TEXT_DIRECTION = /\b(label(?:s|ed|led|ing)?|caption(?:s|ed)?|callouts?|lettering|written|text|typography|title card|signage|reads?|reading)\b/i;

export function stripTextDirections(value) {
  const sentences = String(value || '').match(/[^.!?]+[.!?]*\s*/g) || [];
  return sentences.filter((sentence) => !TEXT_DIRECTION.test(sentence)).join('').trim();
}

const WEAK_SINGLE_LABELS = new Set([
  'angle', 'change', 'changes', 'effect', 'effects', 'part', 'parts', 'point',
  'points', 'process', 'result', 'results', 'step', 'steps', 'system', 'thing',
  'things', 'way', 'ways',
]);
const LABEL_STOPWORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

function normalizeLabels(labels, { dialogue, duration }) {
  if (!Array.isArray(labels)) return [];
  const spoken = ` ${tokenKey(dialogue)} `;
  return labels
    .map((label) => ({
      text: preserveLabelContext(
        improveLabelText(clean(label?.text || '', 24), dialogue),
        dialogue,
      ),
      atSeconds: round(clamp(Number(label?.atSeconds) || 0, 0, Math.max(0, duration - 1))),
      durationSeconds: round(clamp(Number(label?.durationSeconds) || 2.5, 1, 4)),
    }))
    // A label may only name something the narration says, so it cannot introduce new claims.
    .filter((label) => label.text && spoken.includes(` ${tokenKey(label.text)} `))
    .slice(0, 2);
}

function improveLabelText(text, dialogue) {
  const key = tokenKey(text);
  const parts = key.split(' ').filter(Boolean);
  if (parts.length !== 1 || !WEAK_SINGLE_LABELS.has(parts[0])) return text;

  const rawWords = String(dialogue || '').match(/[\p{L}\p{N}]+/gu) || [];
  const keys = rawWords.map((word) => tokenKey(word));
  const index = keys.indexOf(parts[0]);
  if (index < 0) return text;

  const next = keys[index + 1];
  const next2 = keys[index + 2];
  const previous = keys[index - 1];

  let candidate = '';
  if (next === 'of' && next2 && !LABEL_STOPWORDS.has(next2)) {
    candidate = [rawWords[index], rawWords[index + 1], rawWords[index + 2]].join(' ');
  } else if (next && !LABEL_STOPWORDS.has(next)) {
    candidate = [rawWords[index], rawWords[index + 1]].join(' ');
  } else if (previous && !LABEL_STOPWORDS.has(previous)) {
    candidate = [rawWords[index - 1], rawWords[index]].join(' ');
  }

  const improved = clean(candidate, 24);
  return improved || text;
}

const LABEL_CONTEXT_PREFIXES = [
  ['loss', 'of'],
  ['lack', 'of'],
  ['absence', 'of'],
  ['failure', 'of'],
  ['drop', 'in'],
  ['reduction', 'in'],
  ['without'],
  ['not'],
  ['no'],
  ['never'],
  ['reduced'],
  ['decreased'],
  ['decreasing'],
  ['increased'],
  ['increasing'],
];

function preserveLabelContext(text, dialogue) {
  const labelKeys = tokenKey(text).split(' ').filter(Boolean);
  if (!labelKeys.length) return text;

  const rawWords = String(dialogue || '').match(/[\p{L}\p{N}]+/gu) || [];
  const keys = rawWords.map((word) => tokenKey(word));

  for (let start = 0; start <= keys.length - labelKeys.length; start += 1) {
    if (!labelKeys.every((key, offset) => keys[start + offset] === key)) continue;

    for (const prefix of LABEL_CONTEXT_PREFIXES) {
      const prefixStart = start - prefix.length;
      if (prefixStart < 0) continue;
      const matches = prefix.every((key, offset) => keys[prefixStart + offset] === key);
      if (!matches) continue;

      const candidate = rawWords
        .slice(prefixStart, start + labelKeys.length)
        .join(' ');
      if (candidate.length <= 24) return candidate;
    }
  }

  return text;
}

function tokenKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
