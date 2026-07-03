import { readFileSync, writeFileSync } from 'fs';
import { buildJobPostingUrl, parseJobDescription } from './providers/linkedin-guest.mjs';
const SCRATCH = process.argv[2]; const START = 1139;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const cr = JSON.parse(readFileSync(SCRATCH + '/todo-rows.json','utf8')).filter(r => r.src==='linkedin' && r.tier==='country-remote');
function kebab(s){return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,55);}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function fetchJd(id){const url=buildJobPostingUrl(id);for(let a=0;a<3;a++){try{const resp=await fetch(url,{headers:{'user-agent':UA}});if(resp.status===429){await sleep(9000);continue;}if(!resp.ok)return{err:'HTTP'+resp.status};return{jd:parseJobDescription(await resp.text())||''};}catch(e){await sleep(3000);}}return{err:'fail'};}
const items=[],fails=[];let i=0;
async function worker(){while(i<cr.length){const idx=i++;const r=cr[idx];const id=(r.url.match(/jobs\/view\/(\d+)/)||[])[1];const myNum=START+idx;await sleep(Math.random()*1500);const res=id?await fetchJd(id):{err:'noid'};const slug=`${kebab(r.company)}-${kebab(r.role)}`.slice(0,66).replace(/-+$/,'');if(res.jd&&res.jd.length>120){const jdPath=`jds/cr-${myNum}-${slug}.md`;writeFileSync(jdPath,`# ${r.role} — ${r.company}\n\n**Company:** ${r.company}\n**Location:** ${r.location}\n**URL:** ${r.url}\n**Source:** linkedin guest jobPosting endpoint\n\n---\n\n${res.jd}\n`);items.push({num:myNum,company:r.company,role:r.role,jdPath,pipelineUrl:r.url});}else fails.push({num:myNum,err:res.err});}}
await Promise.all(Array.from({length:4},()=>worker()));
items.sort((a,b)=>a.num-b.num);
writeFileSync(SCRATCH+'/cr-items.json',JSON.stringify(items));
console.log(`country-remote JD ok: ${items.length} | failed: ${fails.length}`);
