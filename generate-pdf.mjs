#!/usr/bin/env node

/**
 * generate-pdf.mjs — HTML → PDF via Playwright
 *
 * Usage:
 *   node career-ops/generate-pdf.mjs <input.html> <output.pdf> [--format=letter|a4]
 *
 * Requires: @playwright/test (or playwright) installed.
 * Uses Chromium headless to render the HTML and produce a clean, ATS-parseable PDF.
 */

import { chromium } from 'playwright';
import { resolve, dirname } from 'path';
import { readFile } from 'fs/promises';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Ensure output directory exists (fresh setup)
mkdirSync(resolve(__dirname, 'output'), { recursive: true });

/**
 * Normalize text for ATS compatibility by converting problematic Unicode.
 *
 * ATS parsers and legacy systems often fail on em-dashes, smart quotes,
 * zero-width characters, and non-breaking spaces. These cause mojibake,
 * parsing errors, or display issues. See issue #1.
 *
 * Only touches body text — preserves CSS, JS, tag attributes, and URLs.
 * Returns { html, replacements } so the caller can log what was changed.
 */
function normalizeTextForATS(html) {
  const replacements = {};
  const bump = (key, n) => { replacements[key] = (replacements[key] || 0) + n; };

  const masks = [];
  const masked = html.replace(
    /<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi,
    (match) => {
      const token = `\u0000MASK${masks.length}\u0000`;
      masks.push(match);
      return token;
    }
  );

  let out = '';
  let i = 0;
  while (i < masked.length) {
    const lt = masked.indexOf('<', i);
    if (lt === -1) { out += sanitizeText(masked.slice(i)); break; }
    out += sanitizeText(masked.slice(i, lt));
    const gt = masked.indexOf('>', lt);
    if (gt === -1) { out += masked.slice(lt); break; }
    out += masked.slice(lt, gt + 1);
    i = gt + 1;
  }

  const restored = out.replace(/\u0000MASK(\d+)\u0000/g, (_, n) => masks[Number(n)]);
  return { html: restored, replacements };

  function sanitizeText(text) {
    if (!text) return text;
    let t = text;
    t = t.replace(/\u2014/g, () => { bump('em-dash', 1); return '-'; });
    t = t.replace(/\u2013/g, () => { bump('en-dash', 1); return '-'; });
    // Same dashes written as HTML entities (templates/generated HTML use &mdash;/&ndash;).
    // The raw-char passes above don't match the literal entity strings, so handle them too.
    t = t.replace(/&mdash;|&#8212;|&#x2014;/gi, () => { bump('em-dash', 1); return '-'; });
    t = t.replace(/&ndash;|&#8211;|&#x2013;/gi, () => { bump('en-dash', 1); return '-'; });
    t = t.replace(/[\u201C\u201D\u201E\u201F]/g, () => { bump('smart-double-quote', 1); return '"'; });
    t = t.replace(/[\u2018\u2019\u201A\u201B]/g, () => { bump('smart-single-quote', 1); return "'"; });
    t = t.replace(/\u2026/g, () => { bump('ellipsis', 1); return '...'; });
    t = t.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, () => { bump('zero-width', 1); return ''; });
    t = t.replace(/\u00A0/g, () => { bump('nbsp', 1); return ' '; });
    // Arrows often stripped by PDF text extractors \u2014 replace with ASCII for ATS safety.
    // Consume surrounding whitespace to avoid double-spacing in output.
    t = t.replace(/\s*\u2192\s*/g, () => { bump('right-arrow', 1); return ' to '; });
    t = t.replace(/\s*\u2190\s*/g, () => { bump('left-arrow', 1); return ' from '; });
    t = t.replace(/\s*[\u2191\u2193]\s*/g, () => { bump('vert-arrow', 1); return ' '; });
    // Middle dot and bullet glyphs garble in some extractors \u2014 replace with pipe.
    t = t.replace(/\s*\u00B7\s*/g, () => { bump('middot', 1); return ' | '; });
    t = t.replace(/\s*\u2022\s*/g, () => { bump('bullet', 1); return ' | '; });
    // Currency symbols sometimes stripped by font-subsetted PDFs \u2014 spell out
    // the unambiguous ones. \u00A5 is intentionally NOT converted: it maps to both
    // Japanese Yen (JPY) and Chinese Yuan (CNY), so any spelled-out code would be
    // wrong for half of users \u2014 better to leave the glyph than emit bad data.
    t = t.replace(/\u20AC/g, () => { bump('euro', 1); return 'EUR '; });
    t = t.replace(/\u00A3/g, () => { bump('pound', 1); return 'GBP '; });
    // Greek letters / math operators used as variables in ML/stats prose (e.g. Cohen's
    // kappa, >=85%). They're outside the Latin static-font subset, so they trigger a
    // fallback-font glyph (a stray LiberationSans in the PDF) and can garble extraction.
    // Spell out / ASCII-ify; handle both raw chars and HTML entities. Deliberately narrow
    // to unambiguous cases (mu is intentionally NOT mapped \u2014 it would mangle "50\u00B5s").
    t = t.replace(/\u03BA|&kappa;/g, () => { bump('greek-kappa', 1); return 'kappa'; });
    t = t.replace(/\u2265|&ge;|&#8805;/g, () => { bump('ge', 1); return '>='; });
    t = t.replace(/\u2264|&le;|&#8804;/g, () => { bump('le', 1); return '<='; });
    return t;
  }
}

/**
 * Inline self-hosted @font-face sources (url('./fonts/X')) as base64 data: URIs.
 *
 * Why base64 and not file:// URLs: when the page is created via page.setContent(),
 * Chromium treats cross-directory file:// font fetches as opaque-origin subresources
 * and silently blocks them \u2014 the document falls back to a system font (Liberation/Arial).
 * Inlined data: URIs carry no origin, so they always load.
 *
 * Pair this with STATIC (single-weight) TTFs in fonts/, NOT variable woff2: Chromium
 * cannot cleanly subset a variable font into the PDF and falls back to Type 3 glyph
 * procedures, which corrupts ATS text extraction (spurious spaces inside words, e.g.
 * "j4khmola @gma il.com"). Static TTFs embed as CID TrueType and extract cleanly.
 */
async function inlineFonts(html, fontsDir) {
  const mime = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };
  const refs = new Set();
  for (const m of html.matchAll(/url\(['"]?\.\/fonts\/([^'")]+)['"]?\)/g)) refs.add(m[1]);
  for (const file of refs) {
    const ext = file.split('.').pop().toLowerCase();
    try {
      const b64 = (await readFile(resolve(fontsDir, file))).toString('base64');
      const re = new RegExp(
        `url\\(['"]?\\.\\/fonts\\/${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\)`,
        'g'
      );
      html = html.replace(re, `url(data:${mime[ext] || 'font/ttf'};base64,${b64})`);
    } catch {
      console.warn(`\u26A0\uFE0F  font not found, leaving reference as-is: ${file}`);
    }
  }
  return html;
}

async function generatePDF() {
  const args = process.argv.slice(2);

  // Parse arguments
  let inputPath, outputPath, format = 'a4';

  for (const arg of args) {
    if (arg.startsWith('--format=')) {
      format = arg.split('=')[1].toLowerCase();
    } else if (!inputPath) {
      inputPath = arg;
    } else if (!outputPath) {
      outputPath = arg;
    }
  }

  if (!inputPath || !outputPath) {
    console.error('Usage: node generate-pdf.mjs <input.html> <output.pdf> [--format=letter|a4]');
    process.exit(1);
  }

  inputPath = resolve(inputPath);
  outputPath = resolve(outputPath);

  // Ensure the output file's parent directory exists (e.g. output/cover-letters/)
  mkdirSync(dirname(outputPath), { recursive: true });

  // Validate format
  const validFormats = ['a4', 'letter'];
  if (!validFormats.includes(format)) {
    console.error(`Invalid format "${format}". Use: ${validFormats.join(', ')}`);
    process.exit(1);
  }

  console.log(`📄 Input:  ${inputPath}`);
  console.log(`📁 Output: ${outputPath}`);
  console.log(`📏 Format: ${format.toUpperCase()}`);

  // Read HTML and inline self-hosted fonts as base64 data: URIs (see inlineFonts).
  let html = await readFile(inputPath, 'utf-8');
  html = await inlineFonts(html, resolve(__dirname, 'fonts'));

  // Normalize text for ATS compatibility (issue #1)
  const normalized = normalizeTextForATS(html);
  html = normalized.html;
  const totalReplacements = Object.values(normalized.replacements).reduce((a, b) => a + b, 0);
  if (totalReplacements > 0) {
    const breakdown = Object.entries(normalized.replacements).map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`🧹 ATS normalization: ${totalReplacements} replacements (${breakdown})`);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // Set content with file base URL for any relative resources
    await page.setContent(html, {
      waitUntil: 'networkidle',
      baseURL: `file://${dirname(inputPath)}/`,
    });

    // Wait for fonts to load
    await page.evaluate(() => document.fonts.ready);

    // Generate PDF
    const pdfBuffer = await page.pdf({
      format: format,
      printBackground: true,
      margin: {
        top: '0.6in',
        right: '0.6in',
        bottom: '0.6in',
        left: '0.6in',
      },
      preferCSSPageSize: false,
    });

    // Write PDF
    const { writeFile } = await import('fs/promises');
    await writeFile(outputPath, pdfBuffer);

    // Count pages (approximate from PDF structure)
    const pdfString = pdfBuffer.toString('latin1');
    const pageCount = (pdfString.match(/\/Type\s*\/Page[^s]/g) || []).length;

    console.log(`✅ PDF generated: ${outputPath}`);
    console.log(`📊 Pages: ${pageCount}`);
    console.log(`📦 Size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

    return { outputPath, pageCount, size: pdfBuffer.length };
  } finally {
    await browser.close();
  }
}

generatePDF().catch((err) => {
  console.error('❌ PDF generation failed:', err.message);
  process.exit(1);
});
