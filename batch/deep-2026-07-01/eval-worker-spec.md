# Phase 2 — Lite Eval Worker Spec (deep scan 2026-07-01)

You evaluate a CHUNK of freshly-scanned job postings and produce, per role: a **light fit report** + a **tracker TSV row**. You do NOT generate CVs or cover letters (that is Phase 3). You do NOT edit `data/pipeline.md` or `data/applications.md` (the orchestrator does).

Candidate: **Shubham Jakhmola**, Amsterdam (orientation-year permit / zoekjaar). Today: **2026-07-01**.

## Read FIRST (once)
1. `cv.md` — canonical CV, source of truth. NEVER invent metrics.
2. `modes/_profile.md` — archetypes, skill-gap weighting, location policy, language hard-stop, lite-flow. THIS GOVERNS SCORING.
3. `article-digest.md` — proof points (optional but useful).

## Your input
A list of pipeline rows, each: `URL_OR_LOCALREF | Company | Title` (may carry a ` · pre:A78` pre-triage annotation — ignore it, judge for yourself).

## Per role

### Step 1 — Get the JD text
- `local:jds/<file>.md` ref → read that file directly.
- LinkedIn URL (`linkedin.com/jobs/view/<id>`) → fetch JD via guest API:
  `curl -s "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/<id>" | ...` (strip HTML) — or WebFetch the URL.
- Any other URL → WebFetch it.
- If the JD is genuinely unreachable (login wall, dead link, empty), record status `unreachable` for that row and MOVE ON — do NOT fabricate a JD or score.

### Step 2 — Language hard-stop (MANDATORY, do this BEFORE scoring)
Grep the FULL JD for a required non-English language: search `dutch`, `nederlands`, `taal`, `vereist`, `fluent`, `proficiency`, `command of`, `moedertaal`, `native`, `C1`, `C2`.
- A **must-have** non-English language (e.g. "Nederlands is een must", "fluent Dutch required", "native German") → **HARD STOP**. Report score **1.0**, status `SKIP`, note `⛔ {Language} required`. Do NOT score on merits.
- "Nice to have" / "a plus" / "willing to learn" another language → NOT a blocker; note as ⚠️ minor, continue.
- JD merely *written* in Dutch, or a Dutch company, is NOT a requirement. Continue normally.
- If you could not retrieve the full JD, do NOT assert "English-OK" — mark `verify-language` in the note and cap the recommendation.

### Step 3 — Mini fit-check + score (per `modes/_profile.md` lite flow)
Output the fit table (4–7 requirements that decide fit). Score 0–5 = weighted CV-match + location/visa policy.

Apply these calibrations from `_profile.md` (do not re-derive):
- **Skill-gap weighting:** penalize/block ONLY a hard must-have that is (a) not core AI/ML/LLM, (b) not quick to learn — Terraform, Kubernetes/infra-ops, Go/Rust/C++, Java/Kotlin/.NET as primary language. DO NOT penalize quick-ramp/adjacent gaps — Tableau/PowerBI, Airflow/Prefect/Dagster, GCP (knows AWS), a specific vector DB, Unity Catalog/Lakeflow (knows Databricks). Note those as "minor / quick ramp".
- **Location:** any NL location → 5.0 (no commute penalty). EU + sponsorship offered → 4.0. Outside NL, sponsorship unclear → 3.0 + flag. Sponsorship explicitly refused / EU-citizenship-required → 1.0 SKIP.

Apply these directives for THIS run (from the user):
- **No Data Engineer.** A pure data-engineering role (ETL/pipelines/warehouse-ownership with no meaningful AI/ML/LLM/DS component) is a poor fit → score it low (≤3.0) and note "pure data-eng, not target". A role that BLENDS ML + data-eng is fine — judge on the ML content.
- **Wary of senior roles, especially at big/reputed companies.** If the JD demands seniority Shubham doesn't have (7+ yrs, "extensive experience leading", staff-level scope, deep specialization) AND it's a large/well-known employer (where the bar is realistically high), down-weight for the seniority stretch — a moderate penalty, and cap the verdict at "stretch". A "Senior" title at a scaleup that's reachable at 3–4 yrs is NOT auto-penalized (judge the actual requirements, not the title).
- **Tech Shubham can stretch to:** if a listed tool is learnable quickly (see quick-ramp list), assume he can pick it up — don't treat it as a gap.

### Step 4 — Reserve a report number + write the light report
- Reserve atomically: `node reserve-report-num.mjs` → prints the number (e.g. `1542`). Use it. One number per role.
- AFTER the report file is written, release the sentinel: `node reserve-report-num.mjs --release {num}` (keeps reports/ clean).
- slug = `{company-kebab}-{role-kebab}` (role REQUIRED in slug — no same-company overwrites).
- Write `reports/{num}-{slug}-2026-07-01.md`:

```
# {num} — {Company} — {Role}

**Score:** {X.X}/5
**URL:** {url}
**PDF:** ❌
**Legitimacy:** {Verified|Probable|Unverified}

## Fit: {Company} — {Role}
Archetype: {detected} ({primary/secondary/adjacent})
Score: {X.X}/5

| JD need | CV evidence | Gap? |
|---------|-------------|------|
| ... | ... | ✅ / ⚠️ minor / ❌ blocker |

Verdict: {one line — tailor & apply / stretch / skip}.

## Keywords
{15–20 ATS keywords from the JD, comma-separated}
```

### Step 5 — Write the tracker TSV
Write `batch/tracker-additions/{num}-{slug}.tsv` — ONE line, 9 tab-separated cols (status BEFORE score):
```
{num}\t2026-07-01\t{Company}\t{Role}\t{status}\t{X.X}/5\t❌\t[{num}](reports/{num}-{slug}-2026-07-01.md)\t{one-line note}
```
status = `Evaluated` normally; `SKIP` for language hard-stop or clear no-fit. score format `X.X/5`. PDF col = `❌` (Phase 3 flips it).

## Return format (final message — raw data, no prose)
One line per role:
`{num} | {score}/5 | {status} | {Company} — {Role} | {core-slug}`
End with a one-line tally: `N evaluated, M ≥3.5, K SKIP, U unreachable`.
