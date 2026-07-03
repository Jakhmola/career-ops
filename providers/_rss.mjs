// Shared minimal RSS 2.0 <item> parser. Files prefixed with _ are never loaded
// as providers by scan.mjs. Used by the NL-native board aggregators
// (werkeninai, datajobs) whose feeds are plain recent-jobs RSS — relevance is
// handled downstream by the scanner's title_filter + location_filter.
//
// Deliberately regex-based (no XML dependency): the feeds are small and the
// fields we need (title, link, pubDate, category, description) are flat.

/**
 * Parse RSS <item> elements into flat records.
 * @param {string} xml
 * @returns {Array<{title: string, link: string, guid: string, pubDate: string, description: string, categories: string[]}>}
 */
export function parseRssItems(xml) {
  if (typeof xml !== 'string' || !xml) return [];
  const out = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1];
    out.push({
      title: firstTag(body, 'title'),
      link: firstTag(body, 'link'),
      guid: firstTag(body, 'guid'),
      pubDate: firstTag(body, 'pubDate'),
      description: firstTag(body, 'description'),
      categories: allTags(body, 'category'),
    });
  }
  return out;
}

/** Parse an RFC-822 pubDate to epoch ms, or undefined when unparseable. */
export function rssDateToMs(pubDate) {
  const t = Date.parse(String(pubDate || ''));
  return Number.isFinite(t) ? t : undefined;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function firstTag(body, name) {
  const m = body.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? unwrap(m[1]) : '';
}

function allTags(body, name) {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(body)) !== null) out.push(unwrap(m[1]));
  return out;
}

function unwrap(s) {
  const cdata = String(s).match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return decodeEntities((cdata ? cdata[1] : String(s)).trim());
}

/** Decode the named + numeric HTML/XML entities these feeds emit. */
export function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)));
}

function safeCodePoint(n) {
  try {
    return Number.isFinite(n) ? String.fromCodePoint(n) : '';
  } catch {
    return '';
  }
}
