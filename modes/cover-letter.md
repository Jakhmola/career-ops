# Mode: cover-letter — Tailored Cover Letter (HTML → PDF)

Mirror of `pdf` mode, for the cover letter. Same template-fill → `generate-pdf.mjs` mechanism, same ATS-clean PDF output, same header as the CV so the CV + cover letter read as one packet.

## Full pipeline

1. Read `cv.md` + `article-digest.md` (proof points) + `config/profile.yml` (name, contact, narrative, location/visa).
2. Get the JD if not in context (text or URL). Extract the company name, the role title, and the JD's top 2-3 needs.
3. CV/letter language: if `config/profile.yml` has `language.force_english_output: true`, ALWAYS write in English (even for a Dutch/other-language JD). Otherwise detect JD language → letter language (EN default).
4. Detect company location → paper format: US/Canada → `letter`, rest of the world → `a4` (same rule as `pdf` mode).
5. Detect role archetype → adapt framing (read `modes/_profile.md` "Adaptive Framing").
6. Write the body — **exactly 3 short paragraphs**:
   - **Hook** — tie to the company's mission/product and the specific role. One genuine, specific reason (not boilerplate).
   - **Proof** — 2-3 proof points from `config/profile.yml` / `article-digest.md` mapped to the JD's top needs. Read metrics from files, NEVER hardcode or invent. Honor the project preference in `modes/_profile.md` (lead with the preferred flagship project when it is relevant to the role).
   - **Close** — availability + visa one-liner from `_profile.md` Location Policy, and a forward-looking line. Keep it warm, not desperate.
7. Read `name` from `config/profile.yml` → normalize to kebab-case lowercase → `{candidate}`.
8. Fill the template (`templates/cover-letter-template.html`) → write HTML to `/tmp/cover-letter-{candidate}-{company}.html`.
9. Execute: `node generate-pdf.mjs /tmp/cover-letter-{candidate}-{company}.html output/cover-letters/cover-letter-{candidate}-{company}-{YYYY-MM-DD}.pdf --format={letter|a4}`
10. Report: PDF path, page count (should be 1).

## Tone & length rules

- **One page, ~250-320 words.** A cover letter longer than a page is a red flag.
- Specific over generic. No "I am writing to express my interest in…" openers.
- Mirror the JD's vocabulary (ATS + recruiter scan) but only for experience the candidate actually has.
- First person, active voice, concrete metrics. Same exit-narrative bridge used in the CV summary.
- **NEVER invent** experience, metrics, or interest. Only reframe what's in `cv.md` / `article-digest.md`.

## Template placeholders

Use `templates/cover-letter-template.html`. Replace the `{{...}}` placeholders:

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
