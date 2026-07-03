# Autonomous Scan Loop — State

**Mission:** Continuously scan portals, improve the scan, evaluate finds, generate PDFs for any role scoring ≥3.5. Survive usage limits (resume after reset). Run unattended ~10h. Report back to user at the end.

**Started:** 2026-06-16 23:40 GMT+2
**Target end / report:** 2026-06-17 ~09:40 GMT+2
**User away:** no input expected for 10h; go with recommendations, never stop.

## Standing rules (calibration — DO NOT VIOLATE)
- **Dutch/German/French language REQUIRED in JD = hard blocker → score ≤1.5.** Verify in full JD text. (KPN #575 / Zonneplan #577 lesson.) JD *written* in Dutch ≠ Dutch required.
- Any NL location scores 5.0 on location; no commute penalty.
- Candidate is **MID-level** (AI/LLM Eng, ML Eng, Data Scientist). Lead/Head/Principal → cap Block A per modes/_profile.md. "Senior" OK if fit strong.
- Comp target €50–80K gross NL. Consulting/strategy archetype is a mismatch (score lower).
- PDF gate = **≥3.5** (config auto_pdf_score_threshold set to 3.5 for this run).
- NEVER submit applications. Evaluate + report + PDF only.
- Report numbering: sequential, max existing +1. After each wave run `node merge-tracker.mjs`.

## Update deferred
- v1.10.0 → v1.11.0 available; dismissed (revert risk to scan engine). Apply via git-merge later, NOT the clobbering updater.

## Report number cursor
- Max used before loop: **581**. Next free: see "allocated" below.

## Cycle log
### Cycle 0 — setup (2026-06-16 23:40)
- Ran update check (dismissed), doctor (ok), scan-stats.
- Fresh scan: +44 new offers. Pending backlog ~100 local JDs + URL finds.
- Set auto_pdf_score_threshold 4.0→3.5.
- Wave 1 launched: report nums 582–596 (see below).

## Allocated report numbers
- 582 de Bijenkorf Data Scientist
- 583 HSO Analytics & AI Engineer
- 584 Helloprint Founding AI Engineer
- 585 CuspAI Data Engineer
- 586 Samotics Data Scientist
- 587 NIBC Data Scientist
- 588 Booking.com Data Engineer II
- 589 Morgan Black AI Engineer
- 590 Cognizant Solution Architect AI Agents
- 591 Fyrm.ai medior AI Engineer
- 592 CIMSOLUTIONS Data Scientist
- 593 Nationale-Nederlanden AI Engineer
- 594 Van Oord Data & AI Engineer
- 595 Prodrive Technologies AI Engineer
- 596 Medtronic Data Scientist

## Scan-improvement notes
- ats-discover (2026-06-16): no NEW boards worth adding — Xebia already covers Xccelerated (xccelerated.recruitee.com 302→xebiacareers); Tether/Deeploy/Mistral/Nebius already tracked. KPN smartrecruiters = known Dutch blocker, skip. Coverage is current.
- Web discovery: NL mid-level EN AI market is saturated (per 2026-06-09 sweep) — diminishing returns. Strategy: re-run `node scan.mjs` each cycle for freshest postings; spend token budget on evaluating the ~100-item backlog, not more discovery.

## Next-wave queue (high-fit local JDs, not yet evaluated) — allocate 597+
Wave 2 candidates (English/on-profile, fast local JDs):
- Bright Professionals Data Scientist - Agentic AI (A88)
- WKL Consultancy XT DS/ML AI Eng 130k (A92)
- Packsize Sr. AI Engineer (A91)
- Celonis Senior Applied AI Engineer (A73)
- Quatt AI-Native builder (B71)
- Team5pm AI Workflow Engineer (A83)
- A2G Consulting AI Application Developer LLM (A83)
- Ubique Systems Azure AI Engineer (A91)
- DataNorth AI Solutions Engineer (A83 — check Dutch "Nederlandstalig")
- ING Senior Data Scientist (A91)
- ABN AMRO Senior Data Scientist (A91)
- Tiqets Senior Data Scientist (A91)
- Elevation Group Senior ML Engineer (A91)
- CGI Lead Data Engineer (A87)
- Stedin Data Engineer (A87 — check Dutch)
URL-fetch wave (need JD fetch): Xebia recruitee roles, Deeploy ashby, Nebius, Mistral, Haystack(dup-check), Gemeente Apeldoorn(Dutch?), Werken in Gelderland(Dutch?).
Defer/likely-SKIP: Tether remote-research (senior research overshoot), consulting-archetype (Accenture/Atos/Avantage strategy), academic (UvA, SURF research), Dutch-title govt roles.

## DISCIPLINE FIX (learned wave 1) — apply to ALL future waves
- Agents MUST NOT run merge-tracker.mjs (caused concurrent renumber races). Orchestrator merges ONCE per wave.
- Agent TSV first column = assigned REPORT_NUM verbatim (do NOT recompute max+1 — that caused the 584-588 vs 592-596 desync).
- Pre-assign report nums strictly ABOVE current tracker max so merge respects them (line 428: addition.num>maxNum keeps it).
- Dedup-check candidates vs applications.md BEFORE assigning (wave 1 wasted 5 evals on already-evaluated CuspAI/Samotics/NIBC/Helloprint/Morgan Black).
- Report FILE nums currently run to 596; tracker max num = 591 (cosmetic gap from wave-1 renumber — links resolve correctly, accepted). Next report file num = 597.

## Cycle 1 — Wave 1 results (582–596) — DONE
PDF (≥3.5): Fyrm.ai 4.2, Booking.com 4.0, de Bijenkorf 3.8, NIBC 3.8, Prodrive 3.8, CuspAI 3.6, Samotics 3.5 — all 7 PDFs on disk in output/.
SKIP: HSO 1.5 (Dutch), CIMSOLUTIONS 1.5 (Dutch), Nationale-Nederlanden 1.5 (Dutch), Helloprint 2.8, Van Oord 2.8, Medtronic 2.2, Cognizant 2.5, Morgan Black 3.3 (Java).
Note: CuspAI/Samotics/NIBC/Helloprint/Booking/Morgan Black were dedup-updates of earlier #544-549/#543 entries.

## Cycle 2 — Wave 2 results (597–606) — DONE, merged clean (nums respected, no renumber)
PDF (≥3.5): Tiqets 3.9, Quatt 3.8, IQVIA 3.6, Team5pm 3.6 — 4 PDFs on disk.
SKIP: WKL 3.2 (truncated JD — research first), Packsize 3.0, Celonis 2.8, Elevation 3.2, Samba TV 3.0, DataNorth 1.0 (Dutch).
⚠️ RE-FETCH-BEFORE-APPLY flags: WKL #597 + IQVIA #605 had truncated JDs at scan time.

## Cycle 3 — Wave 3 launched (607–616): A2Z-CM Sr AI, Empiric Agentic, Empiric Sr AI Amstelveen, Brain Corp SWE II, Alignerr ML, Hadrian Sr DE, zerohash Sr DE, Rabobank Back-end Conversational AI, NVIDIA Sr DL, Bright Professionals DS-Agentic.
- Fresh scan (cycle 3, 00:30): +12 new (Optics11 Sr AI/ML Eng Amsterdam ⭐, OverheidZZP Sr GenAI Eng, IQ Staffing AI eng — rest consulting/Dutch/recruiter). Pending ~140.
- RUNNING TOTAL PDFs (≥3.5): 11 (wave1: 7, wave2: 4).

## Cycle 3 — Wave 3 results (607–616) — DONE, merged clean
PDF (≥3.5): Empiric Freelance Agentic 3.8, Bright Professionals/Philips DS-Agentic 3.8, A2Z-CM Sr AI 3.6, zerohash Sr DE 3.5.
SKIP: Empiric Amstelveen 1.0 (Dutch), Brain Corp 2.8, Alignerr 2.2, Hadrian 3.2, Rabobank Back-end Conv-AI 3.1, NVIDIA 2.3.
⭐ LEAD TO QUEUE: Rabobank Senior Full Stack AI Engineer (scale 10, €65–92K, LangGraph/RAG) — agent flagged as stronger than #614; find/fetch JD for a future wave.

## Cycle 4 — Wave 4 launched (617–626): Optics11 Sr AI/ML ⭐, Cushman&Wakefield Sr DE, Good Company Sr DE, ITIS DE, dsm-firmenich Sr Scientist AI/ML, Organon AI&Tech Specialist II (⭐ level-I was 4.4 Applied #011), KMWE AI&Automation, Cognizant Sr Back-end Conv-AI, AHOLD Logistical SW/DE, ITproposal Platform Eng AI&Analytics.
- Skipped MLabs (company already #266 culture-mismatch SKIP).
- RUNNING TOTAL PDFs (≥3.5): 15 (w1:7, w2:4, w3:4).

## Cycle 4 — Wave 4 results (617–626) — DONE (low yield, backlog saturating)
PDF (≥3.5): AHOLD Delhaize Sr SW/DE Logistical 3.6. ONLY 1/10.
SKIP/below: Optics11 2.2 (defense/acoustics+clearance), Cushman 2.8 (JD trunc), Good Company 2.5 (Dutch JD trunc), ITIS 1.0 (Dutch), dsm-firmenich 1.5 (PhD/biology), Organon II 1.0 (Dutch! — note level-I #011 was 4.4, repost added Dutch req), KMWE 2.8, Cognizant Back-end 3.4 (Java cap, just missed), ITproposal 2.2 (infra-ops).

## SATURATION NOTE — high-fit local-JD backlog largely exhausted
Many pending rows are STALE already-evaluated roles (Oakwell 4.4 SKIP, BAS Group 4.0 Applied #576, Celonis #599, Xebia ×6, IQ Staffing ×3, A2G #495, Cegeka #541). MUST dedup-check every candidate. Remaining tail skews Data-Engineer/Dutch/consulting/Lead/niche. Strategy: curate only genuine NEW AI/ML/DS roles; pivot to URL-fetch finds; slow cadence as pool empties.

## Cycle 5 — Wave 5 launched (627–636): Super Sr ML, PAFnow/Celonis Sr Applied AI, Elephants-in-the-Room Back-end+DS, European Tech Recruit Sr ML, Jobgether Sr AI Supernal, Jobgether Sr ML Token Factory, OverheidZZP Sr GenAI, IQ Staffing AI eng, Xebia GEN AI Engineer (URL), Xebia ML Engineer (URL).
- RUNNING TOTAL PDFs (≥3.5): 16 (w1:7, w2:4, w3:4, w4:1).

## Cycle 5 — Wave 5 results (627–636) — DONE (HIGH yield via curation+URL fetch)
PDF (≥3.5): IQ Staffing AI Eng 4.1 ⭐, Jobgether/Supernal Sr AI 3.8, Xebia GEN AI Eng 3.8, Super Sr ML 3.6, Elephants-in-the-Room Back+DS 3.5, Xebia ML Eng 3.5. SIX PDFs.
SKIP: PAFnow/Celonis 2.8 (pre-sales), European Tech Recruit 2.0 (semiconductor C++), Jobgether Token 2.2 (GPU systems), OverheidZZP GenAI 1.5 (Dutch CV mandated).

## Cycle 6 — Wave 6 MOP-UP launched (637–641, 1 agent): Ubique Azure AI, STAFIDE Sr DE, IQVIA Lead DE, Hoppinger AI SolArch, Mistral AI Deployment Strategist (LinkedIn fetch). These are the last borderline-new candidates.
- RUNNING TOTAL PDFs (≥3.5): 22 (w1:7, w2:4, w3:4, w4:1, w5:6).

## >>> TRANSITION TO MONITOR MODE after wave 6 <<<
Realistic ≥3.5 pool from current pipeline is EXHAUSTED. Remaining ~105 pending are dups, Dutch-required, Lead-level, consulting, infra/systems, or niche-domain (verified via dedup). Grinding them wastes budget + violates quality-over-quantity ethos.
NEW PLAN for rest of 10h window (until ~09:40 GMT+2):
- Re-run `node scan.mjs` every ~45–60 min to catch genuinely NEW postings (overnight/morning).
- Evaluate ONLY fresh finds that are clearly on-archetype (AI/LLM/ML/DS), English, NL/remote, mid-senior, and NOT already in tracker.
- Use longer ScheduleWakeup intervals (~2400–3000s) to conserve budget across the long idle window.
- Keep state file + running PDF total updated each cycle.
- At ~09:40 GMT+2 produce the FINAL SUMMARY report for the user.

## Cycle 6 — Wave 6 mop-up (637–641) — DONE, merged. 0 PDFs (all <3.5: Ubique 1.0 Dutch, STAFIDE 2.8, IQVIA Lead 2.2, Hoppinger 2.5 C#/.NET, Mistral 3.2 consulting/travel). Confirms saturation.

## MONITOR MODE active (from cycle 7)
- Monitor scan (01:35): +4 new → evaluating DataSnipper Sr SWE AI Agents (642, Amsterdam ⭐), Jobgether Sr NLP Eng (643), NVIDIA DL SWE Inference (644, GPU-gap-predict), Capgemini DS Consultant (645, consulting-predict).
- Cadence now: scan every ~50min, eval only new high-fit, longer wakeups to conserve budget. Final summary at ~09:40 GMT+2.

## Cycle 7 — Monitor wave (642–645) DONE, merged. PDF: DataSnipper Sr SWE AI Agents 3.6 ⭐. SKIP: Jobgether NLP 2.8, NVIDIA Inference 1.5 (GPU systems), Capgemini DS Consultant 2.5 (comp+consulting).
- RUNNING TOTAL PDFs THIS LOOP (≥3.5): 23 (w1:7, w2:4, w3:4, w4:1, w5:6, w6:0, monitor:1).
- Steady monitor cadence begins ~01:45 GMT+2. Next monitor scans at ~50min intervals.

### PDF coverage audit (tick 2, 03:00)
- 16 tracker entries ≥3.5 have PDF❌, but 11 are SKIP-status (disqualified: remote-non-EU/closed/location — correctly no PDF), 2 Applied + 1 Discarded (handled). Only actionable gaps: #533 Xebia ML 3.5 (SUPERSEDED by this loop's #636 which HAS a PDF) and #231 Ctalents ML 3.5 (borderline werk.nl listing). ⇒ ≥3.5 PDF coverage for ACTIONABLE roles is effectively COMPLETE. No meaningful backfill needed.

### Monitor ticks log
- FINAL tick (09:30): scan +1. Evaluated Docentenmarktplaats.nl/Deltion AI Eng (657, 3.7 ✅ PDF — GenAI/RAG/MLOps fit, Zwolle, no Dutch req, Consider). Running PDF total → 25. LOOP ENDED — final report posted to user. Session reports 582–657 = 76 evals, 25 PDFs (≥3.5).
- Tick 7 (08:43): scan +2. Evaluated Fluence AI Use Case Developer (656, 1.5 — US work-auth req + Salesforce core, Skip). Skipped Tether kernel/inference (systems gap). Running PDF total still 24. Roles evaluated this session: 81.
- Tick 6 (07:45): scan +1. Evaluated Signify Technology Sr Full Stack/AI Eng (655, 2.5 — TypeScript/Node full-stack hard req, recruiter/vague JD, Skip). Running PDF total still 24. Roles evaluated this session: 80.
- Tick 5 (06:42): scan +9 (morning pickup). Evaluated Booking AI Backend SWE II (652, 3.3 — backend-platform not AI-app), Booking Sr Solutions Architect Data&AI (653, 2.5 — principal-track), HCLTech Sr Tech Lead GenAI (654, 3.2 — Lead cap + consultancy). Skipped Sopra Steria Lead-consult, Gramian DUTCH analyst, NVIDIA VLM research, NIBC DS (dup #587), DHL Sr DE (no JD), Rabobank Sr DE (marginal). Running PDF total still 24. (Near-miss watch: Booking AI Backend 3.3, HCLTech GenAI 3.2.)
- Tick 4 (05:41): scan +1. Evaluated Unica Building Projects AI Eng (651, 3.6 ✅ PDF — no Dutch req, AI assistant/RAG/ERP fit, Bodegraven €52.6-72K, Consider). Running PDF total → 24.
- Tick 3 (04:05–04:45): Bash-classifier outage ~40min (transient infra, NOT usage limit) — backed off 270s→1800s, recovered. Scan +7. Evaluated Qualcomm Sr ML Eng AI Research (649, 2.3 — C++/Android/quantization systems gap) + Independent Recruiters Sr GenAI Tijdelijk (650, 3.2 — Terraform/Azure gap + Dutch-context risk, research-first €84-96K). Skipped Celonis consultants ×2, DAS/Jobster Dutch, Xylem Lead. Running PDF total still 23.
- Tick 2 (03:00): +6 scan finds. Evaluated NS MLOps Eng (648, 3.0 — platform/DevEx archetype + 5yr req, Skip). Skipped PAFnow Solutions Consultant + SevenLab consultant (consulting), M&I Windows/.NET, VU/UU Dutch PhD/student. Running PDF total still 23.
- Tick 1 (02:00): +4 scan finds. Evaluated Tibber Sr AI Platform Eng (646, 3.3 — K8s/TS gap) + Haystack AI Eng Energietransitie (647, 3.4 — recruiter unknowns, €102K comp; research-first). Both JUST below 3.5, no PDF. Skipped Sytac Kotlin-backend (Sytac Agentic role already #067 4.4) + OverheidZZP full-stack (Dutch). Running PDF total still 23.

## TOP RECOMMENDATIONS (≥3.5, for final report)
4.0+: IQ Staffing AI Engineer 4.1 (#634), Fyrm.ai medior AI Eng 4.2 (#591), Booking.com Data Eng II 4.0 (#588 — note status Discarded).
3.8-3.9: Tiqets Sr DS 3.9 (#602), de Bijenkorf DS 3.8 (#582), NIBC DS 3.8 (#587), Prodrive AI Eng 3.8 (#595), Quatt AI-Native 3.8 (#600), Empiric Freelance Agentic 3.8 (#608), Bright Prof/Philips DS-Agentic 3.8 (#616), Xebia GEN AI Eng 3.8 (#635), Jobgether/Supernal Sr AI 3.8 (#631).
3.5-3.6: CuspAI DE 3.6, Samotics DS 3.5, IQVIA Sr AI/ML 3.6, Team5pm 3.6, A2Z-CM Sr AI 3.6, zerohash Sr DE 3.5, AHOLD Logistical 3.6, Super Sr ML 3.6, Elephants Back+DS 3.5, Xebia ML Eng 3.5, DataSnipper Sr SWE AI Agents 3.6, Unica Building Projects AI Eng 3.6 (#651, confirm English).
NEAR-MISS WATCH (3.0-3.4, research-first if interested): Tibber Sr AI Platform 3.3 (K8s/TS gap), Haystack Energietransitie 3.4 (€102K, recruiter unknowns), Cognizant Back-end Conv-AI 3.4 (Java cap), Independent Recruiters Sr GenAI 3.2 (€84-96K, Terraform/Azure+Dutch-context), Mistral Deployment Strategist 3.2 (consulting/travel).
VERIFY-BEFORE-APPLY flags: WKL #597 + IQVIA-Sr #605 + Cushman #618 + Good Company #619 (truncated JDs); Jobgether/Supernal #631 (hidden company); Xebia #635/#636 + Bright/Philips #616 (liveness); Fyrm.ai #591 (confirm English).

## Wave 2 launched (597–606) — clean/new only (dedup-checked)
597 WKL Consultancy, 598 Packsize, 599 Celonis, 600 Quatt, 601 Team5pm, 602 Tiqets, 603 Elevation Group, 604 Samba TV, 605 IQVIA, 606 DataNorth(Nederlandstalig-check).
Already-evaluated (SKIP from queue): A2G #495, Ubique, ING×4, ABN×2, CGI×2.
