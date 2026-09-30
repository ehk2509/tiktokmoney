const HOOKS = [
  (topic) => `Most people get ${topic} wrong. Here is the part nobody explains.`,
  (topic) => `There is a surprising reason ${topic} matters more than it looks.`,
  (topic) => `If you only remember one thing about ${topic}, make it this.`,
];

export class ScriptGenerator {
  constructor({ llm }) {
    this.llm = llm;
  }

  async generate({ topic, audience = 'curious adults', durationSeconds = 35 }) {
    if (this.llm?.generateStructuredScript) {
      return this.llm.generateStructuredScript({ topic, audience, durationSeconds });
    }

    const hook = HOOKS[Math.abs(hashString(topic)) % HOOKS.length](topic);
    const body = [
      `Start with the simplest useful definition of ${topic}.`,
      'Then explain one counter-intuitive detail with a concrete example.',
      'Connect that detail to why the viewer should care today.',
    ];
    const payoff = `The takeaway: ${topic} becomes easier to understand when you focus on the mechanism, not just the headline.`;

    return {
      topic,
      audience,
      durationSeconds,
      hook,
      body,
      payoff,
      cta: 'Follow for the next explanation.',
      source: 'template-fallback',
    };
  }
}

function hashString(value) {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return hash;
}
