// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// LinkedIn guest-API provider — a native, source-side-filtered replacement for
// the jobspy LinkedIn path. Pure HTTP (no browser, no Python): it queries the
// public `jobs-guest` endpoint that LinkedIn serves WITHOUT a login wall, the
// same one the website calls to lazy-load more result cards.
//
// Why this exists (see the scanner-overhaul plan): jobspy is a black box that
// cannot reach LinkedIn's NATIVE filters. We fetch ~5k rows/scan and discard
// ~90% on the title filter. This provider pushes the filtering UPSTREAM —
// experience level (f_E), job function (f_F), workplace (f_WT), date tier
// (f_TPR) and freshest-first sort (sortBy=DD) are applied server-side, so we
// pull a few hundred pre-filtered rows instead of thousands, and we also catch
// well-fit roles whose off-pattern titles ("Member of Technical Staff") the
// local title filter would otherwise kill.
//
// Decision gate (per plan): this provider ships DORMANT (enabled:false in
// portals.yml). Cut LinkedIn over to it only once scan-ab-linkedin.mjs proves
// it dominates jobspy on relevant-kept + freshness at an acceptable 429 rate.
// The A/B harness imports fetch() directly regardless of the enabled flag.
//
// Scrapers export NO detect() — like jobspy/aggregators, they must never be
// auto-matched to a tracked_companies entry. scan.mjs reaches this provider
// only via the `scrapers.linkedin-guest` block in portals.yml (config key ==
// provider id).
//
// Rate-limit hygiene: single concurrency (the fetch loop is sequential),
// browser-like headers, jittered delays between requests, exponential backoff
// on HTTP 429. Source-side filtering means FEWER pages per query, which is
// itself the strongest block-avoidance lever.

import { htmlToText } from './_jd.mjs';

// ── Endpoints ────────────────────────────────────────────────────────────────

const SEARCH_API =
  'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const JOBPOSTING_API =
  'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';

// Browser-like headers — the default career-ops UA gets a faster block.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'X-Requested-With': 'XMLHttpRequest',
  Referer: 'https://www.linkedin.com/jobs',
};

// ── Defaults (overridable per portals.yml scrapers.linkedin-guest) ────────────

const DEFAULTS = {
  // Experience tiers: 2=entry, 3=associate, 4=mid-senior. Drops intern(1) and
  // director(5)/executive(6) at the source.
  f_E: '2,3,4',
  // Job functions: eng=Engineering, it=Information Technology. The two that
  // hold ~all AI/ML IC roles. (rsch/sci/anls available if a profile needs them.)
  f_F: 'eng,it',
  // f_TPR=r<seconds> recency tier. 168h = one week catch-up window.
  timeWindowHours: 168,
  // Per (query × geo) pagination cap. Source filtering keeps real volume low.
  resultsPerQuery: 75,
  // Pull the full JD for each surviving card (no login wall on jobPosting/<id>).
  fetchDescription: true,
  // Base delay between HTTP requests; actual wait is base..2*base (jittered).
  delayMs: 2500,
};

// LinkedIn's guest search returns ~10 cards per `start` offset. We advance
// `start` by the number of cards actually parsed (adapts to whatever page size
// LinkedIn uses) and stop when a page is empty or adds nothing new.
const MIN_PAGE_STEP = 10;

// ── Provider ──────────────────────────────────────────────────────────────────

