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

The current continuity mechanism is intentionally conservative: the previous accepted reference image is supplied to the next reference-frame generation with a configurable weight. A later milestone will replace this with explicit character/location bibles.

## Realism QC and targeted regeneration

When enabled, realism QC runs before narration and final rendering:

```text
generated AI clip
  -> FFmpeg frame sampler
  -> 3 compact JPEG checkpoints
  -> OpenRouter vision model
  -> realism score + concrete defect list
       |
       +-- pass -> accept scene
       |
       +-- fail -> feed corrective guidance back to Luma
                     |
                     +-- regenerated scene -> QC again
                     |
                     +-- still fails -> Pexels real-footage fallback
                                          |
                                          +-- unavailable -> VISUAL_QC_FAILED
```

The evaluator scores photorealism, anatomy, geometry, physics, motion consistency, continuity, scene relevance and artifact freedom. Each attempt is retained in `visualQcHistory` together with generation IDs and feedback.

QC is opt-in to avoid surprise inference cost, but once enabled it is fail-closed by default. A QC service failure therefore falls back to real footage or stops the project instead of silently accepting an unreviewed AI scene.


## Character and location continuity bibles

Every video now builds a canonical continuity artifact before expensive visual generation:

```text
script
  -> StoryBibleGenerator
      -> recurring characters
      -> recurring locations
      -> camera / lighting language
      -> scene bindings
  -> Luma canonical references
      -> 1-4 identity images per recurring character
      -> one canonical establishing image per location
  -> scene generation
      -> character_ref
      -> location image_ref
      -> previous accepted scene image_ref
      -> Photon reference frame
      -> Ray image-to-video
```

The Luma image API supports up to four image references and a dedicated `character_ref` structure. TikTokMoney uses those native controls rather than relying only on repeated text prompts.

Canonical references live in `project.storyBible.references` and are reused across regeneration attempts. This prevents targeted QC regeneration from accidentally changing the actor, wardrobe, cockpit/room layout, lighting language or camera identity while correcting an artifact.

The QC evaluator also receives the textual bible and treats visible drift from canonical character, location and style constraints as a continuity defect.


## Temporal motion QC

Static-looking frames are not enough for realistic AI video. A clip can look excellent at three checkpoints while briefly morphing, flickering, teleporting objects or changing facial identity between those frames.

TikTokMoney now samples two complementary sets:

```text
AI clip
  -> 3 larger realism checkpoints
  -> 8 smaller chronological temporal frames
  -> one multimodal vision request
       -> static realism score
       -> temporal stability score
```

The temporal evaluator measures:

- identity stability
- object persistence
- geometry stability
- motion plausibility
- camera continuity
- flicker freedom
- temporal artifact freedom
- action continuity

Acceptance requires both thresholds. By default:

```text
static realism >= 82
temporal stability >= 80
```

A scene that scores 93 on static realism but 54 on temporal stability is rejected. Its temporal defect description is fed into the existing Luma targeted-regeneration path, so guidance can explicitly request stable facial identity, no morphing, smoother camera motion or removal of texture flicker.

Temporal QC shares the same OpenRouter request as static QC to keep inference cost bounded. The denser sequence uses smaller frames and preserves strict timestamp ordering in the multimodal message.


## Adaptive multi-model video routing

TikTokMoney no longer treats one video model as universally best. Current production candidates can include:

```text
Luma Agents / Ray 3.2
Runway / Gen-4.5
Runway / Gen-4 Turbo
```

The router classifies every scene as `human`, `human-action`, `action`, `environment`, `object`, or `general`. It then combines:

- a static capability profile for that model
- estimated generation cost
- provider generation-failure history
- historical realism-QC pass rate
- average static realism score
- average temporal stability score
- the current regeneration defect type

Routing outcomes are persisted to `provider-stats.json`. This turns the QC system into training data for future routing decisions without requiring an ML model yet.

On a QC rejection, the retry carries the previous provider ID. By default the router penalizes that same provider, making cross-model recovery possible:

```text
scene
  -> Gen-4 Turbo
  -> temporal QC fails
  -> retry router penalizes Gen-4 Turbo
  -> Ray 3.2 or Gen-4.5
  -> QC passes
```

