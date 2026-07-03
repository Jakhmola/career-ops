# Deep Scan + Eval + Packet — 2026-07-01

User directive: deep 2-week scan, AI/ML/DS/GenAI focus, **no data engineer**, wary of senior roles esp. at big/reputed cos, linkedin-auth aggressive, generous limits. Then Phase 2 (full pipeline → reports, Sonnet agents), then Phase 3 (CV+cover for ≥3.5, Sonnet agents). Bounded agent waves; minimal blast radius; resume on limit.

## Phase 1 — SCAN (zero-token, background)
- Configs: `portals-deep.yml` (pass 1, LA off), `portals-deep-la.yml` (pass 2, LA only). Generated from portals.yml; "Data Engineer" dropped from title positives; 14-day (336h) window.
- Pass 1 (all fast sources): bg task `by6z55v88`, log `batch/deep-2026-07-01/pass1.log`. STATUS: running.
- Pass 2 (linkedin-auth only, aggressive): NOT STARTED — launch AFTER pass 1 exits (sequential = no file race). Log `pass2.log`.
- Output → canonical `data/pipeline.md` (Pending) + `data/scan-history.tsv`.

## Phase 2 — EVAL (Sonnet subagents, bounded waves)
- Spec: `batch/deep-2026-07-01/eval-worker-spec.md`. Workers write reports + `batch/tracker-additions/*.tsv`. NO PDFs. Do NOT touch pipeline.md/applications.md.
- Worklist: `worklist.json` (parse pipeline pending → rows). Chunk ~4 rows/agent, ~6 agents/wave (~24 roles/wave). Checkpoint between waves.
- After each wave: `node merge-tracker.mjs`; mark done rows in pipeline.md Pending→Processed.
- RESUME: remaining = pipeline pending rows with NO matching `reports/*-2026-07-01.md` (match by company+role slug). Re-chunk and continue.

## Phase 3 — PACKETS (Sonnet subagents, bounded waves)
- Spec: `batch/deep-2026-07-01/packet-worker-spec.md`. Gate: reports scoring ≥3.5, not language-SKIP.
- Chunk ~4 reports/agent, ~5 agents/wave. Step-0 skip makes it idempotent → safe to re-run.
- After: flip PDF flag ❌→✅ in tracker for generated packets (reconcile-pdfs.mjs or manual).
- RESUME: ≥3.5 reports lacking `output/cv-...-{core}-*.pdf` → re-run those chunks.

## Report numbering
`node reserve-report-num.mjs` (atomic sentinel). Next was ~1542 at start.

## Cleanup at end
rm portals-deep.yml portals-deep-la.yml (temp). Do NOT commit unless asked.

---
## PROGRESS LOG
- Pass 1 DONE: 15 net-new → evaluated (reports 1541-1555, merged as tracker #1575-1585).
  - New packet-worthy (≥3.5, not already in tracker): **BMN Nederland AI Engineer 4.0** (report 1548).
  - Blue Lynx 3.5, Akkodis, Wolters Kluwer, STAFIDE = DUPS of prior higher evals (merge-tracker skipped). Not new packets.
  - Borderline (<3.5): Nostrion 3.3, Linnk 3.0. Rest SKIP.
  - Tracker merged ✅ (applications.md). Sentinels cleaned.
  - PENDING: pipeline.md Pending→Processed for these 15 — HELD until Pass 2 scan finishes writing pipeline.md.
- Pass 2 (linkedin-auth) RUNNING (bg bjzok5dz0). Next: on completion, build full worklist (remaining pending), eval in bounded waves, then Phase 3 packets for ALL ≥3.5 incl. BMN.

---
## PACKET CANDIDATES (≥3.5) after Waves 1+2 (roles 0-59 done) — PRE-merge-dedup
1. BMN Nederland — AI Engineer 4.0 [report 1548]  ⭐NL
2. Zapier — Applied AI Engineer 4.0 [1565]  (confirm NL hiring)
3. Twine — AI Engineer 3.8 [1573]  (EEA remote)
4. Mendix — Solutions Engineer Core AI 3.7 [1560]  ⭐NL Amsterdam
5. EPAM — Senior Python/ML Engineer 3.5 [1562]  (non-NL, sponsor?)
6. Goodgame Studios — Senior AI Data & Analytics Eng 3.5 [1572]  (DE, sponsor?)
7. Staq.io — AI Engineer 3.5 [1606]  (Spain, sponsor?)
8. EPAM — Senior AI Python Developer 3.5 [1605]  (Bulgaria, sponsor?)
9. Macaque Consulting — AI Backend Engineer 3.5 [1607]  (Spain, verify EN)
10. Jet HR — AI Engineer 3.5 [1611]  (EU remote CET, verify EN)
11. GlobalLogic — LLM Engineer 3.5 [1613]  (Poland, English JD, confirm remote)
NOTE: SoftServe Senior GenAI = Poland (confirmed, 3.3, not a packet). Nortal 1601 = unreachable (retry).
Wave 3 (roles 60-74) IN FLIGHT: agents abde35(60-64), a39c28(65-69), ae5e0b(70-74).
NEXT: after Wave 3 → consolidated merge-tracker (watch dedup skips like Blue Lynx) → finalize packet list → Phase 3 packets in bounded waves → bulk pipeline.md Pending→Processed.

---
## RUN COMPLETE 2026-07-01T04:09:56+02:00
Phase1✅ Phase2✅(90 evals) Phase3✅(14 packets). Tracker merged, flags flipped, pipeline cleared, temp configs removed, memory saved.
