import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const MB = 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * MB;

export class TikTokPublisher {
  constructor({
    accessToken = process.env.TIKTOK_ACCESS_TOKEN,
    authService = null,
    baseUrl = process.env.TIKTOK_API_BASE_URL || 'https://open.tiktokapis.com',
    fetchImpl = fetch,
    chunkSizeBytes = MAX_CHUNK_BYTES,
  } = {}) {
    this.accessToken = accessToken;
    this.authService = authService;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.chunkSizeBytes = Math.min(MAX_CHUNK_BYTES, Math.max(5 * MB, Number(chunkSizeBytes) || MAX_CHUNK_BYTES));
  }

  get configured() {
    return Boolean(this.accessToken || this.authService?.configured);
  }

  async queryCreatorInfo() {
    return this.request('/v2/post/publish/creator_info/query/', { body: {} });
  }

  async publishFile({
    filePath,
    title = '',
    privacyLevel,
    disableComment = false,
    disableDuet = false,
    disableStitch = false,
    videoCoverTimestampMs = 1000,
  }) {
    this.requireConfigured();
    if (!filePath) throw new Error('filePath is required');
    if (!privacyLevel) throw new Error('privacyLevel is required');

    const creator = await this.queryCreatorInfo();
    const allowed = creator?.privacy_level_options || [];
    if (!allowed.includes(privacyLevel)) {
      throw new Error(`privacyLevel ${privacyLevel} is not available for this TikTok creator`);
    }

    const file = await stat(filePath);
    const plan = buildUploadPlan(file.size, this.chunkSizeBytes);
    const initialized = await this.request('/v2/post/publish/video/init/', {
      body: {
        post_info: {
          title: String(title || '').slice(0, 2200),
          privacy_level: privacyLevel,
          disable_comment: Boolean(disableComment),
          disable_duet: Boolean(disableDuet),
          disable_stitch: Boolean(disableStitch),
          video_cover_timestamp_ms: Math.max(0, Number(videoCoverTimestampMs) || 0),
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: file.size,
          chunk_size: plan.chunkSize,
          total_chunk_count: plan.totalChunkCount,
        },
      },
    });

    if (!initialized?.publish_id || !initialized?.upload_url) {
      throw new Error('TikTok did not return publish_id and upload_url');
    }

    await this.uploadFile({
      uploadUrl: initialized.upload_url,
      filePath,
      videoSize: file.size,
      ranges: plan.ranges,
    });

    return {
      publishId: initialized.publish_id,
      creator: {
        username: creator.creator_username || null,
        nickname: creator.creator_nickname || null,
      },
      privacyLevel,
      upload: {
        videoSize: file.size,
        chunkSize: plan.chunkSize,
        totalChunkCount: plan.totalChunkCount,
      },
    };
  }

  async uploadFile({ uploadUrl, filePath, videoSize, ranges }) {
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index];
      const response = await this.fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(range.length),
          'content-range': `bytes ${range.start}-${range.end}/${videoSize}`,
        },
        body: createReadStream(filePath, { start: range.start, end: range.end }),
        duplex: 'half',
      });
      const expected = index === ranges.length - 1 ? 201 : 206;
      if (response.status !== expected) {
        const text = await safeText(response);
        throw new Error(`TikTok upload chunk ${index + 1}/${ranges.length} failed with HTTP ${response.status}: ${text}`);
      }
    }
  }

  async getStatus(publishId) {
    if (!publishId) throw new Error('publishId is required');
    return this.request('/v2/post/publish/status/fetch/', {
      body: { publish_id: publishId },
    });
  }

  async queryVideos(videoIds) {
    const ids = [...new Set((videoIds || []).map(String).filter(Boolean))].slice(0, 20);
    if (!ids.length) return [];
    const fields = [
      'id', 'create_time', 'share_url', 'video_description', 'duration',
      'like_count', 'comment_count', 'share_count', 'view_count', 'is_aigc',
    ].join(',');
    const data = await this.request(`/v2/video/query/?fields=${encodeURIComponent(fields)}`, {
      body: { filters: { video_ids: ids } },
    });
    return Array.isArray(data?.videos) ? data.videos : [];
  }

  async request(path, { body = {} } = {}) {
    const accessToken = await this.resolveAccessToken();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(body),
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      throw new Error(`TikTok API HTTP ${response.status}: ${payload?.error?.message || JSON.stringify(payload)}`);
    }
    if (payload?.error?.code && payload.error.code !== 'ok') {
      const error = new Error(`TikTok API ${payload.error.code}: ${payload.error.message || 'request failed'}`);
      error.code = payload.error.code;
      throw error;
    }
    return payload?.data || {};
  }

  requireConfigured() {
    if (!this.configured) {
      throw new Error('TikTok publishing requires an OAuth account or TIKTOK_ACCESS_TOKEN');
    }
  }

  async resolveAccessToken() {
    if (this.accessToken) return this.accessToken;
    if (this.authService?.getValidAccessToken) {
      const token = await this.authService.getValidAccessToken();
      if (token) return token;
    }
    throw new Error('TikTok account is not authorized or the refresh token is unavailable');
  }
}

export function buildUploadPlan(videoSize, preferredChunkSize = MAX_CHUNK_BYTES) {
  const size = Number(videoSize);
  if (!Number.isInteger(size) || size <= 0) throw new Error('videoSize must be a positive integer');

  if (size <= MAX_CHUNK_BYTES) {
    return {
      chunkSize: size,
      totalChunkCount: 1,
      ranges: [{ start: 0, end: size - 1, length: size }],
    };
  }

  const chunkSize = Math.min(MAX_CHUNK_BYTES, Math.max(5 * MB, Number(preferredChunkSize) || MAX_CHUNK_BYTES));
  const totalChunkCount = Math.floor(size / chunkSize);
  if (totalChunkCount < 1 || totalChunkCount > 1000) {
    throw new Error('video size requires an unsupported TikTok chunk count');
  }

  const ranges = [];
  for (let index = 0; index < totalChunkCount; index += 1) {
    const start = index * chunkSize;
    const isLast = index === totalChunkCount - 1;
    const end = isLast ? size - 1 : start + chunkSize - 1;
    ranges.push({ start, end, length: end - start + 1 });
  }

  if (ranges.at(-1).length > 128 * MB) {
    throw new Error('final TikTok upload chunk exceeds 128 MB');
  }

  return { chunkSize, totalChunkCount, ranges };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
