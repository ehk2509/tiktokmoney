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
narration / verified transcript
  -> exact word timing when available
  -> otherwise estimate word timing from retimed scenes
  -> restore script punctuation onto verified words
  -> group into semantic short phrases
       -> avoid weak connector endings
       -> finish short dependent clauses when layout permits
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
      -> exact TTS for locked dialogue
      -> WAN 3 audiovisual generation
      -> reference audio for visible speakers
      -> TTS-only post-mix for off-screen narration
      -> conditional previous-act video reference
      -> optional forced opening keyframe after repeated framing failures
  -> realism + temporal QC
  -> generated-text + visual-factual QC
  -> transition-aware editorial-variety QC
  -> AudiovisualRenderer
      -> keep trusted native audio or authoritative TTS
      -> concatenate acts
      -> loudness normalize
      -> burn subtitles + deterministic labels
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

Each accepted act is normalized to 1080x1920 H.264 + AAC, then acts are concatenated and the final soundtrack is loudness-normalized before publishability succeeds.

For visible-speaker/native-audio acts, the accepted model soundtrack is retained. For **off-screen voiceover**, exact TTS is authoritative: TikTokMoney replaces the generated act audio by default instead of mixing both together. This prevents faint duplicate speech, echo-like vocal artifacts, or looping model-generated effects from surviving under narration. Generated ambience can be explicitly opted back in with `VOICEOVER_GENERATED_AMBIENCE_GAIN>0`.

Subtitles and deterministic labels are burned in only after the underlying audiovisual acts pass QC.


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

### Cross-act continuity and shot-change isolation

The previous accepted act is **not** automatically sent as `referenceVideos` for every new act. A previous video reference makes WAN behave like it is continuing the same shot, which conflicts with deliberate framing changes.

TikTokMoney now sends the previous act as a video reference only when the new act is a true continuation: same shot type, same location, and no hard-cut transition. When the screenplay asks for a different shot type, continuity instead comes from the Story Bible, canonical references, location/lighting contracts, and optional keyframes.

QC still compares recurring character face geometry, apparent age, hair, body proportions, wardrobe, location geometry, fixed objects and lighting. The default cross-act continuity floor remains 85/100.

### Subtitle and label safety

Captions use verified word timings when available and are grouped into short semantic phrases before ASS rendering. The word-count limit is soft only when one or two extra words are needed to avoid stranding a connector or leaving a short dependent clause unfinished. Character count, timing gap, two-line layout, and rendered-width limits still remain hard bounds.

Deterministic labels are also constrained by the spoken narration. Labels must be contiguous spoken phrases, and nearby polarity/context such as `loss of`, `without`, `not`, or `no` is preserved when dropping it would reverse the meaning. The renderer refuses subtitle layouts that violate the safe-area contract.

### Audio safety

The renderer measures the joined soundtrack with FFmpeg EBU R128 analysis. Effectively silent audio is rejected before final encode. Final audio is normalized to -14 LUFS, LRA 7 and -1 dBTP, then measured again before success is returned.

For off-screen narration, the generated audiovisual bed is considered untrusted by default and is discarded before composition. Exact TTS is padded to the visual act length and becomes the authoritative audio stream. This is intentionally stricter than merely lowering the generated bed because duplicate synthetic speech can remain audible even at low gain.


### Editorial-variety and transition gate

A planned shot change must be visible **from the opening frames**, not merely by the middle of the act.

For each act after the first, the editorial-variety provider samples:

```text
previous accepted act
  -> tail: ~duration-1.0s, ~duration-0.2s

current act
  -> opening: ~0.15s, ~0.75s, ~1.5s
  -> whole act: distributed checkpoints
```

The evaluator reports `transitionDistinctness`, `shotTypeAdherence`, `compositionDifference`, `scaleOrAngleDifference`, and `editorialNovelty`. A concrete high/critical issue such as `transition-framing-reuse` blocks the act; a low numeric score without a concrete defect remains a warning.

Repeated editorial-variety failures have an independent retry budget. After two failed attempts, supported WAN generation can escalate to a generated opening keyframe in the required framing. The previous act may still be sampled as an identity/location reference for that still, but the keyframe prompt explicitly treats its camera framing as non-authoritative.

