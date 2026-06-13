#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner with a plugin-based provider layer.
 *
 * Providers live in providers/*.mjs and are loaded at startup. Each provider
 * exports a default object with:
 *   - id: string — matched against `provider:` in portals.yml
 *   - detect(entry): {url}|null — optional auto-detection from careers_url
 *   - fetch(entry, ctx): [{title,url,company,location}] — required
 *
 * Files prefixed with _ are shared helpers (e.g. _http.mjs) and are never
 * loaded as providers. Adding a new HTTP/API source = drop a *.mjs into
 * providers/. Local executable parsers use `providers/local-parser.mjs` when
 * `parser.command` + `parser.script` are set in portals.yml.
 *
 * A tracked_companies entry can set `provider:` explicitly to bypass
 * URL-based auto-detection. The `transport:` field is reserved for future
 * transports — Phase A only ships the http transport.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 *   node scan.mjs --verify         # Playwright-check each new URL; drop expired postings
 *   node scan.mjs --verify --headed-fallback  # retry anti-bot-blocked URLs in a headed browser (needs a display)
 *   node scan.mjs --verify --throttle          # jittered ~5-10s gap between checks (stay under rate limits)
 *   node scan.mjs --verify --throttle=8000     # custom base gap in ms (waits base..2*base)
 */

import 'dotenv/config'; // loads .env so aggregator providers can read API keys from process.env

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';
import yaml from 'js-yaml';

import { makeHttpCtx } from './providers/_http.mjs';
import { jdFilename, renderJd } from './providers/_jd.mjs';
import { getMonthlyCount, addUsage } from './usage-ledger.mjs';

const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const JDS_DIR = 'jds';
const PROVIDERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'providers');

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;

// ── Provider loading ────────────────────────────────────────────────

async function loadProviders(dir) {
  const providers = new Map();
  if (!existsSync(dir)) return providers;
  // Alphabetical order so detect() priority is deterministic across machines.
  const entries = readdirSync(dir)
    .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
    .sort();
  for (const file of entries) {
    const full = path.join(dir, file);
    let mod;
    try {
      mod = await import(pathToFileURL(full).href);
    } catch (err) {
      console.error(`⚠️  ${file}: failed to load — ${err.message}`);
      continue;
    }
    const p = mod.default;
    if (!p || typeof p.fetch !== 'function' || !p.id) {
      console.error(`⚠️  ${file}: skipping — default export must be { id, fetch }`);
      continue;
    }
    if (providers.has(p.id)) {
      console.error(`⚠️  ${file}: duplicate provider id "${p.id}" — keeping first`);
      continue;
    }
    providers.set(p.id, p);
  }
  return providers;
}

// Resolve which provider handles a tracked_companies entry.
// 1. Explicit `provider:` field wins (skips detect()).
// 2. local-parser when parser.command + script are configured (before API detect).
// 3. Otherwise each provider's detect() runs in load order; first hit wins.
function resolveProvider(entry, providers, { skipIds = [] } = {}) {
  if (entry.provider) {
    const p = providers.get(entry.provider);
    if (!p) return { error: `unknown provider: ${entry.provider}` };
    return { provider: p };
  }

  const localParser = providers.get('local-parser');
  if (localParser && !skipIds.includes('local-parser')) {
    try {
      const hit = localParser.detect?.(entry);
      if (hit) return { provider: localParser };
    } catch (err) {
      console.error(`⚠️  local-parser: detect() threw for "${entry.name}" — ${err.message}`);
    }
  }

  for (const p of providers.values()) {
    if (skipIds.includes(p.id)) continue;
    let hit;
    try {
      hit = p.detect?.(entry);
    } catch (err) {
      console.error(`⚠️  ${p.id}: detect() threw for "${entry.name}" — ${err.message}`);
      continue;
    }
    if (hit) return { provider: p };
  }
  return null;
}

// ── Title filter ────────────────────────────────────────────────────

export function buildTitleFilter(titleFilter) {
  // Compile each keyword to a word-boundary regex for alphanumeric/hyphen keywords
  // (prevents "AI" matching "paid", "ML" matching "AML", etc.).
  // Keywords with special chars like ".NET" fall back to substring match.
  // `plural` (negatives only) appends an optional trailing "s" so "Professor"
  // also drops "Professors", "Manager"→"Managers", "Lead"→"Leads", etc. It is
  // NOT applied to positives: matching is the strict direction there, so we
  // don't loosen 2-char tokens like "AI"/"ML" into "AIS"/"MLS". Special-char
  // keywords (".NET") stay substring and are unaffected.
  const compile = (k, plural = false) => {
    const t = k.trim();
    if (/^[\w\s-]+$/.test(t)) {
      const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { re: new RegExp('\\b' + esc + (plural ? 's?' : '') + '\\b', 'i') };
    }
    return { sub: t.toLowerCase() };
  };
  const hit = (c, title) => c.re ? c.re.test(title) : title.toLowerCase().includes(c.sub);

  const positive = (titleFilter?.positive || []).map(k => compile(k));
  const negative = (titleFilter?.negative || []).map(k => compile(k, true));

  return (title) => {
    const hasPositive = positive.length === 0 || positive.some(c => hit(c, title));
    const hasNegative = negative.some(c => hit(c, title));
    return hasPositive && !hasNegative;
  };
}

// ── Location filter ─────────────────────────────────────────────────
// Optional. If `location_filter` is absent from portals.yml, all locations pass.
// Semantics (case-insensitive substring, in this order):
//   - Empty / whitespace-only / non-string location → pass (don't penalize
//     missing or malformed provider data)
//   - `always_allow` matches → pass (takes precedence over `block` — lets a
//     multi-location string like "Remote, Belgium or France" through because
//     the home region is an option, even though "france" is blocked)
//   - `block` matches → reject
//   - `allow` empty → pass (already cleared block)
//   - `allow` non-empty → must match at least one keyword, where remote-ish
//     allow tokens (remote/europe/emea/...) only pass UNANCHORED strings —
//     see REMOTE_ALLOW_TOKENS below for the anchored-remote rule.

// Normalize a keyword list from portals.yml: tolerates a bare string
// (wrapped to a 1-item array), null/undefined (→ []), and non-string
// entries (filtered out). Survivors are lowercased, trimmed, and any
// resulting empty strings are dropped — an empty keyword would otherwise
// match every location via String.includes(''), silently bypassing the
// other tiers.
function normalizeKeywordList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter(k => typeof k === 'string')
    .map(k => k.toLowerCase().trim())
    .filter(Boolean);
}

