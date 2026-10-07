# TikTokMoney

Prototype autonomous short-form video engine inspired by the production-pipeline strengths of MoneyPrinterTurbo, but designed around a larger loop:

```text
live signals -> trend history -> cluster -> opportunity -> research -> creative tournament -> production -> QC -> publish -> analytics -> learn
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
- Optional local pose sidecar: Python 3.9-3.12; Docker includes it automatically

No npm runtime dependencies are currently required.

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

## Provider cost ledger

Every persisted project now includes a `costLedger` built from provider-reported billing attached to generation provenance. The first instrumented path covers Runway audiovisual video, locked-dialogue TTS, and generated keyframes.

The ledger never substitutes estimates for missing billing:

```json
{
  "taskCount": 4,
  "usdReportedTaskCount": 3,
  "costUsdObserved": 2.41,
  "costUsdComplete": false,
  "costUsd": null,
  "source": "provider-reported-partial"
}
```

Daily-plan jobs reconcile their planning estimate against that ledger. If coverage is incomplete, `actualCostUsd` and variance remain `null`; `observedCostUsd` and coverage are still reported. The plan-level `budget.reconciled` object follows the same rule, so incomplete provider billing can never masquerade as a complete production cost.

Cost provenance now also consumes OpenRouter QC `usage` (including reported `cost` when present) and OpenAI-compatible LLM token/cost metadata when the upstream provider returns it. Non-reporting providers still remain incomplete rather than being priced from hard-coded tables.

## External provider billing reconciliation

For providers whose generation responses do not expose actual billing, import a provider/account export instead of guessing with static price tables.

Example billing file:

```json
[
  {"provider":"luma","generationId":"gen_123","costUsd":1.42},
  {"provider":"elevenlabs","taskId":"req_456","costUsd":0.08}
]
```

Import and reconcile:

```bash
node src/cli.js billing-import --file ./billing.json --source provider-export
node src/cli.js billing-reconcile --id "vid_..."
```

Imported records are keyed by `provider + taskId/generationId`, upserted idempotently, and only attach to matching project provenance. Reconciled costs carry their source in the project ledger.

## Scheduled publishing and automatic metric refresh

TikTok publication can now be queued for a future time while preserving the explicit publish-approval guard. Scheduling still requires `confirmPublish=true` and an explicit privacy level.

```bash
node src/cli.js publish-schedule \
  --id "vid_..." \
  --at "2026-10-08T12:00:00Z" \
  --privacy SELF_ONLY \
  --confirm-publish
```

The API server automatically polls the durable orchestration queue. After a scheduled publish succeeds, it creates a metrics-refresh job at the experiment observation window (or `PUBLICATION_METRICS_DELAY_HOURS` for non-experiment posts). If TikTok has not exposed the post/metrics yet, the job retries with the configured delay instead of silently completing.

Operational commands:

```bash
node src/cli.js orchestration-jobs
node src/cli.js orchestration-run
```

Set `ORCHESTRATION_AUTO_RUN=false` if an external cron/worker should own queue execution instead of the API process.

## Controlled creative experiments

High-conviction opportunities that receive multiple production variants are now treated as controlled experiments. The first variant is the control and later variants are challengers under one persisted experiment ID.

Experiment outcomes do not enter normal learning immediately. TikTok snapshots must first satisfy a comparable observation window:

```env
EXPERIMENT_OBSERVATION_WINDOW_HOURS=24
EXPERIMENT_COMPARISON_TOLERANCE_HOURS=3
```

An experiment completes only when every arm has a snapshot at or beyond the target age and selected arm snapshots are within the configured tolerance. Only those comparable snapshots become eligible for future creative-learning evidence.

Inspect or re-evaluate experiments:

```bash
node src/cli.js experiments
node src/cli.js experiment-evaluate --id "exp_..."
```

## Closed-loop creative learning

TikTok performance snapshots now feed a conservative evidence store instead of stopping at reporting.

Each refreshed publication can persist an outcome containing:
- winning creative candidate, format, emotional driver, hook and retention device;
- views, likes, comments, shares and engagement rate;
- complete actual cost when the project ledger is complete, otherwise observed cost only;
- cost per 1,000 views only when complete cost evidence exists.

Future audiovisual Creative Tournaments read this evidence automatically. Historical format/emotional-driver performance can adjust a judge score only after `PERFORMANCE_LEARNING_MIN_SAMPLES` is reached, and the adjustment is capped by `CREATIVE_LEARNING_MAX_ADJUSTMENT` (default 4 points).

This is intentionally bounded evidence weighting, not autonomous retraining. One viral or failed post cannot dominate future selection.

Inspect the evidence:

```bash
node src/cli.js performance-outcomes --limit 100
node src/cli.js learning-context --audience "curious adults"
```

## Guarded TikTok publishing

TikTok publishing is available as an **explicitly confirmed** post-generation step. It is never invoked by `generate`, `plan`, or `run-plan`.

Configure a TikTok user access token with `video.publish`:

```bash
export TIKTOK_ACCESS_TOKEN=...
```

Then publish an already rendered project:

```bash
node src/cli.js publish \
  --id "vid_..." \
  --privacy SELF_ONLY \
  --confirm-publish