### Visual factual and generated-text gates

Generated footage is expected to remain text-free. Generated-text QC rejects pseudo-labels, captions, signage, or other model-rendered text artifacts before deterministic editor overlays are added.

Visual factual QC uses the narration/action contract to find **high-confidence visible contradictions** such as incorrect anatomy, reversed flow/mechanism direction, or the wrong object/species/place. Its numeric score is diagnostic only: generic footage, a narration preview of a later event, or a low score without a blocking contradiction does not trigger regeneration.


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


## Multi-speaker audiovisual dialogue

The audiovisual screenplay supports ordered non-overlapping dialogue turns for up to three characters in one act.

```text
ProductionScript.dialogueTurns
  -> one TTS request per turn using the recurring character voice
  -> download each voice clip
  -> ffprobe duration
  -> place clips on a non-overlapping timeline
  -> FFmpeg amix into one mono 48 kHz dialogue master
  -> encode MP3
  -> base64 data URI
  -> WAN referenceAudio
```

The combined master is preferred over unrelated audio references because it makes exact turn order and pause timing deterministic before video generation.

Each normalized character is assigned a valid Runway Eleven v3 preset. Duplicate or invalid generated presets are replaced with unused known presets so two recurring speakers do not accidentally share the same voice.

### Speaker blocking

The WAN prompt receives:

- all visible cast identity/wardrobe descriptions
- each measured turn start/end time
- exact words for each named speaker
- strict non-overlap instructions
- listener-silent behavior
- previous-act continuity references

Example:

```text
0.00-2.10s ALEX says exactly: "Is starting now too late?"
2.30-5.40s MAYA says exactly: "No. Consistency matters more."

Only the named active speaker talks and moves their mouth.
The listener reacts silently.
```

### Speaker-turn QC

A dedicated vision gate samples early/late points inside each measured dialogue turn and scores:

- speaker attribution
- active-speaker mouth motion
- listener stillness
- cast identity stability
- turn-taking clarity

This gate is complementary to dialogue WER, visual speech timing, SyncNet-class A/V sync, and phoneme↔viseme QC. WER verifies the words; speaker-turn QC verifies **who visibly says them**.


## Creative tournament

The production path now separates **creative search** from **expensive execution**.

```text
topic
  -> CreativeTournament
      -> candidate generator
      -> normalization / duplicate removal
      -> independent judge
      -> safety / feasibility hard rejects
      -> weighted rank
      -> winner + margin
  -> ProductionScriptGenerator(winner)
  -> reference generation
  -> voice / video generation
```

The tournament asks for materially different angles and formats rather than multiple paraphrases of one hook. Candidate metadata includes:

- angle
- exact hook
- format
- emotional driver
- retention device
- payoff
- visual opportunity
- dialogue style
- monetization fit
- production constraints
- risk notes

### Independent judging

The judge receives the complete candidate set and scores every candidate from 0-100 on:

```text
hookStrength
retentionPotential
clarity
novelty
productionFeasibility
monetizationFit
factualSafety
platformFit
```

The default weighted score is:

```text
0.22 hook
0.20 retention
0.13 clarity
0.12 novelty
0.10 feasibility
0.08 monetization
0.08 factual safety
0.07 platform fit
```

The generator and judge can use different models through `LLM_MODEL` and `CREATIVE_JUDGE_MODEL`. Even when they use the same model, candidate generation and judgment are separate calls with different instructions and temperatures.

A judge can set `hardReject=true` for deceptive, fabricated, copyright-dependent, or infeasible concepts. A hard-rejected candidate receives an effective score of zero regardless of its hook score.

### Spend gate

The default winner floor is 68/100. If the best concept does not reach that threshold, the project terminates as `CREATIVE_REJECTED` before:

- full production screenplay generation
- continuity-reference generation
- TTS
- video generation
- audiovisual QC

This keeps weak ideas from consuming the expensive part of the pipeline.

The full tournament provenance is retained in `project.creativeTournament`; the winning brief is copied to `project.creativeBrief` and becomes binding input to the production screenplay.


## Live trend intelligence

The M2 trend layer normalizes changing public signals before they reach creative generation.