// Tokens whose allow-match means "remote/region-wide", not a concrete place.
// They are trusted only when the location string is NOT anchored to a
// non-allowed place: "Madrid, MD, Spain, Remote" is Spain-anchored remote
// (a Spanish employment entity), not EU-remote — without this distinction
// every global board leaks foreign postings through a trailing ", Remote".
const REMOTE_ALLOW_TOKENS = new Set(['remote', 'europe', 'emea', 'eu', 'anywhere', 'worldwide', 'global']);
const REMOTE_GENERIC_SEGMENT_RE = /\b(remote|hybrid|flexible|home\s*office|wfh|telework)\b/i;

export function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;
  const alwaysAllow = normalizeKeywordList(locationFilter.always_allow);
  const allow = normalizeKeywordList(locationFilter.allow);
  const block = normalizeKeywordList(locationFilter.block);
  const allowPlace = allow.filter(k => !REMOTE_ALLOW_TOKENS.has(k));
  const allowRemote = allow.filter(k => REMOTE_ALLOW_TOKENS.has(k));

  return (location) => {
    if (typeof location !== 'string' || location.trim() === '') return true;
    const lower = location.toLowerCase();
    if (alwaysAllow.length > 0 && alwaysAllow.some(k => lower.includes(k))) return true;
    if (block.length > 0 && block.some(k => lower.includes(k))) return false;
    if (allow.length === 0) return true;
    // Concrete place tokens (cities/countries) match anywhere in the string.
    if (allowPlace.some(k => lower.includes(k))) return true;
    if (allowRemote.length === 0 || !allowRemote.some(k => lower.includes(k))) return false;
    // A remote-ish token matched. Trust it only if every comma-ish segment is
    // itself remote/region-flavored — i.e. there is no anchor to a place we
    // did not allow ("Kraków, Poland, Remote" → anchored → reject;
    // "Remote - Europe" / "Remote job" → unanchored → pass).
    const segments = lower.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
    const anchorSegments = segments.filter(
      s => !allowRemote.some(k => s.includes(k)) && !REMOTE_GENERIC_SEGMENT_RE.test(s)
    );
    return anchorSegments.length === 0;
  };
}

// ── Salary filter ───────────────────────────────────────────────────
// Optional. If `salary_filter` is absent from portals.yml, all salaries pass.
// Semantics:
//   - min/max are annual compensation filters (use annualized values)
//   - max: 0 means "no upper limit"
//   - If no salary data exists on a job, it passes (conservative behavior)
//   - If both currencies are known and mismatch (e.g., USD filter, EUR job), it fails
//   - Partial ranges (min only or max only) work correctly via overlap logic
// Uses null-safe checks (!= null, ??) to preserve 0 values correctly.

export function buildSalaryFilter(salaryFilter) {
  if (!salaryFilter) return () => true;

  // Coerce and validate bounds — malformed YAML must not silently mis-filter
  const min = Number(salaryFilter.min ?? 0);
  const max = Number(salaryFilter.max ?? 0);
  const filterCurrency = (salaryFilter.currency || '').trim().toUpperCase();

  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0) {
    console.error('Warning: salary_filter.min/max must be non-negative numbers — salary filter disabled');
    return () => true;
  }
  if (max > 0 && min > max) {
    console.error('Warning: salary_filter.min cannot exceed salary_filter.max — salary filter disabled');
    return () => true;
  }

  // If both min and max are 0, no filtering applied
  if (min === 0 && max === 0) return () => true;

  return (salary) => {
    // If no salary data exists, pass (conservative - many providers don't expose salary)
    if (!salary) return true;

    const jobMin = salary.min ?? salary.max ?? null;
    const jobMax = salary.max ?? salary.min ?? null;

    // If we have no usable salary values, pass conservatively
    if (jobMin == null && jobMax == null) return true;

    // Currency handling - reject only if BOTH currencies exist and mismatch
    const jobCurrency = (salary.currency || '').trim().toUpperCase();
    if (filterCurrency && jobCurrency && filterCurrency !== jobCurrency) {
      return false;
    }

    // Range overlap logic - reject ONLY if job is completely outside filter range
    // Job entirely below user minimum
    if (min > 0 && jobMax != null && jobMax < min) {
      return false;
    }
    // Job entirely above user maximum
    if (max > 0 && jobMin != null && jobMin > max) {
      return false;
    }

    // Otherwise pass (overlap exists or no valid range to compare)
    return true;
  };
}

// ── URL rediscovery (--rediscover-404) ──────────────────────────────
// When a tracked company's job URL returns 404/410, the role may have just
// moved to a new URL (Workday/Greenhouse rotate URLs without closing roles).
// These helpers back an opt-in search-and-reverify fallback before giving up.

// extractCareersUrlDomain returns the hostname of a company's careers_url, or
// null when it's missing/unparseable. The presence of a domain is what gates
// the fallback — broad-discovery offers without a careers_url stay ineligible.
export function extractCareersUrlDomain(careersUrl) {
  if (!careersUrl) return null;
  try {
    return new URL(careersUrl).hostname;
  } catch {
    return null;
  }
}

// resolveSearchHref unwraps a DuckDuckGo HTML redirect (`/l/?uddg=<encoded>`)
// to its real destination, so domain matching sees the actual host instead of
// duckduckgo.com. Non-redirect hrefs pass through unchanged.
function resolveSearchHref(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const isDdgHost = u.hostname === 'duckduckgo.com' || u.hostname.endsWith('.duckduckgo.com');
    if (isDdgHost && u.pathname === '/l/') {
      const target = u.searchParams.get('uddg');
      if (target) return target;
    }
  } catch {
    /* fall through to the raw href */
  }
  return href;
}

// pickRediscoveredUrl chooses the first result whose hostname *exactly* equals
// the careers domain (no substring/look-alike matches), unwrapping search-engine
// redirects first. Pure + exported so result-matching is unit-testable without
// driving a real browser. Returns null when nothing matches.
export function pickRediscoveredUrl(hrefs, domain) {
  if (!domain || !Array.isArray(hrefs)) return null;
  for (const raw of hrefs) {
    const href = resolveSearchHref(raw);
    let host;
    try {
      host = new URL(href).hostname;
    } catch {
      continue;
    }
    if (host === domain) return href;
  }
  return null;
}

// REDISCOVER_TIMEOUT_MS bounds the single fallback search so a slow or blocked
// search engine can't stall the sequential verify loop.
const REDISCOVER_TIMEOUT_MS = 10_000;

