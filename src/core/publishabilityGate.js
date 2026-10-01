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