```text
source adapters
  -> normalized TrendSignal[]
  -> lexical topic clustering
  -> cross-source cluster strength
  -> TrendHistoryStore
  -> velocity / acceleration
  -> OpportunityScorer
  -> ResearchPacket
  -> CreativeTournament
```

### Signal contract

Every adapter emits a common shape containing:

- stable source id
- source name
- topic/title
- snippet
- canonical URL
- published/observed timestamps
- normalized 0-100 strength
- raw engagement/source metrics

The adapters keep provider-specific measurements in `sourceMetrics` instead of forcing raw view counts, Reddit scores, and RSS positions into the same unit.

### Clustering

Signals are ordered by strength, normalized into language-agnostic alphanumeric tokens, stripped of common stop words, then clustered by Jaccard/containment similarity. Each cluster preserves all evidence and reports source diversity.

No embedding API is required, keeping the trend loop cheap and deterministic. A later semantic-clustering implementation can replace the similarity function without changing the provider contract.

### Historical momentum

`TrendHistoryStore` persists up to 64 observations / seven days per cluster. Current strength and the delta against the previous snapshot produce bounded 0-100 velocity and acceleration features consumed by the existing opportunity scorer.

This means `acceleration` is based on observed change rather than being guessed from a single request.

### Research before creative

The selected topic is searched across configured providers before the audiovisual Creative Tournament. The resulting ResearchPacket is retained in project provenance and sent to:

1. creative candidate generation
2. independent candidate judging
3. production screenplay generation

The LLM contract explicitly prohibits inventing facts not supported by the packet and asks the judge to penalize creative premises that outrun available evidence.

### Failure isolation

Trend sources are independent. Collection uses settled provider calls; an unavailable YouTube/Reddit/RSS source does not suppress healthy sources. This keeps trend discovery usable under API quota, token expiry, or feed outages.


## Autonomous daily planner

The planner sits between opportunity ranking and the production pipeline.

```text
TrendIntelligence.list()
  -> DailyContentPlanner
       -> quality/evidence filters
       -> recent-topic similarity filter
       -> budget allocator
       -> variant allocator
       -> creative-search-depth allocator
  -> DailyPlanStore
  -> executePlan()
       -> AudiovisualPipeline.generate()
       -> persisted job result
```

### DailyPlanStore

`daily-plans.json` retains up to 180 plans. A job is also short-term topic memory: queued, completed, failed, and rejected jobs remain visible to the cooldown policy, while explicitly skipped jobs do not count as production history.

### Allocation policy

The planner consumes opportunities in existing opportunity-score order. For each eligible opportunity it calculates an estimated per-video cost and the maximum affordable slots.

Normal opportunities receive one slot. High-conviction opportunities may receive multiple slots only when they combine:

- strong opportunity score
- positive/rising acceleration
- multiple independent sources

This avoids spending multiple generations on a single-source viral spike.

### Reproducible execution

A queued job freezes:
- the source-grounded research packet
- audience
- duration
- render policy
- creative candidate count
- opportunity metrics
- production variant number

During execution, that frozen research packet is passed directly into the audiovisual pipeline. The pipeline does not re-run trend research when a packet is supplied.

The creative tournament accepts per-job `candidateCount` and `variantIndex`. Variant index is propagated to the LLM so repeated high-conviction slots are instructed to explore distinct creative batches.

### State machine

```text
PLAN: EMPTY | PLANNED -> RUNNING -> COMPLETED | PARTIAL | FAILED

JOB: QUEUED -> RUNNING -> COMPLETED
                      -> REJECTED
                      -> FAILED
```

A project ending in `CREATIVE_REJECTED`, QC failure, publishability failure, or render failure is never counted as a completed production job.

### Budget limitation

The current planner enforces a budget against estimated slot cost. It does not yet aggregate actual provider invoices/tokens/credits. The future cost ledger should record actual spend per LLM, TTS, video generation, regeneration and QC call, then reconcile plan estimate versus realized daily spend.


## Anti-plastic realism architecture

`RealismDirector` is a deterministic transformation over the normalized ProductionScript. It does not require another model call.

For each act it derives a risk score from:

- complex hand/object interactions
- athletic or rapid body motion
- physically complex camera instructions
- number of visible characters
- multi-speaker blocking

