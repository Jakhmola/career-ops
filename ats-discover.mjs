#!/usr/bin/env node

/**
 * ats-discover.mjs — turn employers seen in scan results into directly-pollable
 * ATS boards.
 *
 * The tracked-companies layer is the freshest, cheapest discovery source (public
 * ATS JSON, zero tokens, zero quota) but it only knows the companies you hand it.
 * Aggregator/scraper hits are exactly the employers hiring your kind of role in
 * your market RIGHT NOW — this script harvests their names from
 * data/scan-history.tsv, guesses board slugs, probes the public APIs of six ATS
 * vendors, and emits ready-to-paste tracked_companies entries for every hit.
 *
 * Zero LLM tokens. Results cached in data/cache/ats-companies/ (gitignored):
 * hits refresh after 1 day, misses re-probe after 30.
 *
 * Usage:
 *   node ats-discover.mjs                      # harvest from scan-history (top 30)
 *   node ats-discover.mjs --limit 50           # widen the harvest
 *   node ats-discover.mjs "Picnic" "Mollie"    # probe explicit company names
 *   node ats-discover.mjs --emit-yaml          # print tracked_companies YAML for hits
 *   node ats-discover.mjs --json               # machine-readable results
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCAN_HISTORY_PATH = path.join(ROOT, 'data', 'scan-history.tsv');
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || path.join(ROOT, 'portals.yml');
const CACHE_DIR = path.join(ROOT, 'data', 'cache', 'ats-companies');

const HIT_TTL_DAYS = 1;    // refresh job counts on hits daily
const MISS_TTL_DAYS = 30;  // companies adopt a new ATS rarely; re-probe misses monthly
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 8000;

// Company-name values that are board artifacts, not employers.
const NAME_DENYLIST = new Set([
  '', 'linkedin', 'indeed', 'glassdoor', 'confidential', 'recruiter', 'unknown',
  'via linkedin', 'via indeed',
]);

// Legal/locale suffixes that never appear in board slugs.
const SLUG_STOPWORDS = new Set([
  'bv', 'b', 'v', 'nv', 'n', 'gmbh', 'inc', 'ltd', 'llc', 'plc', 'sa', 'srl',
  'spa', 'ag', 'ab', 'as', 'aps', 'oy', 'holding', 'holdings', 'group',
  'international', 'netherlands', 'nederland', 'europe', 'global', 'company',
  'corporation', 'corp', 'co', 'the',
]);

/** Generate plausible board slugs from a display name. */
export function slugCandidates(name) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return [];
  const words = base.split(' ').filter((w) => !SLUG_STOPWORDS.has(w));
  if (words.length === 0) return [];
  const out = new Set();
  out.add(words.join(''));        // "picnic technologies" → picnictechnologies
  out.add(words.join('-'));       // → picnic-technologies
  if (words.length > 1 && words[0].length >= 4) out.add(words[0]); // → picnic
  return [...out].filter((s) => s.length >= 3 && s.length <= 40);
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'career-ops-ats-discover/1.0' },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    return { ok: true, data };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// Each probe returns null on miss, or { jobs: [{title, location}], careersUrl, extra? }.
// Ordered by NL-market prevalence so stop-on-first-hit does minimal requests.
const PROBES = [
  {
    id: 'greenhouse',
    async probe(slug) {
      const r = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
      if (!r.ok || !Array.isArray(r.data?.jobs)) return null;
      return {
        jobs: r.data.jobs.map((j) => ({ title: j.title, location: j.location?.name || '' })),
        careersUrl: `https://job-boards.greenhouse.io/${slug}`,
        extra: { api: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs` },
      };
    },
  },
  {
    id: 'lever',
    async probe(slug) {
      const r = await fetchJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
      if (!r.ok || !Array.isArray(r.data) ) return null;
      return {
        jobs: r.data.map((j) => ({ title: j.text, location: j.categories?.location || '' })),
        careersUrl: `https://jobs.lever.co/${slug}`,
      };
    },
  },
  {
    id: 'recruitee',
    async probe(slug) {
      const r = await fetchJson(`https://${slug}.recruitee.com/api/offers/`);
      if (!r.ok || !Array.isArray(r.data?.offers)) return null;
      return {
        jobs: r.data.offers.map((j) => ({ title: j.title, location: j.location || j.city || '' })),
        careersUrl: `https://${slug}.recruitee.com`,
      };
    },
  },
  {
    id: 'ashby',
    async probe(slug) {
      const r = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
      if (!r.ok || !Array.isArray(r.data?.jobs)) return null;
      return {
        jobs: r.data.jobs.map((j) => ({ title: j.title, location: j.location || '' })),
        careersUrl: `https://jobs.ashbyhq.com/${slug}`,
      };
    },
  },
  {
    id: 'workable',
    async probe(slug) {
      const r = await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${slug}`);
      if (!r.ok || !Array.isArray(r.data?.jobs)) return null;
      return {
        jobs: r.data.jobs.map((j) => ({ title: j.title, location: [j.city, j.country].filter(Boolean).join(', ') })),
        careersUrl: `https://apply.workable.com/${slug}`,
      };
    },
  },
  {
    id: 'smartrecruiters',
    async probe(slug) {
      const r = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings`);
      if (!r.ok || !Array.isArray(r.data?.content)) return null;
      return {
        jobs: r.data.content.map((j) => ({
          title: j.name,
          location: [j.location?.city, j.location?.country].filter(Boolean).join(', '),
        })),
        careersUrl: `https://jobs.smartrecruiters.com/${slug}`,
        extra: { provider: 'smartrecruiters' },
      };
    },
  },
];

function cachePath(provider, slug) {
  return path.join(CACHE_DIR, `${provider}--${slug}.json`);
}

