// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// aijobs.net aggregator — global AI/ML/Data board. No public feed or API: the
// homepage server-renders 50 job cards we parse directly. Exports NO detect();
// reached only via the `aggregators:` block in portals.yml.
//
// Two-stage by necessity: the card carries title/url/location but NOT the
// employer (company lives only on the /job/<slug> detail page, in the
// `<a href="/company/…">@ {company}</a>` link). An empty company is a dedup
// hazard — companyRoleKey('', title) collapses DIFFERENT employers' same-titled
// roles into one — so we MUST enrich company before returning. To bound the
// extra fetches, we relevance-gate cards against descriptor.positive first
// (only AI/ML-relevant titles get a detail fetch), capped by `max_detail`.
//
// DISABLED BY DEFAULT in portals.yml: it's a global board with no NL filter and
// mostly US-remote roles. Opt in if you want broad coverage; the per-card detail
// fetch makes it the heaviest aggregator.

const BASE = 'https://aijobs.net';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const DEFAULT_MAX_DETAIL = 40;

/** @type {Provider} */
export default {
  id: 'aijobs',
  // NO detect() — aggregator.

  async fetch(descriptor, ctx) {
    const html = await ctx.fetchText(`${BASE}/`, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    ctx.recordCall?.('aijobs');

    let cards = parseAijobsCards(html);

    // Relevance gate (cheap, before detail fetches): keep cards whose title
    // mentions any positive keyword. Loose by design — scan.mjs applies the real
    // title filter afterwards; this only bounds the company-enrichment fetches.
    const positives = (Array.isArray(descriptor?.positive) ? descriptor.positive : [])
      .map((k) => String(k || '').toLowerCase().trim())
      .filter(Boolean);
    if (positives.length > 0) {
      cards = cards.filter((c) => {
        const t = c.title.toLowerCase();
        return positives.some((k) => t.includes(k));
      });
    }

    const cfg = descriptor?.config || {};
    const fetchCompany = cfg.fetch_company !== false; // default ON (dedup safety)
    const maxDetail = Number(cfg.max_detail) > 0 ? Math.trunc(Number(cfg.max_detail)) : DEFAULT_MAX_DETAIL;

    const out = [];
    for (const c of cards.slice(0, maxDetail)) {
      let company = '';
      if (fetchCompany) {
        try {
          const detail = await ctx.fetchText(`${BASE}${c.path}`, {
            headers: { 'user-agent': UA, accept: 'text/html' },
            redirect: 'follow',
          });
          ctx.recordCall?.('aijobs');
          company = parseAijobsCompany(detail);
        } catch {
          // Detail fetch failed — fall through with empty company (the role can
          // still pass scan.mjs's URL dedup; only the role-key dedup is weaker).
        }
      }
      out.push({ title: c.title, url: `${BASE}${c.path}`, company, location: c.location });
    }
    return out;
  },
};

// ── Pure parsers (exported for unit tests — no network inside) ────────────────

/**
 * Parse aijobs.net homepage job cards. Exported for unit tests.
 *
 * Card: <li class="d-flex …"> … <a class="… stretched-link" href="/job/<slug>/">
 *   [<span>Featured</span>] Title </a> … <div class="text-end"> … location … </div></li>
 *
 * @param {string} html
 * @returns {Array<{path: string, title: string, location: string}>}
 */
export function parseAijobsCards(html) {
  if (typeof html !== 'string' || !html) return [];
  const out = [];
  const liRe = /<li[^>]*class="[^"]*d-flex[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const li = m[1];
    const a = li.match(/<a[^>]*class="[^"]*stretched-link[^"]*"[^>]*href="(\/job\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const path = a[1];
    // Title: drop the "Featured"/"Feat." badge spans, then all remaining tags.
    const title = cleanText(
      a[2]
        .replace(/<span[^>]*>\s*(?:Featured|Feat\.)\s*<\/span>/gi, ' ')
        .replace(/<[^>]+>/g, ' '),
    );
    if (!title) continue;

    // Location lives in the text-end block — the bare text of the non-muted div
    // (the muted div is the "Xd ago" posted line). Badges are spans we strip.
    // text-end is the last element of the card, so match to the end of the slice
    // (the </li> is the liRe boundary and isn't part of this captured group).
    let location = '';
    const te = li.match(/<div class="text-end">([\s\S]*)$/i);
    if (te) {
      const block = te[1]
        .replace(/<div class="text-muted[\s\S]*$/i, '') // cut the posted line onward
        .replace(/<span[^>]*>[\s\S]*?<\/span>/gi, ' ')  // drop badge spans
        .replace(/<[^>]+>/g, ' ');
      location = cleanText(block);
    }
    out.push({ path, title, location });
  }
  return out;
}

/**
 * Extract the employer from an aijobs.net /job detail page. The company link
 * reads `<a href="/company/…">@ {company}</a>`. Exported for unit tests.
 * @param {string} html
 * @returns {string}
 */
export function parseAijobsCompany(html) {
  if (typeof html !== 'string' || !html) return '';
  const m = html.match(/<a[^>]*href="\/company\/[^"]+"[^>]*>([\s\S]*?)<\/a>/i);
  if (!m) return '';
  return cleanText(m[1].replace(/<[^>]+>/g, ' ')).replace(/^@\s*/, '').trim();
}

function cleanText(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