The risk score determines a maximum stable-shot target and whether a long act should stay continuous or use a small number of clean cuts.

The director also selects a project-wide capture profile so every normalized act uses the same final frame rate. This avoids concat instability while still supporting style-aware 24 fps versus 30 fps output.

### Prompt realism contract

The generated model prompt now includes physical instead of marketing-style quality language:

- one camera axis at a time
- human-operated inertia and minor reframing
- believable focus/exposure settling
- motivated practical/natural light and falloff
- breathing, posture correction, clothing/hair motion
- gravity/contact/body-weight constraints
- location-specific room tone and synchronized foley

### Bounded optical post

The post stage runs before final concat and uses stable FFmpeg filters only:

```text
scale/crop
 -> slight gblur
 -> small saturation/contrast correction
 -> low-strength temporal noise/grain
 -> project frame-rate normalization
```

No chromatic shift is applied by default. Synthetic motion blur is explicitly gated because it can hide judder but worsen or smear morphing/anatomical defects.

### QC

Realism QC includes three additional dimensions:

- `materialRealism`
- `cameraPhysics`
- `lightingNaturalism`

Older/mocked QC responses that do not return these fields fall back to the photorealism score, preserving backwards compatibility.


## First / last frame control

The keyframe layer runs after RealismDirector because the realism risk score determines how much endpoint control is worth paying for.

```text
normalized ProductionScript
  -> RealismDirector
  -> KeyframeDirector
       -> off
       -> first
       -> first-last
  -> RunwayAudiovisualProvider
```

### Script contract

Audiovisual segments may contain:

```json
{
  "startState": "exact stable visual state before the main action",
  "endState": "physically reachable final visual state after the main action"
}
```

If the LLM omits either field, KeyframeDirector derives a conservative fallback from the normalized action.

### Adaptive policy

The default thresholds are tied to the existing anti-plastic risk score:

```text
risk < 32     -> off
32 <= risk<50 -> first
risk >= 50    -> first-last
```

This avoids doubling image-generation cost for simple talking-head acts while applying stronger constraints to hands/objects, action, multiple people and complex camera motion.

### Keyframe generation

Runway `gen4_image` produces the first keyframe from:
- canonical character images
- canonical location image
- previous accepted endpoint when available
- startState
- the physical-camera realism profile

The last keyframe also references the newly generated first frame and uses `endState`. This prevents the endpoint generator itself from freely redesigning the subject or location.

### WAN request contract

For supported audiovisual models (`wan3`, `wan3_prime`), a keyframed act uses:

```text
/image_to_video
promptImage = [
  { uri: first, position: "first" },
  { uri: last,  position: "last"  }
]
ratio = auto_720p
referenceAudio = locked dialogue when configured
referenceVideos = previous accepted act when available
```

Image references are not mixed into the WAN keyframe request; they are consumed while generating the first/last images. This respects Runway's distinction between keyframe images and general image references.

Unsupported audiovisual models skip keyframe mode and retain the normal generation path.

### Fail-open policy

Image generation is an additional dependency. By default `KEYFRAME_FAIL_OPEN=true`, so a failed keyframe task records the error and falls back to text-to-video. Production can make keyframes mandatory by setting it to false.

### Verification

Realism QC receives the exact first and last keyframe images alongside sampled generated frames. When keyframes exist it requires explicit `keyframeStartMatch` / `keyframeEndMatch` scores above the configured threshold. Missing scores fail the keyframe gate rather than inheriting the generic photorealism score.


## Motion region control

The MotionRegionDirector runs after realism and keyframe planning.

```text
ProductionScript
  -> RealismDirector
  -> KeyframeDirector
  -> MotionRegionDirector
  -> audiovisual provider
```

It emits a provider-neutral semantic contract:

```json
{
  "allowedMotion": [
    {
      "id": "speech-mouth-jaw",
      "region": "active speaker mouth and jaw",
      "behavior": "speech articulation only",
      "intensity": "low"
    }
  ],
  "lockedRegions": [
    {
      "id": "environment-anchors",
      "region": "walls, doors, windows, furniture...",
      "rule": "preserve rigid geometry",
      "tolerance": "locked"
    }
  ]
}
```

