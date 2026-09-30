export function buildRealismSceneSpec({ topic, narration, purpose, index }) {
  const context = narration.trim().replace(/\s+/g, ' ');
  const shot = chooseShot(index, purpose);

  return {
    mode: 'photorealistic',
    aspectRatio: '9:16',
    continuityGroup: 'main-story',
    shot,
    referencePrompt: [
      'Photorealistic documentary still frame.',
      'Vertical 9:16 composition.',
      `Topic context: ${topic}.`,
      `Scene: ${context}`,
      `Camera: ${shot}.`,
      'Natural real-world lighting and believable depth of field.',
      'Physically plausible environment, materials, anatomy, hands, faces and proportions.',
      'Natural skin texture when people are present.',
      'Looks captured by a real camera, not CGI, illustration, 3D render or synthetic stock art.',
      'No text, captions, logos, watermarks or UI elements.',
    ].join(' '),
    motionPrompt: [
      'Continuous, seamless photorealistic shot.',
      `Scene action: ${context}`,
      `Camera: ${shot} with subtle natural movement.`,
      'Realistic physics and natural human or object motion.',
      'Preserve subject identity, clothing, environment and geometry throughout the shot.',
      'No cuts, morphing, warping, duplicated limbs, sudden camera jumps, text, logos or watermarks.',
      'Documentary realism, restrained cinematic motion.',
    ].join(' '),
  };
}

function chooseShot(index, purpose) {
  if (purpose === 'hook') return 'medium close-up or strong establishing shot, 50mm documentary lens feel';
  if (purpose === 'cta') return 'calm medium shot, stable composition, subtle push-in';
  return index % 2 === 0
    ? 'medium documentary shot, eye-level camera, subtle handheld movement'
    : 'wide-to-medium environmental shot, slow controlled dolly movement';
}
