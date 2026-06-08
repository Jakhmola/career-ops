// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Playwright scraper — config-driven browser-based scraper for job boards that
// have no public API. Boards: IamExpat (NL expat), werk.nl (UWV government).
//
// Architecture: one headless Chromium instance per fetch() call, reused across
// all boards sequentially (concurrency 1 to avoid triggering rate limits from
// the same home IP). Sequential board processing: each HANDLER gets one page.
//
// Data extraction strategies per board:
//   IamExpat — Next.js App Router (RSC streaming). Job data in window.__next_f
//     as "initialJobAds" JSON array; description $refs resolved from T-chunks;
//     URLs from DOM links (matched by position).
//   werk.nl  — Angular SPA with internal REST JSON API. Navigates to the
//     vacatures homepage, dismisses the UWV cookie-consent modal via JS, fills
//     in the keyword search input, then intercepts the POST response from
//     /kia/publiek/zoekenvacatures/api/search. Pagination via currentPage param.
//     XSRF token read from the non-HttpOnly XSRF-TOKEN cookie and forwarded as
//     X-XSRF-TOKEN header on subsequent page.evaluate() fetch calls.
//
// Dormant pattern: if Playwright/chromium is unavailable (ENOENT / import
// failure), log a one-line skip and return [] — never throw for mere absence,
// matching jobspy's pattern.
//
// NO detect() — scrapers must never be auto-matched to a tracked_companies entry.

// ── Handler registry ────────────────────────────────────────────────────────

/**
 * Add new board handlers here. Each entry:
 *   key   = board name (must match portals.yml scrapers.playwright.boards[].name)
 *   value = async (page, boardConfig) => Job[]
 *
 * @type {Record<string, (page: import('playwright').Page, boardConfig: BoardConfig) => Promise<NormalizedJob[]>>}
 */
const HANDLERS = {
  iamexpat:   scrapeIamExpat,
  werknl:     scrapeWerkNl,
  // werkzoeken: BLOCKED — Cloudflare hard-blocks headless Chromium at the IP/
  //   datacenter level (HTTP 403 before any JS challenge fires). Investigation
  //   on 2026-06-08 confirmed the block affects every URL path including /vacatures/
  //   and all keyword sub-paths. Cannot be bypassed without a residential proxy or
  //   real browser solving Turnstile. The board is excluded until that changes.
};

// ── Provider ─────────────────────────────────────────────────────────────────

/** @type {Provider} */
export default {
  id: 'playwright',
  // NO detect() — see header.

  async fetch(descriptor, _ctx) {
    const boards = Array.isArray(descriptor?.config?.boards) ? descriptor.config.boards : [];
    if (boards.length === 0) {
      console.log('playwright-scraper: skipped — no boards configured in portals.yml scrapers.playwright.boards');
      return [];
    }

    // Wrap chromium import+launch in try/catch: if Playwright or its browser
    // binaries are missing we stay dormant instead of crashing scan.mjs.
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      console.log('playwright-scraper: skipped — playwright package not available');
      return [];
    }

    let browser;
    const allJobs = [];

    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();

      for (const board of boards) {
        const name = typeof board?.name === 'string' ? board.name.trim().toLowerCase() : '';
        if (!name) continue;
        if (board.enabled === false) {
          console.log(`playwright-scraper: board "${name}" disabled — skipping`);
          continue;
        }
        const handler = HANDLERS[name];
        if (!handler) {
          console.warn(`playwright-scraper: unknown board "${name}" — skipping (add a handler to HANDLERS)`);
          continue;
        }
        try {
          const jobs = await handler(page, board);
          console.log(`playwright-scraper [${name}]: fetched ${jobs.length} jobs`);
          allJobs.push(...jobs.map((j) => ({ ...j, site: name })));
        } catch (err) {
          console.error(`playwright-scraper [${name}]: error — ${err.message}`);
        }
      }
    } finally {
      await browser?.close();
    }

    return allJobs;
  },
};

// ── IamExpat handler ──────────────────────────────────────────────────────────

/**
 * Scrapes the IamExpat NL job board.
 *
 * IamExpat uses Next.js App Router (RSC streaming). There is no public JSON
 * API. Job data is embedded in window.__next_f RSC chunks:
 *   - "initialJobAds" JSON array: title, company, location, description refs ($aX)
 *   - Text chunks (aX:Thexlen,content): resolve the $aX description references
 *   - DOM links (a[href*="/career/jobs-netherlands/"]): canonical job URLs
 *     (matched by position to the RSC array — rendered in the same order)
 *
 * Pagination: ?page=N URL param, 20 jobs per page. Stops when fewer than 20
 * jobs are returned (last page) or max_results is reached.
 *
 * @param {import('playwright').Page} page
 * @param {BoardConfig} boardConfig
 * @returns {Promise<NormalizedJob[]>}
 */