### Region construction

The director derives regions deterministically from existing screenplay/realism metadata:

- spoken dialogue enables mouth/jaw articulation
- hand/object interactions enable hands, forearms and the primary prop
- athletic/action scenes enable the biomechanical body chain
- micro-motion directions can enable loose hair/fabric or explicitly motivated environmental motion
- face identity is locked outside required articulation
- static background anchors remain locked
- inactive speakers are constrained during another character's dialogue turn

### Camera-aware locking

A static camera uses strict screen-space stability for background anchors.

A moving camera changes the rule to **parallax-only**: fixed geometry may move across the image because the camera moves, but individual background objects may not independently warp, slide, grow or animate.

This prevents a naive mask policy from incorrectly rejecting normal perspective change.

### Provider transport

The current audiovisual Runway path exposes:

```text
motionControlMode = semantic-region-prompt
nativeMotionMask = false
```

The semantic contract is inserted directly into the generation prompt.

No undocumented `mask` or `motionBrush` parameter is sent.

The interface intentionally separates:
- motion intent
- provider transport

so a future provider can implement native masks without changing screenplay or QC contracts.

### Motion-region QC

The regional gate is activated only when the returned asset says the provider applied motion-region control. Legacy providers and mocks are not penalized.

The vision/temporal QC model receives the exact allowed and locked region contract and returns a separate `motionRegionScores` block:

```text
motionRegionCompliance
lockedRegionStability
intendedMotionCompliance
backgroundDriftFreedom
```

These scores do **not** alter the historical generic `temporalScore`; they form an independent gate. This preserves backwards-compatible temporal metrics while adding a stricter anti-drift requirement.

When the gate fails, deterministic regeneration guidance repeats the relevant locked and allowed regions, with a separate rule for static-camera background lock versus moving-camera parallax.


## Real-motion video guidance

The motion-guide layer runs after the deterministic realism/keyframe/region directors because it consumes their risk and camera metadata.

```text
ProductionScript
  -> RealismDirector
  -> KeyframeDirector
  -> MotionRegionDirector
  -> MotionGuideDirector
       -> classify action
       -> risk eligibility
       -> select licensed real-motion reference
  -> RunwayAudiovisualProvider
```

### MotionReferenceStore

The default store reads:

```text
./data/motion-references.json
```

The repository ships only `data/motion-references.example.json`.

Each usable record contains:

```text
id
actionClass
tags
cameraMode
people
durationSeconds
url
source
license
verifiedHumanMotion
rightsConfirmed
```

The store rejects non-HTTPS references and references longer than 15 seconds. By default the director additionally requires `rightsConfirmed=true`.

### Selection

MotionGuideDirector uses deterministic scoring rather than another LLM call.

A reference gets credit for:

```text
exact action class       0.55
action/tag overlap       up to 0.20
camera compatibility     0.10
duration fit             up to 0.10
person-count match       0.05
```

A simple speaking scene is not eligible. In auto mode, physical-action scenes also need to clear the configured realism-risk threshold.

### Provider transport

For WAN audiovisual generation the selected real-motion clip is sent through `referenceVideos`.

This keeps the existing generation contract compatible with:

- first/last keyframes
- locked reference dialogue audio
- canonical story-bible image generation
- native audiovisual output

The prompt distinguishes motion authority from appearance authority:

```text
motion reference:
  timing / trajectory / mechanics

canonical refs + keyframes:
  identity / wardrobe / location / lighting / composition
```

### Reference-video budget

The provider constructs an ordered reference plan.

Priority:

1. selected human motion guide
2. previous accepted act for continuity

References are added only while the known combined duration remains <=15 seconds. Unknown previous-act duration is conservatively budgeted as 15 seconds.

This prevents an otherwise valid generation from being rejected by the provider because accumulated video references exceed the model contract.

### Local guide cache

Before submission, the selected guide is downloaded into `ASSET_DIR` using a URL fingerprint.

The local copy serves two purposes:

- identical guide URLs are not repeatedly downloaded
- realism QC can sample the exact same guide used for generation

If download fails and `MOTION_GUIDE_FAIL_OPEN=true`, the provider removes motion-guide language/reference from the request and records the error in asset provenance.

