# Mode: pdf — ATS-Optimized PDF Generation

## Full pipeline

1. Read `cv.md` as the source of truth
2. Ask the user for the JD if it is not in context (text or URL)
3. Extract 15-20 keywords from the JD
4. CV language: if `config/profile.yml` has `language.force_english_output: true`, ALWAYS output English (even for a Dutch/other-language JD — extract keywords from it but write the CV in English). Otherwise detect JD language → CV language (EN default).
5. Detect company location → paper format:
   - US/Canada → `letter`
   - Rest of the world → `a4`
6. Detect role archetype → adapt framing
7. **Rewrite the Professional Summary — the single highest-leverage edit (see the worked example below).** 2–4 sentences, ~50–85 words. Lead with the candidate's level + the ONE cross-cutting differentiator (read `modes/_profile.md` → cross-cutting advantage / positioning / exit narrative). Anchor it in the single most role-relevant achievement with **at most ONE quantified result** — and that number must NOT already appear in a bullet below it (the summary is a *highlight reel, not a recap* of the bullets). Close with the availability/visa line from `_profile.md`. **Hard bans (these are the AI-slop tells recruiters reject on sight):** no parenthetical pile-ups or semicolon-stacked clauses; no metric dump (one number, max); no phrase lifted verbatim from the JD (mirror JD vocabulary in Competencies/Skills/bullets instead, never by stuffing the summary); no buzzwords ("results-oriented", "passionate", "proven track record", "leverage", "spearheaded", "detail-oriented"). **Anchor the proof on role and scope, not the employer's name** — the candidate's companies are usually not household names, so "At {Company} I…" buys no credibility; lead with the position and its scope instead (e.g. "As the sole AI engineer on a consumer chat product, I…"). The Work Experience section still lists company names; this rule is about the *summary prose* only. **No em-dashes in the prose** — write with commas and periods. (`generate-pdf.mjs` normalizes stray em-dashes to hyphens for ATS, but the real reason is that em-dash-joined clauses read as AI-generated; avoid them at the source.)
8. Select top 3-4 most relevant projects for the job. Honor any project preference in `modes/_profile.md` (e.g. a preferred flagship project) — include the preferred project whenever it is relevant to the role, and only drop it when genuinely unsuitable.
9. Reorder experience bullets by JD relevance
10. Build competency grid from JD requirements (**6 keyword phrases — keep it tight**; it's a skim-strip, not a second Skills section, and it should not re-list what Skills already covers)
11. Inject keywords naturally into existing achievements (NEVER invent)
12. Generate full HTML from template + personalized content
13. Read `name` from `config/profile.yml` → normalize to kebab-case lowercase (e.g. "John Doe" → "john-doe") → `{candidate}`
14. **Build `{slug}` — company AND role, always.** `{slug}` = `{company-kebab}-{role-kebab}`, where `{role-kebab}` is the 2-4 distinguishing words of the role title in kebab-case (drop generic filler like "engineer" only if it would otherwise collide; keep enough to make the role unique). Examples: bol.com "Data Scientist – AdAdvice" → `bol-adadvice`; Miro "ML Research Engineer" → `miro-ml-research-engineer`. **NEVER use `{company}` alone** — two roles at the same company would overwrite each other's PDF. The cover letter for the same application MUST reuse this identical `{slug}` so the CV + cover letter stay paired.
15. Write HTML to `/tmp/cv-{candidate}-{slug}.html`
16. Execute: `node generate-pdf.mjs /tmp/cv-{candidate}-{slug}.html output/cv-{candidate}-{slug}-{YYYY-MM-DD}.pdf --format={letter|a4}`
17. Report: PDF path, number of pages, keyword coverage %

## Project Links

Project titles in the `Projects` section must be `<a>` hyperlinks to the repo/demo URL — `<span class="project-title"><a href="{url}">{Title}</a></span>`. The URL is also repeated as plain text in the `.project-tech` line (no `<a>` tag there) so ATS parsers that strip anchor tags still extract it. Never put the URL only in the tech line with the title as a plain span.

## ATS Rules (clean parsing)

- Single-column layout (no sidebars, no parallel columns)
- **Standard headers — use these EXACT strings, always. Never embellish or rename them** (no "Selected Projects", "Key Projects", "Relevant Experience", "Professional Experience", etc.). ATS parsers match on canonical section names:
  - `Professional Summary`
  - `Core Competencies`
  - `Work Experience`
  - `Projects`  ← exactly this, never "Selected Projects"
  - `Education`
  - `Certifications`
  - `Skills`
- No text in images/SVGs
- No critical info in PDF headers/footers (ATS ignores them)
- UTF-8, selectable text (not rasterized)
- No nested tables
- Distributed JD keywords: Summary (1-2, woven in naturally — never a keyword list), Competencies, first bullet of each role, Skills section

## PDF Design

- **Fonts**: Space Grotesk (headings, 600-700) + DM Sans (body, 400-500)
- **Fonts self-hosted**: `fonts/`
- **Header**: name in Space Grotesk 24px bold + gradient line `linear-gradient(to right, hsl(187,74%,32%), hsl(270,70%,45%))` 2px + contact row
- **Section headers**: Space Grotesk 13px, uppercase, letter-spacing 0.05em, color cyan primary
- **Body**: DM Sans 11px, line-height 1.5
- **Company names**: accent purple color `hsl(270,70%,45%)`
- **Margins**: 0.6in
- **Background**: pure white

## Section order (optimized "6-second recruiter scan")

1. Header (large name, gradient, contact, portfolio link)
2. Professional Summary (2-4 sentences, differentiator-led — see step 7, never keyword-dense)
3. Core Competencies (6 keyword phrases in flex-grid)
4. Work Experience (reverse chronological)
5. Projects (top 3-4 most relevant)
6. Education & Certifications
7. Skills (languages + technical)

## Keyword injection strategy (ethical, truth-based)

Examples of legitimate reformulation:
- JD says "RAG pipelines" and CV says "LLM workflows with retrieval" → change to "RAG pipeline design and LLM orchestration workflows"
- JD says "MLOps" and CV says "observability, evals, error handling" → change to "MLOps and observability: evals, error handling, cost monitoring"
- JD says "stakeholder management" and CV says "collaborated with team" → change to "stakeholder management across engineering, operations, and business"

**NEVER add skills that the candidate does not have. Only reword real experience using the exact JD vocabulary.**

## Professional Summary — worked example

The summary is where CVs most often read as auto-generated. The failure mode is the **kitchen-sink paragraph**: every metric, three parenthetical stacks, and a phrase copied from the JD. Same candidate, same role (a production GenAI engineer role at a bank):

**❌ Weak (metric dump — what to avoid):**
> AI Engineer who ships GenAI to production end-to-end — from the first business conversation through deployment, monitoring, and iteration. At Bobble AI, owned a multi-agent RAG assistant (hybrid retrieval with RRF, a 4-layer RAGAS + LLM-as-judge eval ladder, Prometheus/Grafana drift monitoring) that lifted factual-hit rate +67 pp and DAU +150% QoQ, plus 100+ production system prompts driving measurable A/B results at ~100k requests/day. A developer, not a notebook user (production FastAPI services), with Databricks/PySpark pipelines at 20M+ records/day and five public AI repos built on the side. MSc Advanced Computer Science (Distinction)...

Six metrics (all repeated in the bullets below), three parenthetical pile-ups, and "a developer, not a notebook user" lifted straight from the JD. ~115 words. A recruiter pattern-matches this as AI in seconds.

**✅ Strong (differentiator-led, one number, role not company, reads like a person):**
> AI Engineer who ships GenAI end-to-end, from first prototype through deployment, monitoring, and the iteration after launch that most people skip. As the sole AI engineer on a consumer chat product, I replaced a brittle rule-based system with a multi-agent RAG architecture that grew daily active users 150% QoQ and let us retire the old stack, then built the evaluation and drift-monitoring loop that kept it trustworthy in production. I own the data pipelines beneath the models as readily as the models themselves. MSc Advanced Computer Science (Distinction). Amsterdam-based on an orientation-year permit, available hybrid from day one.

~80 words, one number, no parentheticals or em-dashes, the differentiator up front, the proof anchored on the role ("sole AI engineer") rather than the unknown company name, and nothing copied from the JD. The metrics still exist, in the bullets where they belong.

**Final check — read the summary aloud before generating HTML:** Does it lead with what makes this candidate different? Is there at most one number, and is that number absent from the bullets? Any parenthetical stack or JD phrase to cut? Would it sound human said out loud?

## Fonts & legibility (handled by the template + generator — do not hand-tune)

The CV's typography is fixed in `templates/cv-template.html` and rendered by `generate-pdf.mjs`. Do not change font sizes, line-heights, or `@font-face` per-CV. Two facts worth knowing:
- The template self-hosts **static** Space Grotesk + DM Sans TTFs (`fonts/sg-*.ttf`, `fonts/dm-*.ttf`). `generate-pdf.mjs` inlines them as base64. Static TTFs embed as CID TrueType and stay ATS-extractable; the older **variable** woff2 fall back to Type 3 glyphs and corrupt text extraction (spurious spaces inside words). Keep the template on the static TTFs.
- Body runs ~10pt with tightened line-height for a readable, ATS-clean 2-page result. If a CV overflows to 3 pages, trim content (a bullet, an older role) rather than shrinking the font.

## Template HTML

Use the template in `cv-template.html`. Replace the `{{...}}` placeholders with personalized content:

| Placeholder | Content |
|-------------|-----------|
| `{{LANG}}` | `en` or `es` |
| `{{PAGE_WIDTH}}` | `8.5in` (letter) or `210mm` (A4) |
| `{{NAME}}` | (from profile.yml) |
| `{{PHONE}}` | (from profile.yml — include with its separator only when `profile.yml` has a non-empty `phone` value; omit both `<span>` and `<span class="separator">` otherwise) |
| `{{EMAIL}}` | (from profile.yml) |
| `{{LINKEDIN_URL}}` | [from profile.yml] |
| `{{LINKEDIN_DISPLAY}}` | [from profile.yml] |
| `{{PORTFOLIO_URL}}` | [from profile.yml] (or /es depending on language) |
| `{{PORTFOLIO_DISPLAY}}` | [from profile.yml] (or /es depending on language) |
| `{{LOCATION}}` | [from profile.yml] |
| `{{PERMIT_STATUS}}` | If `profile.yml` has `location.permit_display` set: `<span class="separator">\|</span><span>{value}</span>`. Omit entirely if the key is absent or empty. |
| `{{SECTION_SUMMARY}}` | Professional Summary |
| `{{SUMMARY_TEXT}}` | Personalized summary with keywords |
| `{{SECTION_COMPETENCIES}}` | Core Competencies |
| `{{COMPETENCIES}}` | `<span class="competency-tag">keyword</span>` × 6-8 |
| `{{SECTION_EXPERIENCE}}` | Work Experience |
| `{{EXPERIENCE}}` | HTML for each job with reordered bullets |
| `{{SECTION_PROJECTS}}` | Projects |
| `{{PROJECTS}}` | HTML for top 3-4 projects |
| `{{SECTION_EDUCATION}}` | Education |
| `{{EDUCATION}}` | Education HTML |
| `{{SECTION_CERTIFICATIONS}}` | Certifications |
| `{{CERTIFICATIONS}}` | Certifications HTML |
| `{{SECTION_SKILLS}}` | Skills |
| `{{SKILLS}}` | Skills HTML |

## Canva CV Generation (optional)

If `config/profile.yml` has `cv.canva_resume_design_id` set, offer the user a choice before generating:
- **"HTML/PDF (fast, ATS-optimized)"** — existing flow above
- **"Canva CV (visual, design-preserving)"** — new flow below

If the user has no `cv.canva_resume_design_id`, skip this prompt and use the HTML/PDF flow.

### Canva workflow

#### Step 1 — Duplicate the base design

a. `export-design` the base design (using `cv.canva_resume_design_id`) as PDF → get download URL
b. `import-design-from-url` using that download URL → creates a new editable design (the duplicate)
c. Note the new `design_id` for the duplicate

#### Step 2 — Read the design structure

a. `get-design-content` on the new design → returns all text elements (richtexts) with their content
b. Map text elements to CV sections by content matching:
   - Look for the candidate's name → header section
   - Look for "Summary" or "Professional Summary" → summary section
   - Look for company names from cv.md → experience sections
   - Look for degree/school names → education section
   - Look for skill keywords → skills section
c. If mapping fails, show the user what was found and ask for guidance

#### Step 3 — Generate tailored content

Same content generation as the HTML flow (Steps 1-11 above):
- Rewrite Professional Summary with JD keywords + exit narrative
- Reorder experience bullets by JD relevance
- Select top competencies from JD requirements
- Inject keywords naturally (NEVER invent)

**IMPORTANT — Character budget rule:** Each replacement text MUST be approximately the same length as the original text it replaces (within ±15% character count). If tailored content is longer, condense it. The Canva design has fixed-size text boxes — longer text causes overlapping with adjacent elements. Count the characters in each original element from Step 2 and enforce this budget when generating replacements.

#### Step 4 — Apply edits

a. `start-editing-transaction` on the duplicate design
b. `perform-editing-operations` with `find_and_replace_text` for each section:
   - Replace summary text with tailored summary
   - Replace each experience bullet with reordered/rewritten bullets
   - Replace competency/skills text with JD-matched terms
   - Replace project descriptions with top relevant projects
c. **Reflow layout after text replacement:**
   After applying all text replacements, the text boxes auto-resize but neighboring elements stay in place. This causes uneven spacing between work experience sections. Fix this:
   1. Read the updated element positions and dimensions from the `perform-editing-operations` response
   2. For each work experience section (top to bottom), calculate where the bullets text box ends: `end_y = top + height`
   3. The next section's header should start at `end_y + consistent_gap` (use the original gap from the template, typically ~30px)
   4. Use `position_element` to move the next section's date, company name, role title, and bullets elements to maintain even spacing
   5. Repeat for all work experience sections
d. **Verify layout before commit:**
   - `get-design-thumbnail` with the transaction_id and page_index=1
   - Visually inspect the thumbnail for: text overlapping, uneven spacing, text cut off, text too small
   - If issues remain, adjust with `position_element`, `resize_element`, or `format_text`
   - Repeat until layout is clean
e. Show the user the final preview and ask for approval
f. `commit-editing-transaction` to save (ONLY after user approval)

#### Step 5 — Export and download PDF

a. `export-design` the duplicate as PDF (format: a4 or letter based on JD location)
b. **IMMEDIATELY** download the PDF using Bash:
   ```bash
   curl -sL -o "output/cv-{candidate}-{slug}-canva-{YYYY-MM-DD}.pdf" "{download_url}"
   ```
   The export URL is a pre-signed S3 link that expires in ~2 hours. Download it right away.
c. Verify the download:
   ```bash
   file output/cv-{candidate}-{slug}-canva-{YYYY-MM-DD}.pdf
   ```
   Must show "PDF document". If it shows XML or HTML, the URL expired — re-export and retry.
d. Report: PDF path, file size, Canva design URL (for manual tweaking)

#### Error handling

- If `import-design-from-url` fails → fall back to HTML/PDF pipeline with message
- If text elements can't be mapped → warn user, show what was found, ask for manual mapping
- If `find_and_replace_text` finds no matches → try broader substring matching
- Always provide the Canva design URL so the user can edit manually if auto-edit fails

## Post-generation

If the job is already registered:
1. Update the tracker (`data/applications.md`): change PDF column from ❌ to ✅ and add the output filename.
2. Update the report file (`reports/{num}-*.md`): change `**PDF:** ❌` to `**PDF:** output/{filename}.pdf ✅`.
