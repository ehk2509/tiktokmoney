const DEFAULT_BASE_URL = 'https://oauth.reddit.com';

export class RedditTrendProvider {
  constructor({
    accessToken = process.env.REDDIT_ACCESS_TOKEN,
    baseUrl = process.env.REDDIT_API_BASE_URL || DEFAULT_BASE_URL,
    userAgent = process.env.REDDIT_USER_AGENT || 'tiktokmoney/0.16 trend-intelligence',
    subreddit = process.env.REDDIT_TREND_SUBREDDIT || 'all',
    maxResults = Number(process.env.REDDIT_TREND_MAX_RESULTS || 40),
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!accessToken) throw new Error('REDDIT_ACCESS_TOKEN is required for Reddit trends');
    this.id = 'reddit';
    this.accessToken = accessToken;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.userAgent = userAgent;
    this.subreddit = subreddit.replace(/^r\//, '') || 'all';
    this.maxResults = Math.max(5, Math.min(100, Number(maxResults) || 40));
    this.fetch = fetchImpl;
  }

  async list() {
    const url = `${this.baseUrl}/r/${encodeURIComponent(this.subreddit)}/hot?limit=${this.maxResults}&raw_json=1`;
    return this.fetchListing(url);
  }

  async search(query) {
    const params = new URLSearchParams({
      q: String(query || ''),
      restrict_sr: this.subreddit === 'all' ? 'false' : 'true',
      sort: 'hot',
      t: 'day',
      limit: String(this.maxResults),
      raw_json: '1',
    });
    const url = `${this.baseUrl}/r/${encodeURIComponent(this.subreddit)}/search?${params}`;
    return this.fetchListing(url);
  }

  async fetchListing(url) {
    const response = await this.fetch(url, {
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'user-agent': this.userAgent,
        accept: 'application/json',
      },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload?.message || payload?.error || response.statusText || 'request failed';
      throw new Error(`Reddit request failed (${response.status}): ${detail}`);
    }

    return (payload?.data?.children || [])
      .map((child) => child?.data)
      .filter((post) => post?.id && post?.title)
      .map((post) => {
        const score = Number(post.score) || 0;
        const comments = Number(post.num_comments) || 0;
        const ratio = Number(post.upvote_ratio) || 0;
        const ageHours = Math.max(0.25, (Date.now() / 1000 - Number(post.created_utc || 0)) / 3600);
        const engagementPerHour = (score + comments * 2) / ageHours;
        const strength = clamp(
          20 + Math.log10(Math.max(1, engagementPerHour)) * 15 + ratio * 12,
        );

        return {
          id: `reddit:${post.id}`,
          source: 'reddit',
          sourceId: post.id,
          topic: clean(post.title, 240),
          title: clean(post.title, 280),
          snippet: clean(post.selftext || '', 700),
          url: post.permalink ? `https://www.reddit.com${post.permalink}` : null,
          publishedAt: post.created_utc ? new Date(Number(post.created_utc) * 1000).toISOString() : null,
          observedAt: new Date().toISOString(),
          strength: round(strength),
          engagement: {
            score,
            comments,
            upvoteRatio: ratio,
            engagementPerHour: round(engagementPerHour),
          },
          sourceMetrics: {
            subreddit: post.subreddit || this.subreddit,
          },
        };
      });
  }
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
