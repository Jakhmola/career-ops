# PDF Packet Worker Spec

You generate **tailored CV + cover-letter PDF packets** for a set of already-evaluated job reports.
Candidate: **Shubham Jakhmola**. Today's date: **2026-06-23**.

## One-time setup (read these FIRST, once)
1. `cv.md` — canonical CV, source of truth for all experience/metrics. NEVER invent metrics.
2. `modes/_profile.md` — archetypes, narrative, cover-letter rules, writing style.
3. `article-digest.md` — detailed proof points (takes precedence over cv.md for project metrics).
4. `config/profile.yml` — name/email/phone/location/linkedin/github.
5. `templates/cv-template.html` — the CV HTML template with `{{...}}` placeholders.

Candidate contact (from profile.yml): name "Shubham Jakhmola", email j4khmola@gmail.com,
phone "+31 6 49975488", location "Amsterdam, Netherlands", linkedin "linkedin.com/in/jakhmola",
github "jakhmola.github.io".

## Per report (you are given a list of report file paths + their core-slug)

For each report:

### Step 0 — Skip if already done
- CV file: if any `output/cv-shubham-jakhmola-{core}-*.pdf` already exists, SKIP CV generation.
- CL file: if any `output/cover-letter-shubham-jakhmola-{core}-*.pdf` already exists, SKIP CL generation.
- Use `ls output/cv-shubham-jakhmola-{core}-*.pdf` etc. If both exist, record status "already-present" and move on.

### Step 1 — Read the report
Mine the `## Fit` table (JD need → CV evidence), `Archetype`, `## Keywords`, `**URL:**`, score, company, role.

### Step 2 — Tailor the CV (HTML)
- Detect archetype from report → adapt framing per `_profile.md`.
- Paper format: NL/EU company → `a4` (default for all these — they are NL roles). US/Canada → `letter`.
- Rewrite Professional Summary: 3–4 lines, inject top 5 JD keywords naturally, keep truthful.
- Core Competencies: 6–8 keyword phrases drawn from the JD `## Keywords` line.
- Reorder experience bullets by JD relevance; inject exact JD vocabulary into REAL achievements only.
- Select top 3–4 most relevant projects.
- Fill EVERY `{{...}}` placeholder in `templates/cv-template.html`. Placeholders documented in `modes/pdf.md`.
- Write HTML to `/tmp/cv-shubham-jakhmola-{core}.html`.
- Generate: `node generate-pdf.mjs /tmp/cv-shubham-jakhmola-{core}.html output/cv-shubham-jakhmola-{core}-2026-06-23.pdf --format=a4`

### Step 3 — Cover letter (HTML → generate-pdf.mjs)
Follow `modes/cover-letter.md` exactly — the narrative 3-paragraph letter, NOT a bullet/payload
generator. Fill `templates/cover-letter-local.html` (`{{...}}` placeholders documented in
`modes/cover-letter.md`), write to `/tmp/cover-letter-shubham-jakhmola-{core}.html`, then run the
SAME engine as the CV (`generate-pdf.mjs`).

Cover-letter rules (from `_profile.md` + `modes/cover-letter.md`, MUST follow): ONE proof story,
≤3 numbers total, honest gap framing, no corporate-speak, no "passionate about"/"leveraged"/
"spearheaded". ~180–230 words, 1 page max. Do NOT use `generate-cover-letter.mjs` (that is the
upstream bullet format — a different letter type; keep it out of the packet).

Generate: `node generate-pdf.mjs /tmp/cover-letter-shubham-jakhmola-{core}.html output/cover-letter-shubham-jakhmola-{core}-2026-06-23.pdf --format=a4`

### Step 4 — Verify
Confirm both PDFs exist with non-zero size (`ls -la output/...`). If a generator errored, read the
error, fix the HTML/JSON, retry once.

## Return format (your final message — raw data, no prose)
Return a compact list, one line per report:
`{num} | {status} | cv:{ok|skip|FAIL} | cl:{ok|skip|FAIL} | {core}`
where status ∈ {done, already-present, partial, FAIL}. End with a one-line tally.
Do NOT edit `data/applications.md` — the orchestrator flips tracker flags.
