import { buildRealismSceneSpec } from './realismSceneSpec.js';

function seconds(value) {
  return Math.max(0.8, Math.round(value * 100) / 100);
}

export function planScenes(script, storyBible = null) {
  const parts = [script.hook, ...script.body, script.payoff, script.cta].filter(Boolean);
  const totalWeight = parts.reduce((sum, text) => sum + text.length, 0) || 1;
  let cursor = 0;

  return parts.map((text, index) => {
    const rawDuration = (text.length / totalWeight) * script.durationSeconds;
    const duration = seconds(rawDuration);
    const purpose = index === 0 ? 'hook' : index === parts.length - 1 ? 'cta' : 'explain';
    const binding = storyBible?.sceneBindings?.find((item) => item.sceneIndex === index) || null;
    const scene = {
      index,
      start: Math.round(cursor * 100) / 100,
      duration,
      purpose,
      narration: text,
      overlay: makeOverlay(text),
      visualPrompt: makeVisualPrompt(script.topic, text, index),
      continuity: binding ? {
        characterIds: binding.characterIds || [],
        locationId: binding.locationId || null,
      } : {
        characterIds: [],
        locationId: null,
      },
      realism: buildRealismSceneSpec({
        topic: script.topic,
        narration: text,
        purpose,
        index,
      }),
      transition: index === 0 ? 'none' : 'hard-cut',
    };
    cursor += duration;
    return scene;
  });
}

function makeOverlay(text) {
  const words = text.replace(/[^\p{L}\p{N}\s'-]/gu, '').split(/\s+/).filter(Boolean);
  return words.slice(0, 7).join(' ').toUpperCase();
}

function makeVisualPrompt(topic, text, index) {
  if (index === 0) return `High-impact vertical opener illustrating ${topic}, cinematic, clean composition`;
  return `Vertical explanatory B-roll for ${topic}: ${text.slice(0, 120)}`;
}
