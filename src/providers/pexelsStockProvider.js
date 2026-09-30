import crypto from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class PexelsStockProvider {
  constructor({
    apiKey = process.env.PEXELS_API_KEY,
    assetDir = process.env.ASSET_DIR || './outputs/assets',
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new Error('PEXELS_API_KEY is required for the Pexels provider');
    if (!fetchImpl) throw new Error('fetch is required');
    this.apiKey = apiKey;
    this.assetDir = assetDir;
    this.fetch = fetchImpl;
  }

  async resolveScene(scene, { projectId }) {
    const query = scene.visualPrompt || scene.narration;
    const url = new URL('https://api.pexels.com/v1/videos/search');
    url.searchParams.set('query', query);
    url.searchParams.set('orientation', 'portrait');
    url.searchParams.set('size', 'medium');
    url.searchParams.set('per_page', '5');

    const response = await this.fetch(url, {
      headers: { authorization: this.apiKey },
    });
    const payload = await readJsonResponse(response, 'Pexels');

    const candidate = selectVideo(payload?.videos || []);
    if (!candidate) return null;

    const source = selectFile(candidate.video_files || []);
    if (!source?.link) return null;

    await mkdir(this.assetDir, { recursive: true });
    const fingerprint = crypto
      .createHash('sha256')
      .update(source.link)
      .digest('hex')
      .slice(0, 16);
    const extension = extensionFromFileType(source.file_type) || '.mp4';
    const localPath = path.join(this.assetDir, `pexels-${candidate.id}-${fingerprint}${extension}`);

    if (!(await fileExists(localPath))) {
      const download = await this.fetch(source.link);
      if (!download.ok) {
        throw new Error(`Pexels asset download failed (${download.status})`);
      }
      const bytes = Buffer.from(await download.arrayBuffer());
      await writeFile(localPath, bytes);
    }

    return {
      provider: 'pexels',
      sourceId: String(candidate.id),
      localPath,
      sourceUrl: candidate.url,
      creator: candidate.user?.name || null,
      creatorUrl: candidate.user?.url || null,
      width: source.width || candidate.width || null,
      height: source.height || candidate.height || null,
      durationSeconds: candidate.duration || null,
      license: 'Pexels',
      query,
      projectId,
    };
  }
}

export class NullStockProvider {
  async resolveScene() {
    return null;
  }
}

function selectVideo(videos) {
  return videos
    .filter((video) => Array.isArray(video.video_files) && video.video_files.length)
    .sort((a, b) => portraitScore(b) - portraitScore(a))[0] || null;
}

function portraitScore(video) {
  const portraitBonus = Number(video.height || 0) > Number(video.width || 0) ? 100000 : 0;
  return portraitBonus + Number(video.height || 0) * Number(video.width || 0);
}

function selectFile(files) {
  const mp4 = files.filter((file) => (file.file_type || '').includes('mp4') && file.link);
  return mp4
    .sort((a, b) => {
      const aPortrait = Number(a.height || 0) > Number(a.width || 0) ? 1 : 0;
      const bPortrait = Number(b.height || 0) > Number(b.width || 0) ? 1 : 0;
      if (aPortrait !== bPortrait) return bPortrait - aPortrait;
      const aPixels = Number(a.width || 0) * Number(a.height || 0);
      const bPixels = Number(b.width || 0) * Number(b.height || 0);
      return bPixels - aPixels;
    })[0] || null;
}

function extensionFromFileType(fileType = '') {
  if (fileType.includes('mp4')) return '.mp4';
  if (fileType.includes('quicktime')) return '.mov';
  return null;
}

async function fileExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readJsonResponse(response, label) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${label} returned a non-JSON response`);
  }

  if (!response.ok) {
    throw new Error(`${label} request failed (${response.status})`);
  }

  return payload;
}
