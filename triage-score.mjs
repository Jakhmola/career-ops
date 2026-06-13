#!/usr/bin/env node

/**
 * triage-score.mjs — cheap pre-triage scoring for scanned offers
 *
 * The scanner is binary (pass/fail) but evaluation effort is not: a batch
 * session evaluates ~40 offers, so ORDER matters. This module scores each
 * offer 0–100 from signals that are free at scan time, so the pipeline can be
 * worked best-first and obvious C-grade rows can be skipped outright.
 *
 * Signals (weights sum to 100):
 *   - title strength (40): phrase-level keyword match ("AI Engineer",
 *     "Machine Learning") beats bare short tokens ("AI", "ML")
 *   - location quality (30): home cities > NL > remote/EU > unknown > other,
 *     driven by the user's own location_filter lists in portals.yml
 *   - source prior (20): measured avg evaluation score per source family
 *     (scan-stats 2026-06-13: ATS 3.1–3.7★, websearch 2.7★, jobspy 2.4★,
 *     jsearch 1.3★)
 *   - captured JD bonus (10): offline-evaluable offers (local:jds/) skip the
 *     flaky fetch step entirely
 *
 * Grades: A ≥ 72, B 50–71, C < 50.
 *
 * Usage:
 *   node triage-score.mjs                # rank pending pipeline items (read-only)
 *   node triage-score.mjs --annotate     # also write ` · pre:A78` onto pending lines
 *   node triage-score.mjs --json
 *
 * scan.mjs imports scoreOffer() to annotate new offers at append time.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = path.join(ROOT, 'data', 'pipeline.md');
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || path.join(ROOT, 'portals.yml');

const REMOTE_TOKENS = new Set(['remote', 'europe', 'emea', 'anywhere', 'worldwide', 'eu']);

// Avg evaluation score per source family (scan-stats), scaled to 0–20.
const SOURCE_PRIOR = {
  ats: 20,
  websearch: 14,
  careerjet: 12,
  'jobspy:linkedin': 12,
  jobspy: 11,
  'jobspy:indeed': 10,
  playwright: 10,
  adzuna: 8,
  arbeitnow: 8,
  jooble: 8,
  jsearch: 6,
  unknown: 10,
};

function compileKeywords(list) {
  return (Array.isArray(list) ? list : [])
    .map((k) => String(k || '').trim())
    .filter(Boolean)
    .map((k) => {
      const safe = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return {
        keyword: k,
        re: new RegExp(`\\b${safe}\\b`, 'i'),
        // Phrases and longer role words are high-signal; 2–3 char tokens
        // (AI/ML/LLM/NLP) match half the noise on a board.
        strong: k.includes(' ') || k.replace(/[^a-z]/gi, '').length >= 5,
      };
    });
}

/** Map an offer source (or URL when source is unknown) to a prior family. */
export function sourceFamily(source, url = '') {
  const s = String(source || '').toLowerCase();
  if (s) {
    if (s.endsWith('-api') || s.endsWith('-scan') || s === 'local-parser') return 'ats';
    if (s.startsWith('websearch')) return 'websearch';
    if (SOURCE_PRIOR[s] != null) return s;
    if (s.startsWith('jobspy')) return 'jobspy';
  }
  const u = String(url || '').toLowerCase();
  if (/greenhouse\.io|lever\.co|ashbyhq\.com|recruitee\.com|smartrecruiters\.com|workable\.com/.test(u)) return 'ats';
  if (/linkedin\.com/.test(u)) return 'jobspy:linkedin';
  if (/indeed\.com/.test(u)) return 'jobspy:indeed';
  if (/careerjet/.test(u)) return 'careerjet';
  if (u.startsWith('local:')) return 'jobspy';
  return s || 'unknown';
}

/**
 * Score one offer. `config` is the parsed portals.yml (title_filter /
 * location_filter drive the keyword and location lists).
 *
 * @returns {{score: number, grade: 'A'|'B'|'C', parts: object}}
 */
