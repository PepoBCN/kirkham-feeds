// One-off: discover + test a native RSS feed for every curated source.
// Reads data/uk-sources.json, collects all domains, and for each tries to find a
// working feed (homepage <link rel=alternate> first, then common paths), testing
// that it returns items. Prints TSV: group<TAB>name<TAB>domain<TAB>status<TAB>items<TAB>feedUrl
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../data/uk-sources.json', import.meta.url)));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TIMEOUT = 12000;

const COMMON = ['/rss', '/feed', '/feed/', '/rss.xml', '/index.xml', '/feeds/posts/default?alt=rss', '/?feed=rss2', '/rss/all.xml', '/en/rss', '/rssfeed', '/feeds/rss', '/arc/outboundfeeds/rss/?outputType=xml', '/rss/uk', '/news/rss', '/rss/home'];

// Known-good feed URLs already wired + Netlify-verified in feed.mjs (domain -> url).
// These are authoritative; the discovery probes are only a fallback.
const KNOWN = {
  'bbc.co.uk': 'https://feeds.bbci.co.uk/news/rss.xml',
  'news.sky.com': 'https://feeds.skynews.com/feeds/rss/home.xml',
  'theguardian.com': 'https://www.theguardian.com/uk/rss',
  'independent.co.uk': 'https://www.independent.co.uk/news/uk/rss',
  'thesun.co.uk': 'https://www.thesun.co.uk/feed/',
  'dailymail.co.uk': 'https://www.dailymail.co.uk/articles.rss',
  'mirror.co.uk': 'https://www.mirror.co.uk/?service=rss',
  'express.co.uk': 'https://www.express.co.uk/posts/rss/1/news',
  'metro.co.uk': 'https://metro.co.uk/feed/',
  'standard.co.uk': 'https://www.standard.co.uk/rss',
  'nytimes.com': 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
  'washingtonpost.com': 'https://feeds.washingtonpost.com/rss/homepage',
  'cnn.com': 'http://rss.cnn.com/rss/cnn_topstories.rss',
  'foxnews.com': 'https://moxie.foxnews.com/google-publisher/latest.xml',
  'abcnews.go.com': 'https://abcnews.go.com/abcnews/topstories',
  'cbsnews.com': 'https://www.cbsnews.com/latest/rss/main',
  'nbcnews.com': 'https://feeds.nbcnews.com/nbcnews/public/news',
  'npr.org': 'https://feeds.npr.org/1001/rss.xml',
  'politico.com': 'https://rss.politico.com/politics-news.xml',
  'thehill.com': 'https://thehill.com/rss/syndicator/19110',
  'axios.com': 'https://api.axios.com/feed/',
  'latimes.com': 'https://www.latimes.com/rss2.0.xml',
  'theatlantic.com': 'https://www.theatlantic.com/feed/all/',
  'newyorker.com': 'https://www.newyorker.com/feed/news',
  'aljazeera.com': 'https://www.aljazeera.com/xml/rss/all.xml',
  'ft.com': 'https://www.ft.com/rss/home',
  'cnbc.com': 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
  'wsj.com': 'https://feeds.a.dj.com/rss/RSSWorldNews.xml',
  'bloomberg.com': 'https://feeds.bloomberg.com/markets/news.rss',
  'upi.com': 'https://www.upi.com/rss/top_news.rss',
  'ansa.it': 'https://www.ansa.it/english/english_rss.xml',
  'yna.co.kr': 'https://en.yna.co.kr/RSS/news.xml',
  'tass.com': 'https://tass.com/rss/v2.xml',
  'news.cn': 'https://english.news.cn/rss/worldrss.xml',
};

function countItems(xml) {
  const items = (xml.match(/<item[\s>]/gi) || []).length;
  const entries = (xml.match(/<entry[\s>]/gi) || []).length;
  return Math.max(items, entries);
}

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'text/html,application/rss+xml,application/atom+xml,application/xml,*/*' } });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; } finally { clearTimeout(t); }
}

function isFeed(txt) {
  if (!txt) return false;
  const head = txt.slice(0, 600).toLowerCase();
  return head.includes('<rss') || head.includes('<feed') || head.includes('<rdf') || (head.includes('<?xml') && /<(item|entry)[\s>]/i.test(txt));
}

async function findFeed(domain) {
  const base = `https://${domain}`;
  // 0) known-good (authoritative)
  if (KNOWN[domain]) {
    const x = await get(KNOWN[domain]);
    if (isFeed(x)) return { url: KNOWN[domain], items: countItems(x), known: true };
  }
  // 1) homepage <link rel=alternate type=...rss/atom...>
  const home = await get(base + '/');
  if (home) {
    const links = [...home.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]);
    for (const l of links) {
      if (!/rss\+xml|atom\+xml/i.test(l)) continue;
      const href = (/href\s*=\s*["']([^"']+)["']/i.exec(l) || [])[1];
      if (!href) continue;
      let u = href.startsWith('http') ? href : (href.startsWith('//') ? 'https:' + href : base + (href.startsWith('/') ? '' : '/') + href);
      const x = await get(u);
      if (isFeed(x)) return { url: u, items: countItems(x) };
    }
  }
  // 2) common paths on the domain and on feed subdomains
  const root = domain.replace(/^www\./, '');
  const hosts = [base, `https://feeds.${root}`, `https://rss.${root}`, `https://feed.${root}`];
  for (const h of hosts) {
    for (const p of COMMON) {
      const u = h + p;
      const x = await get(u);
      if (isFeed(x)) return { url: u, items: countItems(x) };
    }
  }
  return null;
}

const rows = [];
for (const [group, arr] of Object.entries(data.curated)) {
  if (!Array.isArray(arr)) continue;
  for (const s of arr) rows.push({ group, name: s.name, domain: s.domain });
}

const holdouts = new Set(data._native_rss_holdouts || []);
let i = 0;
const CONC = 6;
async function worker() {
  while (i < rows.length) {
    const row = rows[i++];
    const tagged = holdouts.has(row.domain);
    const res = await findFeed(row.domain);
    const status = res ? 'FEED' : (tagged ? 'broad(tagged)' : 'NO-FEED');
    process.stdout.write(`${row.group}\t${row.name}\t${row.domain}\t${status}\t${res ? res.items : 0}\t${res ? res.url : ''}\n`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
process.stderr.write(`done ${rows.length} sources\n`);
