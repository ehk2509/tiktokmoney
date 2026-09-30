# Architecture

TikTokMoney is split into small, replaceable stages instead of one giant generation function.

```text
Trend Provider -> Opportunity Scorer -> Creative Pipeline
                                      -> Script Generator
                                      -> Scene Planner
                                      -> Quality Gate
                                      -> Renderer
                                      -> Project Store
```

## Current prototype

- `SampleTrendProvider`: local deterministic trend input.
- `OpportunityScorer`: prioritizes velocity, acceleration, audience fit, monetization and feasibility while penalizing saturation and risk.
- `TemplateLlmProvider`: zero-key deterministic provider so the project works immediately.
- `OpenAICompatibleLlmProvider`: structured JSON script generation over a Chat Completions-compatible endpoint.
- `PexelsStockProvider`: portrait stock-video discovery, local caching and attribution/license metadata.
- `ElevenLabsVoiceProvider`: narration audio plus character timing converted into word timings.
- `ScriptGenerator`: provider-facing script abstraction.
- `ScenePlanner`: converts structured copy into timed scene directives.
- `QualityGate`: blocks malformed projects before expensive media generation.
- `FfmpegRenderer`: normalizes each scene to 1080x1920, concatenates the scene timeline and attaches narration.
- `JsonStore`: persists complete project provenance.

## Next provider boundaries

1. More LLM adapters: Anthropic / Gemini and generic Responses-style gateways.
2. Trend sources: Google Trends, Reddit, news/RSS, YouTube and compliant TikTok discovery sources.
3. More assets: Pixabay/Coverr plus AI image/video generation and semantic re-ranking.
4. More voice options: Edge/Azure/local TTS plus caption-aware timing.
5. Publishing: official TikTok Content Posting API first, then Shorts/Reels.
6. Analytics: append-only post-performance snapshots.

## Design rule

AI decides *what* to create; deterministic code controls *how* the final media is assembled. This keeps the pipeline testable, recoverable and cheap to iterate.


## Realism-first visual generation

When `LUMA_API_KEY` is configured, visual generation is AI-first:

```text
Scene
  -> RealismSceneSpec
  -> Luma Photon vertical reference frame
  -> previous reference reused as image_ref when available
  -> Luma Ray image-to-video
  -> local cached MP4
  -> FFmpeg timeline
```

The AI video provider stores both the reference-image generation ID and video generation ID. This lets later work add targeted regeneration, continuity scoring and generation-level cost/performance analysis.

Pexels remains a fallback instead of the primary visual source. A failure in AI generation can degrade to real licensed footage without making the entire project fail.

The current continuity mechanism is intentionally conservative: the previous reference image is supplied to the next reference-frame generation with a configurable weight. A later milestone will replace this with explicit character/location bibles plus visual QC.
