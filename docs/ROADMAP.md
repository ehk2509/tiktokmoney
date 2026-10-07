# Prototype roadmap

## M0 - Foundation (this commit)

- [x] Node.js ESM project with zero runtime dependencies
- [x] Trend opportunity scoring
- [x] Structured script abstraction
- [x] Scene planning
- [x] Quality gate
- [x] Real vertical FFmpeg render
- [x] JSON project provenance
- [x] HTTP API + CLI
- [x] Built-in tests

## M1 - High-quality video generation

- [x] OpenAI-compatible structured LLM provider
- [x] Real stock footage provider (Pexels)
- [x] TTS provider + word timestamps (ElevenLabs)
- [x] Timing-aware kinetic subtitles + ASS/SRT sidecars
- [x] Multi-scene FFmpeg timeline
- [x] Asset cache and license metadata
- [ ] Render retry by failed stage

## M1.5 - Realism-first AI video

- [x] Realism-specific scene specification
- [x] Luma Photon reference-frame generation
- [x] Luma Ray image-to-video generation
- [x] AI-first visual routing with Pexels fallback
- [x] Cross-scene reference-image continuity
- [x] Generation polling, failure handling and local download
- [x] Vision-based photorealism/artifact QC
- [x] Automatic targeted regeneration
- [x] Strong character/location bible across a complete video
- [x] Temporal motion / morphing / flicker QC
- [x] Additional AI video providers / adaptive cost-quality router

## M1.8 - Audiovisual Director

- [x] Full AI production screenplay
- [x] Character, wardrobe, location, camera and audio direction
- [x] WAN 3 native-audio generation
- [x] Locked exact-dialogue mode via Runway TTS reference audio
- [x] Native-speech mode
- [x] Reuse canonical character/location references
- [x] Static + temporal QC for audiovisual acts
- [x] Trusted native-audio composition + authoritative TTS-only off-screen voiceover
- [x] Subtitle generation over audiovisual output
- [x] Dialogue-verbatim transcription QC
- [x] Cross-act identity / apparent-age / location QC
- [x] Subtitle safe-area / pixel-width QC
- [x] Publishability gate for script, scene, subtitle and audio failures
- [x] Audio loudness / clipping / silence QC
- [x] Visual speech-timing / lip-sync proxy QC
- [x] Learned frame-level deep A/V sync gate (SyncNet-class)
- [x] Pluggable phoneme / viseme score gates when evaluator supplies them
- [x] Bundled local phoneme / viseme mouth-shape classifier
- [x] Multi-speaker dialogue in one act
- [x] Stable per-character Runway voice assignment
- [x] Timed composed dialogue master
- [x] Speaker attribution / turn-taking QC
- [x] Off-screen exact-TTS post-mix with model-generated audio muted by default
- [x] Generated-text / pseudo-label artifact QC
- [x] Visual factual-consistency QC with contradiction-driven blocking
- [x] Semantic subtitle phrase completion from verified word timings
- [x] Deterministic label context preservation for negation / loss semantics

## M1.9 - Anti-plastic realism

