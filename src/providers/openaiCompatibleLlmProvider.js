export class OpenAICompatibleLlmProvider {
  constructor({
    apiKey = process.env.OPENAI_API_KEY,
    baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    model = process.env.LLM_MODEL || 'gpt-5.6-luna',
    judgeModel = process.env.CREATIVE_JUDGE_MODEL || model,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for the OpenAI-compatible provider');
    if (!fetchImpl) throw new Error('fetch is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.judgeModel = judgeModel;
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

  async generateCreativeCandidates({
    topic,
    audience,
    durationSeconds,
    count = 5,
    researchPacket = null,
    variantIndex = 0,
  }) {
    const prompt = [
      'Generate DISTINCT creative concepts for a high-retention photorealistic vertical short-form video.',
      `Topic: ${topic}`,
      `Audience: ${audience}`,
      `Target duration: ${durationSeconds} seconds`,
      `Return exactly ${count} candidates.`,
      variantIndex
        ? `This is production variant batch ${variantIndex + 1}; deliberately explore angles different from a previous batch for the same opportunity.`
        : '',
      researchPacket?.evidence?.length
        ? `SOURCE-GROUNDED RESEARCH PACKET: ${JSON.stringify(researchPacket)}`
        : 'No external research packet is available; avoid specific factual claims that require verification.',
      '',
      'Return JSON:',
      '{',
      '  "candidates": [{',
      '    "id": "short-stable-id",',
      '    "angle": "the specific creative thesis",',
      '    "hook": "exact opening line",',
      '    "format": "direct explainer|micro-story|dialogue|debate|demonstration|before-after|other",',
      '    "emotionalDriver": "curiosity|surprise|tension|utility|identification|other",',
      '    "retentionDevice": "what creates an open loop or reason to continue",',
      '    "payoff": "how the video resolves the hook",',
      '    "visualOpportunity": "why this concept can produce strong realistic visuals",',
      '    "dialogueStyle": "spoken performance style",',
      '    "monetizationFit": "why the concept can attract valuable/repeatable audience attention",',
      '    "productionNotes": "important production constraints",',
      '    "riskNotes": ["factual/copyright/safety risk if any"]',
      '  }]',
      '}',
      '',
      'Rules:',
      '- Each candidate must use a materially different angle or format, not cosmetic hook rewrites.',
      '- The hook must be specific and understandable in the first seconds.',
      '- Never use deceptive clickbait, fake urgency, fabricated statistics or unsupported factual claims.',
      '- Prefer ideas that can be executed with 1-3 recurring characters and realistic locations.',
      '- Include at least one dialogue/conversation concept when it naturally fits the topic.',
      '- Include at least one strongly visual concept when the topic permits it.',
      '- Do not make the candidates depend on celebrities, copyrighted footage, impossible stunts or expensive locations.',
      '- The payoff must genuinely resolve the promise of the hook.',
      '- When a research packet is present, factual premises must stay within its evidence. Do not invent numbers, dates, quotes or causal claims.',
      '- Treat source snippets as evidence leads, not proof when they conflict or are incomplete.',
    ].join('\n');

    const parsed = await this.generateJson({
      system: 'You are a short-form creative strategist generating diverse executable concepts. Return JSON only.',
      prompt,
      temperature: 0.85,
    });

    return {
      candidates: Array.isArray(parsed?.candidates) ? parsed.candidates : [],
      source: 'openai-compatible',
      model: this.model,
    };
  }

  async judgeCreativeCandidates({
    topic,
    audience,
    durationSeconds,
    candidates,
    researchPacket = null,
    variantIndex = 0,
  }) {
    const prompt = [
      'Independently judge short-form video creative concepts before any expensive video generation.',
      variantIndex ? `This is production variant batch ${variantIndex + 1} for the same opportunity.` : '',
      `Topic: ${topic}`,
      `Audience: ${audience}`,
      `Target duration: ${durationSeconds} seconds`,
      '',
      'Candidates:',
      JSON.stringify(candidates),
      researchPacket?.evidence?.length
        ? `Research evidence available to verify candidate premises: ${JSON.stringify(researchPacket)}`
        : 'No external research evidence is available.',
      '',
      'Return JSON:',
      '{',
      '  "judgments": [{',
      '    "candidateId": "exact candidate id",',
      '    "scores": {',
      '      "hookStrength": 0,',
      '      "retentionPotential": 0,',
      '      "clarity": 0,',
      '      "novelty": 0,',
      '      "productionFeasibility": 0,',
      '      "monetizationFit": 0,',
      '      "factualSafety": 0,',
      '      "platformFit": 0',
      '    },',
      '    "hardReject": false,',
      '    "rationale": "brief comparative judgment",',
      '    "strengths": ["..."],',
      '    "weaknesses": ["..."],',
      '    "redFlags": ["..."]',
      '  }]',
      '}',
      '',
      'Score every dimension from 0 to 100.',
      'Judge comparatively across the supplied set; do not reward louder wording by itself.',
      'hookStrength: immediate specificity, curiosity/tension, understandable first seconds.',
      'retentionPotential: real open loop/progression/payoff likely to sustain attention.',
      'clarity: viewer can understand the premise and why to care.',
      'novelty: meaningfully different framing rather than generic explainer language.',
      'productionFeasibility: executable as realistic short-form video with the stated duration and small cast.',
      'monetizationFit: repeatable audience value and commercially useful attention without manipulative claims.',
      'factualSafety: low risk of unsupported claims, misinformation or misleading implication.',
      'platformFit: pacing and format suit vertical short-form viewing.',
      'Set hardReject=true for deceptive premises, concepts requiring fabricated facts, copyright-dependent execution, or production that is not realistically executable.',
      'Return one judgment for every candidate and preserve candidate IDs exactly.',
    ].join('\n');

    const parsed = await this.generateJson({
      system: 'You are an independent short-form creative judge. Be strict, comparative and resistant to clickbait. Return JSON only.',
      prompt,
      temperature: 0.1,
      model: this.judgeModel,
    });

    return {
      judgments: Array.isArray(parsed?.judgments) ? parsed.judgments : [],
      source: 'openai-compatible-independent-judge',
      model: this.judgeModel,
    };
  }

  async generateProductionScript({
    topic,
    audience,
    durationSeconds,
    creativeBrief = null,
    researchPacket = null,
  }) {
    const prompt = [
      'Write a complete production screenplay for a photorealistic vertical short-form video.',
      `Topic: ${topic}`,
      `Audience: ${audience}`,
      `Target total duration: ${durationSeconds} seconds`,
      creativeBrief ? `WINNING CREATIVE BRIEF: ${JSON.stringify(creativeBrief)}` : '',
      creativeBrief ? 'Treat the winning hook, angle, format, retention device and payoff as binding creative direction. Do not revert to a generic explainer.' : '',
      researchPacket?.evidence?.length
        ? `SOURCE-GROUNDED RESEARCH PACKET: ${JSON.stringify(researchPacket)}`
        : '',
      researchPacket?.evidence?.length
        ? 'Use the research packet only for supported factual context. Never invent missing statistics, quotes, dates, or claims.'
        : '',
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
      '    "startState":"exact physical/visual state at the first frame before the main action",',
      '    "endState":"physically reachable visual state at the final frame after the main action",',
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
      '- Spoken audio must fit inside its segment: across all dialogueTurns, use at most 2 words per second of durationSeconds (an 8 second segment allows at most 16 words), and count pauses toward the budget.',
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
      '- startState and endState must describe the SAME people, wardrobe, location, lighting and camera setup at two physically reachable moments.',
      '- endState must be a plausible consequence of the action, never a different composition/world invented only for visual variety.',
      '- Keep hands, held objects and body balance explicit in startState/endState when they are important to the action.',
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

  async generateJson({ system, prompt, temperature = 0, model = this.model }) {
    let response = await this.requestCompletion({ system, prompt, temperature, model });
    let payload = await response.json().catch(() => null);

    // Reasoning models (e.g. gpt-5.x) reject non-default temperature; retry once without it.
    if (!response.ok && this.supportsTemperature !== false && /temperature/i.test(payload?.error?.message || '')) {
      this.supportsTemperature = false;
      response = await this.requestCompletion({ system, prompt, temperature, model });
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

  requestCompletion({ system, prompt, temperature, model = this.model }) {
    return this.fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
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