### Motion-guide QC

When `asset.motionGuideMode=reference-video`, the realism evaluator samples the real-motion clip and generated clip as separate chronological sequences.

It receives explicit instructions to ignore:
- identity
- wardrobe
- environment
- light
- visual style

and evaluate only:
- action trajectory
- pose order
- rhythm / acceleration
- grips / contacts / releases
- foot plants
- weight transfer

The guide gate is independent from generic temporal score and Motion Region QC. A generation must pass all enabled gates.

The asset/project provenance records the selected reference id, selection score, local cache path, reference-video roles and any dropped continuity references.


## Pose / skeleton motion abstraction

The pose subsystem sits underneath Motion Guide and is deliberately provider-neutral.

```text
real motion reference
  -> PoseMotionExtractor
       -> optional embedded poseSequence
       -> or external command
  -> normalizePoseSequence()
       -> body-center translation removal
       -> torso/shoulder/hip scale normalization
  -> skeleton summary
       -> generation prompt
  -> generated video
       -> PoseMotionExtractor
       -> normalized skeleton
  -> PoseMotionQcProvider
```

### Extractor boundary

The JavaScript runtime has no mandatory pose-estimation dependency.

`PoseMotionExtractor` shells out to an optional command and expects one JSON file. This keeps the core compatible with any extractor capable of producing timestamped 2D joints.

The adapter replaces these placeholders in configured args:

```text
{video}
{output_json}
{fps}
{duration}
```

### Normalization

Raw image coordinates are not compared directly.

For every frame:

1. estimate body center from hips, then shoulders, then visible-joint centroid
2. estimate body scale from torso length, shoulder width or hip width
3. translate joints around the body center
4. divide x/y by body scale
5. retain per-joint confidence

This removes most performer position/size differences before motion comparison.

### Resampling

Reference and generated sequences are resampled onto the same normalized 0..1 timeline.

The deterministic comparator evaluates:

- normalized joint-position trajectory
- elbow / hip / knee angle progression
- normalized whole-body motion-energy rhythm
- annotated contact events when available
- common-joint coverage

### Independent QC

`PoseMotionQcProvider` is separate from OpenRouter temporal QC.

This matters because a vision model can judge a clip as plausible while missing a biomechanical mismatch that is obvious in normalized joint trajectories.

The pose gate participates in the standard audiovisual retry loop and can produce the dedicated terminal state:

```text
POSE_MOTION_QC_FAILED
```

when the configured retry budget is exhausted.

### Graceful fallback

If `POSE_EXTRACTOR_COMMAND` is absent, pose-motion QC is not constructed by default.

Embedded `poseSequence` data can still enrich the generation prompt, because the reference skeleton does not require extracting the generated video. Full deterministic comparison only becomes active when generated-video pose extraction is available.

The current Runway path does not expose a native skeleton/mocap parameter in the contract used by TikTokMoney. The normalized pose layer therefore improves prompting and QC today while remaining ready for a future native pose transport.


## Bundled MediaPipe pose sidecar

v0.23 adds a concrete default implementation behind the v0.22 `PoseMotionExtractor` boundary.

```text
video file
   ↓
FFmpeg frame sampler
   ↓
MediaPipe Pose Landmarker (VIDEO mode)
   ↓
33 timestamped landmarks
   ↓
PoseMotionExtractor normalization
   ↓
pose cache
   ↓
generation summary + deterministic QC
```

### Local installation

`npm run setup:pose` creates an isolated `.venv-pose` and installs `scripts/pose-sidecar-requirements.txt`.

The setup then downloads the Pose Landmarker Full task model into:

```text
models/pose_landmarker_full.task
```

Both the venv and downloaded binary model are intentionally ignored by Git.

### Runtime discovery

When no explicit `POSE_EXTRACTOR_COMMAND` is provided, `PoseMotionExtractor` checks for:

```text
<repo>/.venv-pose/bin/python
<repo>/.venv-pose/Scripts/python.exe
/opt/tiktokmoney-pose/bin/python
```

If one exists together with the bundled extractor script, the extractor is classified as:

```text
kind = bundled-mediapipe
```

Custom commands retain `kind = external-command`.

### Docker

