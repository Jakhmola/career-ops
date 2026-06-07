/**
 * pipeline-prefilter.mjs
 * Pre-filters data/pipeline.md before batch evaluation.
 * Outputs:
 *   data/pipeline-filtered.md  — entries worth evaluating
 *   data/filter-stats.md       — breakdown of what was skipped and why
 *
 * Filter categories (tracked for future pattern analysis):
 *   KEEP           — clear match (AI/ML/DS/DE roles at appropriate level)
 *   skip_fde       — Forward Deployed Engineer roles (skipped — client-facing/presales)
 *   skip_senior    — Senior/Staff/Principal level (skipped — level gap)
 *   skip_sales_mkt — Sales, marketing, BDR, AE, GTM, media
 *   skip_ops       — Operations, supply chain, maintenance, logistics, support
 *   skip_exec      — Director, VP, Head of, C-suite, manager (people mgmt)
 *   skip_pm        — Product Manager, Program Manager, TPM, strategy roles
 *   skip_research  — Research Scientist, Research Staff, PhD-level ML research
 *   skip_design    — Designer, UX, creative
 *   skip_geo       — US-only, APAC-only, LatAm (not accessible from NL without remote)
 *   skip_other     — Legal, compliance, HR, DevRel, finance, other
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

const RAW = readFileSync('./data/pipeline.md', 'utf8');
const lines = RAW.split('\n');

// --- Pattern sets ---

// Patterns that match FDE roles (tag separately, not skip)
const FDE_PATTERNS = [
  /forward.?deployed/i,
  /\bfde\b/i,
  /deployment.?engineer/i,
  /deployed.?ai.?engineer/i,
  /deployment.?strategist/i, // Mistral "AI Deployment Strategist" = FDE-style
  /customer\s+engineer.*agent/i,     // "Customer Engineer, Agent Builder" = FDE-adjacent
  /ai\s+agent\s+architect.*customer/i, // "AI Agent Architect, Customer Experience" = solutions/FDE
];

// Patterns for "too senior" level (staff, principal, lead as prefix)
// Note: "Senior" alone is NOT too senior — leave it in for evaluation
const SENIOR_LEVEL_PATTERNS = [
  /\bstaff\s+(ml|ai|machine|data|software|research|platform|cloud|backend|fullstack|sre)\b/i,
  /\bprincipal\s+(ml|ai|machine|data|software|engineer|scientist|architect|research|consultant)\b/i,
  /\blead\s+(ml|ai|machine|data|software|engineer|scientist|product|architect)\b/i,
  /\btech.?lead.?manager\b/i,
  /\bresearch.?lead\b/i,
  /\bsenior.?staff\b/i, // "Senior/Staff" combined = too senior
  /\bstaff\s*\+\s*sr\b/i,
];

// Executive / people-manager patterns → skip
const EXEC_PATTERNS = [
  /\bvp\s+of\b/i,
  /\bvice.?president\b/i,
  /\bhead\s+of\b/i,
  /\bcto\b/i,
  /\bceo\b/i,
  /\bchief\b/i,
  /\bdirector\s+of\b/i,
  /\bdirector,\s/i,
  /\bmanager\s+of\s+(applied|technical|solutions|ai)\b/i,
  /\bengineering\s+manager\b/i,
  /\bml.?science\s+manager\b/i,
  /\bml.*manager\b/i,
  /\bdata.*manager\b(?!.*engineering)/i,
  /\bsenior\s+manager\b/i,
  /\bmanager,\s/i,
  /\bprincipal\s+client\b/i,
  /\bglobal.*lead\b/i,
  /\bglobal.*applied.*architecture\b/i,
  /\bfield\s+cto\b/i,
  /\btechnical\s+director\b/i,
  /\bml.*engineering\s+manager\b/i,
  /\bgeneral\s+manager\b/i,
  /\bmanager[–-]+\s*growth\s+sales/i,
];

// Sales / Marketing / GTM patterns → skip
const SALES_MKT_PATTERNS = [
  /account\s+executive/i,
  /account\s+manager(?!\s*,?\s*agentic)/i, // "Account Manager" but not "Agent"
  /business\s+development/i,
  /\bbdr\b/i,
  /sales\s+director/i,
  /sales\s+trainer/i,
  /sales\s+strategy/i,
  /sales\s+engineer(?!\s*[–-]\s*(emea|ai|ml|europe))/i, // "Sales Engineer" unless EMEA-specific SA
  /sales\s+operations/i,
  /mid.?market\s+account/i,
  /paid\s+media/i,
  /paid\s+search/i,
  /paid\s+social/i,
  /campaign\s+manager/i,
  /campaign\s+lead/i,
  /lifecycle.*marketing/i,
  /lifecycle.*crm/i,
  /crm.*campaign/i,
  /brand\s+solutions/i,
  /product\s+marketing/i,
  /growth\s+marketing/i,
  /b2b.*marketing/i,
  /marketing\s+manager/i,
  /marketing.*customer/i,
  /marketing.*content/i,
  /media\s+director/i,
  /media\s+manager/i,
  /media\s+strategist/i,
  /commercial\s+terrain/i,
  /agent\s+commercial/i,
  /agenti\s+di\s+commercio/i,
  /agenti\s+di\s+vendita/i,
  /agenti?\s+de\s+ventas/i,
  /executivo.*de\s+vendas/i,
  /\bcommerciale?\s+terrain\b/i,
  /ai\s+social\s+strategist/i,
  /artist.*label.*partner/i,
  /sponsor.*partner/i,
  /retail\s+media\s+strategist/i,
  /sales\s+and\s+operations/i,
  /revenue.*manager/i,
  /\bgtm\b.*(?:sales|native)/i,
  /gtm\s+enablement/i,
  /gtm\s+ecosystem/i,
  /growth\s+account/i,
  /emerging\s+account/i,
  /enterprise\s+account/i,
  /strategic\s+account/i,
  /channel.*partner.*manager/i,
  /cloud.*technology.*partner.*manager/i,
  /senior\s+integrated\s+campaign/i,
  /ai\s+outcomes\s+manager/i, // Glean's customer success = skip
  /ai\s+success\s+manager/i,
  /director,\s+ai\s+success/i,
  /manager,\s+ai\s+outcomes/i,
  /customer\s+campaigns/i,
  /field\s+sales/i,
  /independent\s+sales/i,
  /freelance.*sales/i,
  /evangelis[mt]/i, // "evangelist"
  /developer\s+advocate/i,
  /devrel\b/i,
  /ai\s+community\s+engineer/i,
  /community\s+engineer/i,
  /open.?source.*devrel/i,
  /cloud\s+ml\s+devrel/i,
];

// Operations / Maintenance / Support / Logistics → skip
const OPS_PATTERNS = [
  /supply\s+chain(?!\s+solution\s+consultant)/i, // skip supply chain ops but not "SC solution consultant" (already PM-skip)
  /maintenance\s+(?:tech|engineer|manager|planner|specialist|lead)/i,
  /anlagentechniker/i,
  /schichtleiter/i,
  /teamleiter/i,
  /fulfillment/i,
  /instandhaltung/i,
  /lagerlogistik/i,
  /warehouse/i,
  /facilities.*manager/i,
  /area\s+manager/i,
  /operations\s+manager/i,
  /operations\s+trainer/i,
  /workforce\s+management\s+and\s+ai\s+analyst/i,
  /claims.*risk\s+analyst/i,
  /production\s+manager\b/i,
  /production.*fulfillment/i,
  /(?:customer\s+care|customer\s+support)\s+(?:agent|specialist)/i,
  /customer\s+support\s+agent/i,
  /supply\s+chain\s+(?:co.?op|compliance|development|program)/i,
  /fleet\s+service\s+and\s+maintenance/i,
  /sustainability\s+manager/i,
];

// Product Manager / Program Manager / Strategy / Consulting (non-technical) → skip
const PM_PATTERNS = [
  /\bproduct\s+manager\b/i,
  /\btechnical\s+program\s+manager\b/i,
  /\bprogram\s+manager\b(?!\s+ai)/i,
  /\bproduct\s+designer\b/i, // distinct from AI engineer with design skills
  /\bai\s+product\s+manager\b/i,
  /\bsenior\s+product\s+manager\b/i,
  /\blead\s+product\s+manager\b/i,
  /\bprincipal\s+product\s+manager\b/i,
  /\bstaff\s+ai\s+product\s+manager\b/i,
  /\bagent\s+strategy\s+manager\b/i,
  /\bstrategist,\s+agent\b/i,
  /\bstrategy.*\sconsultant\b/i,
  /\bclient\s+value\s+partner\b/i,
  /\bclient\s+engagement\s+partner\b/i,
  /\bclient\s+account\s+lead\b/i,
  /\bvalue\s+engineer\b/i,
  /\blead\s+value\s+engineer\b/i,
  /\bai\s+transformation\s+lead\b/i,
  /\bbusiness.*transformation\b/i,
  /supply\s+chain\s+solution\s+consultant/i,
  /\bsolutions?\s+consultant\b(?!.*(?:ml|machine|learning))/i, // skip generic "Solutions Consultant"
  /\bsenior\s+applied\s+ai\s+solutions\s+consultant\b/i,
  /\bstrategic\s+applied\s+ai\s+solutions\b/i,
  /\bai\s+strategy\s+consultant\b/i,
  /\bforward\s+deployed\s+marketing\b/i,
  /\bassociate\s+(?:ai\s+)?deployment\s+strategist\b/i, // Mistral's junior FDE → still FDE
  /\bpartner.*solutions.*architect\b/i, // "Partner Solutions Architect" at Anthropic
  /\bglobal\s+applied\s+ai\s+architecture\s+lead\b/i,
  /\bapplied\s+ai\s+architect\b/i, // Anthropic "Applied AI Architect" = solutions architect/senior
  /\bsolutions\s+architect\b(?!.*(?:remote|emea))/i, // skip SA unless remote/EMEA context
  /\bai.*deployment\s+architect\b/i,
  /\bai\s+deployment\s+architect\b/i,
  /\blead\s+ai\s+consultant\b/i,
  /\blead\s+ai\s+agent\s+architect\b/i,
  /\blead\s+agent\s+architect\b/i,
  /\bsenior\s+agent\s+architect\b/i, // Parloa "Senior Agent Architect" = solutions/SA role
  /\bpartner\s+integration\s+engineer\b/i,
  /\bgtme.*teacher\b/i,
  /\bai.*teacher\b/i,
  /\btrainer,\s+gtm\b/i,
  /\bagentic\s+ai\s+advocate\b/i,
  /\bai\s+creative\s+(?:designer|producer)\b/i,
  /\bpigment.*supply\s+chain/i,
];

// Legal / Compliance / Finance / Government / HR → skip
const LEGAL_COMPLIANCE_PATTERNS = [
  /\blegal\s+(?:counsel|trainee|head)\b/i,
  /\bai\s+compliance\s+officer\b/i,
  /\bcompliance\b(?!.*engineer)/i, // compliance roles but not "compliance engineer"
  /\baml\s+(?:investigator|operations)\b/i,
  /\bmlro\b/i,
  /\bgrc.*risk\b/i,
  /\bgovernment\s+affairs\b/i,
  /\bregulatory\s+affairs\b/i,
  /\bfraud\s+prevention\s+agent\b/i,
  /\bpeople\s+systems\s+builder\b/i,
  /\bhr\b/i,
  /\btransformative\s+ai\s+research\s+economist\b/i,
  /\bmember\s+of\s+staff,\s+ai\s+&\s+rule\s+of\s+law\b/i,
  /\bhead\s+of\s+global\s+regulatory\b/i,
  /senior\s+aml\s+investigator/i,
  /team\s+lead\s+aml/i,
  /\bmlro.?grc\b/i,
  /government\s+affairs/i,
  /\bai\s+governance\s+engineer\b/i, // GetYourGuide "Senior AI Governance" = legal/compliance
  /corporate\s+affairs/i,
  /supply\s+chain\s+compliance\b/i,
  /threat\s+intelligence\b/i,
  /supply\s+chain\s+compliance\b/i,
  /\bfinance\s+data\s+(?:scientist|engineer)\b/i, // finance-domain DS/DE
];

// Design / UX / creative → skip
const DESIGN_PATTERNS = [
  /(?:product|staff|ai|ux|experience)\s+designer(?!\s+ai\s+native)/i,
  /design\s+lead/i,
  /product\s+design\s+lead/i,
  /ai\s+creative\s+designer/i,
  /\bagent\s+designer\b/i,         // PolyAI "Agent Designer" = conversational UX
  /\bdesign\s+engineer\b/i,         // "Design Engineer" = frontend/UI role
];

// PhD-level research (different from "research engineer") → skip
const RESEARCH_PHD_PATTERNS = [
  /research\s+scientist(?!\s*\(applied)/i, // "Research Scientist" = PhD, except "Applied" variant
  /\bphd\b/i,
  /discovery\s+scientist/i,
  /\bai\s+scientist\s*-\s*(?:audio|robotics|palo|paris|zurich|warsaw)/i, // Mistral's pure research
  /\bai\s+researcher\b(?!.*engineer)/i, // "AI Researcher" not "AI Research Engineer"
  /research\s+staff\b/i,
  /member\s+of\s+staff.*post.?training\b/i,
  /member\s+of\s+staff.*pre.?training\b/i,
  /\bmember\s+of\s+technical\s+staff.*(?:pre.?training|post.?training|training\s+(?:infra|perf))/i,
  /multimodal\s+generative\s+ai\s+researcher/i,
  /(?:senior|staff|principal)\s+research\s+(?:scientist|engineer.*pre.?train)/i,
  /ai\s+researcher.*foundation\s+model/i,
  /pretraining\s+scaling/i,
  /pre-training\s+scaling/i,
  /rl\s+engineering\b/i, // Anthropic "RL Engineering" = very specialized research
  /reinforcement\s+learning.*engineer\b/i,
  /production\s+model\s+post.?training\b/i,
  /machine\s+learning\s+researcher\b/i, // "ML Researcher" = research role, not engineer
  /\bresearcher,\s+post\s+training\b/i,
  /research\s+engineer.*pretraining\b/i, // Anthropic "Research Engineer, Pretraining"
  /research\s+engineer.*pre.?training\b/i,
];

// Geography filters (explicit US/APAC locations, not accessible from NL without sponsorship)
const GEO_SKIP_PATTERNS = [
  /\s[-–]\s*(sf|san\s+francisco)\b/i,
  /\s[-–]\s*ny\b(?!c)/i,
  /\s[-–]\s*nyc\b/i,
  /\s[-–]\s*new\s+york\b/i,
  /\s[-–]\s*vancouver\b/i,
  /\s[-–]\s*montreal\b/i,
  /\s[-–]\s*canada\b/i,
  /\s[-–]\s*palo\s+alto\b/i,
  /\s[-–]\s*seattle\b/i,
  /\s[-–]\s*latam\b/i,
  /\s[-–]\s*taiwan\b/i,
  /\s[-–]\s*korea\b/i,
  /\s[-–]\s*singapore\b/i,
  /\s[-–]\s*mumbai\b/i,
  /\s[-–]\s*india\b/i,
  /\s[-–]\s*(apj|anz|apac)\b/i,
  /\s[-–]\s*australia\b/i,
  /\s[-–]\s*(mena|morocco|melbourne|canberra|seoul|abu\s+dhabi)\b/i,
  /\s[-–]\s*(brazil|chile|colombia|mexico)\b/i,
  /must\s+be\s+pst\s+timezone/i,
  /\(must\s+be\s+pst/i,
];

// Misc skips: working students, co-ops, interns, field tech
const MISC_SKIP_PATTERNS = [
  /working\s+student/i,
  /co.?op\b/i,
  /\bintern\b/i,
  /rechtsreferendar/i,
  /isa\s*[-–]\s*merchant/i,
  /site\s+reliability\s+engineer(?!.*ai.*ml)/i, // SRE unless AI/ML context
  /\bsre\b(?!.*ai.*ml)/i,
  /cloud\s+sre/i,
  /devsecopsi?/i,
  /qai?\s+engineer\b/i, // QA engineer
  /quality\s+engineer.*\bai\b/i,
  /software\s+quality\s+engineer/i,
  /spontaneous\s+application/i,
  /systems\s+engineer.*(?:air|command|control|autonomous\s+air)/i,
  /\bstaff\s+ui\b/i,               // "Staff UI Software Engineer" = frontend/UI + too senior
  /founder['']s\s+office/i,         // "Founder's Office" = strategy/ops hybrid
  /^partnerships,/i,                // "Partnerships, Agent Delivery Lead" = bizdev
  /\bsystems\s+architect\b/i,       // "Systems Architect" = too senior solutions role
  /airborne\s+mission/i,
  /autonomous\s+air\s+system/i,
  /ground\s+to\s+air\s+hmi/i,
  /programme\s+manager.*air\s+defence/i,
  /supply\s+chain\s+(?:program\s+manager|manager\b)/i,
  /fleet\s+service/i,
  /field\s+engineer.*hpc/i,
];

// --- Categorize a single entry ---

function categorize(title) {
  const t = title || '';

  // FDE — skip entirely
  if (FDE_PATTERNS.some(p => p.test(t))) return 'skip_fde';

  // "Solutions Architect" as standalone title = FDE-adjacent, skip
  if (/\bsolutions?\s+architect\b/i.test(t) && !/senior\s+applied\s+ai\s+engineer/i.test(t)) {
    return 'skip_fde';
  }

  // Exec/manager
  if (EXEC_PATTERNS.some(p => p.test(t))) return 'skip_exec';

  // Sales / marketing / GTM
  if (SALES_MKT_PATTERNS.some(p => p.test(t))) return 'skip_sales_mkt';

  // Operations / maintenance / logistics / support
  if (OPS_PATTERNS.some(p => p.test(t))) return 'skip_ops';

  // PM / strategy / consulting
  if (PM_PATTERNS.some(p => p.test(t))) return 'skip_pm';

  // Legal / compliance / finance / HR
  if (LEGAL_COMPLIANCE_PATTERNS.some(p => p.test(t))) return 'skip_other';

  // Design
  if (DESIGN_PATTERNS.some(p => p.test(t))) return 'skip_other';

  // PhD research
  if (RESEARCH_PHD_PATTERNS.some(p => p.test(t))) return 'skip_research';

  // Geo skip
  if (GEO_SKIP_PATTERNS.some(p => p.test(t))) return 'skip_geo';

  // Misc
  if (MISC_SKIP_PATTERNS.some(p => p.test(t))) return 'skip_other';

  // Senior / staff / principal level — skip entirely
  if (SENIOR_LEVEL_PATTERNS.some(p => p.test(t))) return 'skip_senior';

  // Default: keep
  return 'keep';
}

// --- Parse pipeline ---

const entries = [];
let inPending = false;
let section = '';

for (const line of lines) {
  if (/^##\s+(?:Pending|Pendientes)/i.test(line)) { inPending = true; section = 'pending'; continue; }
  if (/^##\s+Processed/i.test(line)) { inPending = false; section = 'processed'; continue; }
  if (/^##\s+Level\s+3/i.test(line)) { inPending = true; section = 'level3'; continue; }

  if (inPending && /^- \[ \]/.test(line)) {
    const match = line.match(/^- \[ \]\s+(https?:\/\/[^\s|]+)(?:\s*\|\s*([^|]+?))?(?:\s*\|\s*(.+))?$/);
    if (match) {
      const url = match[1].trim();
      const company = match[2] ? match[2].trim() : '';
      const title = match[3] ? match[3].trim() : '';
      const category = categorize(title);
      entries.push({ url, company, title, category, raw: line });
    }
  }
}

// --- Tally stats ---

const stats = {};
const byCompany = {};

for (const e of entries) {
  stats[e.category] = (stats[e.category] || 0) + 1;
  if (!byCompany[e.company]) byCompany[e.company] = { keep: 0, skip: 0 };
  if (e.category === 'keep') byCompany[e.company].keep++;
  else byCompany[e.company].skip++;
}

const total = entries.length;
const keepCount = (stats.keep || 0);
const skipCount = total - keepCount;
const evaluateCount = keepCount;

// --- Write filtered pipeline ---

const keepEntries = entries.filter(e => e.category === 'keep');

let filteredMd = `# Pipeline — Filtered for Evaluation\n`;
filteredMd += `\n_Pre-filtered on ${new Date().toISOString().slice(0,10)}. ${total} raw → ${evaluateCount} for evaluation._\n`;
filteredMd += `\n_Run \`/career-ops batch\` to process all entries below._\n`;

filteredMd += `\n## Core Matches (${keepCount})\n\n`;
for (const e of keepEntries) {
  filteredMd += `- [ ] ${e.url} | ${e.company} | ${e.title}\n`;
}

writeFileSync('./data/pipeline-filtered.md', filteredMd);

// --- Write filter stats report ---

const skipReasons = {
  skip_sales_mkt: 'Sales / Marketing / GTM',
  skip_ops: 'Operations / Maintenance / Support',
  skip_exec: 'Executive / People Manager',
  skip_pm: 'Product Manager / Strategy / Consulting',
  skip_research: 'Research Scientist / PhD-level ML',
  skip_fde: 'Forward Deployed Engineer',
  skip_senior: 'Senior / Staff / Principal Level',
  skip_geo: 'Wrong Geography (US/APAC-only)',
  skip_other: 'Legal / Compliance / Design / Other',
};

// Top skipped companies
const skippedByCompany = Object.entries(byCompany)
  .map(([company, s]) => ({ company, skip: s.skip, keep: s.keep }))
  .sort((a, b) => b.skip - a.skip)
  .slice(0, 15);

let report = `# Pipeline Filter Report\n\n`;
report += `**Date:** ${new Date().toISOString().slice(0,10)}\n`;
report += `**Total raw entries:** ${total}\n\n`;

report += `## Summary\n\n`;
report += `| Category | Count | % of total |\n`;
report += `|----------|-------|------------|\n`;
report += `| **For evaluation (KEEP)** | **${evaluateCount}** | **${pct(evaluateCount, total)}** |\n`;
report += `| Skipped total | ${skipCount} | ${pct(skipCount, total)} |\n\n`;

report += `## Skip Breakdown\n\n`;
report += `| Reason | Count | % of skipped |\n`;
report += `|--------|-------|---------------|\n`;
for (const [key, label] of Object.entries(skipReasons)) {
  const n = stats[key] || 0;
  if (n > 0) report += `| ${label} | ${n} | ${pct(n, skipCount)} |\n`;
}

report += `\n## Top Companies by Skip Count\n\n`;
report += `| Company | Skipped | Keep |\n`;
report += `|---------|---------|------|\n`;
for (const row of skippedByCompany) {
  if (row.skip > 0) {
    report += `| ${row.company} | ${row.skip} | ${row.keep} |\n`;
  }
}

report += `\n## What This Tells You\n\n`;
report += `- **Sales/marketing roles** are the biggest noise source — primarily from Glean (AI Outcomes/Success), SumUp (field sales agents), Celonis (Client Value Partners), and Mistral (Deployment Strategists).\n`;
report += `- **Operations/maintenance** noise mainly from HelloFresh and SumUp (their scanner keywords matched on "AI" in company name, not role).\n`;
report += `- **FDE roles** (${stats.skip_fde || 0}) are now skipped entirely — client-facing/presales focus doesn't fit the profile.\n`;
report += `- **Senior/Staff/Principal roles** (${stats.skip_senior || 0}) are now skipped entirely — level gap.\n`;
report += `- **Portals.yml improvement**: Consider adding title exclusions for "Account Executive", "Operations", "Maintenance", "Agent Commercial" to reduce noise at scan time.\n`;

writeFileSync('./data/filter-stats.md', report);

// --- Print summary ---

console.log(`\n=== Pipeline Pre-filter Results ===\n`);
console.log(`Raw entries:      ${total}`);
console.log(`─────────────────────────────────`);
console.log(`FOR EVALUATION:   ${evaluateCount}  (${pct(evaluateCount, total)})`);
console.log(`Skipped:          ${skipCount}  (${pct(skipCount, total)})`);
console.log(`\nSkip breakdown:`);
for (const [key, label] of Object.entries(skipReasons)) {
  const n = stats[key] || 0;
  if (n > 0) console.log(`  ${label.padEnd(38)} ${String(n).padStart(3)}`);
}
console.log(`\nOutputs:`);
console.log(`  data/pipeline-filtered.md  (evaluate this)`);
console.log(`  data/filter-stats.md       (stats + patterns)`);

function pct(n, total) {
  return total > 0 ? `${Math.round(n / total * 100)}%` : '0%';
}
