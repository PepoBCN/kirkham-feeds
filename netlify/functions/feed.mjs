/*
 * feed.mjs — Netlify Function (v2)  [GitHub issue #4 — trusted-titles-only model]
 *
 * Serves two things from ONE endpoint:
 *   (a) a curated catalogue of tier-one UK/US national, business and tech titles, and
 *   (b) a keyword-filtered, merged RSS feed built from those publishers' OWN native
 *       RSS feeds (no Google News, no aggregators — trusted titles only).
 *
 * Contract (the frontend is built against this exactly):
 *
 *   1) GET /.netlify/functions/feed?catalog=1
 *      -> 200 JSON { "sources": [ { "id", "name", "category" }, ... ] }   (NO urls)
 *      Headers: Content-Type: application/json
 *               Access-Control-Allow-Origin: *
 *               Cache-Control: public, max-age=3600
 *
 *   2) GET /.netlify/functions/feed?sources=<comma ids>&filter=<urlencoded JSON>
 *      -> 200 RSS 2.0 XML
 *      Headers: Content-Type: application/rss+xml; charset=utf-8
 *               Access-Control-Allow-Origin: *
 *               Cache-Control: public, max-age=600
 *
 *      sources : comma-separated catalogue ids. Only catalogue feeds whose id matches
 *                are fetched; unknown ids are ignored; if none valid -> a valid EMPTY
 *                rss document (still 200).
 *
 *      filter  : OPTIONAL, URL-decoded JSON of shape
 *                  { "inc": [ ["arsenal","Arsenal FC"], ["transfer"] ], "exc": ["chelsea"] }
 *                Parsed in try/catch — on ANY parse/shape error the filter is ignored
 *                (no filtering). Matching, against (title + ' ' + description), case-
 *                insensitive substring:
 *                  - inc is a list of GROUPS. An item passes inc iff for EVERY group
 *                    at least ONE term matches (AND across groups, OR within a group).
 *                  - exc: item is rejected if ANY exc term matches.
 *                  - empty/missing inc -> all items pass the inc test.
 *
 * Behaviour:
 *   - Selected feeds are fetched IN PARALLEL, each with a ~8s AbortController timeout
 *     and a browser-ish User-Agent. A feed that fails (network, timeout, non-200,
 *     unparseable) is simply skipped — it never kills the whole response.
 *   - Items (title, link, pubDate, description) are parsed, tagged with the publisher
 *     name as <source>, merged, deduped by link (fallback title), sorted by pubDate
 *     desc, and capped at ~60.
 *   - ALL interpolated text is XML-escaped.
 *   - This function NEVER throws to the client: any error path returns a valid
 *     (possibly empty) RSS document with status 200.
 *
 * Cloud reachability note: every catalogue URL below was curl-verified to return valid
 * RSS during the build. The Telegraph (403) was dropped. Final reachability from
 * Netlify's cloud IPs is confirmed post-deploy; individual feeds degrade gracefully —
 * if one is unreachable it is skipped and the rest still render.
 *
 * No npm deps — plain fetch + light regex parsing only.
 */

