// Shared JD-persistence helper. Files prefixed with _ are never loaded as
// providers by scan.mjs.
//
// Scraper sources (e.g. jobspy) capture the full job description at scrape time.
// scan.mjs persists that JD to jds/{slug}.md ONLY for offers that survive the
// title/location/dedup filters, then references it from pipeline.md as
// `local:jds/...` so downstream evaluation reads the JD offline instead of
// re-fetching a login-walled page. Keeping the write here (not in the provider)
// means filtered-out roles never leave orphan files behind.

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
    `**Source:** scraped via jobspy (${job.site || 'unknown'})`,
    '',
    '---',
    '',
    job.description || '',
    '',
  ].join('\n');
}
