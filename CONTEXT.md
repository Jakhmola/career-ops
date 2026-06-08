# Career-Ops Domain

The shared vocabulary for how career-ops discovers, evaluates, and tracks job
offers. This is a glossary, not a spec — it defines what terms mean, not how the
code works.

## Job discovery

**Provider**:
A job source bound to a single employer, fetched from that employer's applicant
tracking system through its public JSON API (Greenhouse, Ashby, Lever, …).
One employer, one endpoint.
_Avoid_: portal, integration, connector

**Aggregator**:
A query-based job source that returns postings from many employers in response
to a search (keywords + location), fetched through a legitimate public API.
Adzuna, Arbeitnow, and JSearch are aggregators. Distinct from a Provider (tied to
one employer) and from a Scraper (same query-based role, but fetches by scraping
a job board instead of via an API).
_Avoid_: portal, board, connector

**Scraper**:
A query-based job source that returns postings from many employers by scraping a
public job board's search results — LinkedIn, Indeed, Google Jobs — rather than
calling an API. Plays the same role in a Scan as an Aggregator (reuses the title
and location filters and the shared dedup pass), but is named separately because
its access mechanism carries ToS-gray status, IP-reputation / rate-limit risk,
and markup fragility that an API-backed Aggregator does not. Backed by JobSpy.
_Avoid_: crawler, bot, portal

**Tracked company**:
A single employer the scanner watches directly via its Provider. Curated by the
user, one entry per employer.
_Avoid_: portal, target

**Source**:
The attribution label recorded on each discovered job, naming which Provider or
Aggregator surfaced it (e.g. `greenhouse`, `adzuna`, `jsearch`). Used for
per-source statistics.
_Avoid_: portal, origin, channel

## Flow

**Pipeline**:
The inbox of discovered-but-not-yet-evaluated job URLs awaiting scoring.
_Avoid_: queue, backlog

**Scan**:
A single run of the discovery step that polls all enabled Providers and
Aggregators, deduplicates, filters by title and location, and appends new jobs
to the Pipeline.
_Avoid_: crawl, fetch, poll
