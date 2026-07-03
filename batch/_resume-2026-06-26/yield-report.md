# Deep Scan — Final Yield Report (2026-06-26)

## 1. Scanner yields (net-new URLs today, by source)

| Source | Net-new | Notes |
|--------|--------:|-------|
| **linkedin-auth** | **124** | ⭐ Top source by far — the authed Playwright scraper. Ran this comprehensive pass after session-validity check. |
| jobspy | 26 | LinkedIn/Indeed via python-jobspy |
| linkedin-guest | 19 | Public guest API |
| werknl (playwright) | 8 | NL-native board |
| careerjet | 5 | Aggregator |
| adzuna / arbeitnow / jooble | 0 | No net-new |
| jsearch | 0 | Monthly quota exhausted (187/180) — skipped gracefully |
| aijobs | off | Disabled (0 net-new historically) |
| **Total net-new** | **182** | +11 carryover already in pipeline = **193 queued** |

scan-history grew 1,262 → 1,443 URLs.

## 2. Evaluation (193 queued)

184 evaluated · 9 discarded (1 datajobs blog, ~5 Dutch/German/other-language *required* hard-stops, 2 non-job/sample listings, 1 duplicate of existing #021).

| Score band | Count |
|-----------|------:|
| 4.0+ | 8 |
| 3.5–3.9 | 47 |
| 3.0–3.4 | 34 |
| 2.0–2.9 | 58 |
| <2.0 | 37 |
| **≥3.5 leads** | **55** |

### Apply-tier (≥4.0)
- 4.2 — NN Group · GenAI Engineer – Agentic SWAT
- 4.1 — IBS · Data Scientist
- 4.0 — ABN AMRO (via We Match People) · Senior Data Scientist
- 4.0 — Rabobank · Agentic AI Engineer
- 4.0 — Opsfleet · AI Engineer (EU remote)
- 4.0 — Dura Vermeer Groep · AI Engineer
- 4.0 — Artsen zonder Grenzen NL · Data Engineer
- 4.0 — AmPhi Labs · AI/ML Engineer

## 3. CV + cover-letter packets (≥3.5)

55 leads → 7 already had packets · **48 pending**. **0 generated this run** — blocked by the session usage limit (resets 6:40pm Amsterdam). Worklist persisted to `batch/_resume-2026-06-26/` (12 chunks). Resumes idempotently (skip-if-exists).

## 4. Issues hit & fixed

1. **`reserve-report-num.mjs` broken since report #1000** — `maxSlot()` regex `^(\d{3})-` matched *exactly* 3 digits, so 4-digit reports were invisible; it computed `candidate ≈ 1000` and burned all 50 retries on already-taken slots. Fixed regex → `^(\d{3,})-` and `--release` validator → `^\d{3,}$`. **System-layer fix, worth committing.**
2. **LinkedIn JD prefetch returned 87/87 "empty JD"** — `parseJobDescription()` returns a *string*; the rebuilt worker treated it as an object (`jd.description`). Fixed → string + topcard regex for title/company. Result 86/87 (1×HTTP 429).
3. Location classifier read wrong field — joined `scan-history.tsv` col 7 by URL instead.
4. Shell portability (fish foreground vs zsh background) — used `env VAR=val` + POSIX.
5. Scratchpad wiped twice on session restarts — worklist is fully regenerable from durable merged TSVs; now scripted in `build-packets.mjs`.

## 5. Integrity

- `merge-tracker.mjs`: +175 added, 4 updated, 5 skipped (dedup). 1,121 tracker rows.
- `verify-pipeline.mjs`: **0 errors**, 11 warnings (pre-existing duplicate pairs, none from today). All report links valid, all statuses canonical.
- `pipeline.md`: reconciled to **0 pending**.