The production Docker image includes:
- Python 3
- isolated `/opt/tiktokmoney-pose` virtual environment
- pinned MediaPipe package
- official Pose Landmarker Full model
- build-time sidecar health check

No OpenCV package is required. FFmpeg performs video decode and sampling.

### Cache

The Node adapter caches normalized results in `POSE_CACHE_DIR`.

The fingerprint includes file path, size, mtime, sampling rate and extractor contract. The cache is therefore reusable for immutable motion-reference assets but invalidates when the source changes.

Writes use a temporary file + rename so a partially written extraction does not become a valid cache entry.

### Factory behavior

`createPoseMotionQcProvider()` constructs the extractor first.

When `POSE_MOTION_QC_ENABLED` is unset:
- discovered sidecar -> QC enabled
- no sidecar -> QC absent

When explicitly enabled without an available extractor, startup fails with a setup instruction instead of silently claiming biomechanical QC is active.

### Operations

`GET /health` exposes the effective pose capability:

```text
enabled
extractorAvailable
extractorKind
bundled
```

This separates installed capability from configuration and prevents deployments from assuming pose verification is running when it is not.


## Automatic motion-library builder

v0.24 adds an offline ingestion pipeline around `MotionReferenceStore`.

```text
capture directory / clip
  -> rights gate
  -> PoseMotionExtractor
  -> detectMotionSegments()
  -> classifyPoseSequence()
  -> detectFootContacts()
  -> scoreMotionReferenceQuality()
  -> findDuplicate()
  -> FFmpeg reference transcode
  -> MotionReferenceStore.write()
```

### Store contract

`MotionReferenceStore` remains backwards-compatible with HTTPS references and now also accepts local references:

```json
{
  "id": "squat-...",
  "actionClass": "squat",
  "durationSeconds": 6.2,
  "url": "",
  "localPath": "data/motion-library/squat-....mp4",
  "qualityScore": 87,
  "classificationConfidence": 0.91,
  "autoGenerated": true,
  "rightsConfirmed": true,
  "poseSequence": {}
}
```

Writes are atomic through a temporary file + rename.

### Segmentation

Pose motion energy is computed from normalized shoulders, elbows, wrists, hips, knees and ankles.

A robust per-clip threshold is derived from the clip's own positive-motion distribution. Active regions separated by less than roughly 0.8 seconds are kept together, padded slightly, then split to the configured maximum reference duration.

Only the highest-activity bounded windows are retained.

### Classification

The first deterministic classifier covers the motion families most useful to short-form human scenes:

- squat: large correlated bilateral knee-angle range
- lifting: large wrist vertical travel + elbow articulation
- walking/running: alternating lower-limb motion + knee articulation
- reaching: large wrist trajectory with limited lower-body articulation
- jumping: high whole-body articulated motion

An explicit action hint is authoritative when supplied.

Unknown/ambiguous movement remains `general` and is rejected by default.

### Contact inference

The builder derives conservative left/right foot-plant events from low ankle velocity near the lower support region of the body-normalized pose.

These annotations flow into the existing deterministic contact-mechanics QC.

### Quality scoring

Candidate quality combines:
- core-joint visibility coverage (50%)
- useful duration fit (18%)
- motion signal (20%)
- classification confidence (12%)

The default acceptance floor is 62/100.

### Deduplication

Candidates are compared only against references in the same action class.

The existing deterministic `comparePoseSequences()` result becomes a similarity score. At >=0.90, the library keeps the higher-quality example.

Deduplication runs against the existing library and against earlier accepted segments from the same ingestion batch.

### Local provider transport

The library stores media paths, not base64.

When a selected reference has `localPath`, `RunwayAudiovisualProvider.prepareMotionGuide()`:
1. verifies the local file
2. enforces the configured raw-byte budget
3. reads that one file
4. converts it to `data:video/mp4;base64,...`
5. places it in `referenceVideos`

Remote HTTPS references continue through the existing download/cache path unchanged.

This makes automatically cut local clips immediately usable without requiring S3/CDN/public hosting.

### Security boundary

Building the library is CLI-only because ingestion accepts local filesystem paths and remote source URLs.

The HTTP API exposes only read access through `GET /api/motion-library` until an authenticated administration surface exists.
