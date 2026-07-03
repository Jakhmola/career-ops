// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Authenticated LinkedIn provider — a logged-in, browser-driven job scraper that
// reaches what the public guest API can't: salary bands, applicant counts, the
// Easy-Apply flag, and a deeper result tail. It is the THIRD LinkedIn source,
// ADDITIVE to the keep-both pair (jobspy-linkedin + linkedin-guest, decided
// 2026-06-24); it ships DORMANT (enabled:false in portals.yml) until the eval
// harness (scan-ab-linkedin-auth.mjs) shows it earns a slot.
//
// ── Why a browser + login (vs the guest provider) ────────────────────────────
// linkedin-guest hits a PUBLIC door (jobs-guest/...) with plain fetch and gets
// title/company/location/postedAt — no auth, low ban risk. The authed extras
// (salary, applicants, full Easy-Apply state) live ONLY behind the login wall,
// which is a React/Voyager SPA: no public JSON door, so a logged-in browser is
// the only way in. That is exactly the werk.nl situation (see playwright-scraper)
// — except here the cost is an ACCOUNT, not just an IP. Hence every guardrail
// below is about protecting that account.
//
// ── Account / ban-risk guardrails (BURNER ACCOUNT ONLY) ──────────────────────
//   • Use a BURNER LinkedIn account, never your real one. Automated logged-in
//     scraping violates LinkedIn's ToS and can get the account restricted.
//   • Cookie-first: we load a saved session (storageState.json) captured ONCE by
//     the headed helper `node linkedin-login.mjs`. We NEVER type the password in
//     this provider and NEVER log the cookie.
//   • Human pacing: one search every delay_ms (default 30s, jittered to ~60s) and
//     a hard daily_cap on total searches per run. Slow on purpose.
//   • Checkpoint-abort: the instant LinkedIn shows a login/checkpoint/authwall we
//     STOP (return what we have) and tell the user to re-run linkedin-login.mjs.
//     We never retry into a challenge — hammering a challenge is what gets
//     accounts killed.
//   • Light stealth only (mask navigator.webdriver, real UA/viewport/locale).
//     No fingerprint-spoofing arms race — if LinkedIn blocks us, we fall back to
//     a headed local run, not escalation.
//
// NO detect() — like every scraper, this must never be auto-matched to a
// tracked_companies entry. scan.mjs reaches it only via the
// `scrapers.linkedin-auth` block in portals.yml (config key == provider id).

import { readFileSync, existsSync } from 'fs';
// JD enrichment reuses linkedin-guest's PUBLIC jobPosting endpoint (stable, no
// login, anonymous fetch) instead of scraping the authed detail page — see the
// "Why JD comes from the guest endpoint" note on the enrichment block below.
import { buildJobPostingUrl, parseJobDescription } from './linkedin-guest.mjs';

// ── Endpoints ────────────────────────────────────────────────────────────────

const SEARCH_PAGE = 'https://www.linkedin.com/jobs/search/';
const VIEW_BASE = 'https://www.linkedin.com/jobs/view/';

// A real desktop UA/viewport — the bundled-Chromium default UA gets flagged faster.
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1366, height: 900 };

// Browser-like headers for the anonymous guest JD fetch (no cookie sent).
const GUEST_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'X-Requested-With': 'XMLHttpRequest',
  Referer: 'https://www.linkedin.com/jobs',
};

// ── Defaults (overridable per portals.yml scrapers.linkedin-auth) ─────────────