```

The command first queries TikTok creator info and rejects privacy values that are not currently available for that creator. It then uses the official Content Posting API file-upload flow and persists the returned `publish_id` in `data/publications.json`.

Publishing status and basic engagement metrics can be refreshed later:

```bash
node src/cli.js publication-refresh --id "pub_..."
node src/cli.js publication-metrics --id "pub_..."
```

Metrics require the TikTok `video.list` scope and are stored as timestamped snapshots so future learning code can use observed outcomes rather than overwrite history.

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
export VOICEOVER_GENERATED_AMBIENCE_GAIN=0

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
2. validate the guarded publishing + performance-snapshot foundation
3. extend provider cost coverage beyond the new Runway-backed ledger
4. caption-style experiments driven by retention

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
  -> Creative Tournament
       -> 5 materially different concepts
       -> independent comparative judge
       -> hard reject unsafe / deceptive / infeasible concepts
       -> winning creative brief
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
  -> WAN 3 audiovisual video generation
       -> video
       -> visible-speaker dialogue when applicable
       -> generated ambience/effects when trusted
  -> off-screen voiceover path
       -> exact Runway TTS is authoritative
       -> WAN-generated act audio muted by default
  -> static + temporal realism QC
  -> visual factual + generated-text QC
  -> transition-aware editorial-variety QC
  -> targeted audiovisual regeneration
  -> semantic captions + deterministic editor labels
  -> loudness-normalized final composition
```

### Dialogue modes

`AUDIOVISUAL_DIALOGUE_MODE=locked` is the production default. For visible speakers, each 4–15 second act first creates the exact dialogue using Runway text-to-speech, then passes that audio into WAN 3 through `referenceAudio`. The video prompt explicitly requires the visible performance to preserve those words verbatim.

For **off-screen narration**, TikTokMoney does not ask WAN to re-speak the line. It generates the exact TTS track, generates the visual act without reference speech, then lays the TTS over the accepted video. WAN's generated soundtrack is muted by default in this path because generated beds can contain faint duplicate speech, echo-like vocal artifacts, or looping effects. Set `VOICEOVER_GENERATED_AMBIENCE_GAIN` above zero only when you intentionally want to retain that generated bed.

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
- the previous accepted act is sent as a video reference only for true continuation shots; deliberate framing changes do not inherit the prior clip as a continuation reference
- close-up/macro prompts omit full-room composition cues that would pull the generator back to a wide shot
- editorial-variety QC compares the previous act tail with the first 0.15 / 0.75 / 1.5 seconds of the next act, so delayed reframing cannot pass merely because later frames are different
- after repeated editorial-variety failures, WAN generation can escalate to a forced opening keyframe in the planned framing
- realism QC compares frames from the previous accepted act and enforces recurring identity/location continuity floors
- generated-text QC rejects pseudo-text from the video model; intended labels are drawn deterministically after generation
- label normalization preserves nearby semantic polarity such as `LOSS OF ATTACHED FLOW` or `NOT ENGINE FAILURE`
- visual factual QC blocks only high-confidence visible contradictions; a low diagnostic score without a contradiction is a warning
- off-screen voiceover uses exact TTS as the authoritative soundtrack and discards WAN-generated act audio by default
- joined audio is inspected for silence / unusable level before final render
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
VOICEOVER_GENERATED_AMBIENCE_GAIN=0
EDITORIAL_VARIETY_QC_ENABLED=true
EDITORIAL_VARIETY_QC_THRESHOLD=80
EDITORIAL_VARIETY_QC_MAX_REGENERATIONS=2
VISUAL_FACT_QC_ENABLED=true
VISUAL_FACT_QC_THRESHOLD=82
PRODUCTION_SCRIPT_PREFLIGHT_MAX_RETRIES=1
PRE_GENERATION_QC_MAX_REWRITES=1
PRE_GENERATION_SEMANTIC_QC_ENABLED=true
PRODUCTION_INTEGRITY_QC_ENABLED=true
```

### Pre-generation QC mirror

TikTokMoney now mirrors the downstream audiovisual QC stack **before Story Bible reference generation, TTS, or WAN video generation**. The goal is to spend video credits only on plans that are already capable of passing the post-generation gates.

The preventive pass checks the available planning-time equivalents of:

```text
realism + temporal realism
identity / location continuity
keyframe readiness
motion-region + motion-guide readiness
dialogue duration / speaker ownership
lip-sync / phoneme / visible-mouth prerequisites
multi-speaker turn blocking
pose-motion reference readiness
generated-text prevention
visual factual plan consistency
editorial shot variety
role / interaction / brand integrity
estimated subtitle layout
audio-plan safety
publishability / meta-language
```

Deterministic checks run after the realism, keyframe, motion-region, and motion-guide directors. When the configured LLM supports it, one additional **text-only semantic plan review** checks cross-field contradictions and directorial intent. A failed plan is rewritten at the screenplay level before any video call. If it remains invalid after the configured rewrite budget, the project stops as `PRE_GENERATION_QC_FAILED` with zero WAN generations.

Some qualities cannot literally be measured before media exists—actual flicker/morphing, generated-speech WER, real lip/phoneme timing, hallucinated logo pixels, produced pose trajectory, final frame similarity, or measured LUFS/true peak. Their **prerequisites and prompt contracts are mirrored pre-generation**, while the original post-generation checks remain as verification that the model obeyed the valid plan.

### Editorial variety, semantic labels, and captions

Consecutive acts are expected to be visually distinct when their screenplay `shotType` changes. Shot types such as `wide-establishing`, `close-up`, `macro-detail`, `tracking`, `overhead`, and `pov` expand into concrete framing contracts rather than acting as loose tags.

Editorial-variety QC performs two checks in the same review:

```text
previous accepted act
  -> tail samples near the cut
        versus
