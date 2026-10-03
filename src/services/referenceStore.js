import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MEDIA_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * Story-bible reference images come back as signed provider URLs that expire
 * (about an hour for Luma). Keep a local copy of each, and before generating an
 * act swap any expired link for the local copy as a data URI, so long runs and
 * next-day resumes keep their character and location references.
 */
export class ReferenceStore {
  constructor({
    assetDir = process.env.ASSET_DIR || './outputs/assets',
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
    ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg',
    runCommand = run,
  } = {}) {
    this.assetDir = assetDir;
    this.ffmpegBin = ffmpegBin;
    this.runCommand = runCommand;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async persist(storyBible, { projectId = 'project' } = {}) {
    let saved = 0;
    for (const { item, key } of referenceItems(storyBible)) {
      if (!item.url || item.localPath || String(item.url).startsWith('data:')) continue;
      try {
        const response = await this.fetch(item.url, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (!response.ok) continue;
        const bytes = Buffer.from(await response.arrayBuffer());
        await mkdir(this.assetDir, { recursive: true });
        const localPath = path.join(this.assetDir, `reference-${safe(projectId)}-${safe(key)}${extensionFor(item.url, response)}`);
        await writeFile(localPath, bytes);
        item.localPath = localPath;
        item.sourceUrl = item.url;
        saved += 1;
      } catch {
        // Best effort: an unsaved reference keeps working until its URL expires.
      }
    }
    return saved;
  }

  /** Returns a copy for one act; the saved project keeps URLs, not inline data. */
  async withFreshReferences(storyBible) {
    if (!referenceItems(storyBible).some(({ item }) => item.localPath)) return storyBible;
    const copy = structuredClone(storyBible);
    let refreshed = 0;
    for (const { item } of referenceItems(copy)) {
      if (!item.url || !item.localPath || String(item.url).startsWith('data:')) continue;
      if (await this.isFetchable(item.url)) continue;
      try {
        await access(item.localPath);
        // Originals are multi-megabyte PNGs; embed a compact JPEG instead.
        const bytes = await readFile(await this.compact(item.localPath));
        item.url = `data:image/jpeg;base64,${bytes.toString('base64')}`;
        refreshed += 1;
      } catch {
        // Local copy missing; the provider drops the dead link instead.
      }
    }
    return refreshed ? copy : storyBible;
  }

  async compact(localPath) {
    const compactPath = localPath.replace(/\.[a-z0-9]+$/i, '') + '.ref.jpg';
    try {
      await access(compactPath);
    } catch {
      await this.runCommand(this.ffmpegBin, [
        '-y', '-i', localPath,
        '-vf', "scale='min(1024,iw)':-2",
        '-q:v', '4',
        compactPath,
      ]);
    }
    return compactPath;
  }

  async isFetchable(url) {
    try {
      const response = await this.fetch(url, {
        method: 'GET',
        headers: { range: 'bytes=0-0' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

function referenceItems(storyBible) {
  const references = storyBible?.references || {};
  const items = [];
  for (const [id, character] of Object.entries(references.characters || {})) {
    (character?.images || []).forEach((image, index) => {
      if (image && typeof image === 'object') items.push({ item: image, key: `character-${id}-${index}` });
    });
  }
  for (const [id, location] of Object.entries(references.locations || {})) {
    if (location && typeof location === 'object') items.push({ item: location, key: `location-${id}` });
  }
  return items;
}

function extensionFor(url, response) {
  const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
  const fromType = Object.entries(MEDIA_TYPES).find(([, media]) => type.startsWith(media))?.[0];
  if (fromType) return fromType;
  const fromUrl = path.extname(new URL(url).pathname).toLowerCase();
  return MEDIA_TYPES[fromUrl] ? fromUrl : '.jpg';
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-500)}`))));
  });
}

function safe(value) {
  return String(value || 'project').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 100);
}