// ---------------------------------------------------------------------------
// Curated catalogue of tier-one titles. url = publisher's OWN native RSS feed.
// ---------------------------------------------------------------------------
const CATALOG = [
  // --- UK ---
  { id: 'bbc',          name: 'BBC News',            category: 'UK',       url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { id: 'bbc-uk',       name: 'BBC News (UK)',       category: 'UK',       url: 'https://feeds.bbci.co.uk/news/uk/rss.xml' },
  { id: 'bbc-politics', name: 'BBC News (Politics)', category: 'UK',       url: 'https://feeds.bbci.co.uk/news/politics/rss.xml' },
  { id: 'guardian-uk',  name: 'The Guardian (UK)',   category: 'UK',       url: 'https://www.theguardian.com/uk/rss' },
  { id: 'sky',          name: 'Sky News',            category: 'UK',       url: 'https://feeds.skynews.com/feeds/rss/home.xml' },
  { id: 'independent',  name: 'The Independent (UK)',category: 'UK',       url: 'https://www.independent.co.uk/news/uk/rss' },
  { id: 'sun',          name: 'The Sun',             category: 'UK',       url: 'https://www.thesun.co.uk/feed/' },
  { id: 'mail',         name: 'Daily Mail',          category: 'UK',       url: 'https://www.dailymail.co.uk/articles.rss' },
  { id: 'mirror',       name: 'Daily Mirror',        category: 'UK',       url: 'https://www.mirror.co.uk/?service=rss' },
  { id: 'express',      name: 'Daily Express',       category: 'UK',       url: 'https://www.express.co.uk/posts/rss/1/news' },
  { id: 'metro',        name: 'Metro',               category: 'UK',       url: 'https://metro.co.uk/feed/' },
  { id: 'standard',     name: 'Evening Standard',    category: 'UK',       url: 'https://www.standard.co.uk/rss' },

  // --- US ---
  { id: 'nyt',          name: 'The New York Times',  category: 'US',       url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml' },
  { id: 'npr',          name: 'NPR News',            category: 'US',       url: 'https://feeds.npr.org/1001/rss.xml' },
  { id: 'foxnews',      name: 'Fox News',            category: 'US',       url: 'https://moxie.foxnews.com/google-publisher/latest.xml' },
  { id: 'washpost',     name: 'The Washington Post', category: 'US',       url: 'https://feeds.washingtonpost.com/rss/world' },
  { id: 'politico',     name: 'Politico',            category: 'US',       url: 'https://rss.politico.com/politics-news.xml' },

  // --- World ---
  { id: 'bbc-world',    name: 'BBC News (World)',    category: 'World',    url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { id: 'guardian-world',name: 'The Guardian (World)',category: 'World',   url: 'https://www.theguardian.com/world/rss' },
  { id: 'aljazeera',    name: 'Al Jazeera',          category: 'World',    url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { id: 'nyt-world',    name: 'NYT (World)',         category: 'World',    url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },

  // --- Business ---
  { id: 'ft',           name: 'Financial Times',     category: 'Business', url: 'https://www.ft.com/rss/home' },
  { id: 'cnbc',         name: 'CNBC',                category: 'Business', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { id: 'wsj-world',    name: 'WSJ (World)',         category: 'Business', url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml' },
  { id: 'marketwatch',  name: 'MarketWatch',         category: 'Business', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { id: 'bbc-business', name: 'BBC News (Business)', category: 'Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },

  // --- Tech ---
  { id: 'techcrunch',   name: 'TechCrunch',          category: 'Tech',     url: 'https://techcrunch.com/feed/' },
  { id: 'verge',        name: 'The Verge',           category: 'Tech',     url: 'https://www.theverge.com/rss/index.xml' },
  { id: 'arstechnica',  name: 'Ars Technica',        category: 'Tech',     url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { id: 'bbc-tech',     name: 'BBC News (Technology)',category: 'Tech',    url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
];

const CATALOG_BY_ID = new Map(CATALOG.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
const MAX_SOURCES = 12;       // cap how many feeds we'll actually process
const MAX_ITEMS = 60;         // cap merged output items
const FEED_TIMEOUT_MS = 8000; // per-feed abort timeout
const MAX_TERM_LEN = 80;      // ignore absurdly long filter terms
const MAX_TERMS_PER_GROUP = 30;
const MAX_GROUPS = 30;
const MAX_EXC = 30;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 PepoFeeds/1.0';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Strip CDATA wrapper and decode the handful of named/numeric entities we care
// about so substring matching works on real text. Then collapse whitespace.
function decodeText(raw) {
  if (raw == null) return '';
  let s = String(raw);
  // unwrap CDATA
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // strip any stray tags (HTML in descriptions)
  s = s.replace(/<[^>]+>/g, ' ');
  // decode common entities
  s = s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
    });
  return s.replace(/\s+/g, ' ').trim();
}

// Pull the first inner text of <tag>...</tag> (namespaced ok via :? prefix).
function firstTag(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(block);
  return m ? m[1] : '';
}

// Atom <link href="..."/> (self-closing) — fall back when no <link>text.
function atomLink(block) {
  // Prefer rel="alternate" or no rel; skip rel="self".
  const links = block.match(/<link\b[^>]*\/?>/gi) || [];
  let fallback = '';
  for (const l of links) {
    const rel = /rel\s*=\s*"([^"]*)"/i.exec(l);
    const href = /href\s*=\s*"([^"]*)"/i.exec(l);
    if (!href) continue;
    const relVal = rel ? rel[1].toLowerCase() : '';
    if (relVal === 'self') continue;
    if (relVal === 'alternate' || relVal === '') return href[1];
    if (!fallback) fallback = href[1];
  }
  return fallback;
}

// Parse one feed's body into normalised items.
function parseFeedItems(body, sourceName) {
  const out = [];
  if (typeof body !== 'string' || !body) return out;

  // Support both RSS <item> and Atom <entry>.
  const blocks = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  const entryRe = /<entry\b[\s\S]*?<\/entry>/gi;
  let m;
  while ((m = itemRe.exec(body)) !== null) blocks.push({ b: m[0], atom: false });
  if (blocks.length === 0) {
    while ((m = entryRe.exec(body)) !== null) blocks.push({ b: m[0], atom: true });
  }

  for (const { b, atom } of blocks) {
    const title = decodeText(firstTag(b, 'title'));

    let link = decodeText(firstTag(b, 'link'));
    if (!link && atom) link = decodeText(atomLink(b));
    if (!link) {
      // Some RSS use <link/> self-closing with href, or guid as URL.
      const al = atomLink(b);
      if (al) link = decodeText(al);
      else {
        const guid = decodeText(firstTag(b, 'guid'));
        if (/^https?:\/\//i.test(guid)) link = guid;
      }
    }

    let pubRaw =
      firstTag(b, 'pubDate') ||
      firstTag(b, 'published') ||
      firstTag(b, 'updated') ||
      firstTag(b, 'dc:date');
    const pubDate = decodeText(pubRaw);

    let descRaw =
      firstTag(b, 'description') ||
      firstTag(b, 'summary') ||
      firstTag(b, 'content') ||
      firstTag(b, 'content:encoded');
    const description = decodeText(descRaw);

    if (!title && !link) continue; // junk
    out.push({ title, link, pubDate, description, source: sourceName });
  }

  return out;
}

// Parse a Date safely; return epoch ms or 0.
function toMs(pubDate) {
  if (!pubDate) return 0;
  const t = Date.parse(pubDate);
  return Number.isFinite(t) ? t : 0;
}

// Build the filter spec defensively. Returns null when no filtering applies.
function buildFilter(rawEncoded) {
  if (!rawEncoded) return null;
  let parsed;
  try {
    parsed = JSON.parse(rawEncoded); // req.url already URL-decodes searchParams
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const norm = (term) => {
    if (typeof term !== 'string') return '';
    const t = term.trim().toLowerCase();
    if (!t || t.length > MAX_TERM_LEN) return '';
    return t;
  };

  // inc: array of groups, each group an array of strings.
  const incGroups = [];
  if (Array.isArray(parsed.inc)) {
    for (const group of parsed.inc.slice(0, MAX_GROUPS)) {
      if (!Array.isArray(group)) continue;
      const terms = [];
      for (const term of group.slice(0, MAX_TERMS_PER_GROUP)) {
        const t = norm(term);
        if (t) terms.push(t);
      }
      if (terms.length) incGroups.push(terms);
    }
  }

  // exc: flat array of strings.
  const exc = [];
  if (Array.isArray(parsed.exc)) {
    for (const term of parsed.exc.slice(0, MAX_EXC)) {
      const t = norm(term);
      if (t) exc.push(t);
    }
  }

  if (incGroups.length === 0 && exc.length === 0) return null;
  return { incGroups, exc };
}

// Apply filter to one item. inc: every group needs >=1 hit (AND of groups,
// OR within group). exc: any hit rejects. Empty inc -> passes inc test.
function passesFilter(item, filter) {
  if (!filter) return true;
  const hay = (item.title + ' ' + item.description).toLowerCase();

  for (const term of filter.exc) {
    if (hay.includes(term)) return false;
  }

  for (const group of filter.incGroups) {
    let groupHit = false;
    for (const term of group) {
      if (hay.includes(term)) {
        groupHit = true;
        break;
      }
    }
    if (!groupHit) return false;
  }

  return true;
}

// Fetch one catalogue source -> array of items (never throws).
async function fetchSource(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(source.url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!res || !res.ok) return [];
    const body = await res.text();
    return parseFeedItems(body, source.name);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------
function catalogResponse() {
  const sources = CATALOG.map(({ id, name, category }) => ({ id, name, category }));
  return new Response(JSON.stringify({ sources }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

function rssResponse(items) {
  const now = new Date().toUTCString();
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<rss version="2.0">');
  parts.push('<channel>');
  parts.push('<title>Pepo Feeds — Trusted titles</title>');
  parts.push('<link>https://kirkham-feeds.netlify.app/</link>');
  parts.push(
    '<description>Keyword-filtered merge of selected tier-one publishers&apos; own RSS feeds.</description>'
  );
  parts.push('<lastBuildDate>' + xmlEscape(now) + '</lastBuildDate>');
  parts.push('<generator>Pepo Feeds</generator>');

  for (const it of items) {
    parts.push('<item>');
    if (it.title) parts.push('<title>' + xmlEscape(it.title) + '</title>');
    if (it.link) parts.push('<link>' + xmlEscape(it.link) + '</link>');
    if (it.link) {
      parts.push('<guid isPermaLink="true">' + xmlEscape(it.link) + '</guid>');
    }
    if (it.pubDate) parts.push('<pubDate>' + xmlEscape(it.pubDate) + '</pubDate>');
    if (it.description) {
      parts.push('<description>' + xmlEscape(it.description) + '</description>');
    }
    if (it.source) parts.push('<source>' + xmlEscape(it.source) + '</source>');
    parts.push('</item>');
  }

  parts.push('</channel>');
  parts.push('</rss>');

  return new Response(parts.join('\n'), {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=600',
    },
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export default async (req) => {
  try {
    const url = new URL(req.url);

    // (1) catalogue
    if (url.searchParams.get('catalog')) {
      return catalogResponse();
    }

    // (2) merged filtered feed
    const sourcesParam = url.searchParams.get('sources') || '';
    const ids = sourcesParam
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // Resolve to known catalogue sources, dedupe, cap.
    const seenIds = new Set();
    const selected = [];
    for (const id of ids) {
      if (seenIds.has(id)) continue;
      const src = CATALOG_BY_ID.get(id);
      if (!src) continue; // ignore unknown ids
      seenIds.add(id);
      selected.push(src);
      if (selected.length >= MAX_SOURCES) break;
    }

    // No valid sources -> valid empty RSS.
    if (selected.length === 0) {
      return rssResponse([]);
    }

    const filter = buildFilter(url.searchParams.get('filter'));

    // Fetch all selected feeds in parallel; failures are already swallowed.
    const results = await Promise.all(selected.map((s) => fetchSource(s)));

    // Merge, filter, dedupe by link (fallback title), sort, cap.
    const seen = new Set();
    const merged = [];
    for (const list of results) {
      for (const item of list) {
        if (!passesFilter(item, filter)) continue;
        const key = (item.link || item.title || '').trim().toLowerCase();
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    }

    merged.sort((a, b) => toMs(b.pubDate) - toMs(a.pubDate));
    const capped = merged.slice(0, MAX_ITEMS);

    return rssResponse(capped);
  } catch {
    // Absolute last-resort guard — never throw to the client.
    return rssResponse([]);
  }
};
