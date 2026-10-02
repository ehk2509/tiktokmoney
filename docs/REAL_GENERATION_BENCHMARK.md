# Frozen real-generation benchmark

TikTokMoney v0.25 adds a release-grade evidence harness for the part of the system that unit tests cannot prove: whether the complete production stack makes real paid-provider generations more publishable than a plain provider call.

## Frozen corpus

The v1 suite lives at `data/benchmarks/real-generation-v1.json`.

- 30 cases
- 10 production classes
- 3 cases per class
- talking head
- two-person dialogue
- walking
- gym/lifting
- object interaction
- indoor
- outdoor
- low light
- tracking camera
- static camera

The suite is content-addressed. Its frozen SHA-256 is:

`281b64698b5e92e8b59c14d8cc393ce7c05acd642d36df98c5ef6c443f6c5508`

Never edit v1 in place. If the corpus needs to change, create a new suite version and freeze a new hash.

## Safe planning

The benchmark does not spend provider credits by default:

```bash
npm run benchmark:real
```

Select one case or a small subset while validating configuration:

```bash
npm run benchmark:real -- --case talking-head-01
npm run benchmark:real -- --cases talking-head-01,walking-01 --limit 2
```

The command prints the selected case count and a spend warning but performs no provider calls.

## Live paired benchmark

A paid run requires both audiovisual mode and the explicit spend acknowledgement:

```bash
VIDEO_PIPELINE_MODE=audiovisual \
npm run benchmark:real -- --case talking-head-01 --confirm-spend
```

Run the full frozen suite only after checking the plan:

```bash
VIDEO_PIPELINE_MODE=audiovisual \
npm run benchmark:real -- --confirm-spend
```

A full-stack case may create several paid tasks because TikTokMoney can use dialogue TTS, keyframes, reference conditioning, multiple acts and targeted QC retries. The benchmark intentionally never runs in CI.

Live benchmark construction disables trend research so the same frozen topic is not changed by current trend data.

## What is compared

Each case has two arms. Execution order alternates by case (baseline→full, then full→baseline) so provider drift or time-of-run effects do not systematically favor one arm.

**Baseline** calls the configured Runway audiovisual model directly with one frozen photorealistic prompt. It does not use TikTokMoney's screenplay generation, keyframes, motion guides, continuity system, QC gates or regeneration loop.

**Full** calls the normal TikTokMoney audiovisual pipeline with the same topic, audience and duration budget.

The manifest records:

- generation success
- first-pass success for the full stack
- final success
- QC retry count
- dialogue WER when available
- lip-sync score when available
- pose fidelity when available
- realism-QC score when available
- wall-clock latency
- provider task count
- provider-reported USD cost or credits when the API exposes them

Billing values are never guessed. The harness records observed provider spend separately from complete spend. A USD total is authoritative only when every observed audiovisual-provider task reports USD billing and there are no configured paid full-stack components outside benchmark instrumentation. Partial billing stays visible as observed spend, but `totalProviderSpendUsd` and cost-per-publishable remain `null`.

Full-stack runs can also use paid LLM, transcription, realism, lip-sync or speaker-turn services. Until those components expose benchmark billing telemetry, the manifest lists them as untracked cost components and does not claim a complete full-stack cost.

## Final-render requirement

Paid evidence runs require final rendering. `--no-render` is rejected because the full-stack arm can contain multiple accepted scenes; rating only the first scene would make the blinded comparison non-equivalent to the complete baseline video.

## Outputs and crash recovery

Each live run creates:

```text
outputs/benchmarks/realgen_<timestamp>/
  manifest.json
  summary.json
  ratings-blind.json
  rating-key.json
  review/
    sample_001.mp4
    sample_002.mp4
    ...
```

`manifest.json` is updated after every completed pair, so an interrupted run still preserves completed evidence.

## Blinded human review

Do not give `rating-key.json` to the reviewer.

The `review/sample_###.mp4` names hide whether a clip is baseline or full-stack. Edit the matching entries in `ratings-blind.json`:

- `publishable`: `true` or `false`
- `realismScore`: 1–5
- `identityConsistencyScore`: 1–5
- `dialogueAccuracyScore`: 1–5
- `motionFidelityScore`: 1–5
- `notes`: optional text

Use `null` only when a score is genuinely not applicable. Missing dimensions remain excluded from averages rather than being coerced to zero. Scores must be integers from 1 to 5, `publishable` must be boolean or null, sample IDs and case/arm ratings must be unique, and rating files must match the benchmark run ID. A failed generation counts against publishability even though there is no artifact to rate.

After review:

```bash
npm run benchmark:summary -- \
  --run outputs/benchmarks/realgen_<timestamp>/manifest.json \
  --ratings outputs/benchmarks/realgen_<timestamp>/ratings-blind.json
```

The summarizer automatically loads the sibling `rating-key.json`. A different key can be supplied with `--rating-key`.

## Interpreting the result

Do not use the internal TikTokMoney QC score as the final claim. The strongest evidence is the paired combination of:

1. externally blinded human publishability and quality ratings;
2. deterministic operational metrics such as failures, retries and latency;
3. independent dialogue, lip-sync and pose measurements when configured;
4. provider-reported spend.

Compare releases only when the suite hash is identical. If the suite changes, report it as a new benchmark generation rather than continuing the old series.

The first 30-case paid run remains a separate evidence milestone. Shipping the harness does not itself prove a quality or cost improvement.
