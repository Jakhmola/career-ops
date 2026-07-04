#!/usr/bin/env node

/**
 * scan-stats.mjs — yield telemetry for the portal scanner
 *
 * Reads data/scan-history.tsv and answers: which sources earn their keep?
 *   - rows added per source (raw + per scan-day)
 *   - status breakdown (added / skipped_* / discovered / evaluated)
 *   - downstream conversion per source: scan URL → evaluation report
 *     (reports/*.md `**URL:**` header) → tracker status (data/applications.md)
 *
 * Zero LLM tokens, zero network. Pure local analytics.
 *
 * Usage:
 *   node scan-stats.mjs            # human-readable tables
 *   node scan-stats.mjs --json     # machine-readable (for agents/scripts)
 *   node scan-stats.mjs --since 2026-06-10   # only rows first seen on/after date
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
// Safe to import: scan.mjs has a direct-run guard; import side effects are
// dotenv/config plus an idempotent mkdirSync('data').
import { canonicalizeUrl } from './scan.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCAN_HISTORY_PATH = join(ROOT, 'data', 'scan-history.tsv');
const APPLICATIONS_PATH = join(ROOT, 'data', 'applications.md');
const REPORTS_DIR = join(ROOT, 'reports');

// Collapse the many raw `portal` spellings into stable source families so the
// table stays readable as sources evolve. Raw names are kept in --json.
export function normalizeSource(portal) {
  const p = (portal || '').toLowerCase().trim();
  if (!p) return 'unknown';
  if (p.startsWith('websearch')) return 'websearch';
  if (p.includes('—') || p.includes(' - ')) return 'websearch'; // named search_queries entries
  if (p.startsWith('jobspy:')) return p; // per-board granularity: linkedin vs indeed have very different noise profiles
  if (p.startsWith('jobspy')) return 'jobspy'; // bare/legacy spellings
  if (p.endsWith('-api') || p.endsWith('-scan')) return `ats:${p.replace(/-(api|scan)$/, '')}`;
  if (p === 'local-parser') return 'ats:local-parser';
  if (p === 'playwright' || p.startsWith('playwright')) return 'playwright-board';
  return p; // aggregators keep their id: careerjet, jsearch, adzuna, arbeitnow, jooble
}

function parseScanHistory(since) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    console.error(`No scan history at ${SCAN_HISTORY_PATH}`);
    process.exit(1);
  }
  const rows = [];
  const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const [url, firstSeen, portal, title, company, status = 'added', location = ''] = line.split('\t');
    if (!url) continue;
    if (since && (firstSeen || '') < since) continue;
    rows.push({ url, firstSeen, portal, title, company, status: status || 'added', location });
  }
  return rows;
}

// Map evaluated-offer URL → report number by scanning report headers. Reports
// carry `**URL:** <url>` between Score and PDF (pipeline integrity rule #3).
function loadReportUrlIndex() {
  const index = new Map(); // url → { reportNum, score }
  if (!existsSync(REPORTS_DIR)) return index;
  for (const file of readdirSync(REPORTS_DIR)) {
    if (!file.endsWith('.md') || file.endsWith('-RESERVED.md')) continue;
    const numMatch = file.match(/^(\d{3,})-/); // reports are past #1000 — 3-digit-only silently drops them
    if (!numMatch) continue;
    let head;
    try {
      // Header block only — URL and Score live in the first ~40 lines.
      head = readFileSync(join(REPORTS_DIR, file), 'utf-8').slice(0, 4000);
    } catch {
      continue;
    }
    const urlMatch = head.match(/\*\*URL:\*\*\s*(\S+)/);
    if (!urlMatch) continue;
    const scoreMatch = head.match(/\*\*(?:Score|Puntuación):\*\*\s*([\d.]+)/i);
    // canonicalizeUrl first (LinkedIn locale/slug/currentJobId variants), then
    // stripUrl for the light protocol/www/tracking normalization.
    index.set(stripUrl(canonicalizeUrl(urlMatch[1])), {
      reportNum: numMatch[1],
      score: scoreMatch ? Number(scoreMatch[1]) : null,
    });
  }
  return index;
}

// Tracker rows: | # | Date | Company | Role | Score | Status | PDF | Report | Notes |
// The report link's number joins a tracker status back to a report (and from
// there to the scan URL). Returns reportNum → status.
function loadTrackerStatusIndex() {
  const index = new Map();
  if (!existsSync(APPLICATIONS_PATH)) return index;
  const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    // cells[0] is empty (leading pipe); expect ≥9 data cells
    if (cells.length < 10) continue;
    const status = cells[6];
    const reportCell = cells[8];
    const numMatch = reportCell.match(/\[(\d{1,4})\]/);
    if (!numMatch || !status || status === 'Status') continue;
    index.set(numMatch[1].padStart(3, '0'), status);
  }
  return index;
}

// Light URL normalization for joining scan-history URLs against report URLs:
// protocol-insensitive, ignore trailing slash and common tracking params.
export function stripUrl(url) {
  let u = (url || '').trim().replace(/^https?:\/\//, '').replace(/^www\./, '');
  const qIdx = u.indexOf('?');
  if (qIdx !== -1) {
    const base = u.slice(0, qIdx);
    const keep = [];
    for (const pair of u.slice(qIdx + 1).split('&')) {
      const k = pair.split('=')[0].toLowerCase();
      if (k.startsWith('utm_') || ['ref', 'src', 'source', 'gh_src', 'lever-source'].includes(k)) continue;
      keep.push(pair);
    }
    u = keep.length ? `${base}?${keep.join('&')}` : base;
  }
  return u.replace(/\/$/, '');
}

export function buildStats(rows, reportIndex, trackerIndex) {
  const bySource = new Map();
  for (const row of rows) {
    const source = normalizeSource(row.portal);
    if (!bySource.has(source)) {
      bySource.set(source, {
        source,
        rawPortals: new Set(),
        total: 0,
        byStatus: {},
        days: new Set(),
        evaluated: 0,
        scoreSum: 0,
        scoreCount: 0,
        applied: 0,
        interviewPlus: 0,
        trackerStatuses: {},
      });
    }
    const s = bySource.get(source);
    s.rawPortals.add(row.portal);
    s.total++;
    s.byStatus[row.status] = (s.byStatus[row.status] || 0) + 1;
    if (row.firstSeen) s.days.add(row.firstSeen);

    const report = reportIndex.get(stripUrl(canonicalizeUrl(row.url)));
    if (report) {
      s.evaluated++;
      if (report.score != null) {
        s.scoreSum += report.score;
        s.scoreCount++;
      }
      const trackerStatus = trackerIndex.get(report.reportNum);
      if (trackerStatus) {
        s.trackerStatuses[trackerStatus] = (s.trackerStatuses[trackerStatus] || 0) + 1;
        if (trackerStatus === 'Applied' || trackerStatus === 'Responded') s.applied++;
        if (['Interview', 'Offer'].includes(trackerStatus)) s.interviewPlus++;
      }
    }
  }

  return [...bySource.values()]
    .map(s => ({
      source: s.source,
      rawPortals: [...s.rawPortals].sort(),
      total: s.total,
      byStatus: s.byStatus,
      scanDays: s.days.size,
      perDay: s.days.size ? +(s.total / s.days.size).toFixed(1) : 0,
      evaluated: s.evaluated,
      avgScore: s.scoreCount ? +(s.scoreSum / s.scoreCount).toFixed(2) : null,
      applied: s.applied,
      interviewPlus: s.interviewPlus,
      trackerStatuses: s.trackerStatuses,
      // share of scanned rows that were worth a full evaluation
      evalRate: s.total ? +(s.evaluated / s.total * 100).toFixed(1) : 0,
      // share of evaluations that converted to an application or beyond
      applyRate: s.evaluated ? +((s.applied + s.interviewPlus) / s.evaluated * 100).toFixed(1) : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

function pad(v, w) {
  return String(v ?? '').padEnd(w);
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx !== -1 ? args[sinceIdx + 1] : null;

  const rows = parseScanHistory(since);
  const reportIndex = loadReportUrlIndex();
  const trackerIndex = loadTrackerStatusIndex();
  const stats = buildStats(rows, reportIndex, trackerIndex);

  const totals = {
    rows: rows.length,
    sources: stats.length,
    evaluated: stats.reduce((a, s) => a + s.evaluated, 0),
    applied: stats.reduce((a, s) => a + s.applied + s.interviewPlus, 0),
    reportsIndexed: reportIndex.size,
    since: since || null,
  };

  if (json) {
    console.log(JSON.stringify({ totals, sources: stats }, null, 2));
    return;
  }

  console.log(`scan-stats — ${totals.rows} scan rows${since ? ` since ${since}` : ''}, ${totals.reportsIndexed} reports indexed\n`);
  console.log(
    pad('SOURCE', 18) + pad('ROWS', 6) + pad('DAYS', 6) + pad('/DAY', 7) +
    pad('EVAL', 6) + pad('EVAL%', 7) + pad('AVG★', 6) + pad('APPLIED', 9) + 'STATUSES'
  );
  console.log('-'.repeat(100));
  for (const s of stats) {
    const statuses = Object.entries(s.byStatus)
      .filter(([k]) => k !== 'added')
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    console.log(
      pad(s.source, 18) + pad(s.total, 6) + pad(s.scanDays, 6) + pad(s.perDay, 7) +
      pad(s.evaluated, 6) + pad(`${s.evalRate}%`, 7) + pad(s.avgScore ?? '-', 6) +
      pad(s.applied + s.interviewPlus, 9) + statuses
    );
  }
  console.log('-'.repeat(100));
  console.log(
    pad('TOTAL', 18) + pad(totals.rows, 6) + pad('', 6) + pad('', 7) +
    pad(totals.evaluated, 6) + pad('', 7) + pad('', 6) + pad(totals.applied, 9)
  );
  console.log(
    '\nEVAL% = scanned rows that earned a full evaluation report (URL join).' +
    '\nAPPLIED includes Responded/Interview/Offer. Low EVAL% on a high-ROWS source = noise or triage backlog.'
  );
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