current act
  -> opening samples at ~0.15 / 0.75 / 1.5 s
  -> distributed whole-act samples
```

A clip that copies the old framing for the first seconds and only changes angle later can therefore fail with `transition-framing-reuse`. Numeric variety scores remain diagnostic; regeneration is issue-driven so a merely conservative score does not waste video credits.

Deterministic labels are restricted to phrases supported by the spoken narration. The normalizer also preserves nearby negation or loss context so shortening a phrase cannot reverse its meaning. Examples:

```text
"loss of attached flow" -> LOSS OF ATTACHED FLOW
"not engine failure"    -> NOT ENGINE FAILURE
```

Subtitle grouping uses verified word timings when available and treats the word-count limit as soft when one or two additional words are needed to finish a connector or short dependent clause, while still respecting safe-area width, line count, timing-gap, and character limits.


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


## Creative tournament

Audiovisual generation now starts with a cheap text-only competition before any references, voices, or video are generated.

```text
topic
  -> N diverse creative concepts
  -> independent judge
       -> hook strength
       -> retention potential
       -> clarity
       -> novelty
       -> production feasibility
       -> monetization fit
       -> factual safety
       -> platform fit
  -> hard-reject deceptive / unsupported / infeasible concepts
  -> weighted ranking
  -> winner
  -> full ProductionScript
  -> expensive audiovisual generation
```

Defaults:

```env
CREATIVE_TOURNAMENT_ENABLED=true
CREATIVE_TOURNAMENT_CANDIDATES=5
CREATIVE_TOURNAMENT_MIN_WINNER_SCORE=68
CREATIVE_TOURNAMENT_MIN_MARGIN=2
CREATIVE_JUDGE_MODEL=
```

`CREATIVE_JUDGE_MODEL` is optional. When omitted, the normal LLM model judges the candidates in a separate low-temperature call. A different model can be configured to reduce generator/judge self-preference.

The tournament deliberately rewards executable creative quality rather than hook aggressiveness alone. Weighted dimensions are:

```text
hook strength           22%
retention potential     20%
clarity                 13%
novelty                 12%
production feasibility  10%
monetization fit         8%
factual safety           8%
platform fit             7%
```

If no candidate reaches the configured quality floor, the project stops as `CREATIVE_REJECTED` before production-screenplay generation, TTS, image references, or video generation. This makes the tournament a spend gate as well as a creative selector.

The complete candidate set, independent judgments, ranking, score margin, winner, strengths, weaknesses, and red flags are persisted in the project manifest. The winner is then injected into the production-screenplay prompt as binding direction, so the downstream writer cannot silently fall back to a generic explainer.


## Live trend intelligence

TikTokMoney can now replace the deterministic sample trends with real external signals when any live trend source is configured.

Current adapters:

- **YouTube Data API** — discovers recent high-view videos and enriches them with current view/like/comment statistics.
- **Reddit official OAuth API** — reads hot/search listings and derives engagement velocity from score/comments versus post age.
- **RSS / Atom** — accepts arbitrary configured feeds for news, technology, niche publications, or owned research sources.

When none are configured, the existing deterministic `SampleTrendProvider` remains the zero-key fallback.

Configuration:

```env
TREND_REGION=US
TREND_LOOKBACK_HOURS=24
TREND_HISTORY_PATH=./data/trend-history.json
TREND_CLUSTER_THRESHOLD=0.52
TREND_MAX_SIGNALS=120

YOUTUBE_API_KEY=
YOUTUBE_TREND_MAX_RESULTS=25

REDDIT_ACCESS_TOKEN=
REDDIT_USER_AGENT=tiktokmoney/0.16 trend-intelligence
REDDIT_TREND_SUBREDDIT=all

TREND_RSS_FEEDS=[{"name":"tech","url":"https://example.com/feed.xml"}]
```

### Normalized signal pipeline

```text
YouTube ----+
Reddit -----+--> normalized signals
RSS/Atom ---+       -> title/topic
                    -> source URL
                    -> published time
                    -> source metrics
                    -> normalized strength
                         ↓
                   topic clustering
                         ↓
                   persisted history
                         ↓
                velocity + acceleration
                         ↓
                 opportunity scoring
                         ↓
                 research packet
```

Near-duplicate stories from different providers are clustered using normalized token similarity. A cluster keeps the strongest lead title while retaining every unique source and URL.

`trend-history.json` stores bounded snapshots for each cluster. The first observation starts with neutral acceleration; later observations compare signal strength against previous snapshots so rising stories receive positive acceleration and decaying stories lose momentum.

### Source-grounded research packets

Each opportunity includes `researchPacket`:

```json
{
  "topic": "example trend",
  "sourceNames": ["youtube", "reddit", "rss:tech"],
  "evidence": [
    {
      "source": "youtube",
      "title": "...",
      "url": "...",
      "snippet": "...",
      "publishedAt": "...",
      "strength": 82
    }
  ]
}
```

The packet explicitly tells downstream AI that titles/snippets are evidence leads rather than automatically verified facts. The Creative Tournament, independent judge, and ProductionScript writer all receive the same packet and are instructed not to invent unsupported numbers, dates, quotes, or causal claims.

This also works when generating directly from a topic: audiovisual mode searches configured trend providers for that topic before running the tournament.

Inspect it independently:

```bash
npm run opportunities
node --env-file-if-exists=.env src/cli.js research --topic "AI video"
```

HTTP:

```text
GET /api/opportunities
GET /api/research?topic=AI%20video
```

A provider failure is isolated with `Promise.allSettled`: healthy sources still produce opportunities and provider errors are retained with the result rather than taking the whole trend pipeline down.


## Autonomous daily content planning

TikTokMoney can now convert ranked opportunities into a persisted production queue before any expensive generation starts.

```text
live opportunities
  -> opportunity score floor
  -> source-evidence floor
  -> recent-topic cooldown
  -> daily budget
  -> daily video limit
  -> conviction-based allocation
       -> normal opportunity: 1 video
       -> strong rising multi-source opportunity: up to N variants
  -> queued production jobs
  -> execute sequentially
  -> project results written back to the plan
