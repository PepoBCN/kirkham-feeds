// feed.mjs — the merged broad feed.
// Google News (breadth) + deep Guardian + deep NYT for the same query, merged and
// de-duped by headline so the same story never appears twice across sources.
// Google News links are wrapped by Google, and its titles carry a " - Publisher"
// suffix, so we dedupe on a normalised, suffix-stripped headline — which is exactly
// what collapses "Headline - The Guardian" (Google) against "Headline" (Guardian API).

const GUARDIAN = 'https://content.guardianapis.com/search';
const NYT = 'https://api.nytimes.com/svc/search/v2/articlesearch.json';
const UA = 'PepoFeeds/1.0';
const API_CAP = 25;   // most-relevant deep articles per API source
const TOTAL_CAP = 120;

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function decode(raw) {
  if (raw == null) return '';
  return String(raw)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}
// Dedupe key: drop the trailing " - Source" Google News appends, then normalise.
function dedupeKey(title) {
  return String(title || '')
    .replace(/\s+[-–—]\s+[^-–—]+$/, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function toMs(d) { const t = Date.parse(d || ''); return Number.isFinite(t) ? t : 0; }

async function get(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: '*/*' }, ...opts });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; } finally { clearTimeout(timer); }
}

function parseGoogleNews(xml) {
  if (!xml) return [];
  const out = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const title = decode((/<title>([\s\S]*?)<\/title>/i.exec(b) || [])[1]);
    const link = decode((/<link>([\s\S]*?)<\/link>/i.exec(b) || [])[1]);
    const pub = decode((/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(b) || [])[1]);
    const desc = decode((/<description>([\s\S]*?)<\/description>/i.exec(b) || [])[1]);
    if (title && link) out.push({ title, link, pubDate: pub, desc });
  }
  return out;
}

async function fetchGuardian(q, key) {
  if (!key || !q) return [];
  const p = new URLSearchParams({ 'api-key': key, 'order-by': 'relevance', 'page-size': String(API_CAP), 'show-fields': 'trailText', q });
  const txt = await get(`${GUARDIAN}?${p.toString()}`);
  if (!txt || txt[0] !== '{') return [];
  let data; try { data = JSON.parse(txt); } catch { return []; }
  const rs = (data.response && data.response.results) || [];
  return rs.map(a => ({
    title: (a.webTitle || '').trim(),
    link: (a.webUrl || '').trim(),
    pubDate: a.webPublicationDate ? new Date(a.webPublicationDate).toUTCString() : '',
    desc: (a.fields && a.fields.trailText) || '',
  })).filter(x => x.title && x.link);
}

async function fetchNyt(q, key) {
  if (!key || !q) return [];
  const p = new URLSearchParams({ 'api-key': key, sort: 'relevance', q });
  const txt = await get(`${NYT}?${p.toString()}`);
  if (!txt || txt[0] !== '{') return [];
  let data; try { data = JSON.parse(txt); } catch { return []; }
  const docs = (data.response && data.response.docs) || [];
  return docs.slice(0, API_CAP).map(d => ({
    title: ((d.headline && d.headline.main) || '').trim(),
    link: (d.web_url || '').trim(),
    pubDate: d.pub_date ? new Date(d.pub_date).toUTCString() : '',
    desc: (d.abstract || d.snippet || ''),
  })).filter(x => x.title && x.link);
}

function rss(items) {
  const now = new Date().toUTCString();
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>', '<rss version="2.0"><channel>',
    '<title>Pepo Feeds</title>', '<link>https://pepo-feeds.netlify.app/</link>',
    '<description>News feed: broad coverage + deep Guardian/NYT, de-duped.</description>',
    '<lastBuildDate>' + xmlEscape(now) + '</lastBuildDate>', '<generator>Pepo Feeds</generator>',
  ];
  for (const it of items) {
    parts.push('<item>');
    if (it.title) parts.push('<title>' + xmlEscape(it.title) + '</title>');
    if (it.link) { parts.push('<link>' + xmlEscape(it.link) + '</link>'); parts.push('<guid isPermaLink="true">' + xmlEscape(it.link) + '</guid>'); }
    if (it.pubDate) parts.push('<pubDate>' + xmlEscape(it.pubDate) + '</pubDate>');
    if (it.desc) parts.push('<description>' + xmlEscape(it.desc) + '</description>');
    if (it.source) parts.push('<source url="' + xmlEscape(it.sourceUrl || '') + '">' + xmlEscape(it.source) + '</source>');
    parts.push('</item>');
  }
  parts.push('</channel></rss>');
  return new Response(parts.join('\n'), {
    status: 200,
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' },
  });
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const gn = url.searchParams.get('gn') || '';     // Google News RSS url
    const q = url.searchParams.get('q') || '';        // deep-API query (positive terms)

    const tasks = [];
    tasks.push(gn.startsWith('https://news.google.com/rss/') ? get(gn).then(parseGoogleNews) : Promise.resolve([]));
    tasks.push(fetchGuardian(q, process.env.GUARDIAN_API_KEY).then(a => a.map(x => ({ ...x, source: 'The Guardian', sourceUrl: 'https://www.theguardian.com/' }))));
    tasks.push(fetchNyt(q, process.env.NYT_API_KEY).then(a => a.map(x => ({ ...x, source: 'The New York Times', sourceUrl: 'https://www.nytimes.com/' }))));

    const [gnItems, gItems, nItems] = await Promise.all(tasks);

    // Merge: Google News first (it owns the canonical recent set), then deep sources
    // fill gaps. De-dupe by normalised headline so a Guardian/NYT story already in
    // Google News isn't repeated.
    const seen = new Set();
    const merged = [];
    for (const list of [gnItems, gItems, nItems]) {
      for (const it of list) {
        const k = dedupeKey(it.title);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        merged.push(it);
      }
    }
    merged.sort((a, b) => toMs(b.pubDate) - toMs(a.pubDate));
    return rss(merged.slice(0, TOTAL_CAP));
  } catch {
    return rss([]);
  }
};
