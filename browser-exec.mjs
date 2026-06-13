// browser-exec.mjs — shared Chromium executable resolution for Playwright scripts.
//
// Prefers Playwright's own bundled Chromium when it is present (the normal
// case in CI and after a successful `npx playwright install`). When the
// bundled download is missing or incomplete — which happens in environments
// where the CDN download fails to extract — fall back to a system-installed
// Chrome/Chromium so browser-backed scripts (PDF rendering, --verify,
// liveness checks) still work. Returns `undefined` to mean "let Playwright
// use its default", preserving original behavior everywhere a bundled
// browser exists.
//
// Set PW_CHROME_PATH to force a specific binary ahead of the standard paths.

import { existsSync } from 'fs';

/**
 * Resolve a browser executable for Playwright.
 *
 * @param {{executablePath: () => string}} chromium - Playwright's chromium browser type.
 * @returns {string|undefined} Path to a system browser, or undefined to use Playwright's default.
 */
export function resolveBrowserExecutable(chromium) {
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    // executablePath() can throw if no browser is registered; fall through.
  }
  const candidates = [
    process.env.PW_CHROME_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/chrome',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

/**
 * Build chromium.launch() options with the system-browser fallback applied.
 *
 * @param {{executablePath: () => string}} chromium - Playwright's chromium browser type.
 * @param {object} [base] - Base launch options (headless, etc.).
 * @returns {object} Launch options, with executablePath set only when falling back.
 */
export function chromiumLaunchOptions(chromium, base = {}) {
  const executablePath = resolveBrowserExecutable(chromium);
  return { ...base, ...(executablePath ? { executablePath } : {}) };
}
