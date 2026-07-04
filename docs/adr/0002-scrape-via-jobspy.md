# Scrape LinkedIn, Indeed, and Google Jobs via JobSpy

**Supersedes [0001](0001-aggregator-apis-over-scraping.md).** That decision chose
legitimate aggregator APIs over scraping to avoid ToS violations and IP blocking.
In practice the aggregators failed to surface the user's actual target market. A
cross-check of the seven roles the user applied to — all hand-sourced from
LinkedIn — against everything the scanner ever recorded (`data/scan-history.tsv`)
found **zero overlap (7 of 7 misses)**. The aggregators instead returned
German-language (Arbeitnow) and US-only / expired noise; Adzuna NL surfaced a
single result. The NL mid-market posts on LinkedIn, and no legitimate API indexes
that population densely enough to matter. The coverage gap is structural, not a
tuning problem, so we reverse 0001 and add a **Scraper** source type backed by
**JobSpy** (Python), covering LinkedIn (no-login guest endpoint), Indeed, and
Google Jobs. It is integrated as a subprocess (`jobspy_runner.py`) behind a thin
Node provider (`providers/jobspy.mjs`) that emits the existing job shape and
reuses the aggregator filter + dedup pass. Job descriptions are captured at
scrape time so downstream evaluation never re-fetches a login-walled page.

## Considered Options

- **`joeyism/linkedin_scraper`** (the library that prompted this) — rejected. It
  is a LinkedIn *profile* scraper, LinkedIn-only, and from v2.4.0 requires logging
  in with the user's real credentials — putting the actual account at ban risk.
  Wrong tool for job discovery.
- **`ts-jobspy` (Node port)** — rejected. Would keep the stack pure-Node, but it
  lacks Google Jobs (a hard requirement) and is immature (12★, 13 commits, no
  release) — too fragile to depend on.
- **Hand-rolled Node scrapers** — rejected for Indeed/Google. The LinkedIn guest
  endpoint is trivial to hand-roll, but Indeed (Cloudflare) and Google Jobs would
  put anti-bot and markup maintenance permanently on us — the exact fragility 0001
  warned about, relocated into our own repo.
- **Hosted scraping APIs (Apify / SerpApi / Bright Data)** — rejected. Reliable,
  but reintroduce paid API keys and quotas — the precise constraint this change
  exists to escape (JSearch's free-tier cap was the original pain).
- **Residential proxies from day one** — deferred, not adopted. Personal scan
  volume stays under LinkedIn's ~250-results-per-burst limit. Proxies are a JobSpy
  config parameter we can add later if we observe 429s; not a one-way door.

## Consequences

- **Python dependency.** A previously pure-Node project now requires Python 3.10+
  and `pip install python-jobspy` wherever a scan runs (including cron/unattended).
  This is the price of getting Google + Indeed + LinkedIn reliably from one
  maintained tool.
- **ToS exposure.** LinkedIn's policy (effective 2025-11-03) prohibits scraping.
  We use the no-login guest endpoint, so no account is at risk, but the home IP
  can be temporarily rate-limited (~250 results per burst on LinkedIn) — the same
  IP used for manual browsing. Mitigated by conservative caps: LinkedIn
  `results_wanted ≈ 100` per scan with broad role queries and **no per-keyword
  fan-out**; Indeed and Google run unthrottled.
- **Fragility ownership.** Scrapers break when boards change markup. We accept a
  maintained 3.6k★ community (JobSpy) owning that churn rather than owning it
  ourselves — the key reason we use the library instead of hand-rolling.
- **JD captured at scrape time.** LinkedIn results use
  `linkedin_fetch_description=True`, so the full JD is stored alongside the URL.
  Evaluation works offline and the verification step checks the canonical employer
  URL rather than the login-walled LinkedIn page (avoiding false "expired"
  negatives). This costs one extra LinkedIn request per job, paid for by the low
  `results_wanted` cap.
- **Kept-row JD fetch (later addition).** Scraper providers whose list rows lack
  a JD can expose a per-job `fetchJd()`; `scan.mjs` calls it only for rows that
  survive title/location/dedup filters, capped per provider (`max_jd_fetches`
  config key, default 60). This gets JD text in front of pre-triage (language
  penalty) at scan time without paying a detail request for filtered-out noise.
  Rows past the cap enter the pipeline JD-less, as before.
- **JSearch retired.** Scraped Google Jobs replaces JSearch's Google-for-Jobs
  index without an API key or monthly cap. `providers/jsearch.mjs` and
  `usage-ledger.mjs` become redundant and are slated for removal.
- **Minimal orchestration change.** The Scraper reuses the existing aggregator
  path (same `title_filter` + `location_filter`, same unified dedup), so a Scraper
  hit and an ATS-Provider hit for the same role still deduplicate against each
  other.
