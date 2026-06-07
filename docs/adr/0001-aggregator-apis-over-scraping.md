# Use legitimate aggregator APIs instead of scraping LinkedIn/Indeed/Glassdoor

LinkedIn, Indeed, and Glassdoor expose no usable public jobs API, so surfacing
their listings would require ToS-violating scraping (LinkedIn especially: IP
reputation blocking, fingerprinting, fragile markup). We instead add a new
query-based **Aggregator** source type backed by legitimate APIs — Adzuna and
Arbeitnow (free, EU coverage) for direct discovery, and JSearch (a Google-for-Jobs
index, free tier) to recover LinkedIn/Indeed/Glassdoor postings indirectly.
Aggregators are modeled as a concept distinct from per-company ATS **Providers**
because one query returns jobs from many employers.

## Considered Options

- **Scrape the LinkedIn guest jobs endpoint** — rejected. Zero-token, but violates
  ToS, triggers IP-reputation blocking, and breaks whenever LinkedIn changes
  markup. (No profile ban risk since it needs no login, but the source is
  fundamentally unreliable.)
- **Paid SerpApi Google Jobs** — viable and very reliable, but $25+/mo. JSearch's
  free tier (~200 calls/mo) covers personal-scan volume, so paid is unnecessary now.
- **Keep only the existing WebSearch `site:` filters (Level 3)** — retained for
  ad-hoc discovery, but it costs LLM tokens every scan and yields stale or
  login-walled URLs. Not a substitute for structured zero-token ingestion.

## Consequences

- Introduces external API-key dependencies (Adzuna `app_id`/`app_key`, RapidAPI
  key for JSearch) and free-tier rate caps. A per-source usage counter guards the
  JSearch limit and warns before exhaustion.
- Aggregators reuse the existing `title_filter` + `location_filter`. Discovery runs
  as one unified scan so an Aggregator hit and an ATS-Provider hit for the same
  role deduplicate against each other.
- The per-company Provider path is kept (not removed), trimmed to a few directly
  tracked employers, because direct ATS polling is the freshest, zero-dependency
  source for companies the user specifically targets.
