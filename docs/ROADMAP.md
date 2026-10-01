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
- [x] Audio-preserving final composition
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

## M2 - Trend intelligence

- [x] Pluggable trend ingestion (YouTube, Reddit, RSS/Atom)
- [x] Velocity/acceleration history
- [x] Topic clustering and deduplication
- [x] Creative candidate diversity + weighted ranking
- [x] Pre-generation creative quality/spend gate
- [x] Research packets with source provenance and downstream grounding
- [x] Idea tournament and independent judge

## M3 - Publishing + analytics

- [ ] TikTok official publishing adapter
- [ ] Scheduling queue
- [ ] Post metrics snapshots
- [ ] Creative feature extraction
- [ ] A/B experiment model

## M4 - Learning + monetization

- [ ] Revenue attribution
- [ ] Cost-per-video ledger
- [ ] Strategy analytics by hook/duration/style
- [ ] Contextual exploration/exploitation policy
- [ ] Campaign budgets and autonomous daily planning