```

Defaults:

```env
DAILY_PLAN_PATH=./data/daily-plans.json
DAILY_CONTENT_BUDGET_USD=6
DAILY_CONTENT_MAX_VIDEOS=3
DAILY_CONTENT_MIN_OPPORTUNITY_SCORE=52
DAILY_CONTENT_MIN_EVIDENCE=1
DAILY_CONTENT_ESTIMATED_VIDEO_COST_USD=1.5
DAILY_CONTENT_TOPIC_COOLDOWN_DAYS=7
DAILY_CONTENT_TOPIC_SIMILARITY=0.52
DAILY_CONTENT_HIGH_CONVICTION_SCORE=78
DAILY_CONTENT_HIGH_CONVICTION_ACCELERATION=62
DAILY_CONTENT_MAX_VIDEOS_PER_OPPORTUNITY=2
```

The default evidence floor of `1` intentionally prevents autonomous production from the sample trend provider. Set it to `0` only if you explicitly want unsourced/sample opportunities to be eligible.

### Budget allocation

The planner walks already-ranked opportunities and allocates jobs while both limits remain:

```text
committed estimated cost <= daily budget
jobs <= daily max videos
```

A high-conviction opportunity must satisfy:
- opportunity score >= configured high-conviction score
- acceleration >= configured acceleration threshold
- at least two independent trend sources

Those opportunities may receive multiple video variants, bounded by `DAILY_CONTENT_MAX_VIDEOS_PER_OPPORTUNITY`, budget, and the global daily video limit.

The planner also scales creative search depth:

```text
ordinary opportunity       -> 5 creative candidates
score >= 70                -> 6 candidates
high conviction            -> 7 candidates
very strong + accelerating -> 8 candidates
```

Each variant gets a fresh creative tournament and is explicitly labeled as a separate production batch so the LLM is asked to explore a different angle.

### Topic repetition control

`daily-plans.json` is used as short-term production memory. Before selecting a topic, TikTokMoney compares it with topics already queued/produced during the configured cooldown window.

A sufficiently similar topic is skipped with provenance such as:

```json
{
  "topic": "Real-time AI video model just launched",
  "reasons": ["recent-topic similarity 0.81 >= 0.52"],
  "recentMatch": {
    "topic": "New real-time AI video generation model launches",
    "planId": "plan_..."
  }
}
```

Multiple variants intentionally allocated to the **same high-conviction opportunity inside one plan** are allowed.

### Queue execution

Planning and production are separate operations:

```bash
npm run plan -- --budget 6 --max-videos 3

npm run run-plan -- --id "plan_..."
```

Inspect history:

```bash
node --env-file-if-exists=.env src/cli.js plans
```

HTTP:

```text
POST /api/plans
GET  /api/plans
GET  /api/plans/:id
POST /api/plans/:id/run
```

Each job persists:
- selected opportunity and cluster
- research packet frozen at planning time
- opportunity/velocity/acceleration scores
- evidence/source counts
- planned cost
- creative candidate count
- variant number
- project id
- terminal project status/error

Execution reuses the frozen research packet rather than fetching new evidence, making a daily plan reproducible.

### Cost semantics

`DAILY_CONTENT_ESTIMATED_VIDEO_COST_USD` is currently a **planning estimate**, not provider-billing truth. It prevents planned work from exceeding a configured budget under the estimate, but the next cost-control milestone should reconcile actual LLM/TTS/video/QC usage against the plan after generation.


## Anti-Plastic Realism Pipeline

The audiovisual path now includes a deterministic `RealismDirector` before generation and a bounded optical post stage after QC.

```text
ProductionScript
  -> RealismDirector
       -> action-risk score
       -> capture profile
       -> one-axis physical camera rule
       -> human-action complexity budget
       -> stable-shot duration target
       -> micro environmental motion
       -> motivated imperfect lighting
       -> room tone + synced foley plan
  -> WAN audiovisual generation
  -> realism / temporal QC
  -> bounded optical post
       -> slight optical softness
       -> saturation normalization
       -> contrast normalization
       -> subtle temporal grain
  -> subtitles + loudness normalization
```

Profiles are selected automatically unless `REALISM_CAPTURE_PROFILE` is forced:

- `organic-documentary`: 24 fps, restrained human-operated camera
- `organic-smartphone`: 30 fps, subtle handheld phone behavior
- `fitness-action`: 30 fps, grounded movement and lower blur
- `cinematic`: 24 fps, restrained 35mm-style camera language

The director explicitly removes prompt filler such as `hyperrealistic`, `4K`, `8K`, `masterpiece`, and `trending on artstation`. It replaces those tokens with physical instructions about lens behavior, lighting, camera inertia, body weight, fabric/hair response, and environmental motion.

Complex hand/object interactions, aggressive camera moves, action scenes and multi-person scenes increase a scene risk score. High-risk acts get shorter stable-shot targets and may use a small number of clean motivated cuts instead of one long drifting shot.

Sound realism is also planned before generation. Each act receives explicit room-tone, foley, breathing/clothing and environment cues so WAN's native audio is asked to generate a physically grounded soundscape rather than only dialogue plus generic music.

Post-processing is intentionally conservative. TikTokMoney does **not** automatically add chromatic aberration or synthetic motion blur. The renderer currently applies only bounded softness, saturation/contrast normalization and subtle grain. Motion blur is considered unsafe when QC reports morphing, anatomy, geometry or melting defects.

Configuration:

```env
ANTI_PLASTIC_REALISM_ENABLED=true
REALISM_CAPTURE_PROFILE=auto
REALISM_MAX_SHOTS_PER_ACT=3

