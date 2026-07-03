#!/usr/bin/env node

/**
 * scan-ab-linkedin-auth.mjs — A/B/C harness: jobspy-LinkedIn (A) vs native
 * guest-API (B) vs AUTHENTICATED browser scraper (C).
 *
 * The decision gate for whether the authed provider (providers/linkedin-auth.mjs)
 * earns a slot in the scanner, and at what cadence given its ban risk. It runs
 * ALL THREE providers over the SAME queries / geo / time-window, applies the SAME
 * title+location filter and canonical-URL + company-role dedup that scan.mjs uses,
 * and emits a three-way comparison plus the metrics that justify authed at all:
 *
 *   rows kept (precision) · A∩B∩C overlap and per-source UNIQUE slice ·
 *   freshness · postedAt coverage · avg pre-triage score ·
 *   SALARY coverage · APPLICANT coverage · Easy-Apply coverage ·
 *   checkpoint/429 count · wall-clock.
 *
 * C is the differentiator only if it adds a real unique slice OR materially
 * higher salary/applicant coverage; otherwise the keep-both pair (A+B) already
 * covers discovery and authed isn't worth the account risk.
 *
 * Usage:
 *   node scan-ab-linkedin-auth.mjs
 *   node scan-ab-linkedin-auth.mjs --geo "Netherlands" --window-hours 168 --cap 50
 *   node scan-ab-linkedin-auth.mjs --queries "AI Engineer,Machine Learning Engineer"
 *   node scan-ab-linkedin-auth.mjs --no-jd          # skip JD/detail fetch (faster)
 *   node scan-ab-linkedin-auth.mjs --detail         # force authed detail enrichment on
 *   node scan-ab-linkedin-auth.mjs --out reports/ab-auth.md
 *
 * Requires a captured session for C: run `node linkedin-login.mjs` first. If no
 * session exists, C returns nothing and the report says so (A/B still compared).
 * Network + browser heavy — run deliberately, not on a schedule.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import {
  buildTitleFilter,
  buildLocationFilter,
  canonicalizeUrl,
  companyRoleKey,
} from './scan.mjs';
import { makeHttpCtx } from './providers/_http.mjs';
import jobspyProvider from './providers/jobspy.mjs';
import linkedinGuestProvider from './providers/linkedin-guest.mjs';
import linkedinAuthProvider from './providers/linkedin-auth.mjs';
import { hasValidStorageState } from './providers/linkedin-auth.mjs';
import { scoreOffer } from './triage-score.mjs';

const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';
const DAY_MS = 86_400_000;

// ── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-jd') out.noJd = true;
    else if (a === '--detail') out.detail = true;
    else if (a === '--geo') out.geo = argv[++i];
    else if (a === '--window-hours') out.windowHours = Number(argv[++i]);
    else if (a === '--cap') out.cap = Number(argv[++i]);
    else if (a === '--delay-ms') out.delayMs = Number(argv[++i]);
    else if (a === '--daily-cap') out.dailyCap = Number(argv[++i]);
    else if (a === '--queries') out.queries = argv[++i];
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

// ── Filters + dedup (identical to scan.mjs / scan-ab-linkedin.mjs) ────────────

function applyScannerFilters(jobs, titleFilter, locationFilter) {
  const kept = [];
  const keys = new Set();
  const canonUrls = new Set();
  const seenUrl = new Set();
  const seenRole = new Set();
  let byTitle = 0;
  let byLocation = 0;
  let dupUrl = 0;
  let dupRole = 0;
  for (const j of jobs) {
    if (!j || typeof j.url !== 'string' || !j.url) continue;
    if (!titleFilter(j.title || '')) { byTitle++; continue; }
    if (!locationFilter(j.location)) { byLocation++; continue; }
    const cu = canonicalizeUrl(j.url);
    if (seenUrl.has(cu)) { dupUrl++; continue; }
    const key = companyRoleKey(j.company, j.title);
    if (seenRole.has(key)) { dupRole++; continue; }
    seenUrl.add(cu);
    seenRole.add(key);
    keys.add(key);
    canonUrls.add(cu);
    kept.push(j);
  }
  return { kept, byTitle, byLocation, dupUrl, dupRole, keys, canonUrls };
}

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function scoreSide(kept, source, config) {
  if (kept.length === 0) return { avg: 0 };
  let sum = 0;
  for (const j of kept) {
    const offer = {
      title: j.title,
      location: j.location,
      company: j.company,
      url: j.url,
      pipelineUrl: j.description ? 'local:jds/ab.md' : j.url,
      description: j.description || '',
      source,
    };
    sum += scoreOffer(offer, config).score;
  }
  return { avg: sum / kept.length };
}

function summarize(side, raw, filtered, scoreParts, now) {
  const kept = filtered.kept;
  const withPosted = kept.map((j) => j.postedAt).filter((t) => Number.isFinite(t));
  const withJd = kept.filter((j) => String(j.description || '').trim()).length;
  const withSalary = kept.filter((j) => String(j.salary || '').trim()).length;
  const withApplicants = kept.filter((j) => Number.isFinite(j.applicantCount)).length;
  const withEasyApply = kept.filter((j) => j.easyApply === true).length;
  return {
    side,
    fetched: raw.length,
    kept: kept.length,
    precision: raw.length > 0 ? kept.length / raw.length : 0,
    rejTitle: filtered.byTitle,
    rejLocation: filtered.byLocation,
    dupUrl: filtered.dupUrl,
    dupRole: filtered.dupRole,
    uniqueUrls: filtered.canonUrls.size,
    postedCoverage: kept.length > 0 ? withPosted.length / kept.length : 0,
    ageDaysMedian: withPosted.length > 0 ? median(withPosted.map((t) => (now - t) / DAY_MS)) : null,
    jdCoverage: kept.length > 0 ? withJd / kept.length : 0,
    salaryCoverage: kept.length > 0 ? withSalary / kept.length : 0,
    applicantCoverage: kept.length > 0 ? withApplicants / kept.length : 0,
    easyApplyCoverage: kept.length > 0 ? withEasyApply / kept.length : 0,
    avgScore: scoreParts.avg,
    keys: filtered.keys,
  };
}

// Count warnings / 429s / checkpoints a provider logs during its run.
async function runCounting(fn) {
  const origErr = console.error;
  const origWarn = console.warn;
  let warnings = 0;
  let rateLimited = 0;
  let checkpoints = 0;
  const tap = (orig) => (...args) => {
    const line = args.join(' ');
    warnings++;
    if (/\b429\b|rate.?limit/i.test(line)) rateLimited++;
    if (/checkpoint|authwall|login.?wall/i.test(line)) checkpoints++;
    orig(...args);
  };
  console.error = tap(origErr);
  console.warn = tap(origWarn);
  const startedAt = Date.now();
  let jobs = [];
  let threw = null;
  try {
    jobs = await fn();
  } catch (err) {
    threw = err;
  } finally {
    console.error = origErr;
    console.warn = origWarn;
  }
  return {
    jobs: Array.isArray(jobs) ? jobs : [],
    ms: Date.now() - startedAt,
    warnings,
    rateLimited,
    checkpoints,
    threw,
  };
}

// ── Report ─────────────────────────────────────────────────────────────────────

const fmtPct = (x) => `${(x * 100).toFixed(0)}%`;
const fmtAge = (d) => (d == null ? 'n/a' : `${d.toFixed(1)}d`);
const fmtMs = (ms) => `${(ms / 1000).toFixed(1)}s`;

function buildReport({ params, a, b, c, runA, runB, runC, overlap, sessionOk, verdict }) {
  const rows = [
    ['metric', 'A: jobspy', 'B: guest', 'C: authed'],
    ['rows fetched', a.fetched, b.fetched, c.fetched],
    ['rows kept (after filters)', a.kept, b.kept, c.kept],
    ['precision (kept/fetched)', fmtPct(a.precision), fmtPct(b.precision), fmtPct(c.precision)],
    ['  rejected: title', a.rejTitle, b.rejTitle, c.rejTitle],
    ['  dup (url / role)', `${a.dupUrl}/${a.dupRole}`, `${b.dupUrl}/${b.dupRole}`, `${c.dupUrl}/${c.dupRole}`],
    ['unique canonical URLs', a.uniqueUrls, b.uniqueUrls, c.uniqueUrls],
    ['freshness median (age)', fmtAge(a.ageDaysMedian), fmtAge(b.ageDaysMedian), fmtAge(c.ageDaysMedian)],
    ['  postedAt coverage', fmtPct(a.postedCoverage), fmtPct(b.postedCoverage), fmtPct(c.postedCoverage)],
    ['JD coverage', fmtPct(a.jdCoverage), fmtPct(b.jdCoverage), fmtPct(c.jdCoverage)],
    ['SALARY coverage', fmtPct(a.salaryCoverage), fmtPct(b.salaryCoverage), fmtPct(c.salaryCoverage)],
    ['APPLICANT coverage', fmtPct(a.applicantCoverage), fmtPct(b.applicantCoverage), fmtPct(c.applicantCoverage)],
    ['Easy-Apply coverage', fmtPct(a.easyApplyCoverage), fmtPct(b.easyApplyCoverage), fmtPct(c.easyApplyCoverage)],
    ['avg pre-triage score', a.avgScore.toFixed(1), b.avgScore.toFixed(1), c.avgScore.toFixed(1)],
    ['warnings (429 / checkpoint)', `${runA.warnings} (${runA.rateLimited}/${runA.checkpoints})`, `${runB.warnings} (${runB.rateLimited}/${runB.checkpoints})`, `${runC.warnings} (${runC.rateLimited}/${runC.checkpoints})`],
    ['wall-clock', fmtMs(runA.ms), fmtMs(runB.ms), fmtMs(runC.ms)],
  ];
  const widths = [0, 1, 2, 3].map((c2) => Math.max(...rows.map((r) => String(r[c2]).length)));
  const line = (r) =>
    `| ${String(r[0]).padEnd(widths[0])} | ${String(r[1]).padStart(widths[1])} | ${String(r[2]).padStart(widths[2])} | ${String(r[3]).padStart(widths[3])} |`;
  const sep = `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`;

  const md = [];
  md.push('# LinkedIn A/B/C — jobspy vs guest vs authenticated');
  md.push('');
  md.push(`**Run:** ${params.date}`);
  md.push(`**Queries:** ${params.queries.map((q) => `\`${q}\``).join(', ')}`);
  md.push(`**Geo:** ${params.geo} · **Window:** ${params.windowHours}h · **Cap/query:** ${params.cap} · **JD/detail:** ${params.noJd ? 'off' : 'on'}`);
  if (!sessionOk) {
    md.push('');
    md.push('> ⚠️ **C (authed) had no valid session** — run `node linkedin-login.mjs` first. C columns are empty; A/B comparison still valid.');
  }
  md.push('');
  md.push(line(rows[0]));
  md.push(sep);
  for (const r of rows.slice(1)) md.push(line(r));
  md.push('');
  md.push('**Cross-source overlap (by company-role key):**');
  md.push('');
  md.push(`- in all three (A∩B∩C): **${overlap.all}**`);
  md.push(`- A-only: ${overlap.aOnly} · B-only: ${overlap.bOnly} · **C-only (authed catches the other two miss): ${overlap.cOnly}**`);
  md.push(`- covered by A∪B (keep-both pair): ${overlap.abUnion} · added by C on top of A∪B: **${overlap.cAddsOverAB}**`);
  if (overlap.cOnlyExamples.length) {
    md.push('');
    md.push('**C-only kept roles (authed-exclusive):**');
    for (const ex of overlap.cOnlyExamples) md.push(`- ${ex}`);
  }
  md.push('');
  md.push('## Verdict');
  md.push('');
  md.push(verdict);
  md.push('');
  return md.join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let config = {};
  try {
    config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  } catch {
    console.error(`⚠️  could not read ${PORTALS_PATH} — using built-in defaults`);
  }

  const guestCfg = config.scrapers?.['linkedin-guest'] || {};
  const authCfg = config.scrapers?.['linkedin-auth'] || {};
  const queries = (args.queries
    ? args.queries.split(',').map((s) => s.trim()).filter(Boolean)
    : Array.isArray(guestCfg.queries) && guestCfg.queries.length
      ? guestCfg.queries
      : ['AI Engineer', 'Machine Learning Engineer', 'LLM Engineer']
  ).slice(0, 4); // keep the harness gentle on LinkedIn

  const geoWhere = args.geo
    || (Array.isArray(guestCfg.geos) && guestCfg.geos[0]
      ? (typeof guestCfg.geos[0] === 'string' ? guestCfg.geos[0] : guestCfg.geos[0].where)
      : 'Netherlands');
  const windowHours = Number.isFinite(args.windowHours) && args.windowHours > 0
    ? args.windowHours
    : Number(guestCfg.time_window_hours) || 168;
  const cap = Number.isFinite(args.cap) && args.cap > 0 ? args.cap : 50;
  const noJd = Boolean(args.noJd);
  const detail = args.detail != null ? Boolean(args.detail) : authCfg.fetch_description === true;
  const authDelayMs = Number.isFinite(args.delayMs) && args.delayMs > 0
    ? args.delayMs
    : authCfg.delay_ms;
  const authDailyCap = Number.isFinite(args.dailyCap) && args.dailyCap > 0
    ? args.dailyCap
    : authCfg.daily_cap;
  const date = new Date().toISOString().slice(0, 10);

  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);

  const storagePath = (typeof authCfg.storage_state === 'string' && authCfg.storage_state.trim())
    ? authCfg.storage_state.trim()
    : (process.env.LINKEDIN_STORAGE_STATE || 'linkedin-storage-state.json');
  const sessionOk = hasValidStorageState(storagePath);

  console.log(`\nLinkedIn A/B/C harness — ${date}`);
  console.log(`Queries: ${queries.join(' | ')}`);
  console.log(`Geo: ${geoWhere} · Window: ${windowHours}h · Cap/query: ${cap} · JD: ${noJd ? 'off' : 'on'} · C-JD-enrich: ${detail && !noJd ? 'on (guest endpoint)' : 'off'} · C-pace: ${authDelayMs}ms`);
  console.log(`Authed session: ${sessionOk ? `found (${storagePath})` : 'MISSING — C will be empty (run node linkedin-login.mjs)'}\n`);

  // A — jobspy, LinkedIn only.
  console.log('Running A (jobspy-linkedin)…');
  const runA = await runCounting(() =>
    jobspyProvider.fetch(
      { name: 'jobspy', config: {
        location: geoWhere, hours_old: windowHours, linkedin_fetch_description: !noJd,
        sites: [{ name: 'linkedin', results_wanted: cap }], search_terms: queries } },
      makeHttpCtx(),
    ));
  if (runA.threw) console.error(`  A threw: ${runA.threw.message}`);

  // B — native guest-API.
  console.log('Running B (linkedin-guest)…');
  const runB = await runCounting(() =>
    linkedinGuestProvider.fetch(
      { name: 'linkedin-guest', config: {
        queries, geos: [{ where: geoWhere }], f_E: guestCfg.f_E, f_F: guestCfg.f_F,
        time_window_hours: windowHours, results_per_query: cap, fetch_description: !noJd,
        delay_ms: guestCfg.delay_ms } },
      makeHttpCtx(),
    ));
  if (runB.threw) console.error(`  B threw: ${runB.threw.message}`);

  // C — authenticated browser scraper (returns [] if no session).
  console.log('Running C (linkedin-auth)…');
  const runC = await runCounting(() =>
    linkedinAuthProvider.fetch(
      { name: 'linkedin-auth', config: {
        queries, geos: [{ where: geoWhere }], f_E: authCfg.f_E,
        time_window_hours: windowHours, results_per_query: cap,
        fetch_description: detail && !noJd, storage_state: storagePath,
        delay_ms: authDelayMs, daily_cap: authDailyCap, headless: authCfg.headless } },
      makeHttpCtx(),
    ));
  if (runC.threw) console.error(`  C threw: ${runC.threw.message}`);

  const now = Date.now();
  const fA = applyScannerFilters(runA.jobs, titleFilter, locationFilter);
  const fB = applyScannerFilters(runB.jobs, titleFilter, locationFilter);
  const fC = applyScannerFilters(runC.jobs, titleFilter, locationFilter);
  const a = summarize('A', runA.jobs, fA, scoreSide(fA.kept, 'jobspy', config), now);
  const b = summarize('B', runB.jobs, fB, scoreSide(fB.kept, 'linkedin-guest', config), now);
  const c = summarize('C', runC.jobs, fC, scoreSide(fC.kept, 'linkedin-auth', config), now);

  // Three-way overlap on the company-role key.
  const inAB = (k) => fA.keys.has(k) || fB.keys.has(k);
  let all = 0;
  for (const k of fC.keys) if (fA.keys.has(k) && fB.keys.has(k)) all++;
  const abUnion = new Set([...fA.keys, ...fB.keys]).size;
  let cAddsOverAB = 0;
  for (const k of fC.keys) if (!inAB(k)) cAddsOverAB++;
  const overlap = {
    all,
    aOnly: [...fA.keys].filter((k) => !fB.keys.has(k) && !fC.keys.has(k)).length,
    bOnly: [...fB.keys].filter((k) => !fA.keys.has(k) && !fC.keys.has(k)).length,
    cOnly: [...fC.keys].filter((k) => !fA.keys.has(k) && !fB.keys.has(k)).length,
    abUnion,
    cAddsOverAB,
    cOnlyExamples: fC.kept
      .filter((j) => !inAB(companyRoleKey(j.company, j.title)))
      .slice(0, 12)
      .map((j) => `${j.company || '(no company)'} — ${j.title}${j.salary ? ` · 💶 ${j.salary}` : ''}${Number.isFinite(j.applicantCount) ? ` · ${j.applicantCount} applicants` : ''}`),
  };

  // ── Verdict — does authed earn a slot? ─────────────────────────────────────
  let verdict;
  if (!sessionOk) {
    verdict =
      '⚠️ No authed session captured — C did not run. Run `node linkedin-login.mjs` (burner ' +
      'account, headed, on your machine) to capture a session, then re-run this harness. ' +
      'A vs B is unaffected (keep-both stands).';
  } else if (c.kept === 0 || runC.checkpoints > 0) {
    verdict =
      `⛔ C returned ${c.kept} kept` +
      (runC.checkpoints > 0 ? ` and hit ${runC.checkpoints} checkpoint(s)` : '') +
      '. Either the session is stale (re-run linkedin-login.mjs) or the burner is challenged. ' +
      'Do NOT enable linkedin-auth until it pulls cleanly. Keep-both (A+B) stands.';
  } else {
    // Authed's value is DISCOVERY of the unique role tail, not enrichment:
    // LinkedIn's SDUI detail page no longer exposes salary/applicants to scrape,
    // so those columns are honestly ~0 and JD is recovered via the public guest
    // endpoint. The decision rests on how many roles C adds beyond A∪B.
    const discovery = overlap.cAddsOverAB;
    const worthIt = discovery >= 5;
    if (worthIt) {
      verdict =
        `✅ Authed earns a slot as a DISCOVERY source: ${discovery} roles beyond A∪B ` +
        `(keep-both), JD coverage ${fmtPct(c.jdCoverage)} (via the public guest endpoint), ` +
        `freshest of the three (${fmtAge(c.ageDaysMedian)} median), ${runC.checkpoints} checkpoints. ` +
        'Run it as a LOW-FREQUENCY pass (e.g. weekly), NOT every scan, given burner-account ban ' +
        'risk — keep A+B as the every-scan primary. NOTE: salary/applicant counts are NOT scrapeable ' +
        '(SDUI detail page), so authed is a discovery/tail source, not an enrichment one.';
    } else {
      verdict =
        `↔️ Authed does NOT clearly earn its risk: only ${discovery} roles beyond A∪B. ` +
        'The keep-both pair (A+B) already covers discovery, and salary/applicants are not ' +
        'scrapeable from the SDUI detail page, so there is little unique upside. Leave ' +
        'linkedin-auth disabled. Re-run to confirm before deciding.';
    }
  }

  const report = buildReport({
    params: { date, queries, geo: geoWhere, windowHours, cap, noJd },
    a, b, c, runA, runB, runC, overlap, sessionOk, verdict,
  });

  console.log('\n' + report);

  const outPath = args.out || path.join('reports', `ab-linkedin-auth-${date}.md`);
  try {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, report, 'utf-8');
    console.log(`\nReport written to ${outPath}`);
  } catch (err) {
    console.error(`⚠️  could not write report to ${outPath}: ${err.message}`);
  }
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
