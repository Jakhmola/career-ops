// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Jooble aggregator — query-based source over the Jooble Jobs API.
// Good NL/EU/global coverage; free tier available.
// Auth: API key is a PATH SEGMENT in the endpoint URL (not a header).
// Key is read from JOOBLE_API_KEY in .env (dotenv loaded by scan.mjs).
// Missing key → return [] (dormant, not an error).
//
// API: POST https://jooble.org/api/<API_KEY>
//   Body: { keywords, location, page }  (JSON)
//   Response: { totalCount, jobs: [ { title, company, location, snippet, link, ... } ] }
//   Field mapping: description←snippet, url←link.
//
// Query strategy: one POST per role phrase (config.queries), page 1 by default
// (max_pages configurable). Dedup by link within this fetch; the scanner's
// downstream title_filter + location_filter provide precision.
//
// Aggregators export NO detect() — see arbeitnow.mjs header.

const JOOBLE_API_BASE = 'https://jooble.org/api';
const DEFAULT_LOCATION = 'Netherlands';
const DEFAULT_MAX_PAGES = 1;
const DEFAULT_QUERIES = [
  'AI Engineer',
  'Machine Learning Engineer',
  'Data Scientist',
  'LLM Engineer',
  'NLP Engineer',
  'Applied AI',
  'Data Engineer',
];

/** @type {Provider} */
export default {
  id: 'jooble',
  // NO detect().

  async fetch(descriptor, ctx) {
    const rawKey = process.env.JOOBLE_API_KEY;
    if (!rawKey || !rawKey.trim()) {
      console.log('jooble: skipped — JOOBLE_API_KEY not set in .env');
      return [];
    }
    const key = rawKey.trim();

    const cfg = descriptor?.config || {};
    const location = String(cfg.location || DEFAULT_LOCATION);
    const maxPages = Math.min(10, Math.max(1, Number(cfg.max_pages) || DEFAULT_MAX_PAGES));
    const queries = Array.isArray(cfg.queries) && cfg.queries.length > 0
      ? cfg.queries.map(String).filter(Boolean)
      : DEFAULT_QUERIES;

    const endpoint = `${JOOBLE_API_BASE}/${key}`;

    const seen = new Set();
    const jobs = [];
    let lastErr = null;
    let anyOk = false;

    for (const query of queries) {
      let results;
      try {
        results = await fetchQuery(query, { endpoint, location, maxPages }, ctx);
        anyOk = true;
      } catch (err) {
        lastErr = err; // tolerate a single query failing — partial results win
        continue;
      }
      for (const j of results) {
        if (j.url && !seen.has(j.url)) { seen.add(j.url); jobs.push(j); }
      }
    }

    // Only surface an error if EVERY query failed.
    if (!anyOk && lastErr) throw lastErr;
    return jobs;
  },
};

/**
 * Fetch one query across up to maxPages pages via POST.
 *
 * ctx.fetchJson supports { method, body, headers } (see _http.mjs),
 * so we use it directly. No need for a raw fetch() fallback.
 *
 * @param {string} query
 * @param {{ endpoint: string, location: string, maxPages: number }} opts
 * @param {object} ctx
 * @returns {Promise<Array<{title: string, url: string, company: string, location: string, description: string}>>}
 */
async function fetchQuery(query, { endpoint, location, maxPages }, ctx) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const bodyObj = { keywords: query, location, page: String(page) };
    ctx.recordCall?.('jooble');
    let json;
    try {
      json = await ctx.fetchJson(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
      });
    } catch (err) {
      if (page === 1) throw err;
      break; // transient failure on page > 1: return what we have
    }
    const parsed = parseJoobleResponse(json);
    out.push(...parsed);
    // Stop if the page returned nothing or fewer jobs than a full page (last page).
    if (parsed.length === 0) break;
    // Jooble doesn't expose a total-pages field; stop when we've hit maxPages.
  }
  return out;
}

/**
 * Parse a Jooble API response. Exported for unit tests (no network).
 *
 * Success response shape:
 *   { totalCount: number,
 *     jobs: [ { title, company, location, snippet, salary, source,
 *               type, link, updated, id } ] }
 *
 * Field mapping:
 *   title     ← title
 *   url       ← link        (Jooble's field name for the job URL)
 *   company   ← company
 *   location  ← location
 *   description ← snippet   (Jooble's field name for the job excerpt)
 *
 * Drop records without a usable title or link.
 *
 * @param {any} json
 * @returns {Array<{title: string, url: string, company: string, location: string, description: string}>}
 */
export function parseJoobleResponse(json) {
  const items = json?.jobs;
  if (!Array.isArray(items)) return [];
  return items
    .filter((j) => j && typeof j.link === 'string' && j.link && j.title)
    .map((j) => ({
      title: j.title || '',
      url: j.link,
      company: j.company || '',
      location: typeof j.location === 'string' ? j.location : '',
      description: j.snippet || '',
    }));
}