function readCache(provider, slug) {
  const p = cachePath(provider, slug);
  if (!existsSync(p)) return null;
  try {
    const entry = JSON.parse(readFileSync(p, 'utf-8'));
    const ageDays = (Date.now() - new Date(entry.probedAt).getTime()) / 86400000;
    const ttl = entry.found ? HIT_TTL_DAYS : MISS_TTL_DAYS;
    return ageDays < ttl ? entry : null;
  } catch {
    return null;
  }
}

function writeCache(provider, slug, entry) {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath(provider, slug), JSON.stringify(entry, null, 2), 'utf-8');
  } catch {
    // cache is an optimization; never fail discovery over it
  }
}

/** Probe all providers × slugs for one company; first hit wins. */
async function discoverCompany(name, { titleFilter, locationFilter }) {
  const slugs = slugCandidates(name);
  for (const slug of slugs) {
    for (const { id, probe } of PROBES) {
      const cached = readCache(id, slug);
      let result;
      if (cached) {
        if (!cached.found) continue;
        result = cached.result;
      } else {
        result = await probe(slug);
        // Empty boards count as misses: SmartRecruiters/Workable answer 200 with
        // an empty list for ANY slug (no 404 on unknown companies), and a board
        // with zero postings is useless to track either way. Keep probing.
        if (result && result.jobs.length === 0) result = null;
        writeCache(id, slug, { found: Boolean(result), probedAt: new Date().toISOString(), result: result || undefined });
        if (!result) continue;
      }
      const matching = result.jobs.filter(
        (j) => titleFilter(j.title || '') && locationFilter(j.location)
      );
      return {
        company: name,
        provider: id,
        slug,
        careersUrl: result.careersUrl,
        extra: result.extra || {},
        totalJobs: result.jobs.length,
        matchingJobs: matching.length,
        matchingTitles: matching.slice(0, 6).map((j) => `${j.title} (${j.location || 'n/a'})`),
      };
    }
  }
  return { company: name, provider: null };
}

/** Harvest company names from scan-history, most-frequent first. */
export function harvestCompanies(tsvText, { trackedNames = new Set(), limit = 30 } = {}) {
  const counts = new Map();
  for (const line of tsvText.split('\n').slice(1)) {
    const cols = line.split('\t');
    const name = (cols[4] || '').trim();
    const key = name.toLowerCase();
    if (NAME_DENYLIST.has(key) || trackedNames.has(key)) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

function emitYaml(hits) {
  const lines = ['', '  # ── auto-discovered by ats-discover.mjs — vet before relying on ──'];
  for (const h of hits) {
    lines.push(`  - name: ${h.company}`);
    if (h.extra.provider) lines.push(`    provider: ${h.extra.provider}`);
    lines.push(`    careers_url: ${h.careersUrl}    # ${h.provider}, ${h.totalJobs} jobs, ${h.matchingJobs} matching (${new Date().toISOString().slice(0, 10)})`);
    if (h.extra.api) lines.push(`    api: ${h.extra.api}`);
    lines.push(`    enabled: true`);
  }
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const emitYamlFlag = args.includes('--emit-yaml');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) || 30 : 30;
  const explicit = args.filter((a, i) => !a.startsWith('--') && (limitIdx === -1 || i !== limitIdx + 1));

  // Reuse the user's own filters so "matching" means THEIR target roles.
  const { buildTitleFilter, buildLocationFilter } = await import(pathToFileURL(path.join(ROOT, 'scan.mjs')).href);
  let config = {};
  try {
    config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  } catch {
    console.error(`⚠️  could not read ${PORTALS_PATH}; matching counts will use no filters`);
  }
  const filters = {
    titleFilter: buildTitleFilter(config.title_filter),
    locationFilter: buildLocationFilter(config.location_filter),
  };

  const trackedNames = new Set(
    (config.tracked_companies || []).map((c) => String(c?.name || '').toLowerCase())
  );

  let companies;
  if (explicit.length > 0) {
    companies = explicit;
  } else {
    if (!existsSync(SCAN_HISTORY_PATH)) {
      console.error('No data/scan-history.tsv — run a scan first or pass company names.');
      process.exit(1);
    }
    companies = harvestCompanies(readFileSync(SCAN_HISTORY_PATH, 'utf-8'), { trackedNames, limit });
  }

  console.error(`Probing ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'} across ${PROBES.length} ATS providers...`);

  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, companies.length) }, async () => {
      while (i < companies.length) {
        const name = companies[i++];
        const r = await discoverCompany(name, filters);
        results.push(r);
        if (r.provider) {
          console.error(`  ✓ ${r.company} → ${r.provider}/${r.slug} (${r.totalJobs} jobs, ${r.matchingJobs} matching)`);
        }
      }
    })
  );

  const hits = results
    .filter((r) => r.provider)
    .sort((a, b) => b.matchingJobs - a.matchingJobs);
  const misses = results.filter((r) => !r.provider);

  if (json) {
    console.log(JSON.stringify({ hits, missCount: misses.length }, null, 2));
    return;
  }

  console.log(`\nats-discover — ${hits.length} board(s) found, ${misses.length} compan${misses.length === 1 ? 'y' : 'ies'} without a public board\n`);
  for (const h of hits) {
    console.log(`${h.company}  →  ${h.provider}/${h.slug}  (${h.totalJobs} jobs, ${h.matchingJobs} matching your filters)`);
    for (const t of h.matchingTitles) console.log(`    • ${t}`);
  }
  if (emitYamlFlag && hits.length > 0) {
    console.log('\n# Paste into portals.yml → tracked_companies:');
    console.log(emitYaml(hits.filter((h) => h.matchingJobs > 0)));
  }
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
