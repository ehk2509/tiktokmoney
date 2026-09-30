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

1. real LLM structured generation
2. stock/AI visual acquisition
3. TTS + word timings
4. kinetic captions
5. multi-scene FFmpeg composition
6. visual/script alignment QC

After quality is consistent, add live trend sources, publishing, analytics and the learning loop.

See [Architecture](docs/ARCHITECTURE.md) and [Roadmap](docs/ROADMAP.md).
