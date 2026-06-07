// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Arbeitnow aggregator — query-based source over the public job-board feed.
// No auth, no API key; returns recent EU/DE-heavy postings from many employers.
//
// Unlike per-company Providers, Aggregators export NO detect(): scan.mjs's
// per-company resolveProvider() loop must never auto-select them. scan.mjs
// reaches them only through the `aggregators:` block in portals.yml, calling
// fetch(descriptor, ctx) with a search descriptor instead of a company entry.
//
// The feed has no keyword query param — it's a recent-jobs list. Relevance is
// handled downstream by the scanner's title_filter + location_filter.

const ARBEITNOW_ENDPOINT = 'https://www.arbeitnow.com/api/job-board-api';
const DEFAULT_MAX_PAGES = 2;

/** @type {Provider} */
export default {
  id: 'arbeitnow',
  // NO detect() — see header.

  async fetch(descriptor, ctx) {
    const maxPages = Number(descriptor?.config?.max_pages) || DEFAULT_MAX_PAGES;
    const jobs = [];
    for (let page = 1; page <= maxPages; page++) {
      const url = `${ARBEITNOW_ENDPOINT}?page=${page}`;
      ctx.recordCall?.('arbeitnow');
      let json;
      try {
        json = await ctx.fetchJson(url, { redirect: 'error' });
      } catch (err) {
        // Page 1 failing is a real error; a later page failing just ends pagination.
        if (page === 1) throw err;
        break;
      }
      const parsed = parseArbeitnowResponse(json, descriptor);
      if (parsed.length === 0) break; // no more results
      jobs.push(...parsed);
    }
    return jobs;
  },
};

/**
 * Parse an Arbeitnow job-board-api response. Exported for unit tests (no network).
 *
 * Response shape:
 *   { data: [ { title, company_name, url, location, remote, tags, ... } ], links, meta }
 *
 * @param {any} json
 * @param {object} [descriptor]
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseArbeitnowResponse(json, descriptor) {
  const items = json?.data;
  if (!Array.isArray(items)) return [];
  return items
    .filter((j) => j && typeof j.url === 'string' && j.url)
    .map((j) => ({
      title: j.title || '',
      url: j.url,
      company: j.company_name || '',
      location: typeof j.location === 'string' ? j.location : '',
    }));
}