const DEFAULTS = {
  storageState: 'linkedin-storage-state.json',
  // Source-side filters, same semantics as linkedin-guest (the authed search
  // honors the identical f_* query params).
  f_E: '2,3,4', // entry, associate, mid-senior
  f_WT: '', // workplace type: '' = any; '2' = remote
  timeWindowHours: 168, // f_TPR=r<seconds> — one-week tier
  resultsPerQuery: 50, // pagination cap per (query × geo); authed list = 25/page
  pageSize: 25,
  headless: true,
  // Anti-bot pacing — DELIBERATELY slow. One search per ~30-60s.
  delayMs: 30000,
  // Hard ceiling on total navigations per run (search pages only; JD enrichment
  // hits the anonymous guest endpoint, NOT the authed browser, so it doesn't burn
  // burner exposure and isn't capped here).
  dailyCap: 80,
  // Enrich each kept card with its full JD via the PUBLIC guest jobPosting
  // endpoint (anonymous fetch, no browser, no login). OFF by default at scan time
  // (recovered at eval, like linkedin-guest); the eval harness turns it on.
  fetchDescription: false,
};

// ── Provider ──────────────────────────────────────────────────────────────────

/** @type {Provider} */
export default {
  id: 'linkedin-auth',
  // NO detect() — see header.

  async fetch(descriptor, _ctx) {
    const cfg = descriptor?.config || {};
    const queries = normalizeQueries(cfg.queries);
    if (queries.length === 0) {
      console.log(
        'linkedin-auth: skipped — no queries configured in portals.yml scrapers.linkedin-auth',
      );
      return [];
    }
    const geos = normalizeGeos(cfg.geos);

    const opts = {
      storageState:
        typeof cfg.storage_state === 'string' && cfg.storage_state.trim()
          ? cfg.storage_state.trim()
          : DEFAULTS.storageState,
      f_E: typeof cfg.f_E === 'string' && cfg.f_E.trim() ? cfg.f_E.trim() : DEFAULTS.f_E,
      timeWindowHours: posInt(cfg.time_window_hours, DEFAULTS.timeWindowHours),
      resultsPerQuery: posInt(cfg.results_per_query, DEFAULTS.resultsPerQuery),
      headless: cfg.headless !== false,
      delayMs: posInt(cfg.delay_ms, DEFAULTS.delayMs),
      dailyCap: posInt(cfg.daily_cap, DEFAULTS.dailyCap),
      fetchDescription: cfg.fetch_description === true,
    };

    // ── Session cookie gate ──────────────────────────────────────────────────
    // No saved session → stay dormant with a clear instruction. NEVER throw for
    // mere absence (matches jobspy/playwright "absent ≠ error").
    if (!hasValidStorageState(opts.storageState)) {
      console.log(
        `linkedin-auth: skipped — no valid session at "${opts.storageState}". ` +
          'Run `node linkedin-login.mjs` once (headed, on your machine) to capture it.',
      );
      return [];
    }

    // ── Playwright gate ──────────────────────────────────────────────────────
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      console.log('linkedin-auth: skipped — playwright package not available');
      return [];
    }

    const tprSeconds = opts.timeWindowHours * 3600;
    const seen = new Set(); // dedup by numeric job id within this fetch
    const jobs = [];
    let navCount = 0; // counts every page navigation against the daily cap
    let aborted = false;

    let browser;
    try {
      const { chromiumLaunchOptions } = await import('../browser-exec.mjs');
      browser = await chromium.launch(
        chromiumLaunchOptions(chromium, { headless: opts.headless }),
      );
      const context = await browser.newContext({
        storageState: opts.storageState,
        userAgent: USER_AGENT,
        viewport: VIEWPORT,
        locale: 'en-US',
      });
      // Light stealth: hide the automation flag the SPA probes for.
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      const page = await context.newPage();

      outer: for (const geo of geos) {
        for (const keywords of queries) {
          for (let start = 0; start < opts.resultsPerQuery; start += DEFAULTS.pageSize) {
            if (navCount >= opts.dailyCap) {
              console.warn(
                `linkedin-auth: daily_cap (${opts.dailyCap}) reached — stopping early.`,
              );
              break outer;
            }
            // Pace every navigation except the very first.
            if (navCount > 0) await sleep(jitter(opts.delayMs));
            navCount++;

            const url = buildAuthSearchUrl({
              keywords,
              location: geo.where,
              geoId: geo.geoId,
              distance: geo.distance,
              f_WT: geo.f_WT,
              f_E: opts.f_E,
              f_TPR: `r${tprSeconds}`,
              start,
            });

            let html;
            try {
              html = await harvestSearchCards(page, url);
            } catch (err) {
              if (err && err.code === 'LINKEDIN_CHECKPOINT') {
                console.error(
                  '⛔ linkedin-auth: hit a login/checkpoint wall — the saved session is ' +
                    'stale or the burner is challenged. Re-run `node linkedin-login.mjs`. ' +
                    'Aborting this run (no retry into a challenge).',
                );
                aborted = true;
                break outer;
              }
              console.error(
                `⚠️  linkedin-auth [${keywords} @ ${geo.label}] start=${start}: ${err.message}`,
              );
              break; // next query/geo
            }

            const cards = parseAuthCards(html);
            if (cards.length === 0) break; // exhausted this query/geo

            let added = 0;
            for (const card of cards) {
              if (seen.has(card.id)) continue;
              seen.add(card.id);
              jobs.push(card);
              added++;
            }
            if (added === 0) break; // page echoed only dupes → stop paginating
          }
        }
      }

      // ── Optional JD enrichment (via the PUBLIC guest endpoint) ──────────────
      // Why not the authed /jobs/view detail page? LinkedIn moved it to SDUI
      // (server-driven UI, hashed classes, no stable JD hook, applicant count not
      // in the static HTML) — scraping it is brittle AND every visit is more
      // burner exposure. Each kept card already has a canonical /jobs/view/<id>
      // URL, and LinkedIn's PUBLIC jobPosting endpoint serves that JD with NO
      // login. So we enrich JD anonymously (no cookie, no browser) — same source
      // linkedin-guest uses — which is both more robust and zero burner risk.
      // Salary/applicant counts are NOT reliably scrapeable from the SDUI page,
      // so we don't claim them (see the eval report).
      if (!aborted && opts.fetchDescription) {
        for (const job of jobs) {
          await sleep(jitter(2500)); // gentle pacing on the public endpoint
          try {
            const detailHtml = await fetchGuestJd(job.id);
            const desc = parseJobDescription(detailHtml);
            if (desc) job.description = desc;
          } catch (err) {
            console.error(`⚠️  linkedin-auth JD [${job.id}]: ${err.message}`);
          }
        }
      }
    } finally {
      await browser?.close();
    }

    return jobs;
  },
};