// searchForNewUrl runs one site-scoped search for a moved tracked role and
// returns a same-domain URL if found, else null. Every failure path returns
// null — the fallback must never throw into the verify loop. Leaves the page on
// a blank document so the next checkUrlLiveness call starts clean.
async function searchForNewUrl(page, offer) {
  const domain = offer.careersUrlDomain;
  if (!domain) return null;
  const query = `"${offer.title}" "${offer.company}" site:${domain}`;
  try {
    await page.goto(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { waitUntil: 'domcontentloaded', timeout: REDISCOVER_TIMEOUT_MS },
    );
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a.result__a'))
        .map((a) => a.getAttribute('href'))
        .filter(Boolean),
    );
    return pickRediscoveredUrl(hrefs, domain);
  } catch {
    return null;
  } finally {
    try {
      await page.goto('about:blank');
    } catch {
      /* ignore — best-effort cleanup */
    }
  }
}

// ── Dedup ───────────────────────────────────────────────────────────

// Normalize a company+title pair into a stable dedup key so the SAME role
// surfaced by different sources collapses to one — notably LinkedIn vs Indeed
// (the JobSpy scraper hits BOTH), which name the employer differently
// ("CGI" vs "CGI Nederland", "X" vs "X (IND)") under different URLs. Drops
// parentheticals, common corporate suffixes, and punctuation. Conservative:
// the normalized TITLE must still match, so distinct roles at one employer stay
// separate. Exported for tests.
const COMPANY_SUFFIXES =
  /\b(nederland|netherlands|bv|gmbh|inc|incorporated|ltd|limited|llc|nl|se|ag|plc|group|holding|holdings|nv)\b/g;

export function companyRoleKey(company, title) {
  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')        // drop "(IND)", "(m/f/d)", etc.
    .replace(/[.'`’]/g, '')          // collapse abbreviations so "b.v." → "bv"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const co = norm(company).replace(COMPANY_SUFFIXES, ' ').replace(/\s+/g, ' ').trim();
  const ti = norm(title).replace(/\s+/g, ' ').trim();
  return `${co}::${ti}`;
}

const PERMANENT_SCAN_HISTORY_STATUSES = new Set([
  'skipped_invalid_url',
  'skipped_blocked_host',
]);

// Statuses that may be re-checked after `scan_history.recheck_after_days`,
// exactly like 'added' rows. skipped_no_apply_control is a heuristic verdict
// (overlay walls and unrecognized button languages produce false drops — see
// the 2026-06-13 incident where 7/7 live LinkedIn postings were blacklisted),
// so it must not be permanent: with a recheck window configured the classifier
// gets another look once its detection improves.
const RECHECKABLE_SCAN_HISTORY_STATUSES = new Set([
  'added',
  'skipped_no_apply_control',
]);

function daysBetweenIsoDates(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (startDate.toISOString().slice(0, 10) !== start || endDate.toISOString().slice(0, 10) !== end) return null;
  return Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24));
}

export function shouldDedupScanHistoryRow({ firstSeen, status = 'added' }, { recheckAfterDays = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (PERMANENT_SCAN_HISTORY_STATUSES.has(status)) return true;
  if (!RECHECKABLE_SCAN_HISTORY_STATUSES.has(status)) return true;
  if (recheckAfterDays == null) return true;
  const ageDays = daysBetweenIsoDates(firstSeen, today);
  if (ageDays == null) return true;
  return ageDays < recheckAfterDays;
}

function scanHistoryPolicy(config = {}) {
  const raw = config.scan_history?.recheck_after_days;
  const parsed = Number.parseInt(raw, 10);
  return {
    recheckAfterDays: Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
  };
}

// ── URL canonicalization ────────────────────────────────────────────
// The same posting re-enters under different URL spellings: aggregators wrap
// employer URLs in tracking params (?utm_source=indeed_integration&
// indeed-apply-token=...), boards vary protocol/www/trailing slash, LinkedIn
// serves /jobs/view/<id> with and without slash and query. Dedup compares
// CANONICAL forms; raw URLs are still what gets stored and displayed.

const TRACKING_PARAM_PREFIX_RE = /^(utm_|mtm_|pk_)/i;
const TRACKING_PARAMS = new Set([
  'gh_src', 'lever-source', 'lever-origin', 'source', 'src', 'ref', 'referer',
  'referrer', 'iis', 'iisn', 'indeed-apply-token', 'trk', 'tracking',
  'trackingid', 'mc_cid', 'mc_eid', 'fbclid', 'gclid', 'original_referer',
]);
// NOT stripped: gh_jid (identifies the job on embedded Greenhouse boards),
// jobId/id-style params — anything that may BE the posting identity.

export function canonicalizeUrl(raw) {
  const input = String(raw || '').trim();
  let u;
  try {
    u = new URL(input);
  } catch {
    return input; // local:jds/... refs and malformed strings pass through
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return input;
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.hash = '';
  // LinkedIn job pages: the numeric id IS the identity.
  const li = u.hostname === 'linkedin.com' && u.pathname.match(/^\/jobs\/view\/(\d+)/);
  if (li) return `https://linkedin.com/jobs/view/${li[1]}`;
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM_PREFIX_RE.test(key) || TRACKING_PARAMS.has(key.toLowerCase())) {
      u.searchParams.delete(key);
    }
  }
  return u.toString().replace(/\?$/, '').replace(/\/+$/, '');
}

export function loadSeenUrls(policy = {}) {
  const seen = new Set();
  let recheckEligible = 0;

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const [url, firstSeen, , , , status = 'added'] = line.split('\t');
      if (!url) continue;
      if (shouldDedupScanHistoryRow({ firstSeen, status }, policy)) seen.add(canonicalizeUrl(url));
      else recheckEligible++;
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(canonicalizeUrl(match[1]));
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(canonicalizeUrl(match[0]));
    }
  }

  return { seen, recheckEligible };
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim();
      const role = match[2].trim();
      if (company && role && company.toLowerCase() !== 'company') {
        seen.add(companyRoleKey(company, role));
      }
    }
  }

  // pipeline.md checkbox rows — covers offers already triaged but not (yet) in
  // the tracker. Critical for aggregators like Careerjet that mint a FRESH
  // tracking URL for the same posting on every scan: URL dedup misses them, so
  // without this the same junk re-enters the pipeline every cycle.
  // Row shapes handled:
  //   - [x] <url> | Company | Title | <verdict…>
  //   - [x] #123 | <url-or-local:> | Company | Title | 3.4/5 | PDF ❌
  //   - [ ] local:jds/x.md | Company | Title · annotations — EVAL
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const line of text.split('\n')) {
      const m = line.match(/^- \[[ x!]\] (.+)$/);
      if (!m) continue;
      const segs = m[1].split(' | ').map(s => s.trim());
      if (/^#\d+$/.test(segs[0])) segs.shift();                     // optional #num
      if (/^(https?:\/\/|local:|www\.)/.test(segs[0] || '')) segs.shift(); // url/local ref
      const company = segs[0];
      // Title may carry inline annotations after the role name — strip them.
      const title = (segs[1] || '').split(' · ')[0].split(' — ')[0].trim();
      // Allow EMPTY company: some aggregator rows carry no employer name, and
      // companyRoleKey('') on the incoming side produces the same '::title'
      // key — requiring a company here let those rows re-enter every scan.
      if (title) seen.add(companyRoleKey(company || '', title));
      // Pipe-laden titles ("AI | Genai Engineer | Amsterdam | 100k") get split
      // into separate segments above, so segs[1] alone under-keys them. Also
      // register the full remaining tail (up to any verdict/score annotation
      // we append when triaging) as an alternate title key.
      const tailEnd = segs.findIndex((s, i) => i >= 2 &&
        (/^(SKIP|EVAL|\d\.\d\/5|PDF |✅|❌)/.test(s) || /^\d\.\d\/5$/.test(s)));
      const tail = segs.slice(1, tailEnd === -1 ? undefined : tailEnd).join(' | ')
        .split(' · ')[0].split(' — ')[0].trim();
      if (tail && tail !== title) seen.add(companyRoleKey(company || '', tail));
    }
  }

  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