async function scrapeIamExpat(page, boardConfig) {
  const baseUrl = typeof boardConfig.url === 'string'
    ? boardConfig.url.replace(/\/$/, '')
    : 'https://www.iamexpat.nl/career/jobs-netherlands';
  const maxResults = Number(boardConfig.max_results) > 0 ? Math.trunc(Number(boardConfig.max_results)) : 50;

  const jobs = [];
  let pageNum = 1;

  while (jobs.length < maxResults) {
    const url = pageNum === 1 ? baseUrl : `${baseUrl}?page=${pageNum}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Brief wait for RSC chunks to finish streaming into __next_f
    await page.waitForTimeout(2000);

    const { rscRaw, domLinks } = await page.evaluate(() => {
      const rscRaw = (window.__next_f || [])
        .map((e) => (typeof e[1] === 'string' ? e[1] : ''))
        .join('');
      const domLinks = Array.from(
        document.querySelectorAll('a[href*="/career/jobs-netherlands/"]'),
      ).map((el) => el.href);
      return { rscRaw, domLinks };
    });

    const pageJobs = extractIamExpatJobs(rscRaw, domLinks);
    if (pageJobs.length === 0) break; // no more results

    jobs.push(...pageJobs);
    if (pageJobs.length < 20) break; // last page (partial)
    pageNum++;
  }

  return jobs.slice(0, maxResults);
}

// ── Pure extraction (exported for unit tests — no network/browser inside) ───

/**
 * Extract normalized jobs from IamExpat's RSC payload + rendered DOM links.
 *
 * RSC structure:
 *   - The concatenated __next_f[i][1] strings contain an "initialJobAds" JSON
 *     array with job objects whose description fields are RSC refs ($aX, $bX…).
 *   - Text chunks inline in the same string: `<hexId>:T<hexLen>,<content>`
 *     These hold the actual description text for each ref.
 *   - Job URLs are NOT in the RSC array; they come from rendered DOM <a> tags,
 *     in the same order as the RSC array.
 *
 * @param {string} rscRaw - concatenated window.__next_f strings
 * @param {string[]} domLinks - job page URLs extracted from DOM (same order as RSC array)
 * @returns {NormalizedJob[]}
 */
export function extractIamExpatJobs(rscRaw, domLinks) {
  if (typeof rscRaw !== 'string' || !rscRaw) return [];

  // 1. Find the initialJobAds array in the RSC payload.
  const markerIdx = rscRaw.indexOf('"initialJobAds":[');
  if (markerIdx < 0) return [];
  const bracketStart = rscRaw.indexOf('[', markerIdx);
  if (bracketStart < 0) return [];

  // Balance-bracket scan to extract the full array string.
  let depth = 0;
  let bracketEnd = bracketStart;
  for (let i = bracketStart; i < rscRaw.length && i < bracketStart + 2_000_000; i++) {
    const c = rscRaw[i];
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) { bracketEnd = i; break; }
    }
  }
  if (bracketEnd === bracketStart) return []; // bracket not closed

  // 2. Build a ref→text map by scanning RSC T-chunks (hexId:Thexlen,content).
  //    Only collect chunk IDs that appear as $<hexId> refs in the jobs array,
  //    so we don't waste time scanning huge unrelated chunks.
  const jobsArrayStr = rscRaw.slice(bracketStart, bracketEnd + 1);
  const refIds = new Set();
  for (const [, id] of jobsArrayStr.matchAll(/"\$([0-9a-f]+)"/g)) {
    refIds.add(id);
  }
  /** @type {Map<string, string>} */
  const chunkMap = new Map();
  if (refIds.size > 0) {
    // T-chunk format: <hexId>:T<hexLen>,<content of exactly hexLen bytes>
    const tChunkRe = /([0-9a-f]+):T([0-9a-f]+),/g;
    let m;
    while ((m = tChunkRe.exec(rscRaw)) !== null) {
      const id = m[1];
      if (!refIds.has(id)) continue; // skip unrelated chunks
      const byteLen = parseInt(m[2], 16);
      const contentStart = m.index + m[0].length;
      const content = rscRaw.slice(contentStart, contentStart + byteLen);
      chunkMap.set(id, stripHtml(content));
    }
  }

  // 3. Parse the array — RSC refs like "$a0" won't parse as JSON, so replace
  //    them with a sentinel and resolve after parsing.
  const SENTINEL_PREFIX = '__RSC_REF__';
  const cleanedStr = jobsArrayStr.replace(/"\$([0-9a-f]+)"/g, `"${SENTINEL_PREFIX}$1"`);
  let rawJobs;
  try {
    rawJobs = JSON.parse(cleanedStr);
  } catch {
    return [];
  }
  if (!Array.isArray(rawJobs)) return [];

  // 4. Normalize each job record into the scanner's required shape.
  const domLinksArr = Array.isArray(domLinks) ? domLinks : [];
  const out = [];

  for (let i = 0; i < rawJobs.length; i++) {
    const raw = rawJobs[i];
    if (!raw || typeof raw !== 'object') continue;

    const title = String(raw.JobTitle || '').trim();
    // URL comes from the DOM link at the same index (RSC and DOM are in sync).
    const url = typeof domLinksArr[i] === 'string' ? domLinksArr[i].trim() : '';
    if (!title || !url) continue;

    const company = String(raw.JobProvider?.CompanyName || '').trim();
    const location = String(raw.Location?.Title || '').trim();

    // Resolve description: AboutThisRole is either a plain string or a $ref sentinel.
    const aboutRaw = String(raw.AboutThisRole || '');
    const description = resolveRef(aboutRaw, chunkMap, SENTINEL_PREFIX);

    out.push({ title, url, company, location, description });
  }

  return out;
}

// ── werk.nl handler ───────────────────────────────────────────────────────────

/**
 * Scrapes the werk.nl vacancy board (UWV — Dutch public employment service).
 *
 * werk.nl is an Angular SPA. Vacancies are served through an internal REST API:
 *   POST /werkzoekenden/mijn-werkmap/kia/publiek/zoekenvacatures/api/search
 *   { facets:[], keywords:"<query>", location:"", currentPage:N, sort:{by:1,direction:1},
 *     keywordsChanged:true/false, includeFirstExpansion:false, includeSecondExpansion:false }
 *
 * Authentication: the API requires an anti-forgery token. The site sets a
 * non-HttpOnly XSRF-TOKEN cookie during page load; we read it from document.cookie
 * in the page context and forward it as the X-XSRF-TOKEN request header.
 *
 * Strategy:
 *   1. Navigate to /nl/vacatures/ (homepage, triggers Angular bootstrap + cookies).
 *   2. Dismiss the UWV cookie-consent modal by removing the overlay from the DOM.
 *   3. For each configured query, call the search API via page.evaluate fetch
 *      (shares the session + cookies). Paginate up to max_pages.
 *   4. Map each search item → NormalizedJob (no description in list results —
 *      description left empty; the detail endpoint would require N extra calls).
 *
 * Public vacancy URL: https://www.werk.nl/nl/vacatures/{referenceNumber}
 *
 * @param {import('playwright').Page} page
 * @param {BoardConfig} boardConfig
 * @returns {Promise<NormalizedJob[]>}
 */
async function scrapeWerkNl(page, boardConfig) {
  const BASE = 'https://www.werk.nl';
  const SEARCH_API = '/werkzoekenden/mijn-werkmap/kia/publiek/zoekenvacatures/api/search';

  const queries = Array.isArray(boardConfig.queries) && boardConfig.queries.length > 0
    ? boardConfig.queries
    : ['machine learning', 'AI engineer', 'data scientist'];
  const maxResults = Number(boardConfig.max_results) > 0 ? Math.trunc(Number(boardConfig.max_results)) : 60;
  const maxPages = Number(boardConfig.max_pages) > 0 ? Math.trunc(Number(boardConfig.max_pages)) : 3;

  // ── Step 1: bootstrap the page (sets XSRF-TOKEN cookie) ────────────────────
  await page.goto(`${BASE}/nl/vacatures/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // ── Step 2: dismiss cookie-consent modal (blocks pointer events) ────────────
  await page.evaluate(() => {
    const el = document.querySelector('#js-pw-consent-wrapper');
    if (el) el.remove();
  });
  await page.waitForTimeout(500);

  // ── Step 3: trigger first search via the form (bootstraps Angular routing) ──
  //    We fill the #keywords input and press Enter so Angular initialises the
  //    search route. Subsequent queries are fired directly via fetch().
  const firstQuery = queries[0];
  try {
    await page.fill('#keywords', firstQuery, { force: true });
    await page.press('#keywords', 'Enter', { force: true });
    await page.waitForTimeout(4000);
  } catch {
    // If the form interaction fails, proceed anyway — fetch() calls below will
    // still work as long as the XSRF-TOKEN cookie was set during page load.
  }

  // ── Step 4: read XSRF token from the page cookie (non-HttpOnly) ─────────────
  const xsrfToken = await page.evaluate(() => {
    return document.cookie
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('XSRF-TOKEN='))
      ?.split('=')[1] ?? '';
  });

  if (!xsrfToken) {
    console.warn('werk.nl: XSRF-TOKEN cookie not found — search may return 400');
  }

  // ── Step 5: iterate queries, paginate, collect items ────────────────────────
  const seen = new Set(); // dedup by referenceNumber within this scrape
  const jobs = [];

  for (const query of queries) {
    if (jobs.length >= maxResults) break;

    let pageNum = 1;
    let keywordsChanged = true; // true only on first page of each query

    while (jobs.length < maxResults && pageNum <= maxPages) {
      const body = JSON.stringify({
        facets: [],
        keywords: query,
        location: '',
        currentPage: pageNum,
        sort: { by: 1, direction: 1 },
        keywordsChanged,
        includeFirstExpansion: false,
        includeSecondExpansion: false,
      });

      // Execute fetch inside the page context so session cookies are included.
      const result = await page.evaluate(
        async ([apiPath, reqBody, token]) => {
          try {
            const resp = await fetch(apiPath, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-XSRF-TOKEN': decodeURIComponent(token),
              },
              credentials: 'include',
              body: reqBody,
            });
            if (!resp.ok) return { error: `HTTP ${resp.status}` };
            const data = await resp.json();
            return { items: data.items ?? [], totalResults: data.totalResults ?? 0 };
          } catch (e) {
            return { error: e.message };
          }
        },
        [SEARCH_API, body, xsrfToken],
      );

      if (result.error) {
        console.warn(`werk.nl [${query}] p${pageNum}: ${result.error}`);
        break;
      }

      const items = result.items;
      if (!Array.isArray(items) || items.length === 0) break;

      const pageJobs = parseWerkNlResponse({ items, totalResults: result.totalResults });
      let added = 0;
      for (const j of pageJobs) {
        const key = String(j.url); // referenceNumber is in the URL
        if (!seen.has(key)) {
          seen.add(key);
          jobs.push(j);
          added++;
        }
      }

      if (added === 0 || items.length < 20) break; // last page or all dupes
      pageNum++;
      keywordsChanged = false;
    }
  }

  return jobs.slice(0, maxResults);
}