/** @type {Provider} */
export default {
  id: 'linkedin-guest',
  // NO detect() — see header.

  async fetch(descriptor, _ctx) {
    const cfg = descriptor?.config || {};
    const queries = normalizeQueries(cfg.queries);
    if (queries.length === 0) {
      console.log(
        'linkedin-guest: skipped — no queries configured in portals.yml scrapers.linkedin-guest',
      );
      return [];
    }
    const geos = normalizeGeos(cfg.geos);

    const opts = {
      f_E: typeof cfg.f_E === 'string' && cfg.f_E.trim() ? cfg.f_E.trim() : DEFAULTS.f_E,
      f_F: typeof cfg.f_F === 'string' && cfg.f_F.trim() ? cfg.f_F.trim() : DEFAULTS.f_F,
      timeWindowHours: posInt(cfg.time_window_hours, DEFAULTS.timeWindowHours),
      resultsPerQuery: posInt(cfg.results_per_query, DEFAULTS.resultsPerQuery),
      fetchDescription: cfg.fetch_description !== false,
      delayMs: posInt(cfg.delay_ms, DEFAULTS.delayMs),
    };
    const tprSeconds = opts.timeWindowHours * 3600;

    const seen = new Set(); // dedup by numeric job id within this fetch
    const jobs = [];
    let firstRequest = true;

    for (const geo of geos) {
      for (const keywords of queries) {
        let start = 0;
        while (start < opts.resultsPerQuery) {
          const url = buildSearchUrl({
            keywords,
            location: geo.where,
            geoId: geo.geoId,
            distance: geo.distance,
            f_WT: geo.f_WT,
            f_E: opts.f_E,
            f_F: opts.f_F,
            f_TPR: `r${tprSeconds}`,
            start,
          });

          // Space out requests (skip the wait before the very first one).
          if (!firstRequest) await sleep(jitter(opts.delayMs));
          firstRequest = false;

          let html;
          try {
            html = await fetchWithRetry(url);
          } catch (err) {
            console.error(
              `⚠️  linkedin-guest [${keywords} @ ${geo.label}] start=${start}: ${err.message}`,
            );
            break; // move to the next query/geo rather than killing the scan
          }

          const cards = parseJobCards(html);
          if (cards.length === 0) break; // exhausted this query/geo

          let added = 0;
          for (const card of cards) {
            if (seen.has(card.id)) continue;
            seen.add(card.id);
            jobs.push(card);
            added++;
          }
          // All-dupe page = LinkedIn stopped paginating (it can echo the same
          // window back). Advancing further just burns requests on repeats.
          if (added === 0) break;

          start += Math.max(cards.length, MIN_PAGE_STEP);
        }
      }
    }

    // Every card gets an on-demand JD closure — when fetch_description is
    // false, scan.mjs's kept-row hook calls job.fetchJd() for rows that survive
    // filters/dedup (budgeted by max_jd_fetches), so "false" now means
    // "kept-rows only", not "never".
    attachJdFetchers(jobs, opts.delayMs);

    // fetch_description: true → inline bulk fetch for ALL cards at scrape time.
    // Volume stays small because f_F+f_E pre-filter server-side, so fetch-all is
    // within rate limits. Failures are non-fatal — the role still enters the
    // pipeline with its LinkedIn URL.
    if (opts.fetchDescription) {
      for (const job of jobs) {
        try {
          const desc = await job.fetchJd();
          if (desc) job.description = desc;
        } catch (err) {
          console.error(`⚠️  linkedin-guest JD [${job.id}]: ${err.message}`);
        }
      }
    }

    return jobs;
  },
};

// ── Pure helpers (exported for unit tests — no network inside) ────────────────

/**
 * Normalize the `queries` config into trimmed, non-empty keyword strings.
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeQueries(value) {
  return (Array.isArray(value) ? value : [])
    .filter((q) => typeof q === 'string' && q.trim())
    .map((q) => q.trim());
}

/**
 * Normalize the `geos` config into [{ where, geoId?, distance?, f_WT?, label }].
 * Tolerates a bare list of location strings, objects, or absence (→ a single
 * "Netherlands" pass). Each entry must yield SOME geo signal (where or geoId);
 * entries with neither are dropped.
 *
 * @param {unknown} value
 * @returns {Array<{where: string, geoId?: string, distance?: number, f_WT?: string, label: string}>}
 */
export function normalizeGeos(value) {
  const raw = Array.isArray(value) && value.length > 0 ? value : [{ where: 'Netherlands' }];
  const out = [];
  for (const item of raw) {
    let where = '';
    let geoId;
    let distance;
    let f_WT;
    if (typeof item === 'string') {
      where = item.trim();
    } else if (item && typeof item === 'object') {
      where = typeof item.where === 'string' ? item.where.trim() : '';
      geoId = item.geoId != null ? String(item.geoId).trim() : undefined;
      const d = Number(item.distance);
      distance = Number.isFinite(d) && d > 0 ? Math.trunc(d) : undefined;
      f_WT = item.f_WT != null ? String(item.f_WT).trim() : undefined;
    }
    if (!where && !geoId) continue;
    const wtLabel = f_WT ? ` wt:${f_WT}` : '';
    out.push({ where, geoId, distance, f_WT, label: `${where || geoId}${wtLabel}` });
  }
  return out.length > 0 ? out : [{ where: 'Netherlands', label: 'Netherlands' }];
}

/**
 * Build a guest-search URL with source-side filters. Only non-empty params are
 * appended. sortBy=DD makes the freshest postings fill the pagination cap.
 *
 * @param {{keywords: string, location?: string, geoId?: string, distance?: number,
 *          f_WT?: string, f_E?: string, f_F?: string, f_TPR?: string, start?: number}} p
 * @returns {string}
 */
export function buildSearchUrl(p) {
  const q = new URLSearchParams();
  q.set('keywords', p.keywords || '');
  if (p.geoId) q.set('geoId', p.geoId);
  else if (p.location) q.set('location', p.location);
  if (p.distance) q.set('distance', String(p.distance));
  if (p.f_WT) q.set('f_WT', p.f_WT);
  if (p.f_E) q.set('f_E', p.f_E);
  if (p.f_F) q.set('f_F', p.f_F);
  if (p.f_TPR) q.set('f_TPR', p.f_TPR);
  q.set('sortBy', 'DD'); // date-descending — freshest first
  q.set('start', String(Number.isFinite(p.start) ? p.start : 0));
  return `${SEARCH_API}?${q.toString()}`;
}

/**
 * Build the no-login JD endpoint URL for a numeric job id.
 * @param {string|number} id
 * @returns {string}
 */
export function buildJobPostingUrl(id) {
  return `${JOBPOSTING_API}/${encodeURIComponent(String(id))}`;
}

