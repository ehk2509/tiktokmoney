export class OpenAICompatibleLlmProvider {
  constructor({
    apiKey = process.env.OPENAI_API_KEY,
    baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    model = process.env.LLM_MODEL || 'gpt-5.6-luna',
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for the OpenAI-compatible provider');
    if (!fetchImpl) throw new Error('fetch is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.fetch = fetchImpl;
  }

  async generateStructuredScript({ topic, audience, durationSeconds }) {
    const prompt = [
      'Create a high-retention short-form vertical video script.',
      `Topic: ${topic}`,
      `Audience: ${audience}`,
      `Target duration: ${durationSeconds} seconds`,
      '',
      'Return only JSON with exactly these fields:',
      '{"hook":"string","body":["string","string","string"],"payoff":"string","cta":"string"}',
      '',
      'Requirements:',
      '- Hook must create curiosity immediately without misleading clickbait.',
      '- Use short spoken sentences.',
      '- Body should progress logically and avoid repeating the hook.',
      '- Payoff must resolve the curiosity introduced by the hook.',
      '- Do not invent factual claims that were not supplied in the topic.',
      '- CTA should be short and optional-sounding.',
    ].join('\n');

    const parsed = await this.generateJson({
      system: 'You are a short-form video creative director. Produce concise, structured JSON only.',
      prompt,
      temperature: 0.7,
    });

    validateScript(parsed);

    return {
      topic,
      audience,
      durationSeconds,
      hook: parsed.hook.trim(),
      body: parsed.body.map((part) => part.trim()).filter(Boolean),
      payoff: parsed.payoff.trim(),
      cta: parsed.cta?.trim() || '',
      source: 'openai-compatible',
      model: this.model,
    };
  }

  async generateProductionScript({ topic, audience, durationSeconds }) {
    const prompt = [
      'Write a complete production screenplay for a photorealistic vertical short-form video.',
      `Topic: ${topic}`,
      `Audience: ${audience}`,
      `Target total duration: ${durationSeconds} seconds`,
      '',
      'The result will be sent to a specialized audiovisual video model that generates picture, spoken dialogue, ambience and sound effects together.',
      'Return JSON only with this shape:',
      '{',
      '  "title": "string",',
      '  "synopsis": "string",',
      '  "characters": [{',
      '    "id": "presenter", "name": "string", "description": "string",',
      '    "physicalTraits": "string", "wardrobe": "string",',
      '    "voice": {"presetId":"Bernard","description":"string","delivery":"string","languageCode":"en"}',
      '  }],',
      '  "locations": [{',
      '    "id":"location-main","name":"string","description":"string","lighting":"string",',
      '    "fixedElements":["string"]',
      '  }],',
      '  "visualStyle": {"description":"string","cameraRules":"string","lightingRules":"string"},',
      '  "audioDirection": {"mix":"string","musicPolicy":"string"},',
      '  "segments": [{',
      '    "durationSeconds": 8, "purpose":"hook|explain|payoff|cta",',
      '    "speakerCharacterId":"presenter", "characterIds":["presenter"],',
      '    "locationId":"location-main",',
      '    "dialogue":"BACKWARD-COMPATIBLE COMBINED DIALOGUE",',
      '    "dialogueTurns":[{',
      '      "speakerCharacterId":"presenter",',
      '      "text":"EXACT WORDS SPOKEN BY THIS CHARACTER",',
      '      "delivery":"brief performance direction",',
      '      "pauseAfterSeconds":0.16',
      '    }],',
      '    "action":"detailed physical action",',
      '    "camera":"shot size, lens feel and camera movement",',
      '    "ambience":"environment sound description",',
      '    "soundEffects":["specific sound"],',
      '    "music":"music direction",',
      '    "transition":"transition to next act",',
      '    "editing":{"allowInternalCuts":false,"allowDissolves":false,"shotCount":1}',
      '  }]',
      '}',
      '',
      'Strict rules:',
      '- Write the ACTUAL final spoken script. Never describe how a script should be written.',
      '- Dialogue must be useful, topic-specific and natural when spoken aloud.',
      '- No meta-language such as "a strong explanation should" or "the viewer should".',
      '- Keep each segment between 4 and 15 seconds so exact dialogue audio can be used as a model reference.',
      '- Prefer 3-5 segments for a 30-45 second video.',
      '- A segment may contain 1-3 speaking characters and at most 5 ordered dialogueTurns.',
      '- Use dialogueTurns for multi-speaker exchanges. Each turn must name a valid character id and contain exact spoken words.',
      '- dialogue is only the combined backward-compatible text; dialogueTurns are authoritative for speaker ownership.',
      '- Do not overlap speakers in this version. Use pauseAfterSeconds (usually 0.08-0.30) for natural turn-taking.',
      '- Give recurring speakers stable, distinct voice presets and delivery descriptions.',
      '- Use valid Runway preset voice IDs such as Bernard, Maya, Arjun, Serene, Eleanor, Vincent, Sandra, Kylie, James, Rina, Rachel, or Mark. Do not invent voice IDs.',
      '- Keep the combined spoken duration of all dialogueTurns comfortably inside the segment duration; leave room for natural pauses.',
      '- Prefer multi-speaker dialogue only when it improves the creative: debate, interviewer/expert, customer/expert, skeptic/explainer, friend/friend, or reaction format.',
      '- For dialogue acts, blocking must make the active speaker visually unambiguous while listeners react silently.',
      '- Character descriptions must be stable enough for visual continuity: apparent age, face, hair, body type and wardrobe.',
      '- Locations must include fixed physical anchors and exact lighting.',
      '- Camera/action descriptions must be physically plausible and filmable.',
      '- Default each segment to ONE continuous shot: allowInternalCuts=false, allowDissolves=false, shotCount=1.',
      '- Only enable internal cuts when a montage is narratively necessary; never use unexplained dissolves, crossfades, ghosting or double exposure.',
      '- For videos longer than 25 seconds, prefer 2-3 related locations or clearly different zones/angles when this improves visual variety without breaking continuity.',
      '- Ambience and sound effects must match what is visible.',
      '- Music must stay under dialogue.',
      '- The hook must immediately communicate tension or curiosity.',
      '- The final segment must resolve the promise made by the hook.',
      '- Do not invent factual claims beyond the supplied topic/context.',
    ].join('\n');

    const parsed = await this.generateJson({
      system: 'You are a film screenwriter, director and sound designer creating executable audiovisual production scripts. Return JSON only.',
      prompt,
      temperature: 0.55,
    });

    return {
      ...parsed,
      source: 'openai-compatible',
      model: this.model,
    };
  }

  async generateStoryBible({ script }) {
    const parts = [script.hook, ...(script.body || []), script.payoff, script.cta].filter(Boolean);
    const prompt = [
      'Build a strict continuity bible for a photorealistic short-form video.',
      `Topic: ${script.topic}`,
      '',
      'Narration scenes in order:',
      ...parts.map((part, index) => `${index}: ${part}`),
      '',
      'Return JSON with:',
      '{',
      '  "characters": [{"id":"pilot","name":"...","description":"...","wardrobe":"...","physicalTraits":"..."}],',
      '  "locations": [{"id":"cockpit","name":"...","description":"...","lighting":"...","fixedElements":["..."]}],',
      '  "visualStyle": {"description":"...","cameraRules":"...","lightingRules":"..."},',
      '  "sceneBindings": [{"sceneIndex":0,"characterIds":["pilot"],"locationId":"cockpit"}]',
      '}',
      '',
      'Rules:',
      '- Keep only recurring visual entities that help continuity.',
      '- Maximum 3 characters and 3 locations.',
      '- Use stable concrete descriptions; never describe a real person unless the script explicitly requires one.',
      '- Wardrobe and physical traits must remain unchanged across scenes.',
      '- Locations must list fixed visual anchors that should not move between shots.',
      '- Camera rules should describe one consistent documentary lens/look.',
      '- Every narration scene must have exactly one location binding.',
      '- Only bind a character to scenes where that character is visually useful.',
      '- Do not invent factual claims; this is visual staging only.',
    ].join('\n');

    const parsed = await this.generateJson({
      system: 'You are a continuity supervisor for photorealistic film production. Return JSON only.',
      prompt,
      temperature: 0.2,
    });

    return {
      ...parsed,
      source: 'openai-compatible',
      model: this.model,
    };
  }

  async generateJson({ system, prompt, temperature = 0 }) {
    let response = await this.requestCompletion({ system, prompt, temperature });
    let payload = await response.json().catch(() => null);

    // Reasoning models (e.g. gpt-5.x) reject non-default temperature; retry once without it.
    if (!response.ok && this.supportsTemperature !== false && /temperature/i.test(payload?.error?.message || '')) {
      this.supportsTemperature = false;
      response = await this.requestCompletion({ system, prompt, temperature });
      payload = await response.json().catch(() => null);
    }

    assertOk(response, payload, 'LLM');
    const raw = payload?.choices?.[0]?.message?.content;
    if (!raw) throw new Error('LLM response did not contain message content');

    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      throw new Error(`LLM returned invalid JSON: ${error.message}`);
    }
  }

  requestCompletion({ system, prompt, temperature }) {
    return this.fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        ...(this.supportsTemperature === false ? {} : { temperature }),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    });
  }
}

function assertOk(response, payload, label) {
  if (payload === null) throw new Error(`${label} returned a non-JSON response`);
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || response.statusText || 'request failed';
    throw new Error(`${label} request failed (${response.status}): ${detail}`);
  }
}

function validateScript(value) {
  if (!value || typeof value !== 'object') throw new Error('LLM script must be an object');
  if (typeof value.hook !== 'string' || value.hook.trim().length < 10) {
    throw new Error('LLM script requires a meaningful hook');
  }
  if (!Array.isArray(value.body) || value.body.length < 2 || value.body.some((part) => typeof part !== 'string')) {
    throw new Error('LLM script body must contain at least two strings');
  }
  if (typeof value.payoff !== 'string' || !value.payoff.trim()) {
    throw new Error('LLM script requires a payoff');
  }
  if (value.cta != null && typeof value.cta !== 'string') {
    throw new Error('LLM script CTA must be a string');
  }
}
