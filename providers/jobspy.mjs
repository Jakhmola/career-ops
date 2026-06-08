// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// JobSpy scraper — query-based source that SCRAPES LinkedIn, Indeed, and Google
// Jobs (via the python-jobspy library) instead of calling a vendor API. It is
// the sibling of the aggregators: same job shape, same title/location filter,
// same dedup pass (see docs/adr/0002-scrape-via-jobspy.md, which supersedes
// 0001). The aggregator APIs missed the user's actual NL target market (7/7
// misses vs. the roles they hand-applied to on LinkedIn); scraping closes that
// structural gap.
//
// Architecture: this thin Node provider spawns `python3 jobspy_runner.py` once
// per (site × search-term group) so each board gets its own result cap and a
// failure on one board (e.g. a LinkedIn 429) doesn't kill the others. The runner
// prints a JSON envelope ({jobs} | {error}) on stdout. python-jobspy missing or
// python3 absent → log a skip and return [] (DORMANT, like the missing-API-key
// path in adzuna/jsearch — never throw for mere absence).
//
// JD capture: LinkedIn runs with linkedin_fetch_description so the full JD comes
// back at scrape time. Each job carries its `description` and originating board;
// scan.mjs persists the JD to jds/{slug}.md and surfaces a `local:jds/...`
// pipelineUrl ONLY for offers that pass its filters, so evaluation reads the JD
// offline instead of hitting LinkedIn's login wall (and filtered-out roles leave
// no orphan files). Dedup/verification use the canonical employer URL
// (job_url_direct when present).
//
// Scrapers export NO detect() — like aggregators, they must never be
// auto-matched to a tracked_companies entry.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(HERE, '..', 'jobspy_runner.py');

// Resolve the Python interpreter: explicit JOBSPY_PYTHON wins, else a project
// .venv (the recommended setup on PEP-668 "externally managed" distros where
// system pip is blocked), else the system python3. So `node scan.mjs` just works
// after `python -m venv .venv && .venv/bin/pip install -r requirements.txt`.
// Resolved lazily (per fetch) so the env override is honored at call time.
function resolvePython() {
  if (process.env.JOBSPY_PYTHON) return process.env.JOBSPY_PYTHON;
  const venvPython = path.resolve(HERE, '..', '.venv', 'bin', 'python');
  if (existsSync(venvPython)) return venvPython;
  return 'python3';
}

const DEFAULT_SITES = [
  { name: 'linkedin', results_wanted: 100 },
  { name: 'indeed', results_wanted: 200 },
  { name: 'google', results_wanted: 200 },
];

/** @type {Provider} */
export default {
  id: 'jobspy',
  // NO detect().

  async fetch(descriptor, ctx) {
    const cfg = descriptor?.config || {};

    const defaultTerms = normalizeTerms(cfg.search_terms);

    const pythonBin = resolvePython();
    const sites = normalizeSites(cfg.sites);
    // Each site uses its OWN search_terms when set, else the shared default.
    // This is the per-site fan-out control: broad single tokens (e.g. "AI")
    // belong ONLY on boards with no burst limit (Indeed). Putting "AI" on
    // LinkedIn 429s + IP-blocks the home box — so Indeed can override with a
    // wider list than LinkedIn safely uses.
    const siteTerms = (site) =>
      site.search_terms && site.search_terms.length ? site.search_terms : defaultTerms;
    if (!sites.some((s) => siteTerms(s).length > 0)) {
      console.log('jobspy: skipped — no search_terms configured in portals.yml scrapers.jobspy');
      return [];
    }
    const location = typeof cfg.location === 'string' ? cfg.location.trim() : '';
    const countryIndeed =
      typeof cfg.country_indeed === 'string' ? cfg.country_indeed.trim() : '';
    const hoursOld = Number.isFinite(Number(cfg.hours_old)) ? Math.trunc(Number(cfg.hours_old)) : 0;
    // JOBSPY_MAX_RESULTS lets a smoke test cap every board to a tiny pull
    // (e.g. JOBSPY_MAX_RESULTS=3 node scan.mjs) without editing portals.yml.
    const maxResultsOverride = Number(process.env.JOBSPY_MAX_RESULTS) || 0;
    const fetchDescription = cfg.linkedin_fetch_description !== false; // default ON

    const seenUrls = new Set();
    const jobs = [];
    let anyOk = false;
    let lastErr = null;

    // One subprocess per (site × group). Sequential: parallel scrapes from the
    // same home IP are exactly what trips rate limits. Site-outer so each board's
    // (possibly different) term list is grouped together.
    for (const site of sites) {
      for (const group of siteTerms(site)) {
        const wanted = maxResultsOverride > 0
          ? Math.min(maxResultsOverride, site.results_wanted)
          : site.results_wanted;

        const argv = ['--site', site.name, '--search-term', group, '--results-wanted', String(wanted)];
        if (location) argv.push('--location', location);
        if (hoursOld > 0) argv.push('--hours-old', String(hoursOld));
        if (site.name === 'google') argv.push('--google-search-term', group);
        if (site.name === 'indeed' && countryIndeed) argv.push('--country-indeed', countryIndeed);
        if (site.name === 'linkedin' && fetchDescription) argv.push('--linkedin-fetch-description');

        ctx.recordCall?.('jobspy');
        let result;
        try {
          result = await runRunner(pythonBin, argv);
        } catch (err) {
          // ENOENT (python missing) → dormant, stop entirely.
          if (err && err.code === 'ENOENT') {
            console.log(`jobspy: skipped — '${pythonBin}' not found (install Python 3.10+ and python-jobspy)`);
            return [];
          }
          lastErr = err;
          console.error(`⚠️  jobspy ${site.name}/group: ${err.message}`);
          continue;
        }

        if (result.error === 'missing_dependency') {
          console.log('jobspy: skipped — python-jobspy not installed (pip install python-jobspy)');
          return []; // dormant — every call would say the same thing
        }
        if (result.error) {
          lastErr = new Error(`${site.name}: ${result.error}${result.detail ? ` — ${result.detail}` : ''}`);
          console.error(`⚠️  jobspy ${site.name}: ${result.error}`);
          continue;
        }

        anyOk = true;
        for (const mapped of mapJobspyRecords(result.jobs)) {
          if (seenUrls.has(mapped.url)) continue; // intra-fetch dedup (groups overlap)
          seenUrls.add(mapped.url);
          // `description` + `site` ride along so scan.mjs can persist the JD for
          // offers it keeps; the rest is the normalized job shape it filters on.
          jobs.push({ ...mapped, site: site.name });
        }
      }
    }

    // If literally every call errored (and none were dormant), surface it so
    // scan.mjs records the failure rather than silently reporting zero hits.
    if (!anyOk && lastErr && jobs.length === 0) throw lastErr;
    return jobs;
  },
};