// ── Page flow (browser-side; not unit-tested — see pure helpers below) ────────

/**
 * Navigate to an authed search page and harvest ALL result cards.
 *
 * LinkedIn's results rail is VIRTUALIZED: off-screen cards unmount, so a single
 * page.content() snapshot only ever holds the ~7-14 cards currently on screen
 * (this is why the first build captured 14 of 25). We instead scroll the list in
 * steps and, at each step, grab the outerHTML of every card CURRENTLY in the DOM,
 * accumulating by job id. A card hydrates when scrolled into view, so across the
 * scroll loop every card is captured exactly once — even though no single frame
 * holds them all. We only keep hydrated fragments (a placeholder <li> has no
 * lockup title). Returns the concatenated card HTML for parseAuthCards().
 *
 * @param {import('playwright').Page} page
 * @param {string} url
 * @returns {Promise<string>}
 */
async function harvestSearchCards(page, url, { settleMs = 2500, maxScrolls = 16 } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await assertNotCheckpoint(page);
  await page.waitForTimeout(settleMs);

  const fragments = new Map(); // job id → hydrated card outerHTML (first seen wins)
  let stable = 0;
  for (let i = 0; i < maxScrolls; i++) {
    const batch = await page.evaluate(() => {
      // Drive the virtualized list: scroll the window and any plausible scroll
      // container to the bottom, then bring the last card into view to force the
      // next slice to render.
      window.scrollTo(0, document.body.scrollHeight);
      for (const sel of ['.jobs-search-results-list', '.scaffold-layout__list', 'main']) {
        const el = document.querySelector(sel);
        if (el) el.scrollTop = el.scrollHeight;
      }
      const cards = document.querySelectorAll('[data-job-id]');
      if (cards.length) cards[cards.length - 1].scrollIntoView();
      return [...cards].map((el) => {
        const li = el.closest('li') || el;
        return [el.getAttribute('data-job-id'), li.outerHTML];
      });
    });

    let added = 0;
    for (const [id, frag] of batch) {
      // Only keep hydrated cards — a recycled placeholder carries the id but no
      // title lockup, and would otherwise blank an otherwise-good card.
      const hydrated =
        typeof frag === 'string' &&
        (frag.includes('entity-lockup__title') || frag.includes('job-card-list__title'));
      if (id && hydrated && !fragments.has(id)) {
        fragments.set(id, frag);
        added++;
      }
    }
    await page.waitForTimeout(900);
    // Two consecutive scrolls that add nothing new = list exhausted.
    if (added === 0) {
      if (++stable >= 2) break;
    } else {
      stable = 0;
    }
  }
  return [...fragments.values()].join('\n');
}

