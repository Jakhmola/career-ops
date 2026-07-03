// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// werkeninai.nl aggregator — NL-native AI job board (WordPress). Pulls the
// public RSS feed; no auth, no key. Like the other aggregators it exports NO
// detect() and is reached only via the `aggregators:` block in portals.yml.
// Relevance/location are handled downstream by the scanner's filters.
//
// Feed item shape (verified 2026-06-23):
//   <title>{Role} – {Employer}</title>   (en-dash separated)
//   <link>{job url}</link>
//   <pubDate>{RFC-822}</pubDate>
//   <category>…</category> × N           (employment type, location, employer)
//   <description><![CDATA[ snippet ]]></description>
//
// The <description> snippet is captured as the JD (good for the Dutch-language
// pre-triage penalty — many of these roles are Dutch-required).

import { parseRssItems, rssDateToMs } from './_rss.mjs';
import { htmlToText } from './_jd.mjs';

const ENDPOINT = 'https://werkeninai.nl/feed/';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Category values that are employment-type or generic tags, NOT a location.
const NON_LOCATION_CATS = new Set([
  'fulltime', 'full-time', 'full time', 'parttime', 'part-time', 'part time',
  'stage', 'stages', 'internship', 'internships', 'traineeship', 'traineeships',
  'freelance', 'zzp', 'interim', 'bijbaan', 'tijdelijk', 'vast',
  'vacature', 'vacatures', 'remote', 'hybride', 'hybrid',
]);

/** @type {Provider} */
export default {
  id: 'werkeninai',
  // NO detect() — aggregator.

  async fetch(_descriptor, ctx) {
    const xml = await ctx.fetchText(ENDPOINT, {
      headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
      redirect: 'follow',
    });
    ctx.recordCall?.('werkeninai');
    return parseWerkeninai(xml);
  },
};

/**
 * Parse the werkeninai RSS feed into normalized jobs. Exported for unit tests.
 * @param {string} xml
 * @returns {Array<{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}>}
 */
export function parseWerkeninai(xml) {
  return parseRssItems(xml)
    .filter((it) => it.link && it.title)
    .map((it) => {
      // "{Role} – {Employer}" — split on a dash surrounded by spaces (en/em/hyphen).
      let title = it.title.trim();
      let company = '';
      const parts = title.split(/\s+[–—-]\s+/);
      if (parts.length >= 2) {
        company = parts[parts.length - 1].trim();
        title = parts.slice(0, -1).join(' - ').trim();
      }
      // Location = first category that's neither an employment-type/generic tag
      // nor the employer name itself.
      const cats = (it.categories || []).map((c) => c.trim()).filter(Boolean);
      const location =
        cats.find(
          (c) => !NON_LOCATION_CATS.has(c.toLowerCase()) && c.toLowerCase() !== company.toLowerCase(),
        ) || '';

      const job = { title, url: it.link, company, location };
      const description = htmlToText(it.description || '');
      if (description) job.description = description;
      const postedAt = rssDateToMs(it.pubDate);
      if (postedAt) job.postedAt = postedAt;
      return job;
    });
}
