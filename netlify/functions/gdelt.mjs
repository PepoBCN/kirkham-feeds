/*
 * gdelt.mjs — Netlify Function (v2)  [the "broad index" engine]
 *
 * The breadth source for Pepo Feeds, sitting alongside the Trusted-titles picker
 * (feed.mjs). Takes the rule-cards query the frontend already builds, translates it
 * into a GDELT DOC 2.0 query, fetches, cleans the firehose down to journalism using
 * the curated UK news list, and returns a clean subscribable RSS feed (or JSON for the
 * live preview).
 *
 * Why GDELT: free, keyless, genuinely global, proper country/domain/language filters,
 * and it indexes the PUBLIC headlines + links of paywalled papers that expose no RSS
 * (the Times, the Telegraph) — so they show up in a feed and the click-through lands on
 * the publisher's own paywall, exactly like Google News. No paywall-cracking, no
 * full-text scraping: we only ever surface the public headline + link.
 *
 * --- Contract -------------------------------------------------------------------
 *
 *   1) GET /.netlify/functions/gdelt?catalog=1
 *      -> 200 JSON: the curated source list (data/uk-sources.json) for the Sources page.
 *
 *   2) GET /.netlify/functions/gdelt?<query params>
 *      -> 200 RSS 2.0  (default)  |  &format=json -> 200 JSON { articles: [...] }
 *
 *      Params (all optional, all defensively parsed):
 *        inc      JSON: array of OR-groups, e.g. [["arsenal","Arsenal FC"],["transfer"]]
 *                 -> AND across groups, OR within a group. Terms with spaces are phrased.
 *        exc      JSON: array of exclude terms, e.g. ["chelsea","\"rugby\""]
 *        country  "UK" | "US" | "" (worldwide)        default "UK"
 *        scope    "curated" (allowlist only) | "all" (country minus denylist)  default "curated"
 *        social   "1" exclude socials (default) | "0" keep
 *        inc_dom  JSON: array of domains to RESTRICT to (explicit site: filters)
 *        exc_dom  JSON: array of domains to drop (brand-exclude + explicit -site:)
 *        max      1..75   default 60
 *        format   "rss" (default) | "json"
 *
 * Never throws to the client. GDELT rate-limits to 1 request / 5s per IP; if it throttles
 * or errors, the body isn't JSON -> we degrade to a valid empty feed (200).
 *
 * No npm deps — plain fetch + the shared curated list.
 */

import UK_SOURCES from '../../data/uk-sources.json';

const GDELT_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';

