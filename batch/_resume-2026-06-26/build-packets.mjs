#!/usr/bin/env node
// Regenerate the ≥3.5 packet worklist for today (2026-06-26) from durable merged TSVs.
// Output: packets.json (all today ≥3.5) + packet-NN.json chunks of 4 (only those needing CV or CL).
// Idempotent — skips leads whose cv+cl PDFs already exist. Survives scratchpad wipes.
import fs from 'node:fs';
const ROOT = '/home/shubham/workspace/shubh/career-ops';
const OUT = `${ROOT}/batch/_resume-2026-06-26`;
const dir = `${ROOT}/batch/tracker-additions/merged`;
const outputs = fs.readdirSync(`${ROOT}/output`);

const leads = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.tsv')) continue;
  const c = fs.readFileSync(`${dir}/${f}`, 'utf8').trim().split('\t');
  if (c[1] !== '2026-06-26') continue;
  const m = (c[7] || '').match(/\((reports\/[^)]+2026-06-26\.md)\)/);
  if (!m) continue;
  const s = (c[5] || '').replace('/5', '');
  if (parseFloat(s) < 3.5) continue;
  let rp = m[1];
  if (!fs.existsSync(`${ROOT}/${rp}`)) {
    const hit = fs.readdirSync(`${ROOT}/reports`).find(x => x.startsWith(c[0] + '-') && x.endsWith('2026-06-26.md'));
    rp = hit ? `reports/${hit}` : null;
  }
  if (!rp) { leads.push({ num: c[0], company: c[2], role: c[3], score: s, report: null }); continue; }
  const core = rp.split('/').pop().replace(/\.md$/, '').replace(/^\d+-/, '').replace(/-2026-06-26$/, '');
  leads.push({ num: c[0], company: c[2], role: c[3], score: s, report: rp, core });
}
leads.sort((a, b) => parseFloat(b.score) - parseFloat(a.score));

// disambiguate duplicate cores (same-company multi-role) by appending -num
const counts = {};
for (const x of leads) if (x.core) counts[x.core] = (counts[x.core] || 0) + 1;
for (const x of leads) if (x.core && counts[x.core] > 1) x.core = `${x.core}-${x.num}`;

// existence check uses the (possibly disambiguated) core
for (const x of leads) {
  if (!x.core) { x.cvExists = x.clExists = false; continue; }
  x.cvExists = outputs.some(o => o.startsWith(`cv-shubham-jakhmola-${x.core}-`));
  x.clExists = outputs.some(o => o.startsWith(`cover-letter-shubham-jakhmola-${x.core}-`));
}

fs.writeFileSync(`${OUT}/packets.json`, JSON.stringify(leads, null, 2));
const todo = leads.filter(x => x.report && !(x.cvExists && x.clExists));
// clear old chunks, write new
for (const f of fs.readdirSync(OUT)) if (/^packet-\d+\.json$/.test(f)) fs.unlinkSync(`${OUT}/${f}`);
let n = 0;
for (let k = 0; k < todo.length; k += 4) {
  n++;
  const chunk = todo.slice(k, k + 4).map(x => ({ num: x.num, company: x.company, role: x.role, score: x.score, report: x.report, core: x.core }));
  fs.writeFileSync(`${OUT}/packet-${String(n).padStart(2, '0')}.json`, JSON.stringify(chunk, null, 2));
}
console.log(JSON.stringify({ today_leads: leads.length, already_packeted: leads.filter(x => x.cvExists && x.clExists).length, need_packet: todo.length, chunks: n }));
