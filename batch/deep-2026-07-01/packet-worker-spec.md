# Phase 3 — CV + Cover-Letter Packet Worker Spec (deep scan 2026-07-01)

You generate **tailored CV + cover-letter PDF packets** for already-evaluated reports scoring **≥3.5**.
Candidate: **Shubham Jakhmola**. Today's date: **2026-07-01**.

## Read FIRST (once)
1. `cv.md` — canonical CV, source of truth for experience/metrics. NEVER invent metrics.
2. `modes/_profile.md` — archetypes, narrative, cover-letter + CV-summary rules, writing style (PINNED sections govern).
3. `article-digest.md` — proof points (takes precedence over cv.md for project metrics).
4. `config/profile.yml` — name/email/phone/location/linkedin/github.
5. `templates/cv-template.html` + `templates/cover-letter-local.html` — the `{{...}}` templates.
6. `modes/pdf.md` + `modes/cover-letter.md` — placeholder docs + the narrative letter procedure.

Contact (profile.yml): "Shubham Jakhmola", j4khmola@gmail.com, "+31 6 49975488",
"Amsterdam, Netherlands", linkedin "linkedin.com/in/jakhmola", github "jakhmola.github.io".

## Your input
A list of report file paths + their core-slug (`{company-kebab}-{role-kebab}`), all pre-filtered to score ≥3.5.

## Per report

### Step 0 — Skip if already done
- If `output/cv-shubham-jakhmola-{core}-*.pdf` exists → SKIP CV. If `output/cover-letter-shubham-jakhmola-{core}-*.pdf` exists → SKIP CL. Both exist → status `already-present`, move on.

### Step 1 — Read the report
Mine the `## Fit` table, `Archetype`, `## Keywords`, `**URL:**`, score, company, role.
**Re-confirm the language gate:** if the report says SKIP / ⛔ language-required, generate NOTHING for it — record `lang-skip`.

### Step 2 — Tailor the CV (HTML)
- Detect archetype → adapt framing per `_profile.md`. Prefer project **G1 Interview Coach** for AI/LLM/agentic/RAG roles (per _profile).
- Paper: NL/EU → `a4` (all these are NL/EU). 
- Professional Summary: follow the PINNED "CV Summary Voice" rules in `_profile.md` (2–4 sentences, ONE number max, no em-dashes, lead with the cross-cutting differentiator, close with honest availability/visa line).
- Core Competencies: 6 phrases from the JD `## Keywords`.
- Reorder experience bullets by JD relevance; inject exact JD vocabulary into REAL achievements only.
- Select top 3–4 relevant projects. Fill EVERY `{{...}}` placeholder (docs in `modes/pdf.md`).
- Write HTML to `/tmp/cv-shubham-jakhmola-{core}.html`.
- Generate: `node generate-pdf.mjs /tmp/cv-shubham-jakhmola-{core}.html output/cv-shubham-jakhmola-{core}-2026-07-01.pdf --format=a4`

### Step 3 — Cover letter (HTML → generate-pdf.mjs)
Follow `modes/cover-letter.md` + the PINNED "Cover Letter Voice" rules in `_profile.md`: ONE proof story
(constraint → decision → outcome), **≤3 numbers total**, P1 company-specific (a verifiable detail about
THIS role — no reusable mission paraphrase), honest gap framing, relocation/visa line per Location Policy
when the role is away from Amsterdam or outside NL, no "passionate about"/"leveraged"/"spearheaded", no
em-dashes/semicolon stacks. ~180–230 words, 1 page. English regardless of JD language.
Fill `templates/cover-letter-local.html`, write to `/tmp/cover-letter-shubham-jakhmola-{core}.html`.
Do NOT use `generate-cover-letter.mjs` (wrong letter type).
- Generate: `node generate-pdf.mjs /tmp/cover-letter-shubham-jakhmola-{core}.html output/cover-letter-shubham-jakhmola-{core}-2026-07-01.pdf --format=a4`

### Step 4 — Verify
Confirm both PDFs exist non-zero (`ls -la output/...`). On generator error: read it, fix the HTML/JSON, retry once.

## Return format (final message — raw data, no prose)
One line per report: `{num} | {status} | cv:{ok|skip|FAIL} | cl:{ok|skip|FAIL} | {core}`
status ∈ {done, already-present, partial, lang-skip, FAIL}. End with a one-line tally.
Do NOT edit `data/applications.md` — the orchestrator flips PDF flags.