Current public API pricing is encoded only as a routing estimate, not an accounting guarantee. Provider prices can change and should be refreshed periodically. The router's observed quality history is therefore more important than the initial hand-authored capability scores.

### Current provider surfaces

New Luma deployments use the current Agents API with `ray-3.2` for video and `uni-1` for reference images. The earlier Dream Machine `ray-2` / Photon integration remains only for backwards compatibility.

Runway uses `POST /v1/image_to_video` with the 2024-11-06 API version and downloads task outputs immediately because Runway output URLs are ephemeral.


## Subtitle timeline

Subtitles are a post-QC presentation layer:

```text
narration
  -> ElevenLabs word timing when available
  -> otherwise estimate word timing from retimed scenes
  -> group into short readable phrases
  -> create one highlight event per spoken word
  -> ASS timeline
  -> final FFmpeg burn-in
  -> MP4 + ASS + SRT
```

Subtitles are intentionally not rendered into individual generated scenes. This keeps realism and temporal QC focused on the underlying footage and lets subtitle styling evolve independently.

The default vertical-safe style uses DejaVu Sans, a large font, strong outline, bottom-center alignment and a word-level active highlight. Docker installs `fonts-dejavu-core` so output is deterministic across development and container environments.


## Audiovisual Director

The scene-composer architecture is no longer the only production path. `VIDEO_PIPELINE_MODE=audiovisual` uses a screenplay-first audiovisual architecture.

```text
Topic
  -> ProductionScriptGenerator
  -> ProductionScript
      -> exact dialogue
      -> characters + voice direction
      -> locations
      -> visual/camera direction
      -> ambience/SFX/music direction
      -> 4-15s acts
  -> reference bible
  -> RunwayAudiovisualProvider
      -> optional exact TTS per act
      -> WAN 3 with native audio
      -> audio reference + visual references
  -> existing realism + temporal QC
  -> AudiovisualRenderer
      -> preserve model-generated audio
      -> concatenate acts
      -> burn subtitles
```

### Why acts are capped at 15 seconds

WAN 3 supports 2–30 second native-audio output, but its audio-reference budget is currently 15 seconds. TikTokMoney therefore uses acts of 4–15 seconds when exact dialogue locking is enabled. This lets the system provide a generated speech track as `referenceAudio` while still allowing WAN to create synchronized visuals, ambience and effects.

### Locked vs native dialogue

Locked mode:

```text
exact screenplay dialogue
  -> Runway Eleven v3 speech
  -> audio reference
  -> WAN 3 audiovisual generation
```

Native mode:

```text
exact screenplay dialogue in prompt
  -> WAN 3 generates speech + sound + video directly
```

Locked mode is the default because generated-video models can otherwise paraphrase or omit dialogue.

### Rendering contract

The audiovisual renderer never strips scene audio. Each generated act is normalized to 1080x1920 H.264 + AAC, acts are concatenated with audio intact, then subtitles are burned in during the final video pass while audio is stream-copied.


## Publishability gate

The audiovisual path now distinguishes “generation completed” from “safe to publish”.

```text
production script
  -> meta-language check
  -> audiovisual generation
  -> static + temporal QC
  -> previous-act continuity comparison
  -> subtitle pixel-width safe-area validation
  -> native audio signal inspection
  -> -14 LUFS / -1 dBTP normalization
  -> final audio inspection
  -> RENDERED
```

### Cross-act continuity

For every act after the first, WAN receives the previous accepted act as `referenceVideos`. QC also samples the previous act and compares recurring character face geometry, apparent age, hair, body proportions, wardrobe, location geometry, fixed objects and lighting. The default cross-act continuity floor is 85/100.

### Subtitle safety

Captions are greedily wrapped using an estimated font-width model. A cue may use at most two lines and each rendered line must remain within the configured pixel width. The renderer refuses to burn captions when the safe-area contract fails.

### Audio safety

The renderer measures the joined native soundtrack with FFmpeg EBU R128 analysis. Effectively silent audio is rejected before final encode. Final audio is normalized to -14 LUFS, LRA 7 and -1 dBTP, then measured again before success is returned.


## Dialogue fidelity and speech-timing QC

Native audiovisual generation is not trusted to preserve spoken copy automatically. Every accepted act can now pass through an independent audio-verification path:

```text
generated MP4
  -> gpt-transcribe
      -> transcript
      -> word timestamps
  -> screenplay/transcript alignment
      -> WER
      -> insertions
      -> deletions
      -> substitutions
  -> speech-active/pause sample plan
  -> sampled mouth/face frames
  -> OpenRouter vision speech-timing QC
  -> regenerate if either gate fails
```

The transcription provider uploads the generated MP4 directly to the current OpenAI audio-transcriptions endpoint and requests `verbose_json` with `word` and `segment` timestamps. The expected screenplay text is not supplied as a transcription prompt, avoiding circular verification.

A dialogue mismatch feeds concrete missing/added/substituted words into the existing audiovisual regeneration guidance. If the independent transcript passes, those word timings are also reused for final subtitle timing.

### Lip-sync scope

The current lip-sync gate is a timing-level visual proxy, not phoneme-level measurement. It samples frames at independently transcribed spoken-word midpoints and true pause gaps, then checks:

- speaker/mouth visibility
- mouth activity during speech
- mouth stillness during pauses
- stable face/mouth geometry
- broad visual timing plausibility

This catches frozen-mouth speech, obvious continued talking during pauses, hidden-speaker failures and unstable facial motion. A future milestone can add a dedicated phoneme/viseme alignment model for frame-accurate lip-sync scoring.


## Deep audiovisual synchronization

The visual speech-timing proxy can be supplemented with a dedicated learned A/V synchronization model.

```text
generated audiovisual act
  -> independent transcript / word timing
  -> visual speech-timing QC
  -> external deep sync evaluator
       -> A/V offset frames
       -> A/V offset milliseconds
       -> synchronization confidence
       -> per-track/segment stability
       -> optional phoneme alignment score
       -> optional viseme alignment score
  -> regenerate on failure
```

The Node application executes the evaluator directly with `spawn(..., shell: false)` and expects JSON on stdout. Argument templates support `{video}`, `{transcript}` and `{expected}`, so deployments can use SyncNet or replace it with another evaluator without changing pipeline code.

The repository includes `scripts/syncnet_qc.py`, an optional adapter for `syncnet-python`. The Python package and model weights are deliberately outside the default Node install.

Default deep-sync acceptance:

```text
absolute A/V offset <= 80 ms
confidence >= 5
passing segment/track ratio >= 0.80
```

If a compatible evaluator supplies normalized `phonemeAlignmentScore` or `visemeAlignmentScore`, the same gate can enforce configured minimums. SyncNet's own result is not presented as phoneme/viseme classification; it remains a frame-level correspondence metric.


## Bundled phoneme↔viseme classification

TikTokMoney now has a local articulation verifier in addition to the global SyncNet-class offset metric.

```text
verified generated speech
  -> word timestamps
  -> CMUdict / fallback G2P
  -> ARPAbet phonemes
  -> 15-viseme labels
  -> visually compatible macro-viseme family
        |
        +---------------------------+
                                    |
generated video                     |
  -> MediaPipe FaceMesh             |
  -> mouth landmark geometry        |
  -> normalized openness/width      |
  -> prototype mouth classifier ----+
                                    |
                                    v
                         timeline alignment score
```

### Visual classes

The expected 15-viseme inventory is reduced only where visual ambiguity requires it:

- `closed`: silence, PP
- `narrow`: FF, TH, DD, kk, SS, nn, RR
- `rounded`: CH, oh, ou
- `wide`: E, ih
- `open`: aa

This is deliberate. Several phonemes are acoustically distinct but visually indistinguishable, so forcing a 15-way visual classifier would manufacture precision the image does not contain.

The classifier samples the generated video at expected phoneme midpoints, extracts mouth opening and width relative to face geometry, normalizes those values within the act, and assigns soft probabilities to the five visual families. It reports:

- phoneme alignment probability
- top-family viseme accuracy
- usable face/mouth coverage
- per-family accuracy
- expected→observed confusion counts
- timestamped worst mismatches

The default gate requires:

```text
phoneme alignment >= 0.72
viseme alignment >= 0.68
usable face coverage >= 0.72
```

A failure feeds the worst concrete mismatches back into audiovisual regeneration and can terminate as `PHONEME_VISEME_QC_FAILED`.