// ── Pure extraction (exported for unit tests — no network/browser inside) ───

/**
 * Parse a werk.nl search API response into NormalizedJob records.
 *
 * werk.nl search response shape (relevant fields per item):
 *   referenceNumber: number  — used to build the public URL
 *   vacatureTitle:   string  — job title
 *   organisation:    string  — employer name
 *   workLocationCity:string  — city in ALL-CAPS (we title-case it)
 *
 * No description is available in the list results; the detail endpoint
 * (/api/vacature/{ref}) has it but requires one extra HTTP call per job.
 * description is left empty — scan.mjs skips JD persistence when empty.
 *
 * Public URL: https://www.werk.nl/nl/vacatures/{referenceNumber}
 *
 * @param {unknown} json - parsed JSON from the search API (or any unknown value)
 * @returns {NormalizedJob[]}
 */
export function parseWerkNlResponse(json) {
  if (!json || typeof json !== 'object') return [];
  const items = /** @type {any[]} */ (Array.isArray(json) ? json : (json.items ?? []));
  if (!Array.isArray(items)) return [];

  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    const ref = item.referenceNumber;
    if (!ref || typeof ref !== 'number') continue;

    const title = String(item.vacatureTitle || '').trim();
    if (!title) continue;

    const url = `https://www.werk.nl/nl/vacatures/${ref}`;
    const company = String(item.organisation || '').trim();
    // Work location is stored in ALL-CAPS ("AMSTERDAM") — title-case it.
    const rawCity = String(item.workLocationCity || '').trim();
    const location = rawCity
      ? rawCity.charAt(0).toUpperCase() + rawCity.slice(1).toLowerCase()
      : '';

    out.push({ title, url, company, location, description: '' });
  }
  return out;
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * If the value is an RSC ref sentinel, look it up in chunkMap; otherwise
 * strip HTML from the raw string and return it.
 *
 * @param {string} value
 * @param {Map<string, string>} chunkMap
 * @param {string} sentinelPrefix
 * @returns {string}
 */
function resolveRef(value, chunkMap, sentinelPrefix) {
  if (value.startsWith(sentinelPrefix)) {
    const id = value.slice(sentinelPrefix.length);
    return chunkMap.get(id) || '';
  }
  return stripHtml(value);
}

/**
 * Minimal HTML stripper: removes tags and decodes a handful of common entities.
 * Used only for description text — no DOM parser needed.
 *
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&euro;/g, '€')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── JSDoc types (no runtime cost) ────────────────────────────────────────────

/**
 * @typedef {{ title: string, url: string, company: string, location: string, description: string }} NormalizedJob
 * @typedef {{ name: string, url?: string, queries?: string[], max_results?: number, max_pages?: number, enabled?: boolean }} BoardConfig
 */