/**
 * Fetch a job's JD HTML from LinkedIn's PUBLIC guest jobPosting endpoint —
 * anonymous (no cookie), so it costs no burner exposure. Throws on non-2xx.
 * @param {string|number} id
 * @returns {Promise<string>}
 */
async function fetchGuestJd(id, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(buildJobPostingUrl(id), {
      headers: GUEST_HEADERS,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Throw a tagged checkpoint error if the page redirected to a login/checkpoint/
 * authwall. The provider catches `.code === 'LINKEDIN_CHECKPOINT'` and aborts.
 * @param {import('playwright').Page} page
 */
async function assertNotCheckpoint(page) {
  const url = page.url();
  if (isCheckpointUrl(url)) {
    const err = new Error(`redirected to a login/checkpoint wall (${url})`);
    // @ts-ignore — tag for the caller.
    err.code = 'LINKEDIN_CHECKPOINT';
    throw err;
  }
}

// ── Pure helpers (exported for unit tests — no network/browser inside) ────────

/**
 * Is this URL a LinkedIn login/checkpoint/authwall (i.e. our session is dead)?
 * @param {string} url
 * @returns {boolean}
 */
export function isCheckpointUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  return /\/(checkpoint|authwall|uas\/login)|\/login(\?|\/|$)|\/signup/.test(url);
}

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
 * Mirrors linkedin-guest.normalizeGeos so the two providers accept identical
 * geo blocks. Tolerates bare strings, objects, or absence (→ "Netherlands").
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
 * Build an authenticated /jobs/search/ URL with source-side filters. Only
 * non-empty params are appended. sortBy=DD = freshest first.
 * @param {{keywords: string, location?: string, geoId?: string, distance?: number,
 *          f_WT?: string, f_E?: string, f_TPR?: string, start?: number}} p
 * @returns {string}
 */
export function buildAuthSearchUrl(p) {
  const q = new URLSearchParams();
  q.set('keywords', p.keywords || '');
  if (p.geoId) q.set('geoId', p.geoId);
  else if (p.location) q.set('location', p.location);
  if (p.distance) q.set('distance', String(p.distance));
  if (p.f_WT) q.set('f_WT', p.f_WT);
  if (p.f_E) q.set('f_E', p.f_E);
  if (p.f_TPR) q.set('f_TPR', p.f_TPR);
  q.set('sortBy', 'DD');
  q.set('start', String(Number.isFinite(p.start) ? p.start : 0));
  return `${SEARCH_PAGE}?${q.toString()}`;
}

/**
 * Build the canonical detail URL for a numeric job id.
 * @param {string|number} id
 * @returns {string}
 */
export function buildViewUrl(id) {
  return `${VIEW_BASE}${encodeURIComponent(String(id))}`;
}

/**
 * Parse an authenticated jobs-search page into normalized job cards.
 *
 * Authed cards are obfuscated React markup, but two anchors are stable: each
 * result carries a numeric job id on `data-job-id` / `data-occludable-job-id`,
 * and the title link exposes the title via `aria-label`. We slice the HTML per
 * job-id anchor and pull fields with tolerant, multi-fallback regexes so a class
 * rename doesn't blank a whole card. A card with no recoverable title is skipped.
 *
 * AUTH-ONLY extras captured when present in the card footer: salary band (rare on
 * NL roles) and the Easy-Apply flag. (Applicant count is not reliably scrapeable —
 * the SDUI detail page doesn't expose it in static HTML — so we don't claim it.)
 *
 * The canonical URL is rebuilt from the id as /jobs/view/<id> so scan.mjs's
 * canonicalizeUrl() collapses it to the numeric identity → cross-source dedup
 * with the guest + jobspy LinkedIn rows is automatic.
 *
 * @param {string} html
 * @returns {Array<{id: string, title: string, url: string, company: string,
 *   location: string, postedAt?: number, salary?: string, easyApply?: boolean}>}
 */
export function parseAuthCards(html) {
  if (typeof html !== 'string' || !html) return [];

  // Anchor on every job-id occurrence. A single card carries the SAME id twice —
  // once on the outer <li data-occludable-job-id> and once on the inner
  // <div data-job-id> — so we collapse to each id's FIRST index and bound a
  // card's slice by the next UNIQUE id's first index (not the next raw mark,
  // which would truncate the card at its own inner anchor).
  const idRe = /data-(?:occludable-)?job-id="(\d+)"/g;
  const firstIndex = new Map();
  let m;
  while ((m = idRe.exec(html)) !== null) {
    if (!firstIndex.has(m[1])) firstIndex.set(m[1], m.index);
  }
  if (firstIndex.size === 0) return [];
  const uniq = [...firstIndex.entries()]; // [ [id, index], ... ] in document order

  const out = [];
  for (let i = 0; i < uniq.length; i++) {
    const [id, index] = uniq[i];
    const end = i + 1 < uniq.length ? uniq[i + 1][1] : html.length;
    const slice = html.slice(index, end);

    const title = extractTitle(slice);
    if (!title) continue;

    const postedAt = extractPostedAt(slice);
    const salary = extractSalary(slice);
    out.push({
      id,
      title,
      url: `${VIEW_BASE}${id}`,
      company: extractCompany(slice),
      location: extractLocation(slice),
      ...(postedAt != null ? { postedAt } : {}),
      ...(salary ? { salary } : {}),
      ...(/\bEasy Apply\b/i.test(slice) ? { easyApply: true } : {}),
    });
  }
  return out;
}

/**
 * Pull a salary band from a card's HTML. LinkedIn shows pay (when it shows it at
 * all) in a footer/metadata item as a currency amount with a per-period or K/M
 * cue: "€60,000/yr - €80,000/yr", "$120K/yr", "£45,000 - £55,000 per year".
 *
 * STRICT by design. Most NL roles show NO salary, and a loose regex grabs noise —
 * the first build returned "€0 M" on every card from stray "€0" fragments. We
 * require a REAL amount — comma-grouped thousands (60,000), a K/M-suffixed number
 * (120K, 1.2M), or 4+ digits (60000) — AND either that K/M suffix or an explicit
 * per-period cue. A bare "€0" / "$300" with neither is rejected. Returns '' when
 * no salary is shown (the common case).
 * @param {string} html
 * @returns {string}
 */
export function extractSalary(html) {
  const text = cleanText(html);
  const CUR = '[€$£]';
  // A meaningful amount — NOT a bare 1-3 digit number like €0 or $300.
  const AMT = '(?:\\d{1,3}(?:,\\d{3})+|\\d{1,3}(?:\\.\\d+)?[KkMm]|\\d{4,})';
  const re = new RegExp(
    `${CUR}\\s?${AMT}` +
      `(?:\\s?[-–]\\s?${CUR}?\\s?${AMT})?` +
      `(?:\\s?(?:/\\s?(?:yr|year|hr|hour|mo|month|wk|week)|per\\s+(?:year|hour|month|week)|a\\s+year))?`,
  );
  const m = text.match(re);
  if (!m) return '';
  const found = m[0].trim();
  const hasKM = /\d\s?[KkMm]\b/.test(found);
  const hasPeriod =
    /(\/\s?(yr|year|hr|hour|mo|month|wk|week)|per\s+(year|hour|month|week)|a\s+year)/i.test(found);
  return hasKM || hasPeriod ? found : '';
}

// ── Field extractors (private) ────────────────────────────────────────────────

function extractTitle(slice) {
  // 1) The title link's aria-label is the cleanest source.
  const aria = slice.match(
    /<a[^>]*job-card-(?:container__link|list__title)[^>]*aria-label="([^"]+)"/,
  );
  if (aria) return tidyTitle(aria[1]);
  // 2) Any aria-label on a /jobs/view/ link in this slice.
  const anyAria = slice.match(/<a[^>]*href="[^"]*\/jobs\/view\/[^"]*"[^>]*aria-label="([^"]+)"/);
  if (anyAria) return tidyTitle(anyAria[1]);
  // 3) Visible title span/strong inside a title element.
  const span =
    matchInner(slice, /class="[^"]*job-card-list__title[^"]*"[^>]*>([\s\S]*?)<\/a>/) ||
    matchInner(slice, /class="[^"]*artdeco-entity-lockup__title[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  return tidyTitle(cleanText(span));
}

