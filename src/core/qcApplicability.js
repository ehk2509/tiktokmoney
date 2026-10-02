function characterMap(productionScript) {
  return new Map((productionScript?.characters || []).map((character) => [character.id, character]));
}

function speakingTurns(segment, asset) {
  if (Array.isArray(asset?.dialogueTrack?.turns) && asset.dialogueTrack.turns.length) {
    return asset.dialogueTrack.turns;
  }
  if (Array.isArray(segment?.dialogueTurns) && segment.dialogueTurns.length) {
    return segment.dialogueTurns;
  }
  return segment?.speakerCharacterId
    ? [{ speakerCharacterId: segment.speakerCharacterId, text: segment.dialogue || '' }]
    : [];
}

function contract(applicable, reason = null, details = {}) {
  return { applicable: Boolean(applicable), reason: applicable ? null : reason, ...details };
}

/**
 * Resolve which QC checks are semantically valid for one generated act.
 *
 * A configured checker is not automatically applicable. In particular, visual
 * speech checks require every utterance represented by their segment-level
 * transcript to belong to a visible speaker. This prevents voiceover and mixed
 * voiceover/on-camera acts from being rejected for having no mouth to inspect.
 */
export function resolveQcApplicability({ segment, productionScript, asset } = {}) {
  const characters = characterMap(productionScript);
  const turns = speakingTurns(segment, asset);
  const speakingCharacterIds = [...new Set(
    turns.map((turn) => turn.speakerCharacterId).filter(Boolean),
  )];
  const speakingCharacters = speakingCharacterIds
    .map((id) => characters.get(id))
    .filter(Boolean);
  const unknownSpeakerIds = speakingCharacterIds.filter((id) => !characters.has(id));
  const visibleSpeakerIds = speakingCharacters
    .filter((character) => character.onScreen !== false)
    .map((character) => character.id);
  const offScreenSpeakerIds = speakingCharacters
    .filter((character) => character.onScreen === false)
    .map((character) => character.id);
  const hasDialogue = Boolean(
    String(segment?.dialogue || '').trim()
      || turns.some((turn) => String(turn.text || turn.dialogue || '').trim()),
  );
  const allSpeakingCharactersKnown = unknownSpeakerIds.length === 0;
  const allSpeakersVisible = speakingCharacterIds.length > 0
    && allSpeakingCharactersKnown
    && offScreenSpeakerIds.length === 0;
  const visibleSpeakerCount = new Set(visibleSpeakerIds).size;
  const segmentCharacterIds = Array.isArray(segment?.characterIds)
    ? segment.characterIds
    : [];
  const visibleCharacterIds = segmentCharacterIds.filter((id) => {
    const character = characters.get(id);
    return character && character.onScreen !== false;
  });
  const hasVisibleHuman = visibleCharacterIds.length > 0
    || visibleSpeakerIds.length > 0;

  const visualSpeechReason = !hasDialogue
    ? 'no-dialogue'
    : speakingCharacterIds.length === 0
      ? 'no-speaker'
      : !allSpeakingCharactersKnown
        ? 'unknown-speaker'
        : offScreenSpeakerIds.length > 0
          ? (visibleSpeakerIds.length > 0 ? 'mixed-visible-and-offscreen-speech' : 'offscreen-voiceover')
          : null;

  return {
    context: {
      hasDialogue,
      speakingCharacterIds,
      visibleSpeakerIds,
      offScreenSpeakerIds,
      unknownSpeakerIds,
      visibleCharacterIds,
    },
    realism: contract(true),
    dialogue: contract(hasDialogue, 'no-dialogue'),
    lipSync: contract(allSpeakersVisible && hasDialogue, visualSpeechReason),
    deepLipSync: contract(allSpeakersVisible && hasDialogue, visualSpeechReason),
    phonemeViseme: contract(allSpeakersVisible && hasDialogue, visualSpeechReason),
    speakerTurn: contract(
      hasDialogue && visibleSpeakerCount > 1 && allSpeakersVisible,
      !hasDialogue
        ? 'no-dialogue'
        : !allSpeakersVisible
          ? visualSpeechReason
          : 'fewer-than-two-visible-speakers',
      { visibleSpeakerCount },
    ),
    poseMotion: contract(hasVisibleHuman, 'no-visible-human'),
  };
}
