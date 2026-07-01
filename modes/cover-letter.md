# Mode: cover-letter — Tailored Cover Letter (HTML → PDF)

Mirror of `pdf` mode, for the cover letter. Same template-fill → `generate-pdf.mjs` mechanism, same ATS-clean PDF output, same header as the CV so the CV + cover letter read as one packet.

## Full pipeline

1. Read `cv.md` + `article-digest.md` (proof points) + `config/profile.yml` (name, contact, narrative, location/visa).
2. Get the JD if not in context (text or URL). Extract the company name, the role title, and the JD's top 2-3 needs.
3. CV/letter language: if `config/profile.yml` has `language.force_english_output: true`, ALWAYS write in English (even for a Dutch/other-language JD). Otherwise detect JD language → letter language (EN default).
4. Detect company location → paper format: US/Canada → `letter`, rest of the world → `a4` (same rule as `pdf` mode).
5. Detect role archetype → adapt framing (read `modes/_profile.md` "Adaptive Framing").
6. **Map before you write (the spine).** Identify the role's single biggest need — the top "what you'll do" item or the pain point the role exists to solve — and the ONE proof point in `article-digest.md` that most directly answers it. That pairing is the backbone of the letter. Everything else is support; resist including every metric you have.
7. Write the body — **3 short paragraphs, one job each. Keep it tight: the whole letter is ~180-230 words.**
   - **P1 — Why *them* + their problem (2 sentences).** Open with ONE specific, verifiable detail about *this* company or role: a product, a recent launch/announcement, an engineering-blog topic, the team's stated technical approach, or a concrete challenge named in the JD — and connect it to the core problem the role exists to solve. NOT a paraphrase of their mission statement. NOT "your mission to X is exactly the kind of problem I want to work on." If no specific company detail is findable, anchor on the most concrete technical challenge in the JD itself. The test: a reader from another company should NOT be able to reuse this paragraph.
   - **P2 — One proof story (3 sentences).** Tell the single mapped proof point as a short narrative: the problem/constraint you faced → the key decision you made → the outcome. Lead with the project the role most needs (honor the flagship preference in `modes/_profile.md` when relevant). Use **at most 2-3 quantified results in the ENTIRE letter** — pick the ones that matter to *this* role and drop the rest. Expand on one achievement; do NOT list achievements. End with a clause tying the *instinct* behind the story to their work. If there's a real domain/seniority gap, name it once and frame it as transferable — not as an apology. **Anchor the story on your role and its scope, not the company name** — the candidate's past employers usually aren't well-known, so "At {Company}" adds no signal; open with the position instead (e.g. "As the sole AI engineer on a consumer chat product, I…").
   - **P3 — Close (2 sentences).** A forward line about *their* problem (not "my background could contribute to…"), then the availability + visa one-liner from `_profile.md` Location Policy — and, when the role is away from the candidate's home city, fold in the relocation clause that policy specifies. Warm and specific, never desperate.
