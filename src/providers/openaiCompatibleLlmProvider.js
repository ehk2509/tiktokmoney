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

    const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.7,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are a short-form video creative director. Produce concise, structured JSON only.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    const payload = await readJsonResponse(response, 'LLM');
    const raw = payload?.choices?.[0]?.message?.content;
    if (!raw) throw new Error('LLM response did not contain message content');

    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      throw new Error(`LLM returned invalid JSON: ${error.message}`);
    }

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
}

async function readJsonResponse(response, label) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${label} returned a non-JSON response`);
  }

  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || response.statusText || 'request failed';
    throw new Error(`${label} request failed (${response.status}): ${detail}`);
  }

  return payload;
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
