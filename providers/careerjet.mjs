// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Careerjet v4 aggregator — query-based source over the Careerjet REST API.
// Good NL/EU coverage; free tier allows up to 1000 calls/hour. Auth is HTTP
// Basic: username = API key, password = empty string (built as a header here).
// Key is read from CAREERJET_KEY in .env (dotenv loaded by scan.mjs).
// Missing key → return [] (dormant, not an error).
//
// MANDATORY params: user_ip and user_agent — Careerjet returns 403 without them.
// user_ip defaults to 203.0.113.1 (TEST-NET-3, RFC 5737 — a valid public IPv4)
// and can be overridden via CAREERJET_USER_IP env var or portals config.
// MANDATORY header: Referer — Careerjet returns 403 "Undeclared referrer" if
// the Referer header is absent. Fixed to "https://www.careerjet.com".
//
// Query strategy: one request per role phrase (config.queries), page_size=50,
// max_pages=1 by default. The scanner's downstream title_filter + location_filter
// provide precision; keep queries at role-phrase granularity, not single tokens.
//
// Aggregators export NO detect() — see arbeitnow.mjs header.

const CAREERJET_ENDPOINT = 'https://search.api.careerjet.net/v4/query';
const DEFAULT_LOCALE = 'nl_NL';
const DEFAULT_LOCATION = 'Netherlands';
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 1;
const DEFAULT_USER_IP = '203.0.113.1'; // TEST-NET-3 (RFC 5737) — valid public IPv4
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_QUERIES = [
  'AI Engineer',
  'Machine Learning Engineer',
  'Data Scientist',
  'LLM Engineer',
  'NLP Engineer',
  'Applied AI',
  'Data Engineer',
];

/**
 * Build the Authorization: Basic header for Careerjet.
 * Username = API key, password = empty string.
 *
 * Exported for unit tests (no network).
 *
 * @param {string} key
 * @returns {string}  e.g. "Basic a2V5OA=="
 */
export function buildBasicAuthHeader(key) {
  return 'Basic ' + Buffer.from(key.trim() + ':').toString('base64');
}

/** @type {Provider} */
export default {
  id: 'careerjet',
  // NO detect().

  async fetch(descriptor, ctx) {
    const rawKey = process.env.CAREERJET_KEY;
    if (!rawKey || !rawKey.trim()) {
      console.log('careerjet: skipped — CAREERJET_KEY not set in .env');
      return [];
    }
    const key = rawKey.trim();

    const cfg = descriptor?.config || {};
    const localeCode = String(cfg.locale_code || DEFAULT_LOCALE);
    const location = String(cfg.location || DEFAULT_LOCATION);
    const pageSize = Math.min(100, Math.max(1, Number(cfg.page_size) || DEFAULT_PAGE_SIZE));
    const maxPages = Math.min(10, Math.max(1, Number(cfg.max_pages) || DEFAULT_MAX_PAGES));
    const sort = String(cfg.sort || 'date');
    const userIp =
      process.env.CAREERJET_USER_IP ||
      (typeof cfg.user_ip === 'string' && cfg.user_ip.trim() ? cfg.user_ip.trim() : DEFAULT_USER_IP);
    const queries = Array.isArray(cfg.queries) && cfg.queries.length > 0
      ? cfg.queries.map(String).filter(Boolean)
      : DEFAULT_QUERIES;

    const authHeader = buildBasicAuthHeader(key);

    const seen = new Set();
    const jobs = [];
    let lastErr = null;
    let anyOk = false;

    for (const query of queries) {
      let pages;
      try {
        pages = await fetchQuery(query, { localeCode, location, pageSize, maxPages, sort, userIp, authHeader }, ctx);
        anyOk = true;
      } catch (err) {
        lastErr = err; // tolerate a single query failing — partial results win
        continue;
      }
      for (const j of pages) {
        if (j.url && !seen.has(j.url)) { seen.add(j.url); jobs.push(j); }
      }
    }

    // Only surface an error if EVERY query failed.
    if (!anyOk && lastErr) throw lastErr;
    return jobs;
  },
};

/**
 * Fetch one query across up to maxPages pages.
 *
 * @param {string} query
 * @param {{ localeCode: string, location: string, pageSize: number, maxPages: number, sort: string, userIp: string, authHeader: string }} opts
 * @param {object} ctx
 * @returns {Promise<Array<{title: string, url: string, company: string, location: string, description: string}>>}
 */
async function fetchQuery(query, { localeCode, location, pageSize, maxPages, sort, userIp, authHeader }, ctx) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({
      locale_code: localeCode,
      location,
      keywords: query,
      page_size: String(pageSize),
      page: String(page),
      sort,
      user_ip: userIp,
      user_agent: DEFAULT_USER_AGENT,
    });
    const url = `${CAREERJET_ENDPOINT}?${params.toString()}`;
    ctx.recordCall?.('careerjet');
    let json;
    try {
      json = await ctx.fetchJson(url, {
        headers: {
          Authorization: authHeader,
          // Careerjet requires a Referer header or it returns 403
          // ("Undeclared referrer"). Any registered origin works; use the
          // canonical partner-API page as the declared referrer.
          Referer: 'https://www.careerjet.com',
        },
        redirect: 'error',
      });
    } catch (err) {
      if (page === 1) throw err;
      break; // transient failure on page > 1: return what we have
    }
    const parsed = parseCareerjetResponse(json);
    out.push(...parsed);
    // Careerjet returns a `pages` field; stop early if we're on the last page
    // or if the response returned fewer jobs than requested (last page).
    if (parsed.length < pageSize) break;
    if (typeof json?.pages === 'number' && page >= json.pages) break;
  }
  return out;
}

/**
 * Parse a Careerjet v4 /query response. Exported for unit tests (no network).
 *
 * Success response shape:
 *   { type: 'JOBS', hits, message, pages, response_time,
 *     jobs: [ { title, company, date, description, locations, salary,
 *               salary_currency_code, salary_min, salary_max, salary_type,
 *               site, url } ] }
 *
 * If type !== 'JOBS' (e.g. 'LOCATIONS' for ambiguous location), there are
 * no jobs — return [] without throwing.
 *
 * Note: the location field in the API response is the PLURAL `locations`
 * (a string), not `location`.
 *
 * @param {any} json
 * @returns {Array<{title: string, url: string, company: string, location: string, description: string}>}
 */
export function parseCareerjetResponse(json) {
  if (!json || json.type !== 'JOBS') {
    if (json && json.type && json.type !== 'JOBS') {
      console.log(`careerjet: response type="${json.type}" (no jobs) — skipping`);
    }
    return [];
  }
  const items = json.jobs;
  if (!Array.isArray(items)) return [];
  return items
    .filter((j) => j && typeof j.url === 'string' && j.url)
    .map((j) => ({
      title: j.title || '',
      url: j.url,
      company: j.company || '',
      location: j.locations || '',   // NOTE: plural field name in Careerjet API
      description: j.description || '',
    }));
}
