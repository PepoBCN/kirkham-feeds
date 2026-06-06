/*
 * feedcheck.mjs — TEMPORARY diagnostic. Fetches a given feed URL server-side (from
 * Netlify's IP) and reports item count, so we can authoritatively verify every source's
 * RSS without our local IP getting rate-limited. Token-guarded + SSRF-guarded.
 * REMOVE after the source-feed audit.
 */
const TOKEN = 'pepo-feedcheck-7c3f9a';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function isPrivateHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return true;
  if (/^(10|127)\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
  return false;
}

function countItems(xml) {
  const items = (xml.match(/<item[\s>]/gi) || []).length;
  const entries = (xml.match(/<entry[\s>]/gi) || []).length;
  return Math.max(items, entries);
}

export default async (req) => {
  const u = new URL(req.url);
  if (u.searchParams.get('t') !== TOKEN) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }
  const target = u.searchParams.get('url') || '';
  let parsed;
  try { parsed = new URL(target); } catch { return Response.json({ ok: false, error: 'bad-url' }); }
  if (!/^https?:$/.test(parsed.protocol) || isPrivateHost(parsed.hostname)) {
    return Response.json({ ok: false, error: 'blocked' });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(target, {
      redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*' },
    });
    const txt = r.ok ? await r.text() : '';
    const head = txt.slice(0, 600).toLowerCase();
    const looksFeed = head.includes('<rss') || head.includes('<feed') || head.includes('<rdf') || (head.includes('<?xml') && /<(item|entry)[\s>]/i.test(txt));
    return Response.json({ ok: r.ok && looksFeed, status: r.status, items: looksFeed ? countItems(txt) : 0 }, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e && e.name || e) });
  } finally {
    clearTimeout(timer);
  }
};
