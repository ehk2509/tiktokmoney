# TikTokMoney

Prototype autonomous short-form video engine inspired by the production-pipeline strengths of MoneyPrinterTurbo, but designed around a larger loop:

```text
trend -> opportunity -> creative -> scenes -> quality gate -> render -> publish -> analytics -> learn
```

TikTokMoney now supports two production paths. The original **scene-composer** remains available and can work with zero API keys. The new **Audiovisual Director** writes a complete production screenplay and uses a specialized native-audio video model to generate picture, dialogue, ambience and effects together.

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

- Node.js 22.9+
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

The default remains zero-key/local. Add environment variables when you want production media. The `npm start`, `npm run generate` and `npm run opportunities` scripts load `.env` automatically when it exists; variables already exported in your shell take precedence. When calling `node src/cli.js` directly, pass `--env-file=.env`.

```bash
cp .env.example .env

# Structured script generation
export LLM_PROVIDER=openai-compatible
export OPENAI_API_KEY=...
export LLM_BASE_URL=https://api.openai.com/v1
export LLM_MODEL=...

# Choose the complete audiovisual pipeline
export VIDEO_PIPELINE_MODE=audiovisual

# Runway is required for the audiovisual path
export RUNWAYML_API_SECRET=...
export AUDIOVISUAL_VIDEO_MODEL=wan3
export AUDIOVISUAL_DIALOGUE_MODE=locked
export AUDIOVISUAL_TTS_MODEL=eleven_v3

# Optional/current realism-first scene-composer backends
export LUMA_AGENTS_API_KEY=...
export LUMA_AGENTS_VIDEO_MODEL=ray-3.2

export RUNWAYML_API_SECRET=...
export RUNWAY_PRIMARY_MODEL=gen4.5
export RUNWAY_ENABLE_TURBO=true

# Realism QC + targeted regeneration
export REALISM_QC_ENABLED=true
export OPENROUTER_API_KEY=...
export REALISM_QC_MODEL=google/gemini-3.8-flash
export REALISM_QC_THRESHOLD=82
export REALISM_QC_TEMPORAL_ENABLED=true
export REALISM_QC_TEMPORAL_THRESHOLD=80
export REALISM_MAX_REGENERATIONS=1

# Licensed footage fallback
export PEXELS_API_KEY=...

# Narration + timestamps
export ELEVENLABS_API_KEY=...
export ELEVENLABS_VOICE_ID=...

# Subtitles are enabled by default
export SUBTITLES_ENABLED=true
export SUBTITLES_MAX_WORDS=5
export SUBTITLES_FONT_SIZE=68
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
  -> adaptive AI video router
       -> Luma Ray 3.2
       -> Runway Gen-4.5
       -> Runway Gen-4 Turbo
       -> score scene fit + estimated cost + historical QC
  -> selected reference-guided image-to-video model
  -> sample 3 realism checkpoints
  -> sample 8 ordered temporal frames
  -> one OpenRouter vision QC call
       -> static realism score
       -> temporal motion score
  -> reject + targeted regenerate when either score is too low
  -> Pexels when AI still fails QC
  -> stop if no acceptable fallback exists
  -> ElevenLabs narration + word timing
  -> narration-aware scene retiming
  -> timed subtitle timeline
       -> exact word timing when available
       -> scene-estimated fallback otherwise
       -> active-word highlight
  -> FFmpeg normalization / composition
  -> ASS subtitle burn-in
  -> 1080x1920 MP4 + .srt/.ass sidecars
```

Visual routing is now **AI-first and multi-model**. When more than one current video backend is configured, TikTokMoney classifies each scene (human, human-action, action, environment, object or general), scores each model's capability profile, subtracts estimated generation cost, and incorporates that model's actual historical QC pass rate plus static/temporal scores. Before scene generation, TikTokMoney creates a Story Bible containing stable recurring characters, locations, wardrobe/physical traits, fixed environment elements, camera rules and lighting rules. Luma then creates canonical character references and location references. Each scene reference frame combines those canonical references with the previous accepted scene reference, substantially reducing identity and environment drift. If Luma fails and Pexels is configured, the router falls back to licensed stock footage. If neither produces a visual, FFmpeg retains the deterministic fallback card.

