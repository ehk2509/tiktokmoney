# TikTokMoney

Prototype autonomous short-form video engine inspired by the production-pipeline strengths of MoneyPrinterTurbo, but designed around a larger loop:

```text
trend -> opportunity -> creative -> scenes -> quality gate -> render -> publish -> analytics -> learn
```

The first prototype intentionally focuses on the first executable slice. It works with **zero API keys** and can already score content opportunities, generate a structured short-form script, plan scenes, run a quality gate, and render a real **1080x1920 MP4** with FFmpeg.

## Why this architecture

The goal is not another `prompt -> video` wrapper. Each generated project retains enough provenance to later learn which creative decisions improve retention and monetization.

Borrowed from mature short-video generators:

- staged generation pipeline
- provider abstraction
- deterministic rendering
- task artifacts and reproducibility
- CLI/API surfaces
- quality/retry boundaries

Added as the product direction:

- trend velocity and acceleration scoring
- opportunity economics
- idea tournaments
- research/fact provenance
- creative experimentation
- performance learning
- profit-aware optimization

## Requirements

- Node.js 20+
- FFmpeg available on `PATH`

No npm dependencies are currently required.

## Quick start

```bash
git clone https://github.com/ehk2509/tiktokmoney.git
cd tiktokmoney
npm test
npm run generate -- --topic "Why airplanes rarely fly over Antarctica" --duration 35
```

Generated files appear under `./outputs` and project metadata under `./data`.

## CLI

Generate a prototype video:

```bash
node src/cli.js generate --topic "How AI video is changing advertising" --duration 35
```

Rank sample opportunities:

```bash
node src/cli.js opportunities
```

## HTTP API

```bash
npm start
```

Health:

```bash
curl http://localhost:3000/health
```

Generate:

```bash
curl -X POST http://localhost:3000/api/videos \
  -H 'content-type: application/json' \
  -d '{"topic":"Why airplanes rarely fly over Antarctica","durationSeconds":35}'
```

Discover/rank opportunities:

```bash
curl http://localhost:3000/api/opportunities
```

## Current pipeline

```text
SampleTrendProvider
      |
OpportunityScorer
      |
   topic
      |
ScriptGenerator
      |
ScenePlanner
      |
QualityGate
      |
FfmpegRenderer
      |
1080x1920 MP4 + JSON provenance
```

The fallback script provider is deterministic so development and tests do not spend API money. Real providers can be swapped in behind the same interface.

## Provider-backed M1 mode

The default remains zero-key/local. Add environment variables when you want production media:

```bash
cp .env.example .env

# Structured script generation
export LLM_PROVIDER=openai-compatible
export OPENAI_API_KEY=...
export LLM_BASE_URL=https://api.openai.com/v1
export LLM_MODEL=...

# Realism-first AI video
export LUMA_API_KEY=...
export LUMA_VIDEO_MODEL=ray-2
export LUMA_IMAGE_MODEL=photon-flash-1

# Realism QC + targeted regeneration
export REALISM_QC_ENABLED=true
export OPENROUTER_API_KEY=...
export REALISM_QC_MODEL=google/gemini-3.8-flash
export REALISM_QC_THRESHOLD=82
export REALISM_MAX_REGENERATIONS=1

# Licensed footage fallback
export PEXELS_API_KEY=...

# Narration + timestamps
export ELEVENLABS_API_KEY=...
export ELEVENLABS_VOICE_ID=...
```

With those providers configured, generation becomes:

```text
topic
  -> structured LLM script
  -> continuity Story Bible
       -> recurring characters
       -> recurring locations
       -> camera / lighting rules
       -> per-scene bindings
  -> canonical Luma character references
  -> canonical Luma location references
  -> scene reference combines canonical refs + previous accepted scene
  -> reference-guided Luma image-to-video
  -> sample 3 frames from each AI scene
  -> OpenRouter vision realism QC
  -> reject + targeted regenerate when score is too low
  -> Pexels when AI still fails QC
  -> stop if no acceptable fallback exists
  -> ElevenLabs narration + word timing
  -> narration-aware scene retiming
  -> FFmpeg normalization / composition
  -> 1080x1920 MP4
```

Visual routing is now **AI-first**. Before scene generation, TikTokMoney creates a Story Bible containing stable recurring characters, locations, wardrobe/physical traits, fixed environment elements, camera rules and lighting rules. Luma then creates canonical character references and location references. Each scene reference frame combines those canonical references with the previous accepted scene reference, substantially reducing identity and environment drift. If Luma fails and Pexels is configured, the router falls back to licensed stock footage. If neither produces a visual, FFmpeg retains the deterministic fallback card.

Luma generation IDs, prompts, models and reference-image lineage are stored in the project manifest. When realism QC is enabled, FFmpeg samples multiple frames from every AI clip and sends those images to a vision-capable OpenRouter model. The evaluator scores photorealism, anatomy, geometry, physics, motion consistency, continuity, scene relevance and artifact freedom.

A rejected clip is regenerated with the evaluator's corrective guidance. After the configured retry budget is exhausted, TikTokMoney uses Pexels real footage if available. If no acceptable fallback exists, the project stops at `VISUAL_QC_FAILED` and is not rendered. QC is fail-closed by default once explicitly enabled. Pexels attribution metadata is retained in the manifest.

## Project structure

```text
src/
  core/                 orchestration, scoring, scripts, scenes, QC
  providers.js          model/trend provider adapters
  renderers/            deterministic media composition
  storage/              project persistence
  app.js                 dependency wiring
  cli.js                 CLI entry point
  server.js              HTTP API

test/                    Node built-in test suite
docs/                    architecture and roadmap
```

## Development priorities

The next milestone is **not** auto-posting. It is improving `CreativeSpec -> high-quality TikTok` first:

1. temporal/motion QC beyond sampled frames
2. additional AI video providers + cost/quality router
3. kinetic word-level captions using narration timings
4. render/generation retry by failed stage
5. independent hook variants and creative ranking

After quality is consistent, add live trend sources, publishing, analytics and the learning loop.

See [Architecture](docs/ARCHITECTURE.md) and [Roadmap](docs/ROADMAP.md).
