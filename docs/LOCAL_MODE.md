# Run TikTokMoney with entirely local AI

This mode sends **no text, images, frames or generated audio** to hosted AI providers.
It uses Ollama/LM Studio for language (optional vision QC) and your own ComfyUI
workflow for audiovisual video generation. All video and model files remain on
your machine. Discovery from YouTube/Reddit/RSS and TikTok publishing are
separate internet features; leave their keys unset for offline runs.

## Requirements

- Node.js >= 22.9, FFmpeg and FFprobe on PATH
- ComfyUI running locally (default http://127.0.0.1:8188)
- Local LLM server supporting OpenAI-compatible \`/v1/chat/completions\`
  and JSON response format. For example, install Ollama, run
  \`ollama pull qwen3:8b\` and start its service on port 11434.
- A **working LTX audiovisual** or comparable **ComfyUI video+audio**
  workflow already tested in ComfyUI. Model checkpoints are downloaded
  into ComfyUI locally. On a 24 GB GPU, use the model's quantized/offload
  variants as appropriate; performance/VRAM varies by workflow.

### 1. Configure

\`\`\`bash
cp .env.local.example .env
# Edit .env and set COMFYUI_WORKFLOW_PATH to your exported workflow
npm run local:check
\`\`\`

The required settings are:

\`\`\`dotenv
AI_RUNTIME=local
VIDEO_PIPELINE_MODE=audiovisual
LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1
LOCAL_LLM_MODEL=qwen3:8b
COMFYUI_BASE_URL=http://127.0.0.1:8188
COMFYUI_WORKFLOW_PATH=./comfyui/workflow-api.json
COMFYUI_REQUIRE_AUDIO=true
\`\`\`

No OpenAI, Runway, Luma, ElevenLabs, OpenRouter or Pexels key is needed.
The local runtime ignores those providers even if cloud keys happen to be set.

### 2. Export a working video workflow from ComfyUI

Load your installed LTX video+audio workflow in ComfyUI and test an actual
clip. Export it as **API format** JSON (not the UI layout JSON). In the
resulting workflow graph, replace literal input values with placeholders:

| ComfyUI workflow input | Replace value with |
|---|---|
| Positive prompt (text) | \`{{PROMPT}}\` (required) |
| Negative prompt | \`{{NEGATIVE_PROMPT}}\` |
| Random seed | \`{{SEED}}\` |
| Frame count / length | \`{{FRAMES}}\` |
| FPS input | \`{{FPS}}\` |
| Width / height | \`{{WIDTH}}\` / \`{{HEIGHT}}\` |
| Optional video duration input | \`{{DURATION_SECONDS}}\` |
| Optional separate speech input | \`{{DIALOGUE}}\` |
| Optional \`LoadImage\` input for video first frame | \`{{FIRST_FRAME}}\` |

**Important:** In JSON, quote placeholders as string values, even for seed
or frame count. The adapter replaces exact placeholders with correctly
typed numbers before posting to ComfyUI.

Example excerpt of an **existing workflow**, not a complete LTX graph:

\`\`\`json
{
  "12": { "class_type": "CLIPTextEncode", "inputs": { "text": "{{PROMPT}}", "clip": ["11", 0] } },
  "29": { "class_type": "SomeSampler", "inputs": { "seed": "{{SEED}}", "frames": "{{FRAMES}}" } }
}
\`\`\`

Keep all real LTX model/loader/sampler/save nodes and their links from your
working export. The shown IDs and class names are illustrative only. There
is no universal LTX workflow or node-ID mapping, and TikTokMoney will not
guess missing nodes. A SaveVideo/VideoCombine node must emit MP4 or WebM
in ComfyUI history. The app downloads it from the local \`/view\` endpoint.

If you wire the optional \`{{FIRST_FRAME}}\` input to a LoadImage node in an
**image-to-video compatible** workflow, each next act uses the previous
act's final frame via local ComfyUI image upload. Without this input, clip
continuity is prompted but not visually anchored.

For a production TikTok clip, **include generated audio in the output
video**. \`COMFYUI_REQUIRE_AUDIO=true\` verifies the MP4/WebM has an audio
stream; it fails explicitly instead of silently publishing a mute video.
Set it to false only when testing visual-only workflows; the final renderer
still performs audio-quality checks.

### 3. Generate and inspect

\`\`\`bash
npm run generate -- --topic "A realistic 30-second story about a cafe" --duration 30
\`\`\`

The director splits the story into short segments, sends one workflow job
per segment, downloads locally rendered clips, and assembles them with
FFmpeg and subtitles. The API workflow uses the required \`{{PROMPT}}\`
parameter to inject scene action, dialogue, cinematic camera direction,
location and continuity details. Individual acts must fit
\`COMFYUI_MAX_SEGMENT_SECONDS\` (15s by default). Change the limit only if
your model/workflow supports longer generations.

If a generation is interrupted, use:

\`\`\`bash
npm run resume -- --id vid_...
\`\`\`

### Optional local quality checks

For realism QC using a local vision-language model, install a vision model
supported by your local runtime, then set:

\`\`\`dotenv
REALISM_QC_ENABLED=true
LOCAL_VISION_MODEL=<your-installed-vision-model>
LOCAL_VISION_BASE_URL=http://127.0.0.1:11434/v1
\`\`\`

It inspects a small number of generated frames and requests a JSON verdict,
with optional regeneration. This is a sampled visual check, **not** a
guarantee of temporal coherence or lip synchronization.

For speech verification, you may run an **OpenAI-compatible local**
Whisper/faster-whisper transcription server with
\`POST /audio/transcriptions\` and set:

\`\`\`dotenv
LOCAL_TRANSCRIPTION_ENABLED=true
LOCAL_TRANSCRIPTION_BASE_URL=http://127.0.0.1:8000/v1
LOCAL_TRANSCRIPTION_MODEL=whisper-1
\`\`\`

Additional existing *local* pose-motion, phoneme/viseme or deep lip-sync
sidecars may be enabled separately after installation. Cloud-only
OpenRouter QC adapters are disabled in local mode, rather than quietly
sending video frames to the internet. A disabled QC check is not reported
as passed.

### Limitations

- The adapter requires a **real working ComfyUI API export** and locally
  installed checkpoints; it does not install or invent a video model.
- Native audiovisual output is needed for complete video+audio generation.
  Model fidelity and identity consistency depend on the workflow.
- Server availability and real GPU throughput cannot be tested in CI.
  \`npm run local:check\` checks connectivity and configuration, while CI
  uses a mocked ComfyUI API.
- TikTok publishing is intentionally **not offline** and still requires the
  normal TikTok authorization plus explicit confirmation.