export function appendToPipeline(offers) {
  // A row without a URL segment poisons the pending-line parser downstream
  // (segments shift, company/title misalign, dedup keys corrupt) — never
  // write one.
  offers = offers.filter((o) => String(o.pipelineUrl || o.url || '').trim());
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // The pipeline line carries `pipelineUrl` when present (e.g. a scraper's
  // `local:jds/...` ref, so evaluation reads the JD offline instead of hitting a
  // login wall) and falls back to the canonical URL otherwise. Dedup, liveness
  // verification, and scan-history all keep `o.url` (the employer URL).
  // `preScore` (set by main() via triage-score.mjs) rides along as a ` · pre:A78`
  // annotation so the pipeline can be worked best-first. The ' · ' separator is
  // already stripped by the company-role dedup parser.
  const pipelineLine = (o) => `- [ ] ${o.pipelineUrl || o.url} | ${o.company} | ${o.title}${o.preScore ? ` · ${o.preScore}` : ''}`;

  // Support both English ("## Pending") and Spanish ("## Pendientes") markers so
  // the function works regardless of which language the file was initialised with.
  // The first marker found wins; the Spanish processed header is also recognised
  // so the fallback create path picks the right processed-section counterpart.
  const PENDING_MARKERS = ['## Pending', '## Pendientes'];
  const PROCESSED_MARKERS = ['## Processed', '## Procesadas'];

  // Find the first existing Pending section.
  let markerUsed = null;
  let idx = -1;
  for (const m of PENDING_MARKERS) {
    const i = text.indexOf(m);
    if (i !== -1 && (idx === -1 || i < idx)) {
      idx = i;
      markerUsed = m;
    }
  }

  if (idx === -1) {
    // No Pending section exists yet — create one before the Processed section
    // (or at end of file if there is no Processed section either).
    const newMarker = PENDING_MARKERS[0]; // always create as English
    let procIdx = -1;
    for (const m of PROCESSED_MARKERS) {
      const i = text.indexOf(m);
      if (i !== -1 && (procIdx === -1 || i < procIdx)) procIdx = i;
    }
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${newMarker}\n\n` + offers.map(pipelineLine).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Append into the existing Pending section (just before the next ## heading).
    const afterMarker = idx + markerUsed.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(pipelineLine).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

export function appendToScanHistory(offers, date, status = 'added') {
  // Ensure file + header exist. Location appended as 7th column for non-breaking
  // backward compat — older scan-history.tsv files with 6 columns still parse fine
  // since loadSeenUrls only reads column 0. `status` is parameterized so callers
  // can record verify outcomes (`skipped_expired`, etc.) without the legacy
  // `(expired)` suffix in `source`.
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\t${status}\t${o.location || ''}`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function verifyOffers(offers, { headedFallback = false, throttleBaseMs = 0, rediscover = false } = {}) {
  // Dynamic imports keep the default zero-token path free of Playwright startup
  let chromium;
  let checkUrlLiveness;
  let checkUrlLivenessWithFallback;
  let createHeadedPageProvider;
  let newLivenessPage;
  let jitteredDelayMs;
  let sleep;
  try {
    ({ chromium } = await import('playwright'));
    ({ checkUrlLiveness, checkUrlLivenessWithFallback, createHeadedPageProvider, newLivenessPage, jitteredDelayMs, sleep } = await import('./liveness-browser.mjs'));
  } catch (err) {
    throw new Error(
      `--verify requires Playwright with Chromium (run "npx playwright install chromium"): ${err.message}`,
      { cause: err },
    );
  }

  let browser;
  try {
    const { chromiumLaunchOptions } = await import('./browser-exec.mjs');
    browser = await chromium.launch(chromiumLaunchOptions(chromium, { headless: true }));
  } catch (err) {
    throw new Error(
      `--verify could not launch Chromium (run "npx playwright install chromium" or re-run without --verify): ${err.message}`,
      { cause: err },
    );
  }

  // Three permanent buckets + one transient passthrough:
  //   verified  → active pages and transient nav errors (retry next scan)
  //   expired   → classifier-confirmed dead postings (HTTP 4xx, redirect markers,
  //               body patterns, listing pages, insufficient content)
  //   dropped   → page loaded but classifier saw no Apply control. --verify is an
  //               opt-in stricter filter; keeping these defeats the purpose.
  //   invalid   → up-front URL guard rejections (malformed / non-http / private)
  const verified = [];
  const expired = [];
  const dropped = [];
  const invalid = [];
  const migrated = [];

  const headed = headedFallback ? createHeadedPageProvider(chromium) : null;
  const getHeadedPage = headed ? () => headed.get() : undefined;

  try {
    const page = await newLivenessPage(browser);
    // Sequential — project rule: never Playwright in parallel
    for (let i = 0; i < offers.length; i++) {
      const offer = offers[i];
      const { result, code, reason } = headed
        ? await checkUrlLivenessWithFallback(page, offer.url, { getHeadedPage })
        : await checkUrlLiveness(page, offer.url);
      if (result === 'expired') {
        // 404/410 on a tracked company may just be a moved role — run one
        // search + re-verify before giving up (opt-in via --rediscover-404).
        // Only http_gone (HTTP 404/410) qualifies; soft-expiry signals
        // (redirect/body/listing) are real closures, not URL moves.
        if (rediscover && code === 'http_gone' && offer.tracked && offer.careersUrlDomain) {
          const newUrl = await searchForNewUrl(page, offer);
          if (newUrl) {
            // Mirror the primary check: without the headed fallback, a
            // challenge-prone domain would flag the rediscovered URL as
            // expired just because the recheck hit the same anti-bot wall.
            const recheck = headed
              ? await checkUrlLivenessWithFallback(page, newUrl, { getHeadedPage })
              : await checkUrlLiveness(page, newUrl);
            // Require a *confirmed* live page before migrating. A transient
            // 'uncertain' (timeout/DNS/5xx) must not commit an unverified URL —
            // fall through to expired (the original 404/410 is a real closure).
            if (recheck.result === 'active') {
              migrated.push({ ...offer, url: newUrl, previousUrl: offer.url });
              console.log(`  🔄 migrated  ${offer.company} | ${offer.title} → ${newUrl}`);
              continue;
            }
          }
        }
        expired.push({ ...offer, reason });
        console.log(`  ❌ expired   ${offer.company} | ${offer.title} (${reason})`);
      } else if (result === 'uncertain' && GUARD_CODES.has(code)) {
        // Guard failures are permanent (not transient like a timeout) — record them
        // separately so they don't end up in pipeline.md but DO appear in scan-history
        // with a precise status, dedup-blocking them on subsequent scans.
        invalid.push({ ...offer, code, reason });
        console.log(`  ⛔ invalid   ${offer.company} | ${offer.title} (${reason})`);
      } else if (result === 'uncertain' && code === 'no_apply_control') {
        // Page loaded but classifier could not find an Apply control. Treat like
        // expired for routing — drop from pipeline AND record in scan-history so
        // we don't burn a verify cycle on the same URL next scan.
        dropped.push({ ...offer, reason });
        console.log(`  ⚠️ no-apply  ${offer.company} | ${offer.title} (${reason})`);
      } else {
        // 'active' or 'uncertain' due to navigation_error (transient — retry next scan)
        verified.push(offer);
        const icon = result === 'active' ? '✅' : '⚠️';
        console.log(`  ${icon} ${result.padEnd(9)} ${offer.company} | ${offer.title}`);
      }

      const wait = i < offers.length - 1 ? jitteredDelayMs(throttleBaseMs) : 0;
      if (wait) await sleep(wait);
    }
  } finally {
    if (headed) await headed.close();
    await browser.close();
  }

  return { verified, expired, dropped, invalid, migrated };
}

// Stable codes from liveness-browser's up-front URL guard. Routing dispatches
// on these codes (not on regex over reason strings) so wording can change
// without breaking the pipeline.
const GUARD_CODES = new Set(['invalid_url', 'unsupported_protocol', 'blocked_host']);

// guardStatusFor maps a guard code to the canonical scan-history status string.
function guardStatusFor(code) {
  if (code === 'blocked_host') return 'skipped_blocked_host';
  // invalid_url and unsupported_protocol both surface as malformed input
  return 'skipped_invalid_url';
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verify = args.includes('--verify');
  // Opt-in: on an anti-bot challenge (e.g. pracuj.pl Cloudflare wall), retry the
  // URL in a headed browser. Off by default — headed Chromium needs a display, so
  // scheduled/unattended scans should not rely on it.
  const headedFallback = args.includes('--headed-fallback');
  // --throttle or --throttle=<ms>: jittered gap between --verify checks to stay
  // under rate-based WAF limits (pracuj.pl flags the session after a few rapid
  // hits). Default base 5000ms. Off by default — most ATS feeds don't need it.
  const throttleArg = args.find((a) => a === '--throttle' || a.startsWith('--throttle='));
  const throttleBaseMs = throttleArg ? (Number(throttleArg.split('=')[1]) || 5000) : 0;
  // --rediscover-404: when a tracked company's URL 404/410s, search for the
  // moved role and re-verify before marking it expired. Opt-in; rides on --verify.
  const rediscover = args.includes('--rediscover-404');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Load providers
  const providers = await loadProviders(PROVIDERS_DIR);
  if (providers.size === 0) {
    console.error('Error: no providers loaded from providers/');
    process.exit(1);
  }

  // 2. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  let rawConfig;
  try {
    rawConfig = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Error: failed to parse ${PORTALS_PATH}: ${err.message}`);
    process.exit(1);
  }
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const companies = Array.isArray(config.tracked_companies) ? config.tracked_companies : [];
  const boards = Array.isArray(config.job_boards) ? config.job_boards : [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const salaryFilter = buildSalaryFilter(config.salary_filter);

  // 3. Resolve a provider for each enabled company / board
  const targets = [];
  let skippedCount = 0;
  let boardCount = 0;
  const resolveErrors = [];
  const agentHandoff = [];

  /**
   * Processes a list of configuration entries, resolves their appropriate data providers,
   * and appends valid entries to the global scanning targets list.
   * @param {Array<{ name?: string, enabled?: boolean, [key: string]: unknown }>} entries - List of entries.
   * @param {{ isBoard?: boolean }} [options={}] - Configuration options.
   */
  function resolveEntries(entries, { isBoard = false } = {}) {
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.enabled === false) continue;
      if (typeof entry.name !== 'string' || !entry.name.trim()) {
        console.error(`⚠️  Skipping entry — missing or non-string 'name' field: ${JSON.stringify(entry)}`);
        continue;
      }
      if (filterCompany && !entry.name.toLowerCase().includes(filterCompany)) continue;
      
      const resolved = resolveProvider(entry, providers);
      if (!resolved) {
        skippedCount++;
        if (entry.scan_method === 'websearch') {
          agentHandoff.push({
            company: entry.name,
            method: 'websearch',
            query: entry.scan_query || entry.search_query || entry.careers_url || '',
          });
        }
        continue;
      }
      
      if (resolved.error) { 
        resolveErrors.push({ company: entry.name, error: resolved.error }); 
        continue; 
      }
      
      targets.push({ ...entry, _provider: resolved.provider, _isBoard: isBoard });
      if (isBoard) boardCount++;
    }
  }

  resolveEntries(companies);
  resolveEntries(boards, { isBoard: true });

  const localParserCount = targets.filter(t => t._provider.id === 'local-parser').length;
  const companyCount = targets.length - boardCount;
  const parts = [`${companyCount} companies`];
  if (boardCount > 0) parts.push(`${boardCount} job boards`);
  parts.push(`${localParserCount} local parser`);
  parts.push(`${skippedCount} skipped — no provider matched`);
  console.log(`Scanning ${parts.join('; ')} via providers`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 4. Load dedup sets
  const historyPolicy = scanHistoryPolicy(config);
  const seenUrlState = loadSeenUrls(historyPolicy);
  const seenUrls = seenUrlState.seen;
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 5. Fetch from each target
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFilteredTitle = 0;
  let totalFilteredLocation = 0;
  let totalFilteredSalary = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [...resolveErrors];

  // Filter observability: every rejection is counted per source and sampled to
  // data/parser-output/filter-log-<date>.tsv (gitignored) so false negatives —
  // good roles killed by a filter keyword — can actually be audited. Before
  // this, a 90%+ title kill rate was a single opaque counter.
  const sourceStats = new Map();
  const rejectSamples = [];
  const REJECT_SAMPLE_CAP = 10000;
  const statFor = (source) => {
    if (!sourceStats.has(source)) {
      sourceStats.set(source, { found: 0, kept: 0, title: 0, location: 0, salary: 0, dup: 0 });
    }
    return sourceStats.get(source);
  };
  const recordReject = (source, job, reason) => {
    statFor(source)[reason]++;
    if (rejectSamples.length < REJECT_SAMPLE_CAP) {
      const clean = (s) => String(s || '').replace(/[\t\n\r]+/g, ' ').trim();
      rejectSamples.push(
        `${clean(source)}\t${clean(reason)}\t${clean(job.title)}\t${clean(job.company)}\t${clean(job.location)}\t${clean(job.url)}`
      );
    }
  };

  // Persist a captured JD for offers we KEEP (scrapers attach `description`;
  // some aggregators like Careerjet do too) and reference it offline via
  // local:jds/. Matters double for aggregators: their tracking-wrapper URLs
  // (jobviewtrack.com) rot within days, so the JD text is often the only
  // durable evaluation source. Skipped on dry-run to honor the no-write
  // contract. The canonical url stays on the offer for dedup/verify/history.
  const jdUsedNames = new Set(); // de-dup JD filenames across all offers this scan
  const persistJd = (offer, job, srcLabel) => {
    if (dryRun || !job.description) return;
    const file = jdFilename(job, jdUsedNames);
    try {
      if (!existsSync(JDS_DIR)) mkdirSync(JDS_DIR, { recursive: true });
      writeFileSync(path.join(JDS_DIR, file), renderJd(job), 'utf-8');
      offer.pipelineUrl = `local:jds/${file}`;
    } catch (err) {
      console.error(`⚠️  ${srcLabel}: could not write jds/${file} — ${err.message}`);
    }
  };

  const tasks = targets.map(company => async () => {
    let provider = company._provider;
    const ctx = makeHttpCtx();
    let sourceName = provider.id === 'local-parser' ? 'local-parser' : `${provider.id}-api`;
    try {
      let jobs;
      try {
        jobs = await provider.fetch(company, ctx);
      } catch (parserErr) {
        if (provider.id !== 'local-parser') throw parserErr;
        const fallback = resolveProvider(company, providers, { skipIds: ['local-parser'] });
        if (!fallback || fallback.error) throw parserErr;
        provider = fallback.provider;
        sourceName = `${provider.id}-api`;
        jobs = await provider.fetch(company, ctx);
        errors.push({
          company: company.name,
          error: `local parser failed, used API fallback: ${parserErr.message}`,
        });
      }
      if (!Array.isArray(jobs)) {
        throw new Error(`${provider.id}: fetch() did not return an array`);
      }
      totalFound += jobs.length;

      for (const job of jobs) {
        statFor(sourceName).found++;
        if (!titleFilter(job.title)) {
          totalFilteredTitle++;
          recordReject(sourceName, job, 'title');
          continue;
        }
        if (!locationFilter(job.location)) {
          totalFilteredLocation++;
          recordReject(sourceName, job, 'location');
          continue;
        }
        if (!salaryFilter(job.salary)) {
          totalFilteredSalary++;
          recordReject(sourceName, job, 'salary');
          continue;
        }
        const canonUrl = canonicalizeUrl(job.url);
        if (seenUrls.has(canonUrl)) {
          totalDupes++;
          recordReject(sourceName, job, 'dup');
          continue;
        }
        const key = companyRoleKey(job.company, job.title);
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          recordReject(sourceName, job, 'dup');
          continue;
        }
        statFor(sourceName).kept++;
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(canonUrl);
        seenCompanyRoles.add(key);
        // Tag with the company's careers domain so verify can offer a 404/410
        // rediscovery fallback. A null domain (no careers_url) marks the offer
        // as broad-discovery — ineligible for the fallback, per the issue scope.
        const careersUrlDomain = extractCareersUrlDomain(company.careers_url);
        const offer = {
          ...job,
          source: sourceName,
          tracked: Boolean(careersUrlDomain),
          careersUrlDomain,
        };
        persistJd(offer, job, sourceName);
        newOffers.push(offer);
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5b. Aggregator phase — query-based sources (Adzuna / Arbeitnow / JSearch).
  // One query → jobs from many employers. Results feed the SAME title/location
  // filters and dedup sets as tracked companies, so an aggregator hit and an ATS
  // hit for the same role collapse to one. Skipped when --company is set (that
  // flag targets a single tracked company).
  const apiCallCounts = new Map();
  const usageMonth = date.slice(0, 7);
  let aggregatorsPolled = 0;
  const aggregators =
    !filterCompany && config.aggregators && typeof config.aggregators === 'object'
      ? config.aggregators
      : {};

  const aggregatorTasks = [];
  for (const [aggId, aggConfig] of Object.entries(aggregators)) {
    if (!aggConfig || typeof aggConfig !== 'object') continue;
    if (aggConfig.enabled === false) continue;
    const provider = providers.get(aggId);
    if (!provider) {
      console.error(`⚠️  aggregator "${aggId}" — no provider loaded; skipping`);
      continue;
    }
    // Monthly-cap guard — protects free-tier quotas (e.g. JSearch ~200/mo).
    const cap = Number(aggConfig.monthly_cap);
    if (Number.isFinite(cap) && cap > 0) {
      const used = getMonthlyCount(aggId, usageMonth);
      if (used >= cap) {
        console.error(`⚠️  ${aggId}: monthly cap reached (${used}/${cap}) — skipping this scan`);
        continue;
      }
    }
    aggregatorsPolled++;
    const descriptor = {
      name: aggId,
      positive: config.title_filter?.positive || [],
      location: {
        country: aggConfig.country,
        where: aggConfig.where,
        allow: config.location_filter?.allow || [],
        block: config.location_filter?.block || [],
        always_allow: config.location_filter?.always_allow || [],
      },
      config: aggConfig,
    };
    aggregatorTasks.push(async () => {
      const ctx = makeHttpCtx(apiCallCounts);
      try {
        const jobs = await provider.fetch(descriptor, ctx);
        if (!Array.isArray(jobs)) {
          throw new Error(`${aggId}: fetch() did not return an array`);
        }
        totalFound += jobs.length;
        for (const job of jobs) {
          if (!job || typeof job.url !== 'string' || !job.url) continue;
          statFor(aggId).found++;
          if (!titleFilter(job.title || '')) { totalFilteredTitle++; recordReject(aggId, job, 'title'); continue; }
          if (!locationFilter(job.location)) { totalFilteredLocation++; recordReject(aggId, job, 'location'); continue; }
          const canonUrl = canonicalizeUrl(job.url);
          if (seenUrls.has(canonUrl)) { totalDupes++; recordReject(aggId, job, 'dup'); continue; }
          const key = companyRoleKey(job.company, job.title);
          if (seenCompanyRoles.has(key)) { totalDupes++; recordReject(aggId, job, 'dup'); continue; }
          seenUrls.add(canonUrl);
          seenCompanyRoles.add(key);
          statFor(aggId).kept++;
          const offer = { ...job, source: aggId };
          persistJd(offer, job, aggId);
          newOffers.push(offer);
        }
      } catch (err) {
        errors.push({ company: `aggregator:${aggId}`, error: err.message });
      }
    });
  }
  if (aggregatorTasks.length > 0) {
    await parallelFetch(aggregatorTasks, CONCURRENCY);
  }

  // 5c. Scraper phase — query-based sources that SCRAPE boards (LinkedIn/Indeed/
  // Google via JobSpy) instead of calling a vendor API (docs/adr/0002). Siblings
  // of the aggregators: results feed the SAME title/location filters and dedup
  // sets, so a scraped hit and an ATS/aggregator hit for the same role collapse
  // to one. A scraper carries its OWN search_terms (kept separate from
  // title_filter.positive — broad single tokens belong in the filter, not the
  // search). No quota/usage ledger (scraping is free). Skipped when --company is
  // set. dryRun is threaded so providers can skip side-effects (e.g. writing JDs).
  let scrapersPolled = 0;
  const scrapers =
    !filterCompany && config.scrapers && typeof config.scrapers === 'object'
      ? config.scrapers
      : {};

  const scraperTasks = [];
  for (const [scrId, scrConfig] of Object.entries(scrapers)) {
    if (!scrConfig || typeof scrConfig !== 'object') continue;
    if (scrConfig.enabled === false) continue;
    const provider = providers.get(scrId);
    if (!provider) {
      console.error(`⚠️  scraper "${scrId}" — no provider loaded; skipping`);
      continue;
    }
    scrapersPolled++;
    const descriptor = {
      name: scrId,
      dryRun,
      location: {
        country: scrConfig.country_indeed,
        where: scrConfig.location,
        allow: config.location_filter?.allow || [],
        block: config.location_filter?.block || [],
        always_allow: config.location_filter?.always_allow || [],
      },
      config: scrConfig,
    };
    scraperTasks.push(async () => {
      // No counts map: scrapers have no metered quota, so recordCall is an inert
      // no-op and the API-usage ledger stays aggregator-only.
      const ctx = makeHttpCtx();
      try {
        const jobs = await provider.fetch(descriptor, ctx);
        if (!Array.isArray(jobs)) {
          throw new Error(`${scrId}: fetch() did not return an array`);
        }
        totalFound += jobs.length;
        for (const job of jobs) {
          if (!job || typeof job.url !== 'string' || !job.url) continue;
          // Per-board granularity (jobspy:linkedin vs jobspy:indeed) — the boards
          // have very different noise profiles, so lumping them hides which one
          // a filter problem lives on.
          const scrSource = job.site ? `${scrId}:${job.site}` : scrId;
          statFor(scrSource).found++;
          if (!titleFilter(job.title || '')) { totalFilteredTitle++; recordReject(scrSource, job, 'title'); continue; }
          if (!locationFilter(job.location)) { totalFilteredLocation++; recordReject(scrSource, job, 'location'); continue; }
          const canonUrl = canonicalizeUrl(job.url);
          if (seenUrls.has(canonUrl)) { totalDupes++; recordReject(scrSource, job, 'dup'); continue; }
          const key = companyRoleKey(job.company, job.title);
          if (seenCompanyRoles.has(key)) { totalDupes++; recordReject(scrSource, job, 'dup'); continue; }
          seenUrls.add(canonUrl);
          seenCompanyRoles.add(key);
          statFor(scrSource).kept++;
          // `board` (job.site, e.g. linkedin/indeed) rides along so the summary
          // can break a scraper's contribution down per board.
          const offer = { title: job.title, url: job.url, company: job.company, location: job.location, source: scrId, board: job.site };
          persistJd(offer, job, scrId);
          newOffers.push(offer);
        }
      } catch (err) {
        errors.push({ company: `scraper:${scrId}`, error: err.message });
      }
    });
  }
  // Scrapers run sequentially against the same home IP inside each provider;
  // run the providers themselves sequentially too (concurrency 1) so two
  // scrapers can't hammer overlapping boards at once.
  if (scraperTasks.length > 0) {
    await parallelFetch(scraperTasks, 1);
  }

  // 5.5. Optional liveness verification — drop expired and guard-rejected postings
  let verifiedOffers = newOffers;
  let expiredOffers = [];
  let droppedOffers = [];
  let invalidOffers = [];
  let migratedOffers = [];
  if (verify && newOffers.length > 0) {
    console.log(`\nVerifying liveness of ${newOffers.length} new offer(s) with Playwright (sequential)...`);
    const result = await verifyOffers(newOffers, { headedFallback, throttleBaseMs, rediscover });
    verifiedOffers = result.verified;
    expiredOffers = result.expired;
    droppedOffers = result.dropped;
    invalidOffers = result.invalid;
    migratedOffers = result.migrated;
    // Migrated offers re-enter the pipeline at their newly discovered URL.
    if (migratedOffers.length > 0) {
      verifiedOffers = [...verifiedOffers, ...migratedOffers];
    }
  }

  // 5.6. Pre-triage scoring — cheap heuristic grade (A/B/C) per offer so the
  // pipeline can be worked best-first. Never blocks a scan: scoring failures
  // just leave offers unannotated.
  if (verifiedOffers.length > 0) {
    try {
      const { scoreOffer, formatPre } = await import('./triage-score.mjs');
      for (const o of verifiedOffers) {
        o.preScore = formatPre(scoreOffer(o, config));
      }
    } catch (err) {
      console.error(`⚠️  pre-triage scoring unavailable: ${err.message}`);
    }
  }

  // 6. Write results
  if (!dryRun && verifiedOffers.length > 0) {
    appendToPipeline(verifiedOffers);
    appendToScanHistory(verifiedOffers, date);
  }
  // Expired postings — plus the old URLs of migrated offers — are recorded as
  // skipped_expired so subsequent scans dedup-skip the dead URLs.
  const expiredForHistory = [
    ...expiredOffers,
    ...migratedOffers.map(o => ({ ...o, url: o.previousUrl })),
  ];
  if (!dryRun && expiredForHistory.length > 0) {
    appendToScanHistory(expiredForHistory, date, 'skipped_expired');
  }
  // Pages that loaded but had no Apply control: record so we don't re-verify
  // them next scan, but never let them reach pipeline.md.
  if (!dryRun && droppedOffers.length > 0) {
    appendToScanHistory(droppedOffers, date, 'skipped_no_apply_control');
  }
  // Guard-rejected URLs (invalid / unsupported protocol / blocked host) are
  // recorded with a precise status so subsequent scans dedup-skip them via
  // loadSeenUrls, but they never reach pipeline.md.
  if (!dryRun && invalidOffers.length > 0) {
    // Group by code so the TSV reflects the actual reason category.
    const byStatus = new Map();
    for (const o of invalidOffers) {
      const status = guardStatusFor(o.code);
      if (!byStatus.has(status)) byStatus.set(status, []);
      byStatus.get(status).push(o);
    }
    for (const [status, group] of byStatus) {
      appendToScanHistory(group, date, status);
    }
  }

  // 6c. Persist filter-rejection samples so false negatives can be audited
  // (data/parser-output/ is gitignored). Overwritten per run — it documents
  // the LAST scan of the day, which is what a filter-tuning session needs.
  if (!dryRun && rejectSamples.length > 0) {
    try {
      const dir = path.join('data', 'parser-output');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, `filter-log-${date}.tsv`),
        'source\treason\ttitle\tcompany\tlocation\turl\n' + rejectSamples.join('\n') + '\n',
        'utf-8',
      );
    } catch (err) {
      console.error(`⚠️  could not write filter log: ${err.message}`);
    }
  }

  // 6b. Flush aggregator API usage into the monthly ledger (skip on dry-run —
  // dry-run makes no file writes, matching tracked-company behavior).
  if (!dryRun && apiCallCounts.size > 0) {
    try {
      addUsage(apiCallCounts, usageMonth);
    } catch (err) {
      console.error(`⚠️  could not update API usage ledger: ${err.message}`);
    }
  }

  // 7. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  const summaryCompanies = targets.filter(t => !t._isBoard).length;
  const summaryBoards = targets.filter(t => t._isBoard).length;
  console.log(`Companies scanned:     ${summaryCompanies}`);
  if (summaryBoards > 0) console.log(`Job boards scanned:    ${summaryBoards}`);
  if (aggregatorsPolled > 0) console.log(`Aggregators polled:    ${aggregatorsPolled}`);
  if (scrapersPolled > 0) console.log(`Scrapers polled:       ${scrapersPolled}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFilteredTitle} removed`);
  console.log(`Filtered by location:  ${totalFilteredLocation} removed`);
  console.log(`Filtered by salary:   ${totalFilteredSalary} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  if (historyPolicy.recheckAfterDays != null) {
    console.log(`Recheck eligible:      ${seenUrlState.recheckEligible} old scan-history URL(s)`);
  }
  if (verify) {
    console.log(`Expired (verified):    ${expiredOffers.length} dropped`);
    console.log(`Rediscovered (moved):  ${migratedOffers.length} migrated`);
    console.log(`No apply control:      ${droppedOffers.length} dropped`);
    console.log(`Invalid (guarded):     ${invalidOffers.length} dropped`);
  }
  if (apiCallCounts.size > 0) {
    const parts = [...apiCallCounts.entries()].map(([s, n]) => `${s} ${n}`).join(', ');
    console.log(`Aggregator API calls:  ${parts}`);
  }
  console.log(`New offers added:      ${verifiedOffers.length}`);

  // Per-source funnel: where jobs come from and which filter eats them. A
  // 90% title kill on one source is a tuning signal (query too broad or
  // filter too strict); the same number across all sources is just noise floor.
  if (sourceStats.size > 0) {
    console.log(`\nSource funnel (found → kept | rejected by):`);
    const funnel = [...sourceStats.entries()].sort((a, b) => b[1].found - a[1].found);
    for (const [src, s] of funnel) {
      const rejects = [
        s.title ? `title ${s.title}` : null,
        s.location ? `loc ${s.location}` : null,
        s.salary ? `salary ${s.salary}` : null,
        s.dup ? `dup ${s.dup}` : null,
      ].filter(Boolean).join(', ');
      console.log(`  ${src.padEnd(18)} ${String(s.found).padStart(5)} → ${String(s.kept).padStart(3)}${rejects ? `  (${rejects})` : ''}`);
    }
  }

  // Per-source breakdown of added offers (tracked-company providers + aggregators
  // + scrapers). Scraper sources carry a `board` (e.g. linkedin/indeed), so their
  // line gets an indented per-board sub-tree.
  if (verifiedOffers.length > 0) {
    const bySource = new Map();
    const byBoard = new Map(); // source -> Map(board -> count)
    for (const o of verifiedOffers) {
      const s = o.source || 'unknown';
      bySource.set(s, (bySource.get(s) || 0) + 1);
      if (o.board) {
        if (!byBoard.has(s)) byBoard.set(s, new Map());
        const bm = byBoard.get(s);
        bm.set(o.board, (bm.get(o.board) || 0) + 1);
      }
    }
    const sources = [...bySource.entries()].sort((a, b) => b[1] - a[1]);
    sources.forEach(([s, n], i) => {
      const last = i === sources.length - 1;
      console.log(`  ${last ? '└─' : '├─'} ${s.padEnd(16)} ${n}`);
      const boards = byBoard.get(s);
      if (boards) {
        const cont = last ? '   ' : '│  ';
        const entries = [...boards.entries()].sort((a, b) => b[1] - a[1]);
        entries.forEach(([b, bn], j) => {
          console.log(`  ${cont} ${j === entries.length - 1 ? '└─' : '├─'} ${b.padEnd(13)} ${bn}`);
        });
      }
    });
  }

  if (agentHandoff.length > 0) {
    console.log(`Agent/WebSearch handoff: ${agentHandoff.length} compan${agentHandoff.length === 1 ? 'y' : 'ies'} not handled by zero-token providers`);
    for (const item of agentHandoff.slice(0, 25)) {
      const hint = item.query ? ` — ${item.query}` : '';
      console.log(`  • ${item.company} (${item.method})${hint}`);
    }
    if (agentHandoff.length > 25) {
      console.log(`  … ${agentHandoff.length - 25} more omitted; narrow with --company or inspect portals.yml`);
    }
  }

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (verifiedOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of verifiedOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

// Only run main() when invoked directly (`node scan.mjs`), not when imported by tests.
// `|| ''` guards the case where Node is invoked without a script arg (e.g. `node -e`).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
