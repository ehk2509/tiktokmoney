import { readFile } from 'node:fs/promises';

export class MotionReferenceStore {
  constructor(filePath = process.env.MOTION_REFERENCE_LIBRARY_PATH || './data/motion-references.json') {
    this.filePath = filePath;
  }

  async list() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.references)
          ? parsed.references
          : [];
      return items.map(normalizeReference).filter(Boolean);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }
}

export function normalizeReference(input) {
  if (!input || typeof input !== 'object') return null;
  const url = String(input.url || '').trim();
  if (!/^https:\/\//i.test(url)) return null;

  const durationSeconds = Number(input.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 15) {
    return null;
  }

  const actionClass = normalizeToken(input.actionClass || input.action || 'general');
  const tags = [...new Set((Array.isArray(input.tags) ? input.tags : [])
    .map(normalizeToken)
    .filter(Boolean))]
    .slice(0, 20);

  return {
    id: String(input.id || `${actionClass}-${url.slice(-18)}`).slice(0, 120),
    actionClass,
    tags,
    cameraMode: normalizeToken(input.cameraMode || input.camera || 'any'),
    people: clampInt(input.people, 1, 8, 1),
    durationSeconds: Math.round(durationSeconds * 1000) / 1000,
    url,
    source: String(input.source || '').slice(0, 300),
    license: String(input.license || '').slice(0, 180),
    notes: String(input.notes || '').slice(0, 500),
    verifiedHumanMotion: input.verifiedHumanMotion !== false,
    rightsConfirmed: input.rightsConfirmed === true,
  };
}

function normalizeToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
