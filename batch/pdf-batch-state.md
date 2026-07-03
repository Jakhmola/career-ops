# PDF Batch State — generate CV+CL for Evaluated, score≥3.5, not-applied

Started: 2026-06-23
Trigger: `/career-ops pdf` — generate cv + cover letters for all Evaluated & not-applied & score ≥3.5
User directive: continue across usage-limit resets until complete.

## Work list
- Source of truth: tracker rows where Status=Evaluated, score≥3.5, PDF=❌ → 92 packets (sorted by score desc).
- Full list cached in `batch/pdf-batch-worklist.json`.
- Worker spec: `batch/pdf-worker-spec.md`.
- Output naming: `output/cv-shubham-jakhmola-{core}-2026-06-23.pdf`, `output/cl-shubham-jakhmola-{core}-2026-06-23.pdf`.

## Resume procedure
1. Re-run the tracker filter (Evaluated + ≥3.5 + ❌) to get remaining list — completed packets get their tracker PDF flag flipped to ✅, so they drop off automatically.
2. Cross-check `output/` for existing `cv-…{core}` / `cl-…{core}` files (skip those).
3. Launch parallel workers per `pdf-worker-spec.md` for the remainder.
4. After each wave: flip tracker PDF ❌→✅ for completed nums (orchestrator only — never parallel-edit applications.md).

## Progress log
- (pending) Wave 1 launching: chunks 0–5 (48 packets).
- (pending) Wave 2: chunks 6–11 (44 packets).

## COMPLETE — 2026-06-23 ~04:10
- Wave 1 (chunks 0–5, 48 packets): all done.
- Wave 2 (chunks 6–11, 44 packets): 43 done + KPN #729 held back (Dutch hard-stop, no packet).
- 91/92 packets on disk (CV+CL). ~6 CVs reused pre-existing files; all cover letters fresh.
- Tracker: 85 PDF flags flipped ❌→✅ this pass; Evaluated&≥3.5 now 101 ✅ / 1 ❌ (KPN).
- Note: tracker duplicate rows collapsed during run (736→715 rows); 5 dup siblings inside the ≥3.5 set merged into surviving ✅ rows; their packets remain on disk. verify-pipeline: 0 errors.
- Outstanding: KPN #729 — verify working language on https://… live posting, then generate if English-OK.
