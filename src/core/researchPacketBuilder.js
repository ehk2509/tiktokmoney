export function buildResearchPacket({
  topic,
  cluster = null,
  signals = [],
  maxSources = 8,
} = {}) {
  const evidence = dedupeSignals(
    cluster?.signals?.length ? cluster.signals : signals,
  )
    .sort((a, b) => signalPriority(b) - signalPriority(a))
    .slice(0, maxSources)
    .map((signal, index) => ({
      id: `source-${index + 1}`,
      source: signal.source,
      title: clean(signal.title || signal.topic, 280),
      url: signal.url || null,
      snippet: clean(signal.snippet, 700),
      publishedAt: signal.publishedAt || null,
      observedAt: signal.observedAt || null,
      strength: round(signal.strength),
      engagement: signal.engagement || null,
      sourceMetrics: signal.sourceMetrics || {},
    }));

  const sourceNames = [...new Set(evidence.map((item) => item.source))];

  return {
    topic: clean(topic || cluster?.topic || '', 240),
    generatedAt: new Date().toISOString(),
    clusterKey: cluster?.clusterKey || null,
    sourceCount: sourceNames.length,
    evidenceCount: evidence.length,
    sourceNames,
    evidence,
    provenancePolicy: [
      'Treat source titles/snippets as evidence leads, not automatically verified facts.',
      'Do not invent statistics or claims that are absent from the evidence.',
      'When sources conflict or evidence is thin, phrase the creative around the observable trend rather than asserting disputed details.',
    ],
  };
}

function dedupeSignals(signals) {
  const seen = new Set();
  const output = [];
  for (const signal of Array.isArray(signals) ? signals : []) {
    const key = signal.url || `${signal.source}:${normalize(signal.title || signal.topic)}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(signal);
  }
  return output;
}

function signalPriority(signal) {
  const freshness = signal.publishedAt
    ? Math.max(0, 100 - ((Date.now() - Date.parse(signal.publishedAt)) / 3600000) * 2)
    : 40;
  return (Number(signal.strength) || 0) * 0.7 + freshness * 0.3;
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function clean(value, max = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