export function scoreOffer(offer, config = {}) {
  const title = String(offer.title || '');
  const location = String(offer.location || '');

  // 1. Title strength (0–40)
  const keywords = compileKeywords(config.title_filter?.positive);
  let titlePts = 0;
  if (keywords.length === 0) {
    titlePts = 30; // no filter configured — neutral-high
  } else {
    const matched = keywords.filter((k) => k.re.test(title));
    if (matched.some((k) => k.strong)) titlePts = 40;
    else if (matched.length > 0) titlePts = 20;
    else titlePts = 10; // shouldn't happen for scanner-passed rows; floor it
  }

  // 2. Location quality (0–30)
  const lf = config.location_filter || {};
  const norm = (list) => (Array.isArray(list) ? list : []).map((s) => String(s).toLowerCase());
  const lower = location.toLowerCase();
  const cityAllow = norm(lf.allow).filter((k) => !REMOTE_TOKENS.has(k));
  const homeAllow = norm(lf.always_allow);
  let locPts;
  if (!lower.trim()) {
    locPts = 12; // unknown — don't reward, don't bury
  } else if (homeAllow.some((k) => lower.includes(k))) {
    locPts = 30;
  } else if (cityAllow.some((k) => lower.includes(k))) {
    locPts = 26;
  } else if ([...REMOTE_TOKENS].some((k) => lower.includes(k))) {
    locPts = 18;
  } else {
    locPts = 8;
  }

  // 3. Source prior (0–20)
  const family = sourceFamily(offer.source, offer.pipelineUrl || offer.url);
  const srcPts = SOURCE_PRIOR[family] ?? SOURCE_PRIOR.unknown;

  // 4. Captured-JD bonus (0–10)
  const jdPts = String(offer.pipelineUrl || '').startsWith('local:') ? 10 : 0;

  const score = titlePts + locPts + srcPts + jdPts;
  const grade = score >= 72 ? 'A' : score >= 50 ? 'B' : 'C';
  return { score, grade, parts: { title: titlePts, location: locPts, source: srcPts, jd: jdPts, family } };
}

/** Format the pipeline annotation, e.g. "pre:A78". */
export function formatPre({ grade, score }) {
  return `pre:${grade}${score}`;
}

// ── Pipeline retro-scoring CLI ───────────────────────────────────────

const PRE_ANNOTATION_RE = /\s+·\s+pre:[ABC]\d{1,3}\b/;

/** Parse one pending pipeline line into {url, company, title, raw}. */
export function parsePipelineLine(line) {
  const m = line.match(/^- \[ \] (.+)$/);
  if (!m) return null;
  const segs = m[1].split(' | ').map((s) => s.trim());
  if (/^#\d+$/.test(segs[0])) segs.shift();
  const url = segs.shift() || '';
  if (!/^(https?:\/\/|local:|www\.)/.test(url)) return null;
  const company = segs.shift() || '';
  const title = (segs.join(' | ') || '').replace(PRE_ANNOTATION_RE, '').split(' — ')[0].trim();
  return { url, company, title };
}

async function main() {
  const args = process.argv.slice(2);
  const annotate = args.includes('--annotate');
  const json = args.includes('--json');

  let config = {};
  try {
    config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  } catch {
    console.error(`⚠️  could not read ${PORTALS_PATH} — scoring with defaults`);
  }

  if (!existsSync(PIPELINE_PATH)) {
    console.error(`No ${PIPELINE_PATH}`);
    process.exit(1);
  }
  const text = readFileSync(PIPELINE_PATH, 'utf-8');
  const lines = text.split('\n');

  const scored = [];
  const newLines = lines.map((line) => {
    const parsed = parsePipelineLine(line);
    if (!parsed) return line;
    const offer = {
      title: parsed.title,
      url: parsed.url.startsWith('local:') ? '' : parsed.url,
      pipelineUrl: parsed.url,
      location: '', // pipeline lines don't carry location; URL/source priors still apply
      company: parsed.company,
    };
    const result = scoreOffer(offer, config);
    scored.push({ ...parsed, ...result });
    if (!annotate) return line;
    const stripped = line.replace(PRE_ANNOTATION_RE, '');
    return `${stripped} · ${formatPre(result)}`;
  });

  if (annotate) {
    writeFileSync(PIPELINE_PATH, newLines.join('\n'), 'utf-8');
  }

  scored.sort((a, b) => b.score - a.score);
  if (json) {
    console.log(JSON.stringify(scored, null, 2));
    return;
  }
  console.log(`triage-score — ${scored.length} pending item(s)${annotate ? ' (annotated in pipeline.md)' : ''}\n`);
  for (const s of scored) {
    console.log(`${s.grade}${String(s.score).padEnd(4)} ${s.company || '(no company)'} | ${s.title}`);
  }
  const grades = scored.reduce((acc, s) => ((acc[s.grade] = (acc[s.grade] || 0) + 1), acc), {});
  console.log(`\nA:${grades.A || 0}  B:${grades.B || 0}  C:${grades.C || 0}   — work A-grade first; C-grade is skip-worthy unless something else argues for it.`);
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
