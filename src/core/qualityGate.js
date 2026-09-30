export function evaluateProject({ script, scenes }) {
  const checks = {
    hasHook: Boolean(script.hook && script.hook.length >= 20),
    hasPayoff: Boolean(script.payoff),
    enoughScenes: scenes.length >= 4,
    verticalSafeText: scenes.every((scene) => scene.overlay.length <= 70),
    durationReasonable: script.durationSeconds >= 15 && script.durationSeconds <= 90,
  };

  const passed = Object.values(checks).filter(Boolean).length;
  const score = Math.round((passed / Object.keys(checks).length) * 100);

  return {
    score,
    passed: score >= 80,
    checks,
  };
}
