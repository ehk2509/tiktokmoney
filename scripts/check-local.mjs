#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { assertLocalEndpoint } from '../src/providers/localEndpoints.js';
import { hasPlaceholder } from '../src/providers/localComfyUiAudiovisualProvider.js';

const env = process.env;
const checks = [];
const failures = [];

function report(label, ok, detail = '') {
  (ok ? checks : failures).push((ok ? '✓ ' : '✗ ') + label + (detail ? ': ' + detail : ''));
}

const local = String(env.AI_RUNTIME || '').toLowerCase() === 'local';
report('Local AI runtime', local, local ? 'enabled' : 'set AI_RUNTIME=local');
report('Audiovisual pipeline', env.VIDEO_PIPELINE_MODE === 'audiovisual',
  'VIDEO_PIPELINE_MODE=audiovisual is required');
const tools = ['ffmpeg', 'ffprobe'];
for (const tool of tools) {
  const result = spawnSync(tool, ['-version'], { encoding: 'utf8', timeout: 10000 });
  report(tool, result.status === 0, result.error?.message || (result.status === 0 ? 'available' : 'not installed'));
}

async function checkServer(label, base, endpoint, expectedModel = null) {
  try {
    const url = assertLocalEndpoint(base, label);
    const response = await fetch(url + endpoint, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    if (expectedModel) {
      const ids = (data.data || data.models || []).map(m => m.id || m.name || m.model);
      if (ids.length && !ids.includes(expectedModel)) {
        report(label, false, 'server reachable but missing model ' + expectedModel +
          ' (available: ' + ids.slice(0, 8).join(', ') + ')');
        return;
      }
    }
    report(label, true, url + endpoint);
  } catch (err) {
    report(label, false, err.message);
  }
}

await checkServer('Local LLM server',
  env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434/v1', '/models', env.LOCAL_LLM_MODEL || 'qwen3:8b');
await checkServer('ComfyUI server',
  env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188', '/system_stats');

if (env.COMFYUI_WORKFLOW_PATH) {
  try {
    const data = JSON.parse(await readFile(env.COMFYUI_WORKFLOW_PATH, 'utf8'));
    const workflow = data.workflow || data.prompt || data;
    report('ComfyUI API workflow has {{PROMPT}}', hasPlaceholder(workflow, 'PROMPT'),
      env.COMFYUI_WORKFLOW_PATH);
  } catch (err) {
    report('ComfyUI API workflow', false, err.message);
  }
} else {
  report('ComfyUI API workflow', false, 'set COMFYUI_WORKFLOW_PATH');
}

if (env.REALISM_QC_ENABLED === 'true') {
  report('Local vision QC model', Boolean(env.LOCAL_VISION_MODEL),
    env.LOCAL_VISION_MODEL || 'set LOCAL_VISION_MODEL or disable REALISM_QC_ENABLED');
}

console.log([...checks, ...failures].join('\n'));
if (failures.length) {
  console.error('\n' + failures.length + ' local setup check(s) failed. See docs/LOCAL_MODE.md.');
  process.exitCode = 1;
} else {
  console.log('\nLocal prerequisites OK. A real end-to-end rendering test is still required.');
}