8. Read `name` from `config/profile.yml` → normalize to kebab-case lowercase → `{candidate}`. Build `{slug}` = `{company-kebab}-{role-kebab}` exactly as in `modes/pdf.md` step 14 (company AND role, never company alone). If a CV was generated for this same application, reuse its identical `{slug}` so the CV + cover letter stay paired and neither overwrites a sibling role at the same company.
9. Fill the template (`templates/cover-letter-local.html`) → write HTML to `/tmp/cover-letter-{candidate}-{slug}.html`. (This is the local 3-paragraph `{{BODY}}` template — the only cover-letter template. The old bullet-format generator (`modes/cover.md` + `generate-cover-letter.mjs` + `cover-letter-template.html`) has been removed; there is no other letter style to cross.)
10. Execute: `node generate-pdf.mjs /tmp/cover-letter-{candidate}-{slug}.html output/cover-letter-{candidate}-{slug}-{YYYY-MM-DD}.pdf --format={letter|a4}`
    - **Output lives flat in `output/` with the `cover-letter-` prefix** (paired with the CV's `output/cv-{candidate}-{slug}-…` file) — NOT in an `output/cover-letters/` subfolder.
11. Report: PDF path, page count (should be 1).

## Tone & length rules

- **One page, ~180-230 words.** Shorter wins — recruiters spend ~2 minutes, and a half-page letter that lands beats a full one they skim. Running past one page is a red flag; so is a dense block of numbers.
- **Solve their problem, don't narrate your career.** Every sentence should answer "why should they care," not "here's what I did." Their need leads; your experience is the evidence.
- **Clarity beats cleverness; one story beats ten metrics.** A reader should finish P2 remembering ONE concrete thing you did, not drowning in a list. Cap quantified results at **2-3 for the whole letter**.
- **Specific over generic.** Banned openers and AI tells (these read as auto-generated and earn ~30s instead of 2-3 min): "I am writing to express my interest", "I am excited to apply", "proven track record", "detail-oriented professional", "passionate about", "I believe my skills make me a strong fit", and "your mission to ___ is exactly the kind of problem I want to work on". If a sentence could be pasted into a letter for any other company, cut or rewrite it.
- **Vary sentence length; write like a person.** Avoid semicolon-stacked compound sentences, parenthetical pile-ups, and em-dashes. That density — the em-dash especially — is the AI tell. Mix short, punchy sentences with one longer one. First person, active voice. (`generate-pdf.mjs` normalizes any em-dash to a hyphen, but avoid them at the source.)
- Mirror the JD's vocabulary (ATS + recruiter scan) — but only for experience the candidate actually has. Match the role's flavour: for a GenAI/agentic role lead with LLM/RAG work, not classical ML.
- **NEVER invent** experience, metrics, or interest. Only reframe what's in `cv.md` / `article-digest.md`.

## Final check — read it aloud

Before writing the HTML, reread the body once as if speaking to a hiring manager:
- Does **P1** name something only *this* company would recognize? If a competitor could reuse it verbatim, it's generic — fix it.
- Does **P2** tell one clear story, or dump a list? If it's a list, cut to the single best proof plus ≤3 numbers.
- Would any sentence sound stiff or robotic said out loud? Rewrite it in natural voice.
- Total quantified results ≤ 3? Word count ~180-230 (and never past ~250)? Fits comfortably on one page?

## Worked example — P2 (the proof paragraph)

The biggest quality lever is P2. Same candidate, same role (an ad-ranking ML role), real metrics from `article-digest.md`:

**❌ Weak (metric dump — what to avoid):**
> At Bobble AI I built end-to-end ML systems at consumer scale. The intent classification pipeline processes millions of user events: a two-stage architecture (embedding similarity at Stage A resolves ~82% of decisions cheaply; LLM batch API handles uncertain signals at Stage B) lifted macro-F1 from 0.72 to 0.87 and drove a +11% push open rate. My A/B discipline is equally rigorous: pre-registered primary metrics, two-proportion z-test, bootstrap for skewed ratios, 7-14 day runs — share-tap rate increased +70% vs control. On retrieval I built a RAG system with hybrid BM25 + dense, RRF fusion, and Redis caching, achieving factual-hit +67pp and DAU +150% QoQ.

**✅ Strong (one story, ≤3 numbers, ties back to their problem):**
> The work closest to this role is an intent-classification pipeline I built at Bobble AI. The constraint was cost — running an LLM over millions of daily events was a non-starter, but the legacy rule-based system was too blunt to be useful. So I designed a two-stage classifier: cheap embedding similarity resolves ~82% of cases, and the LLM only ever sees the genuinely ambiguous ones. It lifted macro-F1 from 0.72 to 0.87, and a controlled cohort saw push-notification opens rise 11%. That instinct — spend expensive compute only where it changes the decision — is exactly what ranking and relevance work on advertiser data rewards.

The weak version has ~10 numbers and reads like a spec sheet. The strong version has 3 numbers, one decision a reader remembers, and a closing line aimed at *their* problem.

## Template placeholders

Use `templates/cover-letter-local.html`. Replace the `{{...}}` placeholders:

| Placeholder | Content |
|-------------|---------|
| `{{LANG}}` | `en` (always, when `force_english_output`) |
| `{{PAGE_WIDTH}}` | `8.5in` (letter) or `210mm` (A4) |
| `{{NAME}}` | from `profile.yml` |
| `{{PHONE}}` | from `profile.yml` (omit the span + separator if empty) |
| `{{EMAIL}}` | from `profile.yml` |
| `{{LINKEDIN_URL}}` / `{{LINKEDIN_DISPLAY}}` | from `profile.yml` |
| `{{PORTFOLIO_URL}}` / `{{PORTFOLIO_DISPLAY}}` | from `profile.yml` |
| `{{LOCATION}}` | from `profile.yml` |
| `{{PERMIT_STATUS}}` | If `profile.yml` has `location.permit_display` set: `<span class="separator">\|</span><span>{value}</span>`. Omit entirely if the key is absent or empty. |
| `{{DATE}}` | today, long form (e.g. `6 June 2026`) |
| `{{RECIPIENT}}` | `Hiring Team` + `<br><span class="company">{Company}</span>` (use the hiring manager's name if known) |
| `{{GREETING}}` | `Dear Hiring Team,` (or `Dear {Name},` if known) |
| `{{BODY}}` | the 3 `<p>…</p>` paragraphs from step 6 |
| `{{SIGNOFF}}` | `Sincerely,` |
| `{{SIGNATURE_NAME}}` | candidate name from `profile.yml` |

## ATS / parsing notes

- `generate-pdf.mjs` runs the same Unicode normalization as the CV (em-dashes, smart quotes, arrows, € → `EUR`, etc.), so the cover-letter PDF is ATS-clean automatically.
- Single column, selectable text, no images. The header matches the CV exactly for a consistent application packet.

## Where it fits

The lite workflow (`modes/_profile.md` → DEFAULT WORKFLOW, step 3) calls this mode automatically when the fit score is **above** `workflow.autogenerate_above` (default `4.0`). At or below that threshold, ask the user before generating.
