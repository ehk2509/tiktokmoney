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
