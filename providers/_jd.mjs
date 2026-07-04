// Shared JD-persistence helper. Files prefixed with _ are never loaded as
// providers by scan.mjs.
//
// Scraper sources (e.g. jobspy) capture the full job description at scrape time.
// scan.mjs persists that JD to jds/{slug}.md ONLY for offers that survive the
// title/location/dedup filters, then references it from pipeline.md as
// `local:jds/...` so downstream evaluation reads the JD offline instead of
// re-fetching a login-walled page. Keeping the write here (not in the provider)
// means filtered-out roles never leave orphan files behind.
//
// Providers whose list rows lack a JD may instead attach a per-job `fetchJd()`
// (async, returns the JD text); scan.mjs calls it for KEPT rows only, capped
// per provider via the `max_jd_fetches` config key (default 60), so triage
// sees JD text at scan time without a detail request per filtered-out row.

import { createHash } from 'node:crypto';

/**
 * Build a stable, filesystem-safe `{company}-{role}.md` filename for a captured
 * JD, de-duplicating within a single scan via `usedNames` (appends a short
 * URL-derived hash on collision).
 *
 * @param {{company?: string, title?: string, url?: string}} job
 * @param {Set<string>} [usedNames]
 * @returns {string}
 */
export function jdFilename(job, usedNames) {
  const company = slugify(job.company) || 'company';
  const role = slugify(job.title) || 'role';
  const base = `${company}-${role}`.slice(0, 80).replace(/-+$/, '');
  let name = `${base}.md`;
  if (usedNames && usedNames.has(name)) {
    const hash = createHash('sha1').update(String(job.url || base)).digest('hex').slice(0, 6);
    name = `${base}-${hash}.md`;
  }
  if (usedNames) usedNames.add(name);
  return name;
}

export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Minimal HTML → readable text for ATS description fields (Recruitee
 * description/requirements, Ashby descriptionHtml). Not a sanitizer — output
 * goes into a local markdown file for offline evaluation, never a browser.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Render a captured JD to markdown. Header carries the canonical employer URL
 * (so a human can still open the source) and the originating board.
 *
 * @param {{title?: string, company?: string, location?: string, url?: string, description?: string, site?: string}} job
 * @returns {string}
 */
export function renderJd(job) {
  return [
    `# ${job.title || 'Role'}${job.company ? ` — ${job.company}` : ''}`,
    '',
    `**Company:** ${job.company || 'N/A'}`,
    `**Location:** ${job.location || 'N/A'}`,
    `**URL:** ${job.url || 'N/A'}`,
    `**Source:** ${job.site ? `scraped via jobspy (${job.site})` : 'captured at scan time'}`,
    '',
    '---',
    '',
    job.description || '',
    '',
  ].join('\n');
}
