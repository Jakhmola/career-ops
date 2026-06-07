// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Adzuna aggregator — query-based source over the public Adzuna search API.
// Broad NL/EU coverage with salary data. Free: needs ADZUNA_APP_ID +
// ADZUNA_APP_KEY (query params, NOT headers), read from process.env (dotenv is
// loaded by scan.mjs). Missing key → return [] (dormant, not an error).
//
// Matching modes (config.match):
//   'title' (DEFAULT) — issue one `title_only=<keyword>` query per positive
//     keyword and union the results. Adzuna's title_only restricts the match to
//     the job TITLE, which mirrors scan.mjs's title filter. This is far more
//     precise than a single what_or query: `what_or` matches keywords anywhere
//     in the body, so it returns hundreds of off-target jobs (e.g. a keyword
//     buried in a JD), almost all of which scan.mjs then discards. title_only
//     returns the handful of genuinely title-matched roles instead.
//   'any' — legacy single `what_or` query over all keywords joined by space.
//     Broad recall, body-matched, noisy. Opt in with `match: any` in portals.yml.
//
// Aggregators export NO detect() — see arbeitnow.mjs header.

const ADZUNA_API_BASE = 'https://api.adzuna.com/v1/api/jobs';
const DEFAULT_MAX_PAGES = 1;
const DEFAULT_MAX_DAYS_OLD = 30;
const RESULTS_PER_PAGE = 50;

/** @type {Provider} */
export default {
  id: 'adzuna',
  // NO detect().

  async fetch(descriptor, ctx) {
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;
    if (!appId || !appKey) {
      console.log('adzuna: skipped — ADZUNA_APP_ID/ADZUNA_APP_KEY not set in .env');
      return [];
    }

    const cfg = descriptor?.config || {};
    const country = String(cfg.country || 'nl').toLowerCase().replace(/[^a-z]/g, '') || 'nl';
    const maxPages = Number(cfg.max_pages) || DEFAULT_MAX_PAGES;
    const maxDaysOld = Number(cfg.max_days_old) || DEFAULT_MAX_DAYS_OLD;
    const where = typeof cfg.where === 'string' ? cfg.where : '';
    const mode = cfg.match === 'any' ? 'any' : 'title';

    // Page through one Adzuna query (mutate sets the keyword param), stopping at
    // the first empty/short page. recordCall fires once per HTTP request so
    // scan.mjs can meter usage against the monthly ledger / cap.
    const fetchQuery = async (mutate) => {
      const out = [];
      for (let page = 1; page <= maxPages; page++) {
        const params = new URLSearchParams({
          app_id: appId,
          app_key: appKey,
          results_per_page: String(RESULTS_PER_PAGE),
          'content-type': 'application/json',
          sort_by: 'date',
          max_days_old: String(maxDaysOld),
        });
        if (where) params.set('where', where);
        mutate(params);
        const url = `${ADZUNA_API_BASE}/${country}/search/${page}?${params.toString()}`;
        ctx.recordCall?.('adzuna');
        let json;
        try {
          json = await ctx.fetchJson(url, { redirect: 'error' });
        } catch (err) {
          if (page === 1) throw err;
          break;
        }
        const parsed = parseAdzunaResponse(json, descriptor);
        out.push(...parsed);
        if (parsed.length < RESULTS_PER_PAGE) break; // last page reached
      }
      return out;
    };

    // Legacy broad mode: a single what_or query over all keywords (body-matched).
    if (mode === 'any') {
      const whatOr = (descriptor?.positive || [])
        .filter((k) => typeof k === 'string' && k.trim())
        .join(' ')
        .trim();
      return fetchQuery((p) => { if (whatOr) p.set('what_or', whatOr); });
    }

    // Default title mode: one title-scoped query per unique keyword, unioned by URL.
    const keywords = [...new Set(
      (descriptor?.positive || [])
        .filter((k) => typeof k === 'string' && k.trim())
        .map((k) => k.trim()),
    )];
    const seen = new Set();
    const jobs = [];
    let lastErr = null;
    let anyOk = false;
    for (const kw of keywords) {
      let pages;
      try {
        pages = await fetchQuery((p) => p.set('title_only', kw));
        anyOk = true;
      } catch (err) {
        lastErr = err; // tolerate a single keyword failing (transient/4xx)
        continue;
      }
      for (const j of pages) {
        if (j.url && !seen.has(j.url)) { seen.add(j.url); jobs.push(j); }
      }
    }
    // Only surface an error if EVERY query failed — otherwise partial results win.
    if (!anyOk && lastErr) throw lastErr;
    return jobs;
  },
};

/**
 * Parse an Adzuna /search response. Exported for unit tests (no network).
 *
 * Response shape:
 *   { count, results: [ { title, redirect_url,
 *       company: { display_name }, location: { display_name, area[] },
 *       created, salary_min, salary_max } ] }
 *
 * @param {any} json
 * @param {object} [descriptor]
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseAdzunaResponse(json, descriptor) {
  const items = json?.results;
  if (!Array.isArray(items)) return [];
  return items
    .filter((j) => j && typeof j.redirect_url === 'string' && j.redirect_url)
    .map((j) => ({
      title: j.title || '',
      url: j.redirect_url,
      company: j.company?.display_name || '',
      location: j.location?.display_name || '',
    }));
}
