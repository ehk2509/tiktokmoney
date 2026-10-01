const DEFAULT_BASE_URL = 'https://www.googleapis.com/youtube/v3';

export class YouTubeTrendProvider {
  constructor({
    apiKey = process.env.YOUTUBE_API_KEY,
    baseUrl = process.env.YOUTUBE_API_BASE_URL || DEFAULT_BASE_URL,
    regionCode = process.env.TREND_REGION || 'US',
    maxResults = Number(process.env.YOUTUBE_TREND_MAX_RESULTS || 25),
    lookbackHours = Number(process.env.TREND_LOOKBACK_HOURS || 24),
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new Error('YOUTUBE_API_KEY is required for YouTube trends');
    this.id = 'youtube';
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.regionCode = regionCode;
    this.maxResults = Math.max(5, Math.min(50, Number(maxResults) || 25));
    this.lookbackHours = Math.max(1, Math.min(168, Number(lookbackHours) || 24));
    this.fetch = fetchImpl;
  }

  async list() {
    return this.search('');
  }

  async search(query) {
    const publishedAfter = new Date(Date.now() - this.lookbackHours * 3600000).toISOString();
    const params = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      order: 'viewCount',
      maxResults: String(this.maxResults),
      regionCode: this.regionCode,
      publishedAfter,
      key: this.apiKey,
    });
    if (String(query || '').trim()) params.set('q', String(query).trim());

    const searchPayload = await requestJson(
      this.fetch,
      `${this.baseUrl}/search?${params}`,
      'YouTube search',
    );
    const ids = (searchPayload.items || [])
      .map((item) => item?.id?.videoId)
      .filter(Boolean);
    if (!ids.length) return [];

    const statsParams = new URLSearchParams({
      part: 'snippet,statistics',
      id: ids.join(','),
      key: this.apiKey,
    });
    const statsPayload = await requestJson(
      this.fetch,
      `${this.baseUrl}/videos?${statsParams}`,
      'YouTube videos',
    );

    return (statsPayload.items || []).map((video) => {
      const views = Number(video.statistics?.viewCount) || 0;
      const likes = Number(video.statistics?.likeCount) || 0;
      const comments = Number(video.statistics?.commentCount) || 0;
      const ageHours = Math.max(
        0.25,
        (Date.now() - Date.parse(video.snippet?.publishedAt || new Date().toISOString())) / 3600000,
      );
      const viewsPerHour = views / ageHours;
      const strength = clamp(
        22 + Math.log10(Math.max(1, viewsPerHour)) * 13
        + Math.log10(Math.max(1, likes + comments * 3)) * 4,
      );

      return {
        id: `youtube:${video.id}`,
        source: 'youtube',
        sourceId: video.id,
        topic: cleanTitle(video.snippet?.title),
        title: cleanTitle(video.snippet?.title),
        snippet: clean(video.snippet?.description, 700),
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
        publishedAt: video.snippet?.publishedAt || null,
        observedAt: new Date().toISOString(),
        strength: round(strength),
        engagement: {
          views,
          likes,
          comments,
          viewsPerHour: round(viewsPerHour),
        },
        sourceMetrics: {
          channelTitle: video.snippet?.channelTitle || null,
          regionCode: this.regionCode,
        },
      };
    });
  }
}

async function requestJson(fetchImpl, url, label) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.error?.message || response.statusText || 'request failed';
    throw new Error(`${label} failed (${response.status}): ${detail}`);
  }
  return payload || {};
}

function cleanTitle(value) {
  return clean(value, 240)
    .replace(/\s*[|｜•·]\s*[^|｜•·]{1,80}$/u, '')
    .trim();
}

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clamp(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