ANTI_PLASTIC_POST_ENABLED=true
ANTI_PLASTIC_SOFTNESS_MAX_SIGMA=0.35
ANTI_PLASTIC_GRAIN_MAX_STRENGTH=2.2
```

Realism QC now also scores `materialRealism`, `cameraPhysics` and `lightingNaturalism`, so waxy skin, floating camera motion and glossy synthetic lighting become explicit regeneration signals instead of being hidden inside one generic photorealism score.


## Adaptive First / Last Frame Director

TikTokMoney can now lock the physical start and end state of higher-risk WAN 3 acts instead of asking the video model to invent the complete trajectory from text alone.

```text
ProductionScript
  -> startState / endState
  -> RealismDirector risk score
  -> KeyframeDirector
       low risk    -> no extra keyframe
       medium risk -> first frame
       high risk   -> first + last frame
  -> Runway Gen-4 Image keyframes
       + canonical character references
       + canonical location reference
       + previous accepted act endpoint
  -> WAN 3 image-to-video
       + first/last keyframes
       + locked reference audio
       + previous video reference
  -> keyframe adherence QC
```

The screenplay now supports `startState` and `endState` for every audiovisual act. They describe two moments in the **same physical scene**: identical characters, wardrobe, location, lighting and camera setup, with the end state being a reachable consequence of the action.

Default policy:

```env
FIRST_LAST_FRAME_ENABLED=true
KEYFRAME_MODE=auto
KEYFRAME_FIRST_RISK_THRESHOLD=32
KEYFRAME_LAST_RISK_THRESHOLD=50
KEYFRAME_IMAGE_RATIO=720:1280
KEYFRAME_VIDEO_RATIO=auto_720p
KEYFRAME_FAIL_OPEN=true
REALISM_QC_KEYFRAME_THRESHOLD=84
```

In `auto` mode:
- risk < 32: keep the existing reference/text-to-video path
- risk 32-49: generate a first frame and use WAN image-to-video
- risk >= 50: generate both first and last frames

The first frame is built from canonical character/location references. The last frame additionally uses the generated first frame as a reference so identity, wardrobe, framing and environment remain tied to the same shot.

For WAN keyframe generation, TikTokMoney switches from:

```text
POST /text_to_video
```

to:

```text
POST /image_to_video

promptImage:
  first -> generated start keyframe
  last  -> generated end keyframe
```

while preserving `referenceAudio` for exact locked dialogue and `referenceVideos` for cross-act continuity.

If keyframe generation fails and `KEYFRAME_FAIL_OPEN=true`, the act falls back to the existing WAN text-to-video path and records `keyframeError` in the asset provenance instead of losing the entire video.

### Keyframe adherence QC

The generated keyframes are also supplied to realism QC as explicit visual anchors.

The QC model now returns:
- `keyframeStartMatch`
- `keyframeEndMatch`

When a keyframe exists, the corresponding score must be explicitly present and reach `REALISM_QC_KEYFRAME_THRESHOLD`. A visually realistic clip can therefore still be rejected when it starts with the wrong pose/object state or finishes in a different identity/location/state.

This closes an important failure mode where endpoint images are accepted by the provider but the generated trajectory drifts away from them.


## Motion Region Director

TikTokMoney now plans **where motion is allowed to happen** instead of treating every pixel in an AI-generated act as equally free to move.

The current Runway video-generation contract used by the project does not expose a native spatial motion-brush/mask parameter. v0.20 therefore implements provider-neutral semantic region control rather than sending an invented API field.

```text
ProductionScript
  -> RealismDirector
  -> KeyframeDirector
  -> MotionRegionDirector
       -> ALLOWED TO MOVE
       -> LOCKED / STABILIZE
       -> camera-parallax policy
       -> multi-speaker inactive-subject policy
  -> WAN prompt
  -> temporal regional QC
  -> targeted regeneration
```

Defaults:

```env
MOTION_REGION_CONTROL_ENABLED=true
MOTION_REGION_MODE=semantic
MOTION_REGION_BACKGROUND_LOCK=true
MOTION_REGION_FACE_LOCK=true
REALISM_QC_MOTION_REGION_THRESHOLD=84
```

### Example: talking head

```text
ALLOWED
- active speaker mouth/jaw: speech articulation only
- shoulders/upper torso: tiny breathing/posture motion

LOCKED
- face identity outside mouth/jaw
- body silhouette outside micro-motion
- walls / doors / desk / furniture
- every unrelated background object
```

### Example: hand/object interaction

```text
ALLOWED
- hands / wrists / forearms
- exactly one manipulated prop