// ---------------------------------------------------------------------------
// Build the allow / deny / social sets once from the shared curated list.
// ---------------------------------------------------------------------------
function normDomain(d) {
  return String(d || '')
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

const ALLOW = (() => {
  const set = new Set();
  const cur = (UK_SOURCES && UK_SOURCES.curated) || {};
  for (const group of Object.values(cur)) {
    if (!Array.isArray(group)) continue;
    for (const s of group) {
      const d = normDomain(s && s.domain);
      if (d) set.add(d);
    }
  }
  return set;
})();

const DENY = new Set((UK_SOURCES.denylist_nonnews || []).map(normDomain).filter(Boolean));

const SOCIAL = new Set(
  ['twitter.com', 'x.com', 't.co', 'facebook.com', 'instagram.com', 'reddit.com',
   'youtube.com', 'tiktok.com', 'linkedin.com', 'pinterest.com', 'threads.net']
);

// GDELT sourcecountry codes.
const COUNTRY_CODE = { UK: 'UK', US: 'US' };

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
const HARD_MAX = 75;
const MAX_TERM_LEN = 80;
const MAX_GROUPS = 12;
const MAX_TERMS_PER_GROUP = 20;
const MAX_EXC = 30;
const MAX_DOMAINS = 30;
const GDELT_TIMEOUT_MS = 12000;
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

function safeJsonParam(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function cleanTerm(t) {
  if (typeof t !== 'string') return '';
  const s = t.trim();
  if (!s || s.length > MAX_TERM_LEN) return '';
  return s;
}

// A term for GDELT: phrase-quote if it contains whitespace; strip the user's own
// quotes first so we don't double-wrap. Drop GDELT-breaking characters.
function gdeltTerm(raw) {
  let t = cleanTerm(raw);
  if (!t) return '';
  t = t.replace(/^"+|"+$/g, '').replace(/[()]/g, ' ').trim();
  if (!t) return '';
  return /\s/.test(t) ? `"${t}"` : t;
}

// Translate the structured query into a GDELT DOC query string.
function buildGdeltQuery({ incGroups, exc, country, scope, incDom }) {
  const parts = [];

  for (const group of incGroups) {
    const terms = group.map(gdeltTerm).filter(Boolean);
    if (!terms.length) continue;
    parts.push(terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`);
  }

  // GDELT needs at least one keyword token; operators alone are rejected.
  if (!parts.length) return null;

  for (const e of exc) {
    const t = gdeltTerm(e);
    if (t) parts.push(`-${t}`);
  }

  // Explicit site: restriction -> domainis OR-block (capped).
  const incDomains = incDom.slice(0, 8);
  if (incDomains.length) {
    parts.push(`(${incDomains.map((d) => `domainis:${d}`).join(' OR ')})`);
  }

  const cc = COUNTRY_CODE[country];
  if (cc) parts.push(`sourcecountry:${cc}`);
  // Worldwide: constrain to English so the feed stays readable for an English UI.
  else parts.push('sourcelang:english');

  return parts.join(' ');
}

// Parse GDELT seendate "YYYYMMDDTHHMMSSZ" -> RFC822 string (or '').
function seenToRfc822(seendate) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(seendate || ''));
  if (!m) return '';
  const [, Y, Mo, D, H, Mi, S] = m;
  const dt = new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S));
  return Number.isFinite(dt.getTime()) ? dt.toUTCString() : '';
}

function seenToMs(seendate) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(seendate || ''));
  if (!m) return 0;
  const [, Y, Mo, D, H, Mi, S] = m;
  return Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S);
}

// Domain match against a set, allowing subdomains (news.bbc.co.uk ~ bbc.co.uk).
function domainInSet(domain, set) {
  const d = normDomain(domain);
  if (!d) return false;
  if (set.has(d)) return true;
  for (const entry of set) {
    if (d === entry || d.endsWith('.' + entry)) return true;
  }
  return false;
}

// Normalise a headline for dedup: lowercase, strip punctuation, collapse spaces.
function titleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function callGdelt(query, max) {
  const params = new URLSearchParams({
    query,
    mode: 'ArtList',
    format: 'json',
    maxrecords: String(Math.min(max * 2, 250)), // over-fetch; we dedup/filter down
    sort: 'datedesc',
  });
  const url = `${GDELT_ENDPOINT}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GDELT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, */*' },
    });
    if (!res || !res.ok) return [];
    const text = await res.text();
    // GDELT throttle / error responses are plain text, not JSON.
    if (!text || text[0] !== '{') return [];
    let data;
    try { data = JSON.parse(text); } catch { return []; }
    return Array.isArray(data.articles) ? data.articles : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------
function jsonResponse(obj, maxAge = 300) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': `public, max-age=${maxAge}`,
    },
  });
}

function rssResponse(items) {
  const now = new Date().toUTCString();
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<rss version="2.0">');
  parts.push('<channel>');
  parts.push('<title>Pepo Feeds — Broad index</title>');
  parts.push('<link>https://pepo-feeds.netlify.app/</link>');
  parts.push('<description>Cleaned news index built from GDELT, filtered to journalism.</description>');
  parts.push('<lastBuildDate>' + xmlEscape(now) + '</lastBuildDate>');
  parts.push('<generator>Pepo Feeds</generator>');
  for (const it of items) {
    parts.push('<item>');
    if (it.title) parts.push('<title>' + xmlEscape(it.title) + '</title>');
    if (it.link) {
      parts.push('<link>' + xmlEscape(it.link) + '</link>');
      parts.push('<guid isPermaLink="true">' + xmlEscape(it.link) + '</guid>');
    }
    if (it.pubDate) parts.push('<pubDate>' + xmlEscape(it.pubDate) + '</pubDate>');
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
      'Cache-Control': 'public, max-age=300',
    },
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export default async (req) => {
  try {
    const url = new URL(req.url);
    const wantJson = (url.searchParams.get('format') || 'rss').toLowerCase() === 'json';

    // (1) Source catalogue for the Sources page.
    if (url.searchParams.get('catalog')) {
      return jsonResponse(UK_SOURCES, 3600);
    }

    // (2) Parse the structured query defensively.
    const incRaw = safeJsonParam(url.searchParams.get('inc'));
    const incGroups = [];
    if (Array.isArray(incRaw)) {
      for (const g of incRaw.slice(0, MAX_GROUPS)) {
        const arr = Array.isArray(g) ? g : [g];
        const terms = [];
        for (const t of arr.slice(0, MAX_TERMS_PER_GROUP)) {
          const c = cleanTerm(t);
          if (c) terms.push(c);
        }
        if (terms.length) incGroups.push(terms);
      }
    }

    const excRaw = safeJsonParam(url.searchParams.get('exc'));
    const exc = Array.isArray(excRaw)
      ? excRaw.map(cleanTerm).filter(Boolean).slice(0, MAX_EXC)
      : [];

    const incDom = (safeJsonParam(url.searchParams.get('inc_dom')) || [])
      .map(normDomain).filter(Boolean).slice(0, MAX_DOMAINS);
    const excDom = (safeJsonParam(url.searchParams.get('exc_dom')) || [])
      .map(normDomain).filter(Boolean).slice(0, MAX_DOMAINS);
    const excDomSet = new Set(excDom);

    const country = (url.searchParams.get('country') || 'UK').toUpperCase();
    const countryParam = country === 'WORLDWIDE' || country === '' ? '' : country;
    const scope = (url.searchParams.get('scope') || 'curated').toLowerCase();
    const social = url.searchParams.get('social') !== '0'; // default: exclude socials
    const max = Math.min(Math.max(parseInt(url.searchParams.get('max'), 10) || 60, 1), HARD_MAX);

    const query = buildGdeltQuery({ incGroups, exc, country: countryParam, scope, incDom });

    // No usable keyword -> empty (this tool is topic-driven; "all UK" still needs a topic).
    if (!query) {
      return wantJson ? jsonResponse({ articles: [] }) : rssResponse([]);
    }

    const raw = await callGdelt(query, max);

    const incDomSet = new Set(incDom);
    const seen = new Set();
    const items = [];
    for (const a of raw) {
      const domain = normDomain(a && a.domain);
      const title = (a && a.title ? String(a.title) : '').trim();
      const link = (a && a.url ? String(a.url) : '').trim();
      if (!title || !link || !domain) continue;

      // Explicit site: restriction wins.
      if (incDomSet.size && !domainInSet(domain, incDomSet)) continue;
      // Brand-exclude / explicit -site:.
      if (excDomSet.size && domainInSet(domain, excDomSet)) continue;
      // Socials off (default).
      if (social && domainInSet(domain, SOCIAL)) continue;
      // Scope: curated allowlist, or "all" = country sources minus non-news denylist.
      if (scope === 'curated') {
        if (!incDomSet.size && !domainInSet(domain, ALLOW)) continue;
      } else {
        if (domainInSet(domain, DENY)) continue;
      }

      const tkey = titleKey(title);
      if (seen.has(tkey)) continue; // collapse the same headline across wires
      seen.add(tkey);

      items.push({
        title,
        link,
        pubDate: seenToRfc822(a.seendate),
        _ms: seenToMs(a.seendate),
        source: domain,
        domain,
      });
    }

    items.sort((x, y) => y._ms - x._ms);
    const capped = items.slice(0, max);

    if (wantJson) {
      return jsonResponse({
        count: capped.length,
        articles: capped.map(({ title, link, pubDate, source, domain }) => ({
          title, link, pubDate, source, domain,
        })),
      });
    }
    return rssResponse(capped);
  } catch {
    const wantJson = (() => {
      try { return new URL(req.url).searchParams.get('format') === 'json'; }
      catch { return false; }
    })();
    return wantJson ? jsonResponse({ articles: [] }) : rssResponse([]);
  }
};