/**
 * Parse the guest-search HTML fragment into normalized job cards.
 *
 * Card anatomy (verified 2026-06-23):
 *   <div class="base-card ..." data-entity-urn="urn:li:jobPosting:<id>">
 *     <a class="base-card__full-link" href="https://nl.linkedin.com/jobs/view/<slug>-<id>?...">
 *     <h3 class="base-search-card__title">Title</h3>
 *     <h4 class="base-search-card__subtitle"><a ...>Company</a></h4>
 *     <span class="job-search-card__location">City Area</span>
 *     <time class="job-search-card__listdate[--new]" datetime="YYYY-MM-DD">
 *
 * The canonical URL is rebuilt from the numeric id as
 * https://www.linkedin.com/jobs/view/<id> so scan.mjs's canonicalizeUrl()
 * collapses it to the numeric identity and cross-source dedup is automatic.
 *
 * @param {string} html
 * @returns {Array<{id: string, title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseJobCards(html) {
  if (typeof html !== 'string' || !html) return [];

  // Split the fragment into per-card slices at each job-posting urn. Capturing
  // the index lets us bound each card's field search to its own slice.
  const urnRe = /data-entity-urn="urn:li:jobPosting:(\d+)"/g;
  const marks = [];
  let m;
  while ((m = urnRe.exec(html)) !== null) {
    marks.push({ id: m[1], index: m.index });
  }
  if (marks.length === 0) return [];

  const out = [];
  const seen = new Set();
  for (let i = 0; i < marks.length; i++) {
    const { id, index } = marks[i];
    if (seen.has(id)) continue;
    seen.add(id);
    const slice = html.slice(index, i + 1 < marks.length ? marks[i + 1].index : html.length);

    const title = cleanText(matchInner(slice, /class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/));
    if (!title) continue; // a card without a title is unusable

    const company = cleanText(matchInner(slice, /class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/));
    const location = cleanText(matchInner(slice, /class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/));

    let postedAt;
    const dt = slice.match(/datetime="(\d{4}-\d{2}-\d{2})"/);
    if (dt) {
      const t = Date.parse(`${dt[1]}T00:00:00Z`);
      if (Number.isFinite(t)) postedAt = t;
    }

    out.push({
      id,
      title,
      url: `https://www.linkedin.com/jobs/view/${id}`,
      company,
      location,
      ...(postedAt != null ? { postedAt } : {}),
    });
  }
  return out;
}

/**
 * Extract the readable JD text from a jobPosting/<id> HTML response. The body
 * lives in `.show-more-less-html__markup` (or, on older renders,
 * `.description__text`). Returns '' when no description node is found.
 *
 * @param {string} html
 * @returns {string}
 */
export function parseJobDescription(html) {
  if (typeof html !== 'string' || !html) return '';
  const markup =
    matchInner(html, /class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/) ||
    matchInner(html, /class="[^"]*description__text[^"]*"[^>]*>([\s\S]*?)<\/section>/);
  return markup ? htmlToText(markup) : '';
}

/**
 * Attach a per-job on-demand JD closure. Both LinkedIn providers (guest + auth)
 * use this so scan.mjs's kept-row hook (job.fetchJd()) enriches only the rows
 * that survive filters/dedup — via the PUBLIC jobPosting/<id> endpoint
 * (anonymous fetch: no login, zero burner exposure), jittered base..2*base
 * pacing per call.
 *
 * @param {Array<{id: string|number, fetchJd?: () => Promise<string>}>} jobs
 * @param {number} [delayMs]
 * @returns {typeof jobs}
 */
export function attachJdFetchers(jobs, delayMs = DEFAULTS.delayMs) {
  for (const job of jobs) {
    job.fetchJd = async () => {
      await sleep(jitter(delayMs));
      return parseJobDescription(await fetchWithRetry(buildJobPostingUrl(job.id)));
    };
  }
  return jobs;
}

// ── Private helpers ───────────────────────────────────────────────────────────

function posInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function matchInner(haystack, re) {
  const m = haystack.match(re);
  return m ? m[1] : '';
}

// Strip tags + decode the handful of entities LinkedIn emits, collapse space.
function cleanText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// base..2*base jitter so the cadence isn't a fixed-interval signature.
const jitter = (base) => Math.round(base + Math.random() * base);

/**
 * GET a URL as text with browser-like headers, a timeout, and exponential
 * backoff on HTTP 429 (LinkedIn's rate-limit signal). Throws on non-2xx that
 * isn't a retryable 429, or after exhausting retries.
 *
 * @param {string} url
 * @param {{retries?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<string>}
 */
export async function fetchWithRetry(url, { retries = 3, timeoutMs = 15000 } = {}) {
  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (attempt >= retries) throw err;
      attempt++;
      await sleep(jitter(1500 * attempt));
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429 || res.status === 503) {
      if (attempt >= retries) throw new Error(`HTTP ${res.status} (rate-limited)`);
      attempt++;
      // Honor Retry-After when present, else exponential backoff with jitter.
      const ra = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : jitter(2000 * 2 ** attempt);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }
}
