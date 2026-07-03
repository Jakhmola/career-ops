#!/usr/bin/env node
// @ts-check

/**
 * linkedin-login.mjs — ONE-TIME headed login helper for the authed LinkedIn
 * scraper (providers/linkedin-auth.mjs).
 *
 * Run this ONCE on YOUR machine (it opens a real browser window). It logs into a
 * BURNER LinkedIn account, lets you clear any 2FA / checkpoint / CAPTCHA by hand,
 * then saves the session cookie to a storageState file the provider loads. After
 * that, scans reuse the cookie — no password is ever needed again (until the
 * session expires, when you just re-run this).
 *
 *   node linkedin-login.mjs                       # uses .env creds, default path
 *   node linkedin-login.mjs --out my-session.json # custom storageState path
 *   node linkedin-login.mjs --headless            # NOT recommended (CAPTCHA needs eyes)
 *
 * Credentials (BURNER ACCOUNT ONLY) come from .env:
 *   LINKEDIN_EMAIL=...
 *   LINKEDIN_PASSWORD=...
 * If they're absent we still open the login page — just log in by hand.
 *
 * ⚠️  SECURITY
 *   • Use a throwaway account. Automated logged-in scraping breaks LinkedIn's
 *     ToS and can get the account restricted. Never use your real profile.
 *   • The password is read from .env and typed into LinkedIn's own form ONLY.
 *     It is never printed, logged, or written to the storageState file.
 *   • The storageState file IS a live session token — it's gitignored. Treat it
 *     like a password; delete it to revoke.
 *
 * This environment (where Claude runs) is headless, so DON'T expect Claude to run
 * this for you — run it yourself where you have a display.
 */

import 'dotenv/config';
import { writeFileSync } from 'fs';
import path from 'path';
import readline from 'readline';

const STORAGE_DEFAULT =
  process.env.LINKEDIN_STORAGE_STATE || 'linkedin-storage-state.json';

function parseArgs(argv) {
  const out = { headless: false, out: STORAGE_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--headless') out.headless = true;
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = path.resolve(args.out);

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('✗ playwright is not installed. Run `npm install` first.');
    process.exit(1);
  }
  const { chromiumLaunchOptions } = await import('./browser-exec.mjs');

  const email = process.env.LINKEDIN_EMAIL || '';
  const password = process.env.LINKEDIN_PASSWORD || '';

  console.log('\n🔐 LinkedIn login helper (burner account)\n');
  if (args.headless) {
    console.log('⚠️  --headless set: you will not be able to solve a CAPTCHA. Prefer headed.\n');
  }
  console.log(email ? `   Using LINKEDIN_EMAIL from .env (${maskEmail(email)})` : '   No LINKEDIN_EMAIL in .env — log in by hand in the window.');
  console.log('');

  const browser = await chromium.launch(
    chromiumLaunchOptions(chromium, { headless: args.headless }),
  );
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
  });
  const page = await context.newPage();

  try {
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Best-effort autofill — LinkedIn owns this form, so the password only ever
    // goes into LinkedIn's own input. Any failure just falls back to manual.
    if (email && password) {
      try {
        await page.fill('#username', email, { timeout: 8000 });
        await page.fill('#password', password, { timeout: 8000 });
        await page.click('button[type="submit"]', { timeout: 8000 });
        console.log('→ Submitted credentials. Solve any 2FA / checkpoint / CAPTCHA in the window.\n');
      } catch {
        console.log('→ Could not autofill (layout change?). Log in by hand in the window.\n');
      }
    } else {
      console.log('→ Log in by hand in the browser window.\n');
    }

    await prompt('When you can see your LinkedIn feed/home (fully logged in), press Enter here to save the session… ');

    // Verify a real authenticated cookie exists before we claim success.
    const cookies = await context.cookies();
    const liAt = cookies.find((c) => c.name === 'li_at' && c.value);
    if (!liAt) {
      console.error(
        '\n✗ No `li_at` session cookie found — you may not be fully logged in.\n' +
          '  Finish logging in (clear any checkpoint), then re-run this helper.',
      );
      await browser.close();
      process.exit(2);
    }

    await context.storageState({ path: outPath });
    console.log(`\n✓ Session saved to ${outPath}`);
    console.log('  This file is a live login token — it is gitignored. Delete it to revoke.');
    console.log('  Enable the scraper: set scrapers.linkedin-auth.enabled: true in portals.yml,');
    console.log('  then evaluate it: node scan-ab-linkedin-auth.mjs\n');
  } finally {
    await browser.close();
  }
}

function maskEmail(e) {
  const [user, domain] = String(e).split('@');
  if (!domain) return '***';
  const head = user.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

main().catch((err) => {
  console.error('Fatal:', err?.message || err);
  process.exit(1);
});
