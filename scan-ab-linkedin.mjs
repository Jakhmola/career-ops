#!/usr/bin/env node

/**
 * scan-ab-linkedin.mjs — A/B harness: jobspy-LinkedIn (A) vs linkedin-guest (B).
 *
 * The decision gate for cutting LinkedIn discovery over to the native guest-API
 * provider. It runs BOTH providers over the SAME queries / geo / time-window,
 * applies the SAME title+location filter and the SAME canonical-URL +
 * company-role dedup that scan.mjs uses, and emits a before/after comparison:
 *
 *   rows fetched · rows kept after filters (precision) · unique canonical URLs ·
 *   A∩B overlap / A-only / B-only · freshness median · JD coverage % ·
 *   avg pre-triage score (+ component breakdown) · warning/429 count · wall-clock.
 *
 * DECISION: cut over to native B only if it dominates A on relevant-kept with
 * comparable/better freshness at an acceptable warning/429 rate. Until then the
 * jobspy LinkedIn path stays (linkedin-guest ships enabled:false in portals.yml).
 *
 * Usage:
 *   node scan-ab-linkedin.mjs                       # defaults from portals.yml
 *   node scan-ab-linkedin.mjs --geo "Netherlands" --window-hours 168 --cap 50
 *   node scan-ab-linkedin.mjs --queries "AI Engineer,Machine Learning Engineer"
 *   node scan-ab-linkedin.mjs --no-jd               # skip JD fetch (faster, no coverage metric)
 *   node scan-ab-linkedin.mjs --out reports/ab.md   # write the markdown report
 *
 * Reads nothing destructive; writes only the report file. Network-heavy — run
 * deliberately, not on a schedule (LinkedIn rate-limits aggressive polling).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
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
import { scoreOffer } from './triage-score.mjs';

const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';

// ── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-jd') out.noJd = true;
    else if (a === '--geo') out.geo = argv[++i];
    else if (a === '--window-hours') out.windowHours = Number(argv[++i]);
    else if (a === '--cap') out.cap = Number(argv[++i]);
    else if (a === '--queries') out.queries = argv[++i];
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

// ── Metrics helpers ───────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

// Apply the scanner's real filters + dedup to a provider's raw jobs. Returns
// { kept, dropped, byTitle, byLocation, dupUrl, dupRole, keys, canonUrls }.
function applyScannerFilters(jobs, titleFilter, locationFilter) {
  const kept = [];
  const keys = new Set(); // companyRoleKey of kept rows (cross-source identity)
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

// Build the side-summary for a kept set.
function summarize(side, raw, filtered, scoreParts, now) {
  const kept = filtered.kept;
  const withPosted = kept.map((j) => j.postedAt).filter((t) => Number.isFinite(t));
  const ageDaysMedian =
    withPosted.length > 0 ? median(withPosted.map((t) => (now - t) / DAY_MS)) : null;
  const withJd = kept.filter((j) => String(j.description || '').trim()).length;
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
    ageDaysMedian,
    jdCoverage: kept.length > 0 ? withJd / kept.length : 0,
    avgScore: scoreParts.avg,
    parts: scoreParts.parts,
    keys: filtered.keys,
  };
}

// Average pre-triage score + component breakdown for a kept set.
function scoreSide(kept, source, config) {
  if (kept.length === 0) {
    return { avg: 0, parts: { title: 0, location: 0, source: 0, jd: 0, lang: 0 } };
  }
  const sums = { score: 0, title: 0, location: 0, source: 0, jd: 0, lang: 0 };
  for (const j of kept) {
    const offer = {
      title: j.title,
      location: j.location,
      company: j.company,
      url: j.url,
      // local: prefix earns the captured-JD bonus exactly as production would,
      // since both sides persist a local JD for kept rows that carry description.
      pipelineUrl: j.description ? 'local:jds/ab.md' : j.url,
      description: j.description || '',
      source,
    };
    const r = scoreOffer(offer, config);
    sums.score += r.score;
    sums.title += r.parts.title;
    sums.location += r.parts.location;
    sums.source += r.parts.source;
    sums.jd += r.parts.jd;
    sums.lang += r.parts.lang;
  }
  const n = kept.length;
  return {
    avg: sums.score / n,
    parts: {
      title: sums.title / n,
      location: sums.location / n,
      source: sums.source / n,
      jd: sums.jd / n,
      lang: sums.lang / n,
    },
  };
}

// Count warnings/429s a provider logs to console.error during its run.
async function runCounting(fn) {
  const orig = console.error;
  let warnings = 0;
  let rateLimited = 0;
  console.error = (...args) => {
    const line = args.join(' ');
    warnings++;
    if (/\b429\b|rate.?limit/i.test(line)) rateLimited++;
    orig(...args);
  };
  const startedAt = Date.now();
  let jobs = [];
  let threw = null;
  try {
    jobs = await fn();
  } catch (err) {
    threw = err;
  } finally {
    console.error = orig;
  }
  return { jobs: Array.isArray(jobs) ? jobs : [], ms: Date.now() - startedAt, warnings, rateLimited, threw };
}

// ── Report ─────────────────────────────────────────────────────────────────────

function fmtPct(x) { return `${(x * 100).toFixed(0)}%`; }
function fmtAge(d) { return d == null ? 'n/a' : `${d.toFixed(1)}d`; }
function fmtMs(ms) { return `${(ms / 1000).toFixed(1)}s`; }

function buildReport({ params, a, b, runA, runB, overlap, verdict }) {
  const rows = [
    ['metric', 'A: jobspy-linkedin', 'B: linkedin-guest'],
    ['rows fetched', a.fetched, b.fetched],
    ['rows kept (after filters)', a.kept, b.kept],
    ['precision (kept/fetched)', fmtPct(a.precision), fmtPct(b.precision)],
    ['  rejected: title', a.rejTitle, b.rejTitle],
    ['  rejected: location', a.rejLocation, b.rejLocation],
    ['  dup (url / role)', `${a.dupUrl} / ${a.dupRole}`, `${b.dupUrl} / ${b.dupRole}`],
    ['unique canonical URLs', a.uniqueUrls, b.uniqueUrls],
    ['freshness median (age)', fmtAge(a.ageDaysMedian), fmtAge(b.ageDaysMedian)],
    ['  postedAt coverage', fmtPct(a.postedCoverage), fmtPct(b.postedCoverage)],
    ['JD coverage', fmtPct(a.jdCoverage), fmtPct(b.jdCoverage)],
    ['avg pre-triage score', a.avgScore.toFixed(1), b.avgScore.toFixed(1)],
    ['  · title pts', a.parts.title.toFixed(1), b.parts.title.toFixed(1)],
    ['  · location pts', a.parts.location.toFixed(1), b.parts.location.toFixed(1)],
    ['  · source pts', a.parts.source.toFixed(1), b.parts.source.toFixed(1)],
    ['  · jd pts', a.parts.jd.toFixed(1), b.parts.jd.toFixed(1)],
    ['  · lang penalty', a.parts.lang.toFixed(1), b.parts.lang.toFixed(1)],
    ['warnings (of which 429)', `${runA.warnings} (${runA.rateLimited})`, `${runB.warnings} (${runB.rateLimited})`],
    ['wall-clock', fmtMs(runA.ms), fmtMs(runB.ms)],
  ];
  const w0 = Math.max(...rows.map((r) => String(r[0]).length));
  const w1 = Math.max(...rows.map((r) => String(r[1]).length));
  const w2 = Math.max(...rows.map((r) => String(r[2]).length));
  const line = (r) =>
    `| ${String(r[0]).padEnd(w0)} | ${String(r[1]).padStart(w1)} | ${String(r[2]).padStart(w2)} |`;
  const sep = `|${'-'.repeat(w0 + 2)}|${'-'.repeat(w1 + 2)}|${'-'.repeat(w2 + 2)}|`;

  const md = [];
  md.push(`# LinkedIn A/B — jobspy vs native guest-API`);
  md.push('');
  md.push(`**Run:** ${params.date}`);
  md.push(`**Queries:** ${params.queries.map((q) => `\`${q}\``).join(', ')}`);
  md.push(`**Geo:** ${params.geo} · **Window:** ${params.windowHours}h · **Cap/query:** ${params.cap} · **JD fetch:** ${params.noJd ? 'off' : 'on'}`);
  md.push('');
  md.push(line(rows[0]));
  md.push(sep);
  for (const r of rows.slice(1)) md.push(line(r));
  md.push('');
  md.push(`**Cross-source overlap (by company-role key):** A∩B ${overlap.both} · A-only ${overlap.aOnly} · B-only ${overlap.bOnly}`);
  if (overlap.bOnlyExamples.length) {
    md.push('');
    md.push(`**B-only kept roles (native catches that jobspy missed):**`);
    for (const ex of overlap.bOnlyExamples) md.push(`- ${ex}`);
  }
  md.push('');
  md.push(`## Verdict`);
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
  const queries = (args.queries
    ? args.queries.split(',').map((s) => s.trim()).filter(Boolean)
    : Array.isArray(guestCfg.queries) && guestCfg.queries.length
      ? guestCfg.queries
      : ['AI Engineer', 'Machine Learning Engineer', 'LLM Engineer']
  ).slice(0, 4); // keep the harness gentle on LinkedIn's rate limits

  const geoWhere = args.geo
    || (Array.isArray(guestCfg.geos) && guestCfg.geos[0]
      ? (typeof guestCfg.geos[0] === 'string' ? guestCfg.geos[0] : guestCfg.geos[0].where)
      : 'Netherlands');
  const windowHours = Number.isFinite(args.windowHours) && args.windowHours > 0
    ? args.windowHours
    : Number(guestCfg.time_window_hours) || 168;
  const cap = Number.isFinite(args.cap) && args.cap > 0 ? args.cap : 50;
  const noJd = Boolean(args.noJd);
  const date = new Date().toISOString().slice(0, 10);

  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);

  console.log(`\nLinkedIn A/B harness — ${date}`);
  console.log(`Queries: ${queries.join(' | ')}`);
  console.log(`Geo: ${geoWhere} · Window: ${windowHours}h · Cap/query: ${cap} · JD: ${noJd ? 'off' : 'on'}\n`);

  // A — jobspy, LinkedIn only, identical queries/geo/window.
  console.log('Running A (jobspy-linkedin)…');
  const runA = await runCounting(() =>
    jobspyProvider.fetch(
      {
        name: 'jobspy',
        config: {
          location: geoWhere,
          hours_old: windowHours,
          linkedin_fetch_description: !noJd,
          sites: [{ name: 'linkedin', results_wanted: cap }],
          search_terms: queries,
        },
      },
      makeHttpCtx(),
    ),
  );
  if (runA.threw) console.error(`  A threw: ${runA.threw.message}`);

  // B — native guest-API, identical queries/geo/window.
  console.log('Running B (linkedin-guest)…');
  const runB = await runCounting(() =>
    linkedinGuestProvider.fetch(
      {
        name: 'linkedin-guest',
        config: {
          queries,
          geos: [{ where: geoWhere }],
          f_E: guestCfg.f_E,
          f_F: guestCfg.f_F,
          time_window_hours: windowHours,
          results_per_query: cap,
          fetch_description: !noJd,
          delay_ms: guestCfg.delay_ms,
        },
      },
      makeHttpCtx(),
    ),
  );
  if (runB.threw) console.error(`  B threw: ${runB.threw.message}`);

  const now = Date.now();
  const filteredA = applyScannerFilters(runA.jobs, titleFilter, locationFilter);
  const filteredB = applyScannerFilters(runB.jobs, titleFilter, locationFilter);
  const a = summarize('A', runA.jobs, filteredA, scoreSide(filteredA.kept, 'jobspy', config), now);
  const b = summarize('B', runB.jobs, filteredB, scoreSide(filteredB.kept, 'linkedin-guest', config), now);

  // Cross-source overlap on the company-role key (jobspy emits employer URLs,
  // guest emits linkedin.com URLs, so URL overlap understates true overlap).
  let both = 0;
  for (const k of filteredA.keys) if (filteredB.keys.has(k)) both++;
  const overlap = {
    both,
    aOnly: filteredA.keys.size - both,
    bOnly: filteredB.keys.size - both,
    bOnlyExamples: filteredB.kept
      .filter((j) => !filteredA.keys.has(companyRoleKey(j.company, j.title)))
      .slice(0, 12)
      .map((j) => `${j.company || '(no company)'} — ${j.title}`),
  };

  // Verdict — the decision gate, stated plainly.
  const dominatesKept = b.kept > a.kept;
  const fresher = (b.ageDaysMedian ?? Infinity) <= (a.ageDaysMedian ?? Infinity);
  const acceptable429 = runB.rateLimited <= runA.rateLimited + 1 && runB.jobs.length > 0;
  let verdict;
  if (dominatesKept && fresher && acceptable429) {
    verdict =
      `✅ Native B dominates: more relevant-kept (${b.kept} vs ${a.kept}), ` +
      `comparable/better freshness (${fmtAge(b.ageDaysMedian)} vs ${fmtAge(a.ageDaysMedian)}), ` +
      `acceptable rate-limit (${runB.rateLimited} 429s). ` +
      `RECOMMEND cutover: enable scrapers.linkedin-guest and drop the LinkedIn site from scrapers.jobspy. ` +
      `Keep jobspy-indeed. Re-run a few times before committing.`;
  } else if (b.kept === 0 || runB.jobs.length === 0) {
    verdict =
      `⚠️ Native B returned nothing (likely blocked or zero supply this window). ` +
      `Keep jobspy on LinkedIn. Re-run later / from a different IP.`;
  } else {
    const reasons = [];
    if (!dominatesKept) reasons.push(`kept ${b.kept} ≤ ${a.kept}`);
    if (!fresher) reasons.push(`B less fresh (${fmtAge(b.ageDaysMedian)} vs ${fmtAge(a.ageDaysMedian)})`);
    if (!acceptable429) reasons.push(`B 429s=${runB.rateLimited}`);
    verdict =
      `↔️ No clean win for B (${reasons.join('; ')}). ` +
      `Either keep jobspy, or run BOTH and union (dedup makes overlap free). ` +
      `Do NOT drop the jobspy LinkedIn path yet.`;
  }

  const report = buildReport({
    params: { date, queries, geo: geoWhere, windowHours, cap, noJd },
    a, b, runA, runB, overlap, verdict,
  });

  console.log('\n' + report);

  const outPath = args.out || path.join('data', 'parser-output', `ab-linkedin-${date}.md`);
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
