import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const venv = path.join(root, '.venv-pose');
const requirements = path.join(root, 'scripts', 'pose-sidecar-requirements.txt');
const extractor = path.join(root, 'scripts', 'mediapipe_pose_extractor.py');
const model = path.join(root, 'models', 'pose_landmarker_full.task');

const systemPython = resolvePython();
run(systemPython, ['-m', 'venv', venv]);

const venvPython = process.platform === 'win32'
  ? path.join(venv, 'Scripts', 'python.exe')
  : path.join(venv, 'bin', 'python');

run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
run(venvPython, ['-m', 'pip', 'install', '--no-cache-dir', '-r', requirements]);

mkdirSync(path.dirname(model), { recursive: true });
run(venvPython, [
  extractor,
  '--download-model-only',
  '--model',
  model,
]);
run(venvPython, [
  extractor,
  '--check',
  '--model',
  model,
]);

console.log('');
console.log('Pose sidecar ready.');
console.log(`Python: ${venvPython}`);
console.log(`Model:  ${model}`);
console.log('TikTokMoney will auto-detect .venv-pose; no POSE_EXTRACTOR_COMMAND is required.');

function resolvePython() {
  const candidates = [
    process.env.PYTHON,
    process.platform === 'win32' ? 'python' : 'python3',
    'python',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], {
      stdio: 'ignore',
    });
    if (result.status === 0) return candidate;
  }
  throw new Error('Python 3 was not found. Install Python 3.9-3.12 and rerun npm run setup:pose.');
}

function run(command, args) {
  if (!existsSync(requirements) || !existsSync(extractor)) {
    throw new Error('pose sidecar files are missing from the repository');
  }
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`command failed: ${command} ${args.join(' ')}`);
  }
}