LOCKED
- face geometry
- torso / hips / legs not required by the action
- furniture and architecture
- unrelated props
```

### Camera motion

A moving camera does **not** imply moving scenery.

For locked/tripod shots, environment anchors are expected to remain screen-space stable.

For tracking/push/pan shots, the environment may move in frame only through physically correct camera parallax. Furniture and architecture must still preserve rigid geometry and must not breathe, slide independently or deform.

### Multi-speaker scenes

During each dialogue turn, the active speaker may articulate speech. Inactive speakers are explicitly constrained to:
- resting/closed mouth
- stable face identity
- stable body position
- subtle listening reactions only

This works together with the existing speaker-turn QC rather than replacing it.

### Regional QC

When an audiovisual provider reports that it applied motion-region control, realism QC requires four explicit scores:

```text
motionRegionCompliance
lockedRegionStability
intendedMotionCompliance
backgroundDriftFreedom
```

All must clear `REALISM_QC_MOTION_REGION_THRESHOLD`.

A clip can therefore have excellent photorealism and a strong generic temporal score but still fail because a desk edge breathes, a wall drifts, an inactive speaker moves their mouth, or motion leaks from a hand into the arm/torso/background.

The regeneration prompt receives deterministic region-specific guidance identifying the locked and allowed regions that must be corrected.

### Provider capability provenance

Generated audiovisual assets now record:

```json
{
  "motionControlMode": "semantic-region-prompt",
  "nativeMotionMask": false
}
```

This distinction is deliberate. When a provider later exposes real spatial motion masks, TikTokMoney can add a native transport behind the same MotionRegionDirector contract without pretending the current API already supports it.


## Real-motion video guidance

TikTokMoney can now use a **real human motion clip as a movement reference** for difficult actions while keeping AI character identity, wardrobe, location, keyframes and locked dialogue authoritative.

This is intentionally different from blindly restyling the reference video.

```text
real licensed human-motion clip
        ↓
MotionGuideDirector
  action classification
  risk gate
  reference ranking
        ↓
canonical AI character + location
first/last keyframes
motion-region locks
exact dialogue reference audio
        ↓
WAN audiovisual generation
  referenceVideos = motion guide
        ↓
Motion Guide QC
  pose trajectory
  timing rhythm
  contact mechanics
  motion adherence
```

### Motion library

Create the active library from the example:

```bash
cp data/motion-references.example.json data/motion-references.json
```

Then replace the example URL with a real HTTPS/Runway-hosted clip and document its rights:

```json
{
  "references": [
    {
      "id": "walk-side-01",
      "actionClass": "walking",
      "tags": ["walking", "natural", "full-body", "weight-transfer"],
      "cameraMode": "tracking",
      "people": 1,
      "durationSeconds": 6,
      "url": "https://...",
      "source": "our internal motion capture session",
      "license": "owned footage",
      "verifiedHumanMotion": true,
      "rightsConfirmed": true
    }
  ]
}
```

By default, references are **not eligible** unless `rightsConfirmed=true`.

This keeps autonomous production from accidentally treating arbitrary web video as reusable motion data.

### Selection policy

Defaults:

```env
MOTION_GUIDE_ENABLED=true
MOTION_GUIDE_MODE=auto
MOTION_REFERENCE_LIBRARY_PATH=./data/motion-references.json
MOTION_GUIDE_MIN_RISK_SCORE=50
MOTION_GUIDE_MIN_SELECTION_SCORE=0.55
MOTION_GUIDE_MAX_REFERENCE_SECONDS=15
MOTION_GUIDE_REQUIRE_RIGHTS_CONFIRMED=true
MOTION_GUIDE_FAIL_OPEN=true
```

The selector classifies actions such as:

- walking
- running
- lifting
- squat
- reaching / pick-up
- placing
- drinking
- jumping
- throwing
- dancing
- boxing
- turning

Simple talking-head/general scenes are not motion-guide candidates.

In `auto` mode, the scene must also clear the realism-risk threshold. References are ranked by:

- action-class match
- semantic action/tag overlap
- camera compatibility
- duration fit
- number of people

If no reference clears the threshold, TikTokMoney simply uses the existing generation path.

### What the video reference controls

The generation prompt explicitly says to use the clip only for:

- temporal rhythm
- pose progression
- balance
- body mechanics
- weight transfer
- contact timing
- physically plausible trajectory

It explicitly forbids copying:

- performer identity
- face / apparent age
- clothing
- background
- location
- lighting
- color palette
- reference-video camera look

Canonical story-bible identity and keyframes remain authoritative.

### 15-second reference budget

WAN video references have a combined duration budget. TikTokMoney therefore builds a deterministic reference plan.

The motion guide has priority. The previous accepted act is included as an additional continuity video only when both fit within the configured 15-second total.

Example:

```text
motion guide   7 s
previous act   9 s
-----------------
total         16 s

