// Parse pipeline.md Pending rows → worklist JSON. Resume-aware: drops rows whose
// company+role already has a reports/*-2026-07-01.md (Phase 2 done).
// Usage: node build-worklist.mjs [--all]   (--all = don't apply resume filter)
import { readFileSync, readdirSync, existsSync } from 'fs';

const kebab = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const text = readFileSync('data/pipeline.md', 'utf-8');
// take everything under the first "## Pending" until the next "## "
const m = text.match(/##\s+Pending[^\n]*\n([\s\S]*?)(?=\n##\s|$)/);
const body = m ? m[1] : '';
const rows = [];
for (const line of body.split('\n')) {
  const mm = line.match(/^-\s+\[ \]\s+(.+)$/);
  if (!mm) continue;
  let segs = mm[1].split(' | ').map(s => s.trim());
  if (/^#\d+$/.test(segs[0])) segs.shift();
  const ref = segs[0] || '';
  const company = segs[1] || '';
  // title may carry ` · pre:...` annotation — strip
  const title = (segs[2] || '').split(' · ')[0].split(' — ')[0].trim();
  if (!ref || !title) continue;
  rows.push({ ref, company, title, slug: `${kebab(company)}-${kebab(title)}` });
}

let out = rows;
if (!process.argv.includes('--all') && existsSync('reports')) {
  // build set of slugs already reported today (match on company+role kebab prefix)
  const done = new Set();
  for (const f of readdirSync('reports')) {
    const dm = f.match(/^\d+-(.+)-2026-07-01\.md$/);
    if (dm) done.add(dm[1]);
  }
  out = rows.filter(r => {
    // a row is done if some report slug equals its slug
    return ![...done].some(d => d === r.slug);
  });
}

// de-dup within worklist by slug (scan can surface near-dups)
const seen = new Set();
out = out.filter(r => { if (seen.has(r.slug)) return false; seen.add(r.slug); return true; });

console.error(`pending=${rows.length} remaining=${out.length}`);
process.stdout.write(JSON.stringify(out, null, 0));
