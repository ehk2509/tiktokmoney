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
- `ScriptGenerator`: provider-facing script abstraction.
- `ScenePlanner`: converts structured copy into timed scene directives.
- `QualityGate`: blocks malformed projects before rendering.
- `FfmpegRenderer`: produces a real 1080x1920 MP4 and a render manifest.
- `JsonStore`: persists complete project provenance.

## Next provider boundaries

1. LLM: OpenAI / Anthropic / Gemini compatible structured script generation.
2. Trend sources: Google Trends, Reddit, news/RSS, YouTube and compliant TikTok discovery sources.
3. Assets: Pexels/Pixabay/Coverr plus AI image/video generation.
4. Voice: Edge/Azure/ElevenLabs/local TTS.
5. Publishing: official TikTok Content Posting API first, then Shorts/Reels.
6. Analytics: append-only post-performance snapshots.

## Design rule

AI decides *what* to create; deterministic code controls *how* the final media is assembled. This keeps the pipeline testable, recoverable and cheap to iterate.
