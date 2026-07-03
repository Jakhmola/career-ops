# Story Bank — Master STAR+R Stories

This file accumulates your best interview stories over time. Each evaluation (Block F) adds new stories here. Instead of memorizing 100 answers, maintain 5-10 deep stories that you can bend to answer almost any behavioral question.

## How it works

1. Every time `/career-ops oferta` generates Block F (Interview Plan), new STAR+R stories get appended here
2. Before your next interview, review this file — your stories are already organized by theme
3. The "Big Three" questions can be answered with stories from this bank:
   - "Tell me about yourself" → combine 2-3 stories into a narrative
   - "Tell me about your most impactful project" → pick your highest-impact story
   - "Tell me about a conflict you resolved" → find a story with a Reflection

## Stories

<!-- Format:
### [Theme] Story Title
**Source:** Report #NNN — Company — Role
**S/T/A/R + Reflection + Best for**
-->

### [Production AI / impact] FSM → Multi-Agent RAG
**Source:** Report #483 — Boels Rental — AI Engineer (P1, Bobble AI)
**S:** In-app conversational agent ran on a brittle finite-state machine; multilingual (Hindi/Hinglish) users, strict <2–3s mobile latency.
**T:** Replace it with a trustworthy production LLM assistant.
**A:** Multi-agent RAG — proprietary LLM + web-search crawler → chunked docs in FAISS/Redis, hybrid BM25 + dense retrieval fused with RRF (k=60), Redis semantic chunk caching; phased rollout (knowledge-in-prompt → tools → web-search RAG).
**R:** Factual-hit rate +67pp, DAU +150% QoQ (stable into next quarter), FSM retired entirely.
**Reflection:** RAG isn't always the answer — Phase 1 was knowledge-in-prompt; add retrieval infra only when corpus cadence justifies it.
**Best for:** most impactful project, RAG/agents depth, production ownership, latency/cost trade-offs.

### [Architecture judgment] Why NOT RAG in Phase 1
**Source:** Report #483 — Boels Rental — AI Engineer (P1, Bobble AI)
**S:** Pressure to "just add RAG" for the onboarding assistant.
**T:** Pick the cheapest design that actually meets the need.
**A:** Bounded, slow-changing corpus → put 15–20 features in a ~1,200-token system prompt, no index; documented the threshold (weekly feature cadence) at which RAG wins.
**R:** Shipped faster and cheaper; avoided premature infra.
**Reflection:** Architecture is matching cost to the problem, not reaching for the fanciest tool.
**Best for:** "translate business → technical design," trade-off questions, system design.

### [Eval / reliability] 4-Layer Eval Ladder + Drift Loop
**Source:** Report #483 — Boels Rental — AI Engineer (P1, Bobble AI)
**S:** LLM output drifts silently once real users arrive.
**T:** Keep a production agent trustworthy over time.
**A:** RAGAS + different-family LLM-judge (Cohen's κ-calibrated against humans), Prometheus/Grafana dashboards, async 6-hourly drift job → flagged convos fed back into the offline eval set (closed loop).
**R:** Caught regressions before users did; release gate held quality across launches.
**Reflection:** Eval is a system, not a one-off test — calibrate the judge against humans or you're flying blind.
**Best for:** "evaluate/monitor/optimize," reliability, MLOps/observability.

### [Cost-aware ML] Two-Stage Intent Classifier
**Source:** Report #483 — Boels Rental — AI Engineer (P3, Bobble AI)
**S:** Running an LLM on every event (~1M/6h) was too expensive.
**T:** Cut cost without losing accuracy.
**A:** Stage A embedding-similarity (max cosine over 20 example vectors/signal) resolves ~82% near-free; Stage B LLM fallback only for uncertain signals; batch API (50% cheaper).
**R:** Macro-F1 0.87 vs 0.72 legacy; +11% push open rate; large cost saving.
**Reflection:** Reserve the expensive model for the genuinely hard cases — most decisions don't need it.
**Best for:** cost/performance trade-off, production ML at scale, pragmatic engineering.

### [Stakeholders / discovery] Topic Modelling → Roadmap
**Source:** Report #483 — Boels Rental — AI Engineer (P4, Bobble AI)
**S:** Raw free-form usage data, no structure for product decisions.
**T:** Turn usage into product direction stakeholders would act on.
**A:** Sentence-transformer embeddings → UMAP → HDBSCAN → GPT labels, reviewed monthly with PM/UX.
**R:** 10+ stable themes seeded the classifier taxonomy and triggered the IPL live-commentary feature.
**Reflection:** The value wasn't the clustering — it was making it legible enough that PMs acted on it.
**Best for:** "identify AI use cases with stakeholders," cross-functional collaboration.

### [Data engineering] Medallion Pipeline 6h → 45min
**Source:** Report #483 — Boels Rental — AI Engineer (P5, Golden Pegasus / FMCG)
**S:** pandas-on-a-VM ETL kept breaking on vendor schema changes; 20M+ records/day.
**T:** Make the pipeline reliable at volume.
**A:** Bronze/Silver/Gold on Delta Lake, Auto Loader exactly-once, Great Expectations gate between Silver and Gold, atomic prod-table swaps.
**R:** End-to-end latency 6h → <45min; silent failures eliminated.
**Reflection:** Data-quality gates are cheaper than debugging a bad model downstream.
**Best for:** "data pipelines + knowledge retrieval," reliability, data-eng foundations.

### [Failure / resilience] COVID Forecast Break
**Source:** Report #483 — Boels Rental — AI Engineer (P5, Golden Pegasus / FMCG)
**S:** Demand-forecasting model degraded the week COVID lockdowns hit.
**T:** Recover without flying blind.
**A:** Monitoring dashboard caught the drift in days; ran a 3-week manual-override window while a COVID flag was designed, added, and the model retrained.
**R:** Restored accuracy; the experience drove investment in monitoring/drift detection (PSI).
**Reflection:** The 3-week window was the honest cost of not pre-building the flag — that's why I now build monitoring first.
**Best for:** "tell me about a failure," resilience, honesty/seniority signal.
