// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// JSearch aggregator — query-based source over the OpenWebNinja JSearch
// endpoint (api.openwebninja.com/jsearch), a Google-for-Jobs index. The ONLY
// legitimate way to surface LinkedIn / Indeed / Glassdoor postings (see
// docs/adr/0001). Auth is the `x-api-key` header; the key is read from
// RAPIDAPI_KEY in .env (named for JSearch's original RapidAPI home — it now
// holds the OpenWebNinja x-api-key). Missing key → return [] (dormant).
//
// QUOTA: the free tier is limited (~200 requests/month). We issue exactly one
// request per scan (num_pages=1) and scan.mjs enforces a monthly_cap via
// data/api-usage.tsv BEFORE calling. Ships disabled by default in portals.yml.
//
// Aggregators export NO detect() — see arbeitnow.mjs header.

const JSEARCH_ENDPOINT = 'https://api.openwebninja.com/jsearch/search';
const DEFAULT_QUERY_TERMS = 4;

// Build the free-text query: a compact slice of the positive keywords joined
// with " OR ", optionally scoped " in <where>". An explicit config.query wins.
function buildQuery(descriptor) {
  const cfg = descriptor?.config || {};
  if (typeof cfg.query === 'string' && cfg.query.trim()) return cfg.query.trim();
  const terms = (descriptor?.positive || [])
    .filter((k) => typeof k === 'string' && k.trim())
    .slice(0, DEFAULT_QUERY_TERMS);
  let q = terms.join(' OR ');
  const where =
    (typeof cfg.where === 'string' && cfg.where.trim() && cfg.where.trim()) ||
    descriptor?.location?.where ||
    '';
  if (where) q = q ? `${q} in ${where}` : String(where);
  return q.trim();
}

/** @type {Provider} */
export default {
  id: 'jsearch',
  // NO detect().

  async fetch(descriptor, ctx) {
    const key = process.env.RAPIDAPI_KEY;
    if (!key) {
      console.log('jsearch: skipped — RAPIDAPI_KEY not set in .env');
      return [];
    }
    const cfg = descriptor?.config || {};
    const query = buildQuery(descriptor);
    if (!query) return [];

    // num_pages widens recall (~10 results/page) in a SINGLE request. Default 1
    // to protect the free tier. Each page counts against the OpenWebNinja quota,
    // so meter per-page (conservative) — see recordCall below.
    const numPages = Math.min(Math.max(1, Math.trunc(Number(cfg.num_pages) || 1)), 10);

    const params = new URLSearchParams({
      query,
      page: '1',
      num_pages: String(numPages),
      date_posted: 'month',
    });
    const country =
      typeof cfg.country === 'string' ? cfg.country.toLowerCase().replace(/[^a-z]/g, '') : '';
    if (country) params.set('country', country);

    const url = `${JSEARCH_ENDPOINT}?${params.toString()}`;
    // OpenWebNinja bills per page returned, not per HTTP request — record numPages
    // so scan.mjs's monthly_cap guard never under-counts and overruns the quota.
    ctx.recordCall?.('jsearch', numPages);
    const json = await ctx.fetchJson(url, {
      headers: { 'x-api-key': key },
      redirect: 'error',
      // JSearch aggregates LinkedIn/Indeed/Glassdoor and is slow; num_pages>1
      // compounds it. Give it more than the 10s default so it doesn't abort.
      timeoutMs: 12_000 + numPages * 8_000,
    });
    return parseJSearchResponse(json, descriptor);
  },
};

/**
 * Parse a JSearch /search response. Exported for unit tests (no network).
 *
 * Response shape:
 *   { status, data: [ { job_title, employer_name, job_apply_link,
 *       job_city, job_country, job_posted_at_datetime_utc, job_id } ] }
 *
 * @param {any} json
 * @param {object} [descriptor]
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseJSearchResponse(json, descriptor) {
  const items = json?.data;
  if (!Array.isArray(items)) return [];
  return items
    .filter((j) => j && typeof j.job_apply_link === 'string' && j.job_apply_link)
    .map((j) => ({
      title: j.job_title || '',
      url: j.job_apply_link,
      company: j.employer_name || '',
      location: [j.job_city, j.job_country].filter(Boolean).join(', '),
    }));
}