=> keep motion guide
=> drop previous-act video reference
=> continuity still comes from story bible + keyframes
```

When both fit, both are retained.

### Guide caching + independent QC

The exact motion guide sent to generation is cached under `ASSET_DIR`. Realism QC samples both:

```text
generated temporal sequence
real-motion reference sequence
```

and compares motion rather than appearance.

Four new independent scores are required when a guide was actually applied:

```text
motionGuideAdherence
poseTrajectoryMatch
timingRhythmMatch
contactMechanicsMatch
```

Default:

```env
REALISM_QC_MOTION_GUIDE_THRESHOLD=80
```

These scores do not replace generic temporal realism or Motion Region QC. A clip can therefore look realistic and preserve identity but still be regenerated if the gait, grip, foot plant, timing or weight transfer diverges too far from the real human reference.

Failed guide QC produces deterministic corrective guidance while preserving canonical identity, keyframes and locked regions.


## Pose / skeleton motion abstraction

TikTokMoney can now separate **movement geometry** from the pixels of a motion-reference video.

The goal is to compare and describe:

- pose trajectory
- joint-angle progression
- timing rhythm
- body mechanics
- foot/hand contact events

without depending on:

- performer identity
- body size
- clothing
- location
- lighting
- image style

### Normalized pose contract

A motion reference may include an optional precomputed `poseSequence`:

```json
{
  "durationSeconds": 4,
  "frames": [
    {
      "time": 0,
      "joints": {
        "left_shoulder": { "x": 0.42, "y": 0.30, "confidence": 0.98 },
        "right_shoulder": { "x": 0.58, "y": 0.30, "confidence": 0.98 },
        "left_hip": { "x": 0.45, "y": 0.62, "confidence": 0.98 },
        "right_hip": { "x": 0.55, "y": 0.62, "confidence": 0.98 }
      }
    }
  ],
  "contacts": [
    { "type": "left-foot-plant", "time": 0.2 }
  ]
}
```

TikTokMoney recenters every frame on the body and scales it using torso / shoulder / hip geometry.

That makes the representation approximately invariant to:

```text
screen position
actor height
camera crop scale
raw pixel coordinates
```

while preserving the actual articulated movement.

### Skeleton prompt abstraction

If a motion reference already contains a pose sequence, or if an extractor is configured, the Runway audiovisual provider derives a compact skeleton summary before generation:

```text
beat 1[t=0, hipY=..., knee=...]
 -> beat 2[t=0.25, hipY=..., knee=...]
 -> beat 3...
```

The summary is added beside the real-motion video reference.

It contains geometry/timing only — no visual appearance information.

### External pose extractor

TikTokMoney does not force a Python/computer-vision dependency into the Node runtime.

Instead it exposes a command adapter:

```env
POSE_MOTION_QC_ENABLED=true
POSE_EXTRACTOR_COMMAND=/path/to/your/pose-extractor
POSE_EXTRACTOR_ARGS=["--video","{video}","--output-json","{output_json}","--fps","{fps}"]
POSE_EXTRACTOR_FPS=8
POSE_EXTRACTOR_TIMEOUT_MS=120000
```

Supported placeholders:

```text
{video}
{output_json}
{fps}
{duration}
```

The command must write JSON matching the pose contract above.

This makes MediaPipe, MoveNet, OpenPose, YOLO-pose or an internal mocap service interchangeable without adding a runtime dependency to TikTokMoney.

### Deterministic pose-motion QC

When a pose extractor is configured and a real-motion guide was used, a new deterministic gate compares the generated clip against the reference skeleton.

It computes:

```text
poseTrajectoryScore
bodyMechanicsScore
timingRhythmScore
contactMechanicsScore
coverage
overallScore
```

Default configuration:

```env
POSE_MOTION_QC_THRESHOLD=78
POSE_MOTION_QC_MIN_COVERAGE=0.55
POSE_MOTION_QC_MAX_REGENERATIONS=1
POSE_MOTION_QC_FAIL_CLOSED=true
```

The comparison uses body-normalized coordinates and joint-angle sequences, so the generated character is **not required to have the same height, screen position or proportions in raw pixels** as the motion actor.

A failed gate feeds corrective guidance back into regeneration:

```text
POSE MOTION CORRECTION:
improve pose trajectory / joint mechanics / rhythm / contacts.
Match the normalized skeleton motion, not the actor appearance.
Preserve canonical identity, wardrobe, location, keyframes and motion-region locks.
```

If no pose extractor is configured, this gate remains inactive and the v0.21 real-video Motion Guide + vision QC path continues unchanged.


## Bundled MediaPipe pose sidecar

v0.23 turns pose-motion QC from an integration hook into an installable local capability.

For a local checkout:

```bash
npm run setup:pose
```

That command:

1. finds a compatible Python interpreter
2. creates `.venv-pose`
3. installs the pinned MediaPipe sidecar requirements
4. downloads the official Pose Landmarker Full task model
5. runs a sidecar health check

After setup, TikTokMoney auto-detects:

```text
.venv-pose/bin/python        # Linux/macOS
.venv-pose/Scripts/python.exe # Windows
```

No `POSE_EXTRACTOR_COMMAND` is required.

Docker is fully prewired: the image creates `/opt/tiktokmoney-pose`, installs MediaPipe, downloads the pose model, and exposes it automatically to the audiovisual pipeline.

### Why the worker uses FFmpeg + MediaPipe

The sidecar deliberately does not add OpenCV. FFmpeg already exists in the TikTokMoney runtime and handles frame decoding/sampling; MediaPipe only performs pose inference.

The worker uses MediaPipe Pose Landmarker in VIDEO mode with monotonic frame timestamps and maps the 33 landmarks into TikTokMoney's normalized pose contract. MediaPipe's Pose Landmarker supports image/video/live-stream modes and exposes the expected body landmarks such as shoulders, elbows, wrists, hips, knees and ankles. 

### Extraction cache

Pose extraction is cached under:

```text
./data/pose-cache
```

The cache key includes:

```text
absolute video path
file size
mtime
sample FPS
extractor command
extractor arguments
schema version
```

So a reused real-motion reference is not reprocessed for every generated act, while changed video files invalidate automatically.

Configure:

```env
POSE_CACHE_DIR=./data/pose-cache
POSE_MODEL_PATH=./models/pose_landmarker_full.task
POSE_EXTRACTOR_FPS=8
```

### Auto-enable behavior

When `POSE_MOTION_QC_ENABLED` is unset, audiovisual mode automatically enables deterministic pose QC when the bundled sidecar is discovered.

You can explicitly disable it:

```env
POSE_MOTION_QC_ENABLED=false
```

or replace the bundled worker with any compatible command via `POSE_EXTRACTOR_COMMAND`.

The service health response now reports the effective state:

```json
{
  "capabilities": {
    "poseMotion": {
      "enabled": true,
      "extractorAvailable": true,
      "extractorKind": "bundled-mediapipe",
      "bundled": true
    }
  }
}
```


## Automatic Motion Library Builder

v0.24 removes the need to hand-author `motion-references.json`.

Start with the bundled pose sidecar:

```bash
npm run setup:pose
```

Then ingest footage you own or are licensed to reuse:

```bash
npm run motion-library:build -- \
  --input ./captures/squat-session.mp4 \
  --license "owned internal capture" \
  --source "Paris studio session 2026-10-02" \
  --rights-confirmed