// ── Helpers (exported for unit tests — no network / no subprocess) ──────────

/**
 * Normalize a search_terms list into trimmed, non-empty strings. Shared by the
 * top-level (default) list and the optional per-site override. Exported for tests.
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeTerms(value) {
  return (Array.isArray(value) ? value : [])
    .filter((t) => typeof t === 'string' && t.trim())
    .map((t) => t.trim());
}

/**
 * Normalize the `sites` config into [{name, results_wanted, search_terms?}].
 * Tolerates a bare list of strings (["linkedin","indeed"]) or objects, and
 * falls back to the three default boards when absent. Unknown site names are
 * dropped. An optional per-site `search_terms` array is carried through so a
 * board can override the shared default list.
 *
 * @param {unknown} value
 * @returns {{name: string, results_wanted: number, search_terms?: string[]}[]}
 */
export function normalizeSites(value) {
  const VALID = new Set(['linkedin', 'indeed', 'google']);
  const defaults = new Map(DEFAULT_SITES.map((s) => [s.name, s.results_wanted]));
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_SITES.map((s) => ({ ...s }));
  const out = [];
  const seen = new Set();
  for (const item of value) {
    let name;
    let wanted;
    let perSiteTerms = [];
    if (typeof item === 'string') {
      name = item.trim().toLowerCase();
    } else if (item && typeof item === 'object') {
      name = String(item.name || '').trim().toLowerCase();
      wanted = Number(item.results_wanted);
      perSiteTerms = normalizeTerms(item.search_terms);
    }
    if (!name || !VALID.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      results_wanted: Number.isFinite(wanted) && wanted > 0 ? Math.trunc(wanted) : (defaults.get(name) || 50),
      ...(perSiteTerms.length ? { search_terms: perSiteTerms } : {}),
    });
  }
  return out.length > 0 ? out : DEFAULT_SITES.map((s) => ({ ...s }));
}

/**
 * Map the runner's job records to the scanner's normalized shape. Picks the
 * canonical employer URL (url_direct when present) so dedup + Playwright
 * verification target the employer page rather than the login-walled board URL.
 * Rows without a usable URL or title are dropped. Exported for tests.
 *
 * @param {any} records
 * @returns {Array<{title: string, url: string, company: string, location: string, description: string}>}
 */
export function mapJobspyRecords(records) {
  if (!Array.isArray(records)) return [];
  const out = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const title = String(r.title || '').trim();
    const url = String(r.url_direct || r.url || '').trim();
    if (!title || !url) continue;
    out.push({
      title,
      url,
      company: String(r.company || '').trim(),
      location: String(r.location || '').trim(),
      description: String(r.description || '').trim(),
    });
  }
  return out;
}

// Spawn the python runner and resolve its parsed JSON envelope. Rejects on a
// spawn error (e.g. ENOENT) or when stdout can't be parsed as the envelope.
function runRunner(pythonBin, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [RUNNER_PATH, ...argv], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject); // ENOENT etc. — caller checks err.code
    child.on('close', () => {
      const text = stdout.trim();
      if (!text) {
        const snippet = stderr.replace(/\s+/g, ' ').trim().slice(0, 300);
        return reject(new Error(`runner produced no output${snippet ? `: ${snippet}` : ''}`));
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error(`runner produced unparseable output: ${text.slice(0, 200)}`));
      }
    });
  });
}