Luma generation IDs, prompts, models and reference-image lineage are stored in the project manifest. When realism QC is enabled, FFmpeg now produces two views of every AI clip: sparse realism checkpoints and a denser chronological sequence. Both are sent in one vision call. The evaluator scores photorealism, anatomy, geometry, physics, continuity and artifact freedom, plus temporal identity stability, object persistence, geometry stability, motion plausibility, camera continuity, flicker freedom and action continuity.

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

1. render/generation retry by failed stage
2. independent hook variants and creative ranking
3. live trend intelligence
4. publishing + performance learning
5. caption-style experiments driven by retention

After quality is consistent, add live trend sources, publishing, analytics and the learning loop.

See [Architecture](docs/ARCHITECTURE.md) and [Roadmap](docs/ROADMAP.md).


## Subtitles

Every rendered video now supports burned-in short-form subtitles. With ElevenLabs narration, TikTokMoney uses the provider's exact word timestamps. If word alignment is unavailable, it derives approximate timings from each retimed scene so subtitles remain available in fallback/local workflows.

The default style uses short phrase groups in the lower safe area with the currently spoken word highlighted. Subtitle graphics are added only after the generated footage has passed realism QC, so text overlays do not interfere with visual quality evaluation.

Each successful render can produce:

```text
outputs/<video-id>.mp4
outputs/<video-id>.subtitles.ass
outputs/<video-id>.subtitles.srt
```

The ASS file is used for the burned-in styled render; the SRT file is retained for publishing platforms or later editing.


## Audiovisual Director mode

Set:

```bash
export VIDEO_PIPELINE_MODE=audiovisual
export LLM_PROVIDER=openai-compatible
export OPENAI_API_KEY=...
export RUNWAYML_API_SECRET=...
```

The production path becomes:

```text
topic
  -> AI ProductionScript
       -> exact spoken dialogue
       -> structured dialogueTurns for 1-3 speakers
       -> character descriptions
       -> apparent age / face / hair / body traits
       -> wardrobe
       -> voice preset + delivery
       -> locations + fixed physical anchors
       -> lighting
       -> action
       -> camera
       -> ambience
       -> sound effects
       -> music direction
  -> canonical character/location references when available
  -> per-act exact voice generation
  -> WAN 3 native-audio video generation
       -> video
       -> synchronized dialogue
       -> ambience
       -> effects
  -> static + temporal realism QC
  -> targeted audiovisual regeneration
  -> subtitles
  -> audio-preserving final composition
```

### Dialogue modes

`AUDIOVISUAL_DIALOGUE_MODE=locked` is the production default. Each 4–15 second act first creates the exact dialogue using Runway text-to-speech, then passes that audio into WAN 3 through `referenceAudio`. The video prompt explicitly requires the visible performance to preserve those words verbatim.

`AUDIOVISUAL_DIALOGUE_MODE=native` skips the separate TTS request and asks WAN 3 to generate synchronized speech directly from the screenplay. It is cheaper/simpler but less strict about exact wording.

Acts are capped at 15 seconds in the production-script contract because Runway currently limits WAN 3 reference audio to 15 seconds total per request. WAN 3 itself can generate 2–30 second native-audio clips.

The original `scene-composer` mode is retained as a fallback:

```bash
export VIDEO_PIPELINE_MODE=scene-composer
```


## Publishability hardening

Audiovisual mode now applies a final publishability layer before a video is considered successful:

- production dialogue is rejected if authoring/meta language leaks into the spoken script
- subtitles are laid out by estimated rendered pixel width, not character count alone
- captions are limited to two lines inside an 840px safe width and moved higher above TikTok UI
- audiovisual acts default to one continuous shot; unexplained cuts, dissolves, crossfades and ghosting are explicitly forbidden
- WAN receives the previous accepted act as a video reference to improve cross-act identity/location continuity
- realism QC compares frames from the previous accepted act and enforces recurring identity/location continuity floors
- joined native audio is inspected for silence / unusable level before final render
- final audio is normalized to -14 LUFS with a -1 dBTP ceiling
- the normalized output is inspected again before the render is marked successful