```

Or process every video in one directory:

```bash
npm run motion-library:build -- \
  --dir ./captures/motion-library \
  --license "owned internal captures" \
  --rights-confirmed
```

An optional action hint can override conservative automatic classification:

```bash
npm run motion-library:build -- \
  --input ./captures/squat.mp4 \
  --action squat \
  --camera locked \
  --license "owned" \
  --rights-confirmed
```

List the resulting references:

```bash
npm run motion-library:list
```

or:

```text
GET /api/motion-library
```

### Build pipeline

```text
owned/licensed raw video
      ↓
MediaPipe pose extraction
      ↓
motion-energy segmentation
      ↓
2.5-12 s useful windows
      ↓
pose-based action classification
      ↓
foot-contact detection
      ↓
reference quality score
      ↓
skeleton deduplication
      ↓
FFmpeg lightweight reference clip
      ↓
motion-references.json
```

Automatic classification currently recognizes the high-value reusable motion families:

```text
squat
lifting
walking
running
reaching
jumping
```

Ambiguous `general` movement is rejected by default rather than polluting the library.

Use `--action` when the capture is intentionally labeled or the heuristic is too conservative.

### Rights gate

The builder refuses to run unless both are present:

```text
--rights-confirmed
--license "..."
```

Every generated reference retains:
- source provenance
- rights/license note
- source clip
- original segment timestamps
- quality score
- classification confidence
- creation time
- normalized pose sequence

### Automatic segmentation

Long capture sessions do not need to be manually pre-cut.

The builder analyzes normalized joint motion, detects active regions, pads the useful movement and creates bounded reference clips.

Defaults:

```env
MOTION_LIBRARY_MIN_SEGMENT_SECONDS=2.5
MOTION_LIBRARY_MAX_SEGMENT_SECONDS=12
MOTION_LIBRARY_MAX_SEGMENTS_PER_CLIP=4
MOTION_LIBRARY_MIN_QUALITY_SCORE=62
MOTION_LIBRARY_DEDUPE_THRESHOLD=0.90
MOTION_LIBRARY_ALLOW_GENERAL=false
```

The 12-second default leaves headroom below WAN's 15-second combined video-reference budget.

### Local references without hosting

Auto-built reference media stays under:

```text
./data/motion-library/
```

TikTokMoney does **not** embed base64 blobs in the JSON library.

When Runway selects a local reference, the provider converts that single clip to a bounded `data:video/mp4;base64,...` input at request time. Current Runway video inputs accept HTTPS URLs, Runway upload URIs, or base64 video data URIs up to 5 MB. 

The builder transcodes local motion clips conservatively and defaults to:

```env
MOTION_GUIDE_MAX_DATA_URI_BYTES=3600000
```

so base64 overhead remains below the provider input ceiling.

### Quality + deduplication

Every candidate receives a deterministic quality score based on:
- visible core-joint coverage
- useful duration
- meaningful motion energy
- classification confidence

Before insertion, TikTokMoney compares its normalized pose trajectory with existing references of the same action class.

At the default:

```env
MOTION_LIBRARY_DEDUPE_THRESHOLD=0.90
```

a biomechanically near-duplicate is discarded when the existing reference is equal/better quality, or replaced when the new clip is better.

`MotionGuideDirector` also uses `qualityScore` as a tie-break when two references have the same task-match score.

### Operational status

`GET /health` now also reports:

```json
{
  "motionLibrary": {
    "builderAvailable": true,
    "libraryPath": "./data/motion-references.json"
  }
}
```

The mutation path intentionally remains CLI-only until an authenticated/admin API exists.


## Real-generation benchmark

v0.25 adds a frozen 30-case, 10-category paid-provider benchmark that compares a plain Runway generation with the complete TikTokMoney audiovisual stack.

Planning is safe and free by default:

```bash
npm run benchmark:real
```

Paid provider calls require an explicit acknowledgement:

```bash
VIDEO_PIPELINE_MODE=audiovisual npm run benchmark:real -- --case talking-head-01 --confirm-spend
```

The harness records success, retries, latency, independent QC signals and provider-reported spend when available, then emits anonymized review clips for blinded human scoring. The corpus is content-hashed and must not be edited in place.

See [docs/REAL_GENERATION_BENCHMARK.md](docs/REAL_GENERATION_BENCHMARK.md) for the protocol, full-suite command, rating workflow and interpretation rules.
