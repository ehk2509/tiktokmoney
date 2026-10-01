export class RssTrendProvider {
  constructor({
    feeds = parseFeeds(process.env.TREND_RSS_FEEDS),
    maxItemsPerFeed = Number(process.env.RSS_TREND_MAX_ITEMS || 25),
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.id = 'rss';
    this.feeds = feeds;
    this.maxItemsPerFeed = Math.max(5, Math.min(100, Number(maxItemsPerFeed) || 25));
    this.fetch = fetchImpl;
  }

  async list() {
    const settled = await Promise.allSettled(
      this.feeds.map((feed) => this.fetchFeed(feed)),
    );
    return settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  }

  async search(query) {
    const terms = normalize(query).split(' ').filter((term) => term.length > 2);
    const items = await this.list();
    if (!terms.length) return items;
    return items.filter((item) => {
      const haystack = normalize(`${item.title} ${item.snippet}`);
      return terms.some((term) => haystack.includes(term));
    });
  }

  async fetchFeed(feed) {
    const response = await this.fetch(feed.url, {
      headers: {
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'user-agent': 'tiktokmoney/0.16 trend-intelligence',
      },
    });
    if (!response.ok) {
      throw new Error(`RSS feed failed (${response.status}): ${feed.url}`);
    }
    const xml = await response.text();
    const entries = extractBlocks(xml, 'item').length
      ? extractBlocks(xml, 'item')
      : extractBlocks(xml, 'entry');

    return entries.slice(0, this.maxItemsPerFeed).map((entry, index) => {
      const title = decodeXml(extractTag(entry, 'title'));
      const snippet = decodeXml(
        extractTag(entry, 'description')
        || extractTag(entry, 'summary')
        || extractTag(entry, 'content'),
      );
      const link = extractLink(entry);
      const publishedAt = normalizeDate(
        extractTag(entry, 'pubDate')
        || extractTag(entry, 'published')
        || extractTag(entry, 'updated'),
      );
      const freshness = publishedAt
        ? Math.max(0, 100 - Math.max(0, (Date.now() - Date.parse(publishedAt)) / 3600000) * 3)
        : 45;
      const strength = clamp(42 + freshness * 0.45 + Math.max(0, 12 - index) * 1.2);

      return {
        id: `rss:${feed.name}:${stable(entry)}`,
        source: `rss:${feed.name}`,
        sourceId: link || String(index),
        topic: clean(title, 240),
        title: clean(title, 280),
        snippet: clean(stripTags(snippet), 700),
        url: link || feed.url,
        publishedAt,
        observedAt: new Date().toISOString(),
        strength: round(strength),
        engagement: null,
        sourceMetrics: {
          feed: feed.name,
          feedUrl: feed.url,
          position: index + 1,
        },
      };
    }).filter((item) => item.title);
  }
}

export function parseFeeds(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item, index) => typeof item === 'string'
          ? { name: `feed-${index + 1}`, url: item }
          : { name: String(item.name || `feed-${index + 1}`), url: String(item.url || '') })
        .filter((item) => /^https?:\/\//i.test(item.url));
    }
  } catch {
    // comma-separated fallback
  }

  return String(value)
    .split(',')
    .map((url, index) => ({ name: `feed-${index + 1}`, url: url.trim() }))
    .filter((item) => /^https?:\/\//i.test(item.url));
}

function extractBlocks(xml, tag) {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  return [...String(xml).matchAll(pattern)].map((match) => match[1]);
}

function extractTag(block, tag) {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  return String(block).match(pattern)?.[1]?.trim() || '';
}

function extractLink(block) {
  const atom = String(block).match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1];
  return decodeXml(atom || extractTag(block, 'link')).trim() || null;
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ');
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function normalizeDate(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function stable(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
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
