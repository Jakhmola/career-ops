import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './browser-exec.mjs';
import { writeFileSync } from 'fs';
const SCRATCH = process.argv[2];
const START = parseInt(process.argv[3] || '1106', 10);
const todo = JSON.parse((await import('fs')).readFileSync(SCRATCH + '/werknl-todo.json', 'utf8'));
function kebab(s){return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,55);}
const browser = await chromium.launch(chromiumLaunchOptions(chromium, { headless: true }));
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', locale: 'nl-NL' });
const page = await ctx.newPage();
const items=[], fails=[];
try {
  await page.goto('https://www.werk.nl/nl/vacatures/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3500);
  await page.evaluate(() => { const el=document.querySelector('#js-pw-consent-wrapper'); if(el) el.remove(); });
  let idx=0;
  for (const r of todo) {
    const id=(r.url.match(/vacatures\/(\d+)/)||[])[1];
    const myNum=START+idx; idx++;
    if(!id){ fails.push({num:myNum,company:r.company,err:'no id'}); continue; }
    try{
      await page.goto(`https://www.werk.nl/nl/vacatures/${id}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1800);
      if(/login|checkpoint|oam/.test(page.url())){ fails.push({num:myNum,company:r.company,err:'sso-redirect'}); continue; }
      const text = await page.evaluate(() => {
        const m=document.querySelector('main'); return m? m.innerText.trim() : (document.body?document.body.innerText.trim():'');
      });
      if(text.length<200){ fails.push({num:myNum,company:r.company,err:'short '+text.length}); continue; }
      const slug=`werknl-${myNum}-${kebab(r.company)}-${kebab(r.role)}`.slice(0,72).replace(/-+$/,'');
      const jdPath=`jds/${slug}.md`;
      writeFileSync(jdPath, `# ${r.role} — ${r.company}\n\n**Company:** ${r.company}\n**Location:** Netherlands (werk.nl)\n**URL:** ${r.url}\n**Source:** werk.nl detail page (Playwright)\n\n---\n\n${text}\n`);
      items.push({num:myNum, company:r.company, role:r.role, jdPath, pipelineUrl:r.url, url:r.url});
    }catch(e){ fails.push({num:myNum,company:r.company,err:e.message.slice(0,40)}); }
    await page.waitForTimeout(1200 + Math.random()*800);
  }
} finally { await browser.close(); }
writeFileSync(SCRATCH+'/werknl-items.json', JSON.stringify(items));
writeFileSync(SCRATCH+'/werknl-fails.json', JSON.stringify(fails,null,2));
console.log(`werknl JD ok: ${items.length} | failed: ${fails.length}`);
if(items.length) console.log('nums', items[0].num+'-'+items[items.length-1].num);
if(fails.length) console.log('fails:', JSON.stringify(fails.reduce((a,f)=>{a[f.err.split(' ')[0]]=(a[f.err.split(' ')[0]]||0)+1;return a;},{})));
