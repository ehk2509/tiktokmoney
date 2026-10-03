const META_LANGUAGE_PATTERNS = [
  /a strong (?:short-form )?explanation should/i,
  /the viewer should/i,
  /give one concrete example/i,
  /explain the mechanism first/i,
  /the core idea (?:is|should)/i,
  /this script should/i,
];

export function evaluateAudiovisualPublishability({
  productionScript,
  scenes = [],
  subtitles = null,
  render = null,
} = {}) {
  const blockers = [];
  const warnings = [];

  const dialogue = productionScript?.fullDialogue || '';
  for (const pattern of META_LANGUAGE_PATTERNS) {
    if (pattern.test(dialogue)) {
      blockers.push({
        code: 'script-meta-language',
        message: `Production dialogue contains authoring/meta language matching ${pattern}.`,
      });
      break;
    }
  }

  if (!dialogue.trim()) {
    blockers.push({
      code: 'dialogue-missing',
      message: 'Production script contains no spoken dialogue.',
    });
  }

  const missingAssets = scenes.filter((scene) => !scene.asset?.localPath);
  if (missingAssets.length) {
    blockers.push({
      code: 'scene-assets-missing',
      message: `Missing generated audiovisual assets for scene(s): ${missingAssets.map((scene) => scene.index).join(', ')}.`,
    });
  }

  const failedQc = scenes.filter((scene) => {
    const history = scene.visualQcHistory || [];
    return history.length && history.at(-1)?.passed === false;
  });
  if (failedQc.length) {
    blockers.push({
      code: 'scene-qc-failed',
      message: `Audiovisual QC did not pass for scene(s): ${failedQc.map((scene) => scene.index).join(', ')}.`,
    });
  }

  const failedDialogue = scenes.filter((scene) => scene.dialogueVerification?.passed === false);
  if (failedDialogue.length) {
    blockers.push({
      code: 'dialogue-fidelity',
      message: `Generated speech did not match the screenplay for scene(s): ${failedDialogue.map((scene) => scene.index).join(', ')}.`,
    });
  }

  const failedLipSync = scenes.filter((scene) => scene.lipSyncQc?.passed === false);
  if (failedLipSync.length) {
    blockers.push({
      code: 'lip-sync',
      message: `Visual speech timing did not pass for scene(s): ${failedLipSync.map((scene) => scene.index).join(', ')}.`,
    });
  }

  const failedDeepLipSync = scenes.filter((scene) => scene.deepLipSyncQc?.passed === false);
  if (failedDeepLipSync.length) {
    blockers.push({
      code: 'deep-lip-sync',
      message: `Deep audiovisual synchronization did not pass for scene(s): ${failedDeepLipSync.map((scene) => scene.index).join(', ')}.`,
    });
  }

  const failedPhonemeViseme = scenes.filter((scene) => scene.phonemeVisemeQc?.passed === false);
  if (failedPhonemeViseme.length) {
    blockers.push({
      code: 'phoneme-viseme',
      message: `Phoneme/viseme alignment did not pass for scene(s): ${failedPhonemeViseme.map((scene) => scene.index).join(', ')}.`,
    });
  }

  const failedSpeakerTurn = scenes.filter((scene) => scene.speakerTurnQc?.passed === false);
  if (failedSpeakerTurn.length) {
    blockers.push({
      code: 'speaker-turn',
      message: `Multi-speaker attribution/turn-taking did not pass for scene(s): ${failedSpeakerTurn.map((scene) => scene.index).join(', ')}.`,
    });
  }

  const failedVisualFactual = scenes.filter((scene) => scene.visualFactualQc?.passed === false);
  if (failedVisualFactual.length) {
    blockers.push({
      code: 'visual-factual-consistency',
      message: `Generated visuals contradicted the scene's factual contract for scene(s): ${failedVisualFactual.map((scene) => scene.index).join(', ')}.`,
    });
  }

  const failedEditorialVariety = scenes.filter((scene) => scene.editorialVarietyQc?.passed === false);
  if (failedEditorialVariety.length) {
    blockers.push({
      code: 'editorial-variety',
      message: `Generated framing did not create the required visual change for scene(s): ${failedEditorialVariety.map((scene) => scene.index).join(', ')}.`,
    });
  }

  const failedProductionIntegrity = scenes.filter((scene) => scene.productionIntegrityQc?.passed === false);
  if (failedProductionIntegrity.length) {
    blockers.push({
      code: 'production-integrity',
      message: `Generated acts violated role, interaction, single-shot, or brand contracts for scene(s): ${failedProductionIntegrity.map((scene) => scene.index).join(', ')}.`,
    });
  }

  if (subtitles?.enabled && subtitles.layout?.passed === false) {
    blockers.push({
      code: 'subtitle-layout',
      message: 'Subtitle layout exceeds configured safe-area constraints.',
      violations: subtitles.layout.violations,
    });
  }

  if (render?.audioQuality?.output && render.audioQuality.output.passed === false) {
    blockers.push({
      code: 'final-audio-quality',
      message: 'Final rendered audio did not pass loudness/silence/true-peak validation.',
      issues: render.audioQuality.output.issues,
    });
  }

  const locationIds = new Set(
    (productionScript?.segments || []).map((segment) => segment.locationId).filter(Boolean),
  );
  if ((productionScript?.segments?.length || 0) >= 3 && locationIds.size < 2) {
    warnings.push({
      code: 'low-visual-variety',
      message: 'Three or more acts use only one location; consider a second related location or distinct visual zone.',
    });
  }

  const qcWarningScenes = scenes.filter((scene) => (
    scene.visualFactualQc?.warnings?.length
    || scene.editorialVarietyQc?.warnings?.length
    || scene.productionIntegrityQc?.warnings?.length
  ));
  if (qcWarningScenes.length) {
    warnings.push({
      code: 'qc-warnings',
      message: `QC passed with diagnostic warnings for scene(s): ${qcWarningScenes.map((scene) => scene.index).join(', ')}.`,
    });
  }

  const internalEdits = (productionScript?.segments || []).filter(
    (segment) => segment.editing?.allowInternalCuts || segment.editing?.allowDissolves,
  );
  if (internalEdits.length) {
    warnings.push({
      code: 'internal-editing-enabled',
      message: `Internal editing is enabled for act(s): ${internalEdits.map((segment) => segment.index).join(', ')}.`,
    });
  }

  return {
    passed: blockers.length === 0,
    blockers,
    warnings,
  };
}
