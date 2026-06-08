/*
 * parse.mjs — Netlify Function (v2)
 *
 * Contract (the frontend "Describe it" bar is built against this exactly):
 *   POST /.netlify/functions/parse   body: { "text": "...", "current": {state} }
 *   ALWAYS responds 200 with JSON { "state": {...} | null }.
 *   Headers: Content-Type: application/json, Access-Control-Allow-Origin: *
 *
 *   `text`    = the user's plain-English description / refinement.
 *   `current` = the existing query state (optional). If present, the instruction
 *               is applied AS A MODIFICATION to it (add/remove); a full fresh
 *               description replaces it.
 *
 *   Returns { state: { trackTerms, andGroups, phraseTerms, excludeTerms,
 *                      siteTerms, excludeSiteTerms } } — all arrays
 *   (andGroups = array of OR-groups). On a missing key / empty text / any
 *   error (LLM, network, parse), returns { state: null }, 200. NEVER throws.
 */

const MAX_TEXT = 600;
const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const json = (obj) =>
  new Response(JSON.stringify(obj), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });

const STR = (v) => (typeof v === 'string' ? v.trim() : '');
const strArr = (v) =>
  Array.isArray(v) ? [...new Set(v.map(STR).filter(Boolean))].slice(0, 12) : [];

// Normalise the model's JSON into the exact state shape the frontend expects.
function normaliseState(obj) {
  if (!obj || typeof obj !== 'object') return null;
  let andGroups = Array.isArray(obj.andGroups)
    ? obj.andGroups.map(strArr).filter((g) => g.length)
    : [];
  // The UI shows a single "Must also mention" card → keep at most one group in v1.
  if (andGroups.length > 1) andGroups = [andGroups.flat().slice(0, 12)];
  return {
    trackTerms: strArr(obj.trackTerms),
    andGroups,
    phraseTerms: strArr(obj.phraseTerms),
    excludeTerms: strArr(obj.excludeTerms),
    siteTerms: strArr(obj.siteTerms),
    excludeSiteTerms: strArr(obj.excludeSiteTerms),
  };
}

// Pull the first JSON object out of arbitrary model text.
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export default async (req) => {
  try {
    let body = {};
    try {
      body = await req.json();
    } catch {
      return json({ state: null });
    }

    const text = STR(body.text);
    if (!text || text.length > MAX_TEXT) return json({ state: null });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return json({ state: null });

    const current = body.current && typeof body.current === 'object' ? body.current : null;

    const system =
      `You convert a short description or keywords for a news feed into a structured Google News query. ` +
      `Output ONLY a JSON object (no prose, no markdown, no code fences) with these keys, all arrays of short strings:\n` +
      `- "trackTerms": the main SUBJECT(s) of the feed — the person, org, team, place or thing it is about. OR'd: an article matches if it mentions ANY.\n` +
      `- "andGroups": an array of AT MOST ONE extra requirement group (an array of OR'd terms) the article must ALSO mention. Use this to narrow the subject to a topic/aspect. Return [] if there is only a subject.\n` +
      `- "phraseTerms": exact multi-word phrases that must appear verbatim.\n` +
      `- "excludeTerms": words to hide. ONLY fill this when the user EXPLICITLY asks to remove something (words like "exclude", "without", "no", "not", "ignore", "hide", "minus", "except"). Otherwise this MUST be []. \n` +
      `- "siteTerms": domains to restrict TO (only-from). Infer from publisher names ("from the BBC and Guardian" -> ["bbc.co.uk","theguardian.com"]).\n` +
      `- "excludeSiteTerms": domains to EXCLUDE. For "exclude X's own site" / "not from their website", infer the company/brand domain (Tesla -> tesla.com).\n` +
      `CRITICAL RULES:\n` +
      `1. Copy the user's words VERBATIM into terms. NEVER correct spelling, translate, or alter a proper noun — if they type "Arsenal" output "Arsenal" (never "Arenal"); keep their casing for names.\n` +
      `2. NEVER invent exclusions. Words that describe the KIND of coverage wanted — "gossip", "goss", "rumours", "news", "latest", "updates", "analysis", "opinion", "reaction", "talk" — are NOT exclusions; they tell you what the user WANTS. Only exclude when the user explicitly says to (see the excludeTerms rule).\n` +
      `3. Choose structure by intent:\n` +
      `   - SUBJECT + ASPECT ("Arsenal transfer goss", "Tesla earnings", "Labour immigration policy") -> put the subject in trackTerms and the aspect in andGroups so BOTH must appear. e.g. "Arsenal transfer goss" -> trackTerms ["Arsenal"], andGroups [["transfer","transfers","signing","deal","bid"]].\n` +
      `   - SYNONYMS / ALIASES for one thing, or a list of similar entities -> OR them together in trackTerms (e.g. ["Arsenal","Arsenal FC","Gunners"]).\n` +
      `   - Do NOT dump every word into trackTerms as OR — that broadens the feed to anything mentioning any single word.\n` +
      `4. Keep terms short; you may expand an ASPECT into a few helpful synonyms inside its andGroup (transfer -> transfer, signing, deal, bid). Map publisher/company names to bare domains (no www, no https).\n` +
      (current
        ? `A CURRENT state is provided; APPLY the user's instruction to it (add or remove items) and return the FULL updated state. If the instruction is a brand-new complete description, replace it instead.`
        : `Return the state for this description.`);

    const userMsg = current
      ? `CURRENT state:\n${JSON.stringify(current)}\n\nINSTRUCTION:\n${text}`
      : text;

    let response;
    try {
      response = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 500,
          temperature: 0.1,
          system,
          messages: [{ role: 'user', content: userMsg }],
        }),
      });
    } catch {
      return json({ state: null });
    }

    if (!response.ok) return json({ state: null });

    let data;
    try {
      data = await response.json();
    } catch {
      return json({ state: null });
    }

    const out = Array.isArray(data?.content)
      ? data.content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('')
      : '';

    const state = normaliseState(extractJson(out));
    return json({ state });
  } catch {
    return json({ state: null });
  }
};
