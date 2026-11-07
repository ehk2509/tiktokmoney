import { FrameSampler } from '../services/frameSampler.js';
import { assertLocalEndpoint } from './localEndpoints.js';

// Lightweight local VLM alternative to remote visual QC. Optional: requires
// an OpenAI-compatible vision server (e.g. Ollama / LM Studio) on the LAN.
export class LocalVisionQcProvider {
  constructor({
    baseUrl = process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434/v1',
    model = process.env.LOCAL_VISION_MODEL,
    threshold = Number(process.env.REALISM_QC_THRESHOLD || 82),
    maxRegenerations = Number(process.env.REALISM_MAX_REGENERATIONS || 1),
    fetchImpl = globalThis.fetch,
    frameSampler = new FrameSampler({ frameCount: Number(process.env.LOCAL_VISION_QC_FRAMES || 3) }),
  } = {}) {
    this.baseUrl = assertLocalEndpoint(baseUrl, 'LOCAL_LLM_BASE_URL');
    if (!model) throw new Error('LOCAL_VISION_MODEL is required for local realism QC');
    this.model = model;
    this.threshold = threshold;
    this.maxRegenerations = maxRegenerations;
    this.failClosed = true;
    this.temporalEnabled = false;
    this.fetch = fetchImpl;
    this.frameSampler = frameSampler;
  }

  async evaluateScene(scene, asset, { previousAsset = null, storyBible = null } = {}) {
    if (!asset?.localPath) throw new Error('Local vision QC needs an on-disk video');
    const frames = await this.frameSampler.sample(asset.localPath, {
      durationSeconds: Number(asset.durationSeconds) || 5,
    });
    const previousFrames = previousAsset?.localPath
      ? await this.frameSampler.sampleComparison(previousAsset.localPath, {
        durationSeconds: Number(previousAsset.durationSeconds) || 5,
      })
      : [];
    const content = [
      { type: 'text', text: [
        'Judge ONLY visible evidence from these real sampled video frames in chronological order.',
        'Check photorealism, temporal continuity, identity, human anatomy, scene fidelity,',
        'objects, text glitches, flicker, physics and consistency with the previous act.',
        'Scene: ' + String(scene.narration || ''),
        'Prompt: ' + String(asset.prompt || '').slice(0, 1200),
        'Character references: ' + JSON.stringify(storyBible?.characters || []).slice(0, 600),
        'Return JSON with integer overallScore (0-100), a short issues array of',
        'strings, and a regenerationGuidance string. Do not assume invisible defects.',
      ].join(' ') },
      ...previousFrames.flatMap(frame => [
        { type: 'text', text: 'Previous act at ' + frame.timestamp + 's' },
        { type: 'image_url', image_url: { url: frame.dataUrl } },
      ]),
      ...frames.flatMap(frame => [
        { type: 'text', text: 'Current act at ' + frame.timestamp + 's' },
        { type: 'image_url', image_url: { url: frame.dataUrl } },
      ]),
    ];
    const response = await this.fetch(this.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a strict visual QC judge. Output a JSON object only.' },
          { role: 'user', content },
        ],
      }),
      signal: AbortSignal.timeout(180000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error('Local vision QC failed (' + response.status + '): ' +
      JSON.stringify(payload?.error || payload));
    const raw = payload?.choices?.[0]?.message?.content;
    let result;
    try {
      result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      throw new Error('Local vision QC response was not JSON');
    }
    const score = Number(result?.overallScore);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new Error('Local vision QC did not return a valid overallScore (0-100)');
    }
    const issues = Array.isArray(result.issues)
      ? result.issues.map(issue => ({
        code: 'local-vision',
        severity: score < this.threshold ? 'high' : 'low',
        evidence: typeof issue === 'string' ? issue : JSON.stringify(issue),
      }))
      : [];
    return {
      provider: 'local-vision',
      model: this.model,
      passed: score >= this.threshold,
      overallScore: score,
      staticScore: score,
      temporalScore: score,
      issues,
      temporalIssues: [],
      regenerationGuidance: String(result.regenerationGuidance || ''),
    };
  }
}