function extractCompany(slice) {
  const sub =
    matchInner(slice, /class="[^"]*artdeco-entity-lockup__subtitle[^"]*"[^>]*>([\s\S]*?)<\/div>/) ||
    matchInner(slice, /class="[^"]*job-card-container__primary-description[^"]*"[^>]*>([\s\S]*?)<\//) ||
    matchInner(slice, /class="[^"]*job-card-container__company-name[^"]*"[^>]*>([\s\S]*?)<\//);
  return cleanText(sub);
}

function extractLocation(slice) {
  const loc =
    matchInner(slice, /class="[^"]*artdeco-entity-lockup__caption[^"]*"[^>]*>([\s\S]*?)<\/div>/) ||
    matchInner(slice, /class="[^"]*job-card-container__metadata-(?:item|wrapper)[^"]*"[^>]*>([\s\S]*?)<\/(?:li|ul|div)>/);
  return cleanText(loc);
}

function extractPostedAt(slice) {
  const dt = slice.match(/datetime="(\d{4}-\d{2}-\d{2})"/);
  if (!dt) return undefined;
  const t = Date.parse(`${dt[1]}T00:00:00Z`);
  return Number.isFinite(t) ? t : undefined;
}

// Strip a trailing " with verification" and de-dupe LinkedIn's doubled aria text.
function tidyTitle(raw) {
  let t = cleanText(raw).replace(/\s+with verification$/i, '').trim();
  // aria-labels sometimes repeat the title twice ("AI Engineer AI Engineer").
  const half = t.length / 2;
  if (t.length % 2 === 1 && t[Math.floor(half)] === ' ') {
    const a = t.slice(0, Math.floor(half));
    const b = t.slice(Math.ceil(half));
    if (a === b) t = a;
  }
  return t;
}

// ── Storage-state validation ──────────────────────────────────────────────────

/**
 * True when the storageState path holds a usable Playwright session (parseable
 * JSON with at least one cookie). Invalid/empty → treated as "no session".
 * @param {string} pathStr
 * @returns {boolean}
 */
export function hasValidStorageState(pathStr) {
  try {
    if (!existsSync(pathStr)) return false;
    const parsed = JSON.parse(readFileSync(pathStr, 'utf-8'));
    return Array.isArray(parsed?.cookies) && parsed.cookies.length > 0;
  } catch {
    return false;
  }
}

// ── Tiny shared utilities ─────────────────────────────────────────────────────

function posInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function matchInner(haystack, re) {
  const m = haystack.match(re);
  return m ? m[1] : '';
}

function cleanText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&euro;/g, '€')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => Math.round(base + Math.random() * base);