Default controls:

```env
REALISM_QC_CONTINUITY_THRESHOLD=85
SUBTITLES_FONT_SIZE=64
SUBTITLES_MARGIN_V=335
SUBTITLES_MAX_WIDTH_PX=840
SUBTITLES_MAX_LINES=2
PUBLISHABILITY_AUDIO_REQUIRED=true
AUDIO_TARGET_LUFS=-14
AUDIO_TRUE_PEAK_DBTP=-1
```


## Dialogue fidelity + lip-sync QC

Audiovisual mode can now independently verify that generated speech matches the screenplay before an act is accepted.

```text
generated audiovisual act
  -> independent speech transcription
  -> expected dialogue vs transcript
       -> word error rate
       -> missing / added / substituted words
       -> word-count drift
  -> transcript word timestamps
  -> speech-active + pause frame sampling
  -> visual speech-timing QC
  -> targeted regeneration on failure
```

The default transcription model is `gpt-transcribe`. TikTokMoney requests verbose JSON with word and segment timestamps and does **not** feed the expected sentence back as a transcription prompt, keeping the verification pass independent.

Defaults:

```env
DIALOGUE_QC_ENABLED=true
TRANSCRIPTION_MODEL=gpt-transcribe
DIALOGUE_QC_MAX_WER=0.12
DIALOGUE_QC_MAX_WORD_COUNT_DELTA=0.12

LIPSYNC_QC_ENABLED=true
LIPSYNC_QC_THRESHOLD=80
LIPSYNC_QC_FRAMES=10
```

When dialogue verification passes, its actual word timestamps become the subtitle timing source. Captions therefore follow the generated speech rather than an estimated scene clock.

The current lip-sync check is deliberately described as a **visual speech-timing proxy**: it verifies speaker visibility, mouth activity during speech, relative stillness during pauses, face stability and broad timing plausibility. It does not claim phoneme/viseme-level alignment.


## Deep audiovisual synchronization QC

For a learned frame-level lip-sync metric, TikTokMoney can call an external evaluator through a safe no-shell command contract.

A ready adapter for the optional `syncnet-python` package is included:

```bash
python3 -m venv .venv-lipsync
. .venv-lipsync/bin/activate
pip install -r requirements-lipsync.txt
```

Provide the S3FD and SyncNet model weights required by that package, then configure:

```env
DEEP_LIPSYNC_ENABLED=true
DEEP_LIPSYNC_COMMAND=python3
DEEP_LIPSYNC_ARGS=["scripts/syncnet_qc.py","--video","{video}","--s3fd-weights","weights/sfd_face.pth","--syncnet-weights","weights/syncnet_v2.model","--device","cpu"]
DEEP_LIPSYNC_MAX_OFFSET_MS=80
DEEP_LIPSYNC_MIN_CONFIDENCE=5
DEEP_LIPSYNC_MIN_SEGMENT_PASS_RATE=0.8
```

The evaluator returns machine-readable metrics such as:

```json
{
  "offsetFrames": 1,
  "frameRate": 25,
  "confidence": 8.5,
  "segments": [
    {"offsetFrames": 1, "confidence": 8.1},
    {"offsetFrames": 0, "confidence": 7.8}
  ]
}
```

TikTokMoney converts frame offset to milliseconds, checks confidence and per-track/segment stability, and feeds concrete measured lag/lead guidance back into audiovisual regeneration.

The command adapter is generic. A stronger evaluator may additionally return normalized `phonemeAlignmentScore` and `visemeAlignmentScore`; if corresponding minimum thresholds are configured, those scores become hard gates too.

SyncNet itself is treated accurately as a learned frame-level audiovisual synchronization metric, **not** a phoneme/viseme classifier.


## Bundled phoneme↔viseme verifier

TikTokMoney now includes an optional local phoneme/viseme QC implementation instead of only accepting scores from an external evaluator.

