// werkzoeken.nl Cloudflare probe — can a real Chrome (headless and/or headed) pass?
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './browser-exec.mjs';

const HEADLESS = process.argv[2] !== 'headed';
const URL = 'https://www.werkzoeken.nl/vacatures/?trefwoord=AI+engineer';

const browser = await chromium.launch(chromiumLaunchOptions(chromium, { headless: HEADLESS }));
const ctx = await browser.newContext({
  locale: 'nl-NL',
  timezoneId: 'Europe/Amsterdam',
  viewport: { width: 1366, height: 900 },
});
const page = await ctx.newPage();
try {
  const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  console.log('initial status:', resp?.status());
  // give the CF challenge up to 25s to auto-resolve
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(1000);
    const title = await page.title();
    if (!/just a moment|even geduld/i.test(title)) break;
  }
  const title = await page.title();
  const html = await page.content();
  console.log('final title:', title);
  console.log('final url:', page.url());
  console.log('challenge?', /challenges\.cloudflare\.com/.test(html));
  // if we're through, count vacancy links
  const links = await page.$$eval('a[href*="vacature"]', els => els.length).catch(() => -1);
  console.log('vacancy-ish links:', links);
  console.log('html head snippet:', html.slice(0, 300).replace(/\s+/g, ' '));
} catch (e) {
  console.log('ERROR:', e.message.slice(0, 200));
} finally {
  await browser.close();
}
