#!/usr/bin/env node
// reconcile-pdfs.mjs — sync report headers + tracker with the CV PDFs that
// actually exist in output/.
//
// On-demand and batch PDF generation writes files to output/ but does NOT
// rewrite the report's `**PDF:**` header line (it stays "not generated …") or
// always flip the tracker PDF column. The dashboard renders the report header
// verbatim, so a CV that exists on disk still shows "PDF: not generated" — the
// dashboard looks out of sync with reality.
//
// This script is the reconciler:
//   1. Index every CV PDF in output/ (CVs only — cover letters `cover-letter-`/legacy `cl-` ignored).
//   2. Assign each PDF to the report whose slug is its longest filename suffix
//      (longest-match so "…-senior-ai-engineer" never lands on an "ai-engineer"
//      report).
//   3. For each report whose `**PDF:**` header still says "not generated" but a
//      CV PDF exists, rewrite the line to `**PDF:** output/<file> ✅`.
//   4. Flip that report's tracker PDF column to ✅ if it isn't already.
//
// Dry-run by default. Pass --apply to write changes. Idempotent.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.join(ROOT, "reports");
const OUTPUT_DIR = path.join(ROOT, "output");
const TRACKER = fs.existsSync(path.join(ROOT, "data", "applications.md"))
  ? path.join(ROOT, "data", "applications.md")
  : path.join(ROOT, "applications.md");

const APPLY = process.argv.includes("--apply");
const DATE_RE = /-(\d{4}-\d{2}-\d{2})$/;

// slug of a report or pdf base: strip leading "NNN-" and trailing "-YYYY-MM-DD"
function reportSlug(filename) {
  return filename
    .replace(/\.md$/, "")
    .replace(/^\d+-/, "")
    .replace(DATE_RE, "");
}

// base of a CV pdf with the cv-{name}- prefix kept but date/canva removed, so
// the report slug is a clean suffix: cv-shubham-jakhmola-acme-ai-engineer
function pdfBase(filename) {
  let b = filename.replace(/\.pdf$/i, "");
  b = b.replace(DATE_RE, ""); // drop trailing date if present
  b = b.replace(/-canva$/i, ""); // canva variant marker sits before the date
  return b;
}

// 1. index reports
const reportFiles = fs
  .readdirSync(REPORTS_DIR)
  .filter((f) => /^\d+-.*\.md$/.test(f));
const reports = reportFiles.map((f) => ({
  file: f,
  number: f.match(/^(\d+)-/)[1],
  slug: reportSlug(f),
}));
// longest slugs first so longest-suffix wins
const slugsByLength = [...reports].sort((a, b) => b.slug.length - a.slug.length);

// 2. index CV pdfs (exclude cover letters) and assign each to its best report
const pdfFiles = fs
  .readdirSync(OUTPUT_DIR)
  .filter((f) => /\.pdf$/i.test(f) && !/^(cover-letter-|cl-)/i.test(f)); // cl- = legacy cover-letter prefix

const bySlug = new Map(); // reportSlug -> { pdf, date }
for (const pdf of pdfFiles) {
  const base = pdfBase(pdf);
  const match = slugsByLength.find(
    (r) => base === r.slug || base.endsWith("-" + r.slug)
  );
  if (!match) continue;
  const date = (pdf.match(DATE_RE) || [, ""])[1];
  const prev = bySlug.get(match.slug);
  // keep the newest pdf for this report (by date string, else last seen)
  if (!prev || date > prev.date) bySlug.set(match.slug, { pdf, date });
}

// 3. rewrite stale report headers
const PDF_LINE_RE = /^\*\*PDF:\*\*\s*not generated.*$/m;
const fixedReports = [];
for (const r of reports) {
  const hit = bySlug.get(r.slug);
  if (!hit) continue;
  const full = path.join(REPORTS_DIR, r.file);
  const text = fs.readFileSync(full, "utf8");
  if (!PDF_LINE_RE.test(text)) continue; // header already correct / different
  const next = text.replace(
    PDF_LINE_RE,
    `**PDF:** output/${hit.pdf} ✅`
  );
  fixedReports.push({ number: r.number, file: r.file, pdf: hit.pdf });
  if (APPLY) fs.writeFileSync(full, next);
}

// 4. flip tracker PDF column for fixed reports (col index 6, 0-based, in the
//    9-col tracker row: # Date Company Role Score Status PDF Report Notes)
const fixedNums = new Set(fixedReports.map((r) => r.number));
let trackerFixed = 0;
if (fs.existsSync(TRACKER) && fixedNums.size) {
  const lines = fs.readFileSync(TRACKER, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("| ")) continue;
    const reportNum = (line.match(/\[(\d+)\]\(/) || [])[1];
    if (!reportNum || !fixedNums.has(reportNum)) continue;
    const cells = line.split("|");
    // cells: ["", " # ", " Date ", " Company ", " Role ", " Score ",
    //         " Status ", " PDF ", " Report ", " Notes ", ""]
    if (cells.length < 9) continue;
    if (!cells[7].includes("✅")) {
      cells[7] = " ✅ ";
      trackerFixed++;
      if (APPLY) lines[i] = cells.join("|");
    }
  }
  if (APPLY && trackerFixed) fs.writeFileSync(TRACKER, lines.join("\n"));
}

// report
console.log(`CV PDFs indexed:        ${pdfFiles.length}`);
console.log(`Reports matched to PDF: ${bySlug.size}`);
console.log(`Stale headers ${APPLY ? "fixed" : "to fix"}:    ${fixedReports.length}`);
console.log(`Tracker rows ${APPLY ? "flipped" : "to flip"}:   ${trackerFixed}`);
if (fixedReports.length) {
  console.log("\nReports updated:");
  for (const r of fixedReports.slice(0, 50)) {
    console.log(`  #${r.number}  ${r.file}  →  output/${r.pdf}`);
  }
  if (fixedReports.length > 50) console.log(`  … and ${fixedReports.length - 50} more`);
}
if (!APPLY) console.log("\nDry run. Re-run with --apply to write changes.");