Install its isolated Python dependencies:

```bash
python3 -m venv .venv-viseme
. .venv-viseme/bin/activate
pip install -r requirements-viseme.txt
```

Enable:

```env
PHONEME_VISEME_ENABLED=true
PHONEME_VISEME_MIN_PHONEME_ALIGNMENT=0.72
PHONEME_VISEME_MIN_VISEME_ALIGNMENT=0.68
PHONEME_VISEME_MIN_COVERAGE=0.72
```

The local verifier runs:

```text
independent transcript word timestamps
  -> English G2P / CMUdict
  -> ARPAbet phonemes
  -> 15-viseme mapping
  -> visually compatible mouth-shape families

generated video
  -> MediaPipe face landmarks
  -> normalized lip opening / width geometry
  -> local mouth-shape classifier

expected phoneme/viseme timeline
        ↕
observed mouth-shape timeline
        ↓
phoneme alignment score
viseme alignment score
visible-face coverage
confusion matrix
worst timestamped mismatches
```

The evaluator intentionally merges visually ambiguous sounds into coarse visual families such as `closed`, `narrow`, `rounded`, `wide`, and `open`. It does not pretend that mouth geometry alone can reliably separate phonemes that share the same visible articulation.

Failures produce targeted regeneration guidance with timestamped examples, for example:

```text
1.20s P/closed -> open
2.40s OW/rounded -> wide
```

A terminal failure returns `PHONEME_VISEME_QC_FAILED`.

The stronger SyncNet-class global A/V offset gate remains complementary: SyncNet measures learned audio/video synchronization, while this verifier checks whether the visible mouth-shape family is compatible with the spoken phoneme sequence.


## Multi-speaker dialogue scenes

Audiovisual acts can now contain a real conversation instead of one narrator per scene.

The production screenplay uses structured turns:

```json
{
  "characterIds": ["alex", "maya"],
  "dialogueTurns": [
    {
      "speakerCharacterId": "alex",
      "text": "Is starting in your thirties too late?",
      "delivery": "skeptical but curious",
      "pauseAfterSeconds": 0.2
    },
    {
      "speakerCharacterId": "maya",
      "text": "No. Consistency matters much more than the age you start.",
      "delivery": "calm and reassuring",
      "pauseAfterSeconds": 0
    }
  ]
}
```

Single-speaker scripts remain backward-compatible: the old `dialogue` + `speakerCharacterId` form is normalized into one dialogue turn.

### Locked multi-speaker audio

With `AUDIOVISUAL_DIALOGUE_MODE=locked`:

```text
dialogue turn 1
  -> Alex's stable Runway voice
dialogue turn 2
  -> Maya's stable Runway voice
        ↓
measure each generated voice clip
        ↓
FFmpeg timed dialogue master
        ↓
data:audio/mpeg reference
        ↓
WAN 3
```

Each recurring character is normalized to a valid, distinct Runway Eleven v3 preset voice. The dialogue master preserves exact speaker order and per-turn pauses. TikTokMoney refuses a master that exceeds the act duration or WAN's reference-audio budget, preventing final-render truncation.

Runway's current media input contract accepts data URIs wherever a URL media input is accepted, so the locally composed dialogue master does not need to be hosted publicly.

### Speaker attribution QC

For multi-speaker acts, TikTokMoney samples frames during each measured dialogue turn and checks:

- the intended named character is the active speaker
- the active speaker visibly articulates
- listeners react without speaking over the line
- character identities are not swapped between turns
- turn-taking remains visually unambiguous

A failure feeds targeted blocking guidance back into regeneration. A terminal failure becomes:

```text
SPEAKER_TURN_QC_FAILED
```

Defaults:

```env
MULTISPEAKER_TURN_GAP_SECONDS=0.16
SPEAKER_TURN_QC_ENABLED=true
SPEAKER_TURN_QC_THRESHOLD=82
SPEAKER_TURN_QC_FRAME_WIDTH=448
SPEAKER_TURN_QC_MAX_REGENERATIONS=1
```