- [x] Action/camera complexity risk scoring
- [x] Physical camera capture profiles
- [x] Automatic 24/30 fps profile selection
- [x] Stable-shot duration targets by risk
- [x] Prompt cleanup for synthetic quality keywords
- [x] Motivated imperfect lighting direction
- [x] Environmental micro-motion direction
- [x] Room-tone / foley soundscape direction
- [x] Material/camera/lighting realism QC
- [x] Bounded optical softness / saturation / contrast / grain post
- [x] Motion-blur safety guard against morphing defects
- [x] First/last-frame constrained generation where provider supports it
- [x] Motion-region / motion-brush-style semantic control + regional QC
- [ ] Native provider spatial-mask transport when an API exposes it
- [x] Risk-adaptive first-only vs first+last keyframe policy
- [x] Keyframe adherence QC and targeted regeneration
- [x] Concrete framing contracts for wide / close / macro / tracking / overhead / POV shots
- [x] Editorial-variety QC across consecutive acts
- [x] Transition-tail vs opening-frame comparison for delayed reframing
- [x] Conditional previous-act video references only for true continuation shots
- [x] Forced opening-keyframe escalation after repeated framing failures
- [x] Real-motion reference-video guidance for body mechanics/timing
- [x] Motion-reference selection + rights gate
- [x] Combined reference-video duration budgeting
- [x] Motion-guide adherence QC + targeted regeneration
- [x] Provider-neutral normalized pose / skeleton abstraction
- [x] Pluggable external pose extractor command
- [x] Bundled MediaPipe Pose Landmarker sidecar
- [x] One-command local pose setup + Docker preinstall
- [x] Automatic bundled-extractor discovery
- [x] Pose extraction cache with source-file invalidation
- [x] Pose sidecar CI smoke test
- [x] Pose capability health reporting
- [x] Automatic owned/licensed motion-library builder
- [x] Motion-energy auto segmentation
- [x] Pose-based action classification
- [x] Foot-contact annotation
- [x] Motion-reference quality scoring
- [x] Skeleton-based library deduplication
- [x] Local reference clips via bounded Runway data URI
- [x] CLI ingestion + read-only library API
- [x] Deterministic skeleton trajectory / joint-angle / rhythm / contact QC
- [x] Pose-summary prompt guidance from precomputed or extracted skeletons
- [ ] Native provider pose skeleton / mocap transport when providers expose it

## M2 - Trend intelligence

- [x] Pluggable trend ingestion (YouTube, Reddit, RSS/Atom)
- [x] Velocity/acceleration history
- [x] Topic clustering and deduplication
- [x] Creative candidate diversity + weighted ranking
- [x] Pre-generation creative quality/spend gate
- [x] Research packets with source provenance and downstream grounding
- [x] Idea tournament and independent judge

## M2.5 - Production evidence

- [x] Frozen 30-case real-provider corpus across 10 production classes
- [x] Plain-provider vs full-stack paired runner
- [x] First-pass/final success, retry and latency capture
- [x] Provider-reported spend capture without estimated-cost substitution
- [x] Blinded review aliases + separate arm key
- [x] Human publishability / realism / identity / dialogue / motion score import
- [x] Frozen-suite hash validation in tests
- [ ] Complete the first 30-case paid-provider run
- [ ] Establish release-over-release benchmark history on the unchanged suite hash

## M3 - Publishing + analytics

- [x] TikTok official publishing adapter with explicit-confirmation guard
- [ ] Scheduling queue
- [x] Post status + basic engagement metric snapshots
- [x] Creative feature extraction + TikTok outcome evidence
- [x] Controlled A/B experiment assignment + comparable-window evaluation

Current M3 publishing intentionally requires an explicit per-post confirmation and a user access token. OAuth/token-refresh UX, scheduling, webhooks and experiment assignment remain open.

## M3.5 - Autonomous production planning

- [x] Daily opportunity selection
- [x] Per-day estimated production budget
- [x] Max-video allocation
- [x] High-conviction multi-variant allocation
- [x] Recent-topic similarity cooldown
- [x] Persisted production queue + execution state
- [x] Frozen research packet per planned job

## M4 - Learning + monetization

- [ ] Revenue attribution
- [x] Provider-reported task cost ledger + conservative estimated-vs-actual daily budget reconciliation
- [x] OpenRouter QC usage/cost capture across all vision QC stages
- [x] OpenAI-compatible LLM token/cost provenance when provider reports it
- [x] External provider/account billing import and provenance reconciliation for non-reporting providers
- [ ] Native automated account-billing adapters where provider APIs expose billing endpoints
- [x] Conservative performance-learning context for future creative ranking by format/emotional driver
- [x] Bounded exploration via high-conviction control/challenger allocation
- [x] Campaign budgets and autonomous daily planning
