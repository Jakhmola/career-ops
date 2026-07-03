// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// DataJobs.nl aggregator — NL-native data/AI job board (Drupal). Pulls the
// public RSS feed (the Drupal Views /rss.xml path); no auth, no key. Exports NO
// detect(); reached only via the `aggregators:` block in portals.yml.
//
// Feed item shape (verified 2026-06-23):
//   <title>{Role}</title>
//   <link>https://www.datajobs.nl/vacatures/{slug}-bij-{company}</link>
//   <pubDate>{RFC-822}</pubDate>
//   <description>… Drupal THEME-DEBUG HTML noise …</description>   ← intentionally ignored
//
// The employer is encoded in the URL slug after "-bij-" (e.g. "...-bij-mcb").
// The <description> is debug-polluted, so no JD is captured (the detail pages
// carry a clean JSON-LD JobPosting if richer data is ever needed). Location is
// not reliably present in the feed → left empty (scan.mjs passes empty location).

import { parseRssItems, rssDateToMs } from './_rss.mjs';

const ENDPOINT = 'https://www.datajobs.nl/rss.xml';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/** @type {Provider} */
export default {
  id: 'datajobs',
  // NO detect() — aggregator.

  async fetch(_descriptor, ctx) {
    const xml = await ctx.fetchText(ENDPOINT, {
      headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
      redirect: 'follow',
    });
    ctx.recordCall?.('datajobs');
    return parseDatajobs(xml);
  },
};

/**
 * Parse the DataJobs.nl RSS feed into normalized jobs. Exported for unit tests.
 * @param {string} xml
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseDatajobs(xml) {
  return parseRssItems(xml)
    // The feed mixes editorial /blog/ articles in with /vacatures/ postings.
    // Keep only real vacancy URLs — a /blog/ link has no employer ("-bij-")
    // and is not a job, but would otherwise leak into the pipeline as a fake
    // row (e.g. "Waarom AI-projecten niet mislukken…"). Verified 2026-06-24.
    .filter((it) => it.link && it.title && /\/vacatures\//.test(it.link))
    .map((it) => {
      const job = {
        title: it.title.trim(),
        url: it.link.trim(),
        company: companyFromSlug(it.link),
        location: '',
      };
      const postedAt = rssDateToMs(it.pubDate);
      if (postedAt) job.postedAt = postedAt;
      return job;
    });
}

/**
 * Recover the employer from a DataJobs URL slug: the segment after the last
 * "-bij-" (Dutch for "at"). "senior-product-data-specialist-bij-mcb" → "Mcb".
 * Returns '' when the slug has no "-bij-" marker. Exported for unit tests.
 * @param {string} link
 * @returns {string}
 */
export function companyFromSlug(link) {
  let slug;
  try {
    slug = new URL(link).pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    return '';
  }
  const i = slug.lastIndexOf('-bij-');
  if (i < 0) return '';
  return slug
    .slice(i + '-bij-'.length)
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .trim();
}
