export class TemplateLlmProvider {
  async generateStructuredScript({ topic, audience, durationSeconds }) {
    return {
      topic,
      audience,
      durationSeconds,
      hook: `You have probably heard about ${topic}, but the most interesting part is usually left out.`,
      body: [
        `${topic} becomes much easier to understand once you separate the headline from the underlying mechanism.`,
        'A strong short-form explanation should give one concrete example instead of stacking vague claims.',
        'That example should then connect back to something the viewer can recognize or use immediately.',
      ],
      payoff: `That is the core idea behind ${topic}: explain the mechanism first, then the consequence.`,
      cta: 'Save this and follow for more fast explanations.',
      source: 'template-provider',
    };
  }

  async generateStoryBible({ script }) {
    const parts = [script.hook, ...(script.body || []), script.payoff, script.cta].filter(Boolean);
    return {
      characters: [],
      locations: [{
        id: 'location-main',
        name: 'Primary environment',
        description: `A believable real-world environment appropriate for ${script.topic}.`,
        lighting: 'Natural motivated lighting with stable color temperature.',
        fixedElements: ['Stable architecture and object placement'],
      }],
      visualStyle: {
        description: 'Photorealistic documentary footage with real-camera texture.',
        cameraRules: 'Eye-level 35mm-50mm documentary lens feel with restrained camera movement.',
        lightingRules: 'Natural motivated lighting, no CGI glow.',
      },
      sceneBindings: parts.map((_, sceneIndex) => ({
        sceneIndex,
        characterIds: [],
        locationId: 'location-main',
      })),
      source: 'template-provider',
    };
  }
}

export class SampleTrendProvider {
  async list() {
    return [
      {
        id: 'trend-ai-video', topic: 'AI-generated video', source: 'sample',
        velocity: 88, acceleration: 84, audienceFit: 90, novelty: 72,
        contentPotential: 94, monetization: 86, feasibility: 82,
        saturation: 68, copyrightRisk: 12, misinformationRisk: 18,
      },
      {
        id: 'trend-space', topic: 'new space discoveries', source: 'sample',
        velocity: 74, acceleration: 70, audienceFit: 86, novelty: 80,
        contentPotential: 91, monetization: 62, feasibility: 88,
        saturation: 35, copyrightRisk: 5, misinformationRisk: 28,
      },
      {
        id: 'trend-meme', topic: 'fast-moving meme format', source: 'sample',
        velocity: 96, acceleration: 92, audienceFit: 55, novelty: 40,
        contentPotential: 50, monetization: 18, feasibility: 96,
        saturation: 92, copyrightRisk: 48, misinformationRisk: 8,
      },
    ];
  }
}
