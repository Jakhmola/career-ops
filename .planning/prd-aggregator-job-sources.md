# PRD — Aggregator Job Sources (Adzuna · Arbeitnow · JSearch)

> **For the implementing agent:** You are picking this up cold. Read §0–§3 before
> writing any code. The design is already decided and documented — your job is to
> implement it faithfully, not to redesign it. Work through the §4 checklist.

---

## 0. Read first (orientation)

- **Why this exists:** `docs/adr/0001-aggregator-apis-over-scraping.md` — the
  decision record explaining why we use legitimate aggregator APIs instead of
  scraping LinkedIn/Indeed/Glassdoor. Do not reopen that decision.
- **Vocabulary:** `CONTEXT.md` (repo root) — the glossary. Key terms: **Provider**
  (per-company ATS source), **Aggregator** (query-based source returning jobs from
  many companies), **Source** (attribution label), **Scan**, **Pipeline**.
- **Architecture of the existing scanner:** read `scan.mjs` top-to-bottom and one
  example provider (`providers/greenhouse.mjs`, `providers/ashby.mjs`) plus the
  shared helper `providers/_http.mjs` and the type `providers/_types.js`.
- **House rules you MUST honor (from `CLAUDE.md` / `AGENTS.md`):**
  - **Data Contract.** System layer (auto-updatable): `scan.mjs`, `providers/*.mjs`,
    `templates/*`, `CLAUDE.md`, `AGENTS.md`. User layer (never auto-overwritten):
    `portals.yml`, `config/profile.yml`, `data/*`, `.env`. The `aggregators:` block
    lives in `portals.yml` (user layer); the provider code lives in `providers/`
    (system layer).
  - **Zero-token rule.** The scanner is pure HTTP + JSON. No LLM calls in `scan.mjs`
    or any provider.
  - **Pipeline integrity.** Never add tracker entries by hand; the scanner only
    writes to `data/pipeline.md` and `data/scan-history.tsv`.
  - **Sequential Playwright only** — not relevant here (aggregators are HTTP-only).

---

## 1. Goal & non-goals

**Goal:** Add three query-based aggregator sources to the zero-token scanner so a
single `node scan.mjs` run discovers jobs from many employers (not just the
hand-tracked companies), feeds them through the existing title/location filters and
dedup, and writes new ones to `data/pipeline.md`.

| Aggregator | Auth | Cost | Why |
|---|---|---|---|
| **Arbeitnow** | none | free | EU/NL ATS-sourced feed; works out of the box |
| **Adzuna** | `app_id`+`app_key` | free | Broad NL/EU coverage, salary data |
| **JSearch** | RapidAPI key | free tier ~200/mo | The only legit way to surface LinkedIn/Indeed/Glassdoor (via Google for Jobs) |

**Non-goals:**
- No scraping of LinkedIn/Indeed/Glassdoor directly (see ADR 0001).
- No paid SerpApi (revisit only if JSearch's free tier proves insufficient).
- No new CLI command — aggregators run inside the existing `node scan.mjs`.
- Do not remove the per-company Provider path; it stays (trimmed to 3 companies).

---

## 2. Architecture overview

The existing scanner iterates `tracked_companies` and resolves one **Provider** per
company from its `careers_url`. Aggregators are different: **one query → jobs from
many companies**, no `careers_url`, no per-company entry.

Implementation shape (keeps the existing loader & contract intact):
- Aggregator providers live in `providers/` like the others and are auto-loaded by
  `loadProviders()` (they export `{ id, fetch }`). **They have NO `detect()`**, so
  the per-company `resolveProvider()` loop never auto-selects them.
- `scan.mjs` gets a **new aggregator path** that reads `config.aggregators`, looks up
  each enabled aggregator provider by `id`, and calls `fetch(descriptor, ctx)` with a
  **search descriptor** (derived from `title_filter` + `location_filter` + the
  aggregator's own config) instead of a company entry.
- Results from aggregators and from tracked companies are merged into the **same**
  `newOffers` array and go through **one** title-filter → location-filter → dedup
  pass, so an Adzuna hit and a Greenhouse hit for the same role collapse to one.
- Each offer keeps a `source` label = the provider `id` (`adzuna`, `arbeitnow`,
  `jsearch`, `greenhouse`, …) for per-source stats.

---

## 3. The aggregator fetch contract

Per-company providers receive a `tracked_companies` entry. Aggregator providers
receive a **search descriptor** built by `scan.mjs`:

```js
/** @typedef {Object} AggregatorDescriptor
 * @property {string}   name        Display name (e.g. "Adzuna")
 * @property {string[]} positive    config.title_filter.positive (raw keywords)
 * @property {Object}   location    { country, where, allow[], block[], always_allow[] }
 * @property {Object}   config      Raw aggregators.<id> config (max_pages, query, monthly_cap, …)
 */
```

Aggregator provider default export:

```js
/** @type {import('./_types.js').Provider} */
export default {
  id: 'adzuna',
  // NO detect() — aggregators are never auto-matched to a tracked company.
  async fetch(descriptor, ctx) {
    // 1. Read secrets from process.env (dotenv is already loaded by scan.mjs).
    //    Missing key → return [] (dormant, not an error).
    // 2. Build request(s) from descriptor.positive / descriptor.location / descriptor.config.
    // 3. For each HTTP request, call ctx.recordCall('adzuna') BEFORE/at the call (usage counter).
    // 4. Map raw results → [{ title, url, company, location }].
    return parseAdzunaResponse(json, descriptor);
  },
};
```

**Each provider must also export a named pure parse function** (e.g.
`export function parseAdzunaResponse(json, descriptor)`) that maps a raw API payload
to `[{title,url,company,location}]` with **no network** — this is what `test-all.mjs`
unit-tests with fixtures (mirror the existing `parseWorkableMarkdown` /
`parseSmartRecruitersResponse` / `parseRecruiteeResponse` pattern).

`ctx` is from `makeHttpCtx()` (`providers/_http.mjs`): `ctx.fetchJson(url, {timeoutMs,
headers, redirect})`, `ctx.fetchText`. **You will extend `ctx` with
`ctx.recordCall(source, n=1)`** for the usage counter (see §5.7).

---

## 4. Deliverables checklist

- [ ] **4.1** `providers/arbeitnow.mjs` (+ `parseArbeitnowResponse`)
- [ ] **4.2** `providers/adzuna.mjs` (+ `parseAdzunaResponse`)
- [ ] **4.3** `providers/jsearch.mjs` (+ `parseJSearchResponse`)
- [ ] **4.4** `scan.mjs`: load `dotenv`, run aggregator path, per-source stats, usage counter
- [ ] **4.5** `usage-ledger.mjs` (or inline): `data/api-usage.tsv` read/increment + monthly-cap guard
- [ ] **4.6** `portals.yml`: trim `tracked_companies` to 3, add `aggregators:` block, update header comment
- [ ] **4.7** `.env.example`: committed template documenting the three keys
- [ ] **4.8** `.gitignore`: add `data/api-usage.tsv`
- [ ] **4.9** Docs: `templates/portals.example.yml`, `modes/scan.md`, `CLAUDE.md`, `AGENTS.md`, `DATA_CONTRACT.md`
- [ ] **4.10** Tests in `test-all.mjs` for the three providers + usage ledger
- [ ] **4.11** Verify: `node scan.mjs --dry-run` and per-company smoke tests pass; `node test-all.mjs` green

---

## 5. Detailed specs

### 5.1 Secrets & dotenv

- `dotenv@^17` is already a dependency; `.env` is already gitignored. A `.env` with
  empty placeholders already exists at repo root (user fills it).
- At the **top of `scan.mjs`**, before reading config, load env: `import 'dotenv/config';`
  (place it among the imports). Providers then read `process.env.ADZUNA_APP_ID` etc.
- Create **`.env.example`** (committed) mirroring `.env`'s keys with blank values and
  the same signup-URL comments. Variables: `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`,
  `RAPIDAPI_KEY`.
- A provider whose required key is absent returns `[]` and logs one concise note
  (e.g. `adzuna: skipped — ADZUNA_APP_ID/KEY not set`). Never throw on missing keys.

### 5.2 Arbeitnow provider (`providers/arbeitnow.mjs`)

- **Endpoint:** `GET https://www.arbeitnow.com/api/job-board-api` — no auth.
- **Pagination:** `?page=N`. Read `descriptor.config.max_pages` (default `2`).
- **Response:** `{ data: [ { title, company_name, url, location, remote, tags, job_types, created_at, slug } ], links, meta }`.
- **Map:** `title=title`, `url=url`, `company=company_name`, `location=location` (string).
- **Notes:** No keyword query param (it's a recent-jobs feed) — rely on the
  scanner's title/location filters downstream. Call `ctx.recordCall('arbeitnow')`
  once per page fetched. EU/Germany-heavy.

### 5.3 Adzuna provider (`providers/adzuna.mjs`)

- **Endpoint:** `GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}`
  - `{country}` = lowercase ISO (`nl` default from `descriptor.config.country`).
  - `{page}` = 1..`max_pages` (default `1`).
- **Auth:** query params `app_id`, `app_key` (NOT headers) from `process.env`.
- **Query params:** `results_per_page=50`, `what_or=<positive keywords space-joined>`
  (from `descriptor.positive`), `where=<descriptor.config.where>` (optional, e.g.
  "Netherlands"), `max_days_old=<descriptor.config.max_days_old || 30>`,
  `sort_by=date`, `content-type=application/json`.
- **Response:** `{ count, results: [ { title, redirect_url, company:{display_name},
  location:{display_name, area:[…]}, created, salary_min, salary_max } ] }`.
- **Map:** `title=title`, `url=redirect_url`, `company=company.display_name`,
  `location=location.display_name`.
- **Notes:** Call `ctx.recordCall('adzuna')` once per page. URL-encode params.
  Skip (return `[]`) if either key is missing.

### 5.4 JSearch provider (`providers/jsearch.mjs`)

- **Endpoint:** `GET https://jsearch.p.rapidapi.com/search`
- **Headers:** `X-RapidAPI-Key: <process.env.RAPIDAPI_KEY>`,
  `X-RapidAPI-Host: jsearch.p.rapidapi.com`.
- **Query params:** `query` (free-text, e.g. `"AI Engineer OR LLM Engineer OR Machine
  Learning in Netherlands"` — build from a compact slice of `descriptor.positive`
  joined with ` OR ` + ` in ` + location), `page=1`, `num_pages=1`,
  optional `country=nl`, `date_posted=month`.
- **Response:** `{ status, data: [ { job_title, employer_name, job_apply_link,
  job_city, job_country, job_posted_at_datetime_utc, job_id } ] }`.
- **Map:** `title=job_title`, `url=job_apply_link`, `company=employer_name`,
  `location=[job_city, job_country].filter(Boolean).join(', ')`.
- **Quota guard (critical):** free tier ≈ 200 requests/month. Keep `num_pages=1` and
  at most 1–2 queries per scan. `scan.mjs` MUST check the monthly cap (§5.7) BEFORE
  calling JSearch and skip with a warning if exceeded. Call `ctx.recordCall('jsearch')`
  per HTTP request. Skip (return `[]`) if `RAPIDAPI_KEY` is missing.

### 5.5 `scan.mjs` changes

1. **`import 'dotenv/config';`** at top.
2. After the existing per-company `targets` are built and fetched, add an
   **aggregator phase** (before or alongside the tracked-company `parallelFetch`, but
   feeding the same `newOffers`/dedup):
   - Read `config.aggregators` (object keyed by provider id, e.g. `{ adzuna:{…},
     arbeitnow:{…}, jsearch:{…} }`).
   - For each entry with `enabled !== false`, look up `providers.get(id)`. If missing,
     warn and skip.
   - Build the `AggregatorDescriptor` (§3) from `config.title_filter.positive`,
     `config.location_filter`, and the aggregator's own config.
   - **Cap check:** if the provider has a `monthly_cap` and the usage ledger says the
     cap is reached this month, skip it with a clear console note.
   - Call `provider.fetch(descriptor, ctx)`; push results into the SAME filtering/
     dedup pipeline used for tracked companies (title filter → location filter →
     `seenUrls`/`seenCompanyRoles` dedup → `newOffers` with `source: id`).
   - Aggregator fetches may run via `parallelFetch` too, but keep JSearch effectively
     serial/limited to respect quota.
3. **Per-source stats:** maintain a `Map` of `source → count` for added offers (and
   optionally found/filtered). Print a breakdown in the summary block, e.g.:
   ```
   New offers added:      18
     ├─ adzuna     9
     ├─ arbeitnow  6
     └─ jsearch    3
   ```
4. **Flush the usage ledger** after the scan (write incremented counts).
5. Keep all existing behavior (tracked companies, `--dry-run`, `--company`,
   `--verify`) working unchanged.

### 5.6 `ctx.recordCall` wiring

- Extend `makeHttpCtx()` (or wrap the ctx in `scan.mjs`) so `ctx.recordCall(source,
  n=1)` accumulates an in-memory per-source counter for this run. After the scan,
  `scan.mjs` merges those counts into the persistent ledger (§5.7). Keep
  `_http.mjs`'s default `recordCall` a no-op so providers imported in isolation
  (tests) don't break.

### 5.7 Usage ledger (`usage-ledger.mjs` or inline)

- **File:** `data/api-usage.tsv`, header `month\tsource\tcalls` (month = `YYYY-MM`).
- **API:**
  - `readUsage()` → `Map<\`${month}\t${source}\`, number>`.
  - `getMonthlyCount(source, month=thisMonth)` → number.
  - `addUsage(countsBySource, month=thisMonth)` → merge + write back.
- **Cap check:** for a provider with `config.monthly_cap` (default for jsearch: `180`,
  safely under 200), `scan.mjs` skips it when `getMonthlyCount(id) >= monthly_cap`.
- Add `data/api-usage.tsv` to `.gitignore`.

### 5.8 `portals.yml` edits (USER LAYER — edit carefully, preserve user's filters)

1. **Trim `tracked_companies`** to exactly these three (replace the whole list).
   These ATS endpoints are **verified** (2026-06-07):

   ```yaml
   tracked_companies:
     - name: Adyen
       careers_url: https://job-boards.greenhouse.io/adyen   # greenhouse auto-detect
       enabled: true
     - name: Miro
       provider: greenhouse                                   # explicit: board is on the
       api: https://boards-api.greenhouse.io/v1/boards/realtimeboardglobal/jobs  # older boards.greenhouse.io host
       enabled: true                                          # which detect() regex does NOT match
     - name: Cradle
       careers_url: https://jobs.ashbyhq.com/cradlebio        # ashby auto-detect
       enabled: true
   ```
   > ⚠️ **Miro gotcha:** `greenhouse.mjs` `detect()` only matches
   > `job-boards.greenhouse.io/<token>`. Miro's board token is `realtimeboardglobal`
   > on the older `boards.greenhouse.io` host, so you MUST set `provider: greenhouse`
   > + explicit `api:` (the boards-api host IS in greenhouse.mjs's allowlist).

2. **Add an `aggregators:` block** (thin — reuses `title_filter` + `location_filter`):

   ```yaml
   # -- Aggregators (query-based sources; keys live in .env) --
   # Reuse title_filter.positive + location_filter automatically.
   aggregators:
     arbeitnow:
       enabled: true            # no key required
       max_pages: 2
     adzuna:
       enabled: true            # needs ADZUNA_APP_ID / ADZUNA_APP_KEY in .env
       country: nl
       where: Netherlands
       max_pages: 1
       max_days_old: 30
     jsearch:
       enabled: false           # opt-in: needs RAPIDAPI_KEY; surfaces LinkedIn/Indeed/Glassdoor
       country: nl
       monthly_cap: 180         # guard the ~200/mo free tier
   ```

3. **Update the header strategy comment** (top of `portals.yml`) to mention
   aggregators as a first-class source alongside the existing levels, and note that
   `tracked_companies` is intentionally trimmed (the capability remains).

### 5.9 Docs to update

- **`templates/portals.example.yml`** — add the documented `aggregators:` block (keep
  its full example `tracked_companies` list; the example is the template for NEW
  users). Add a comment block explaining `.env` keys.
- **`modes/scan.md`** — document the aggregator path, env vars, the usage counter, and
  per-source stats output.
- **`CLAUDE.md` & `AGENTS.md`** — in the "Main Files" table / scan description, note
  that `scan.mjs` now also polls aggregators (Adzuna/Arbeitnow/JSearch) and that keys
  live in `.env`. Keep it brief.
- **`DATA_CONTRACT.md`** — add `.env` as user-layer secrets (gitignored, never
  committed) and `data/api-usage.tsv` as generated user data.

### 5.10 Tests (`test-all.mjs`)

Mirror the existing provider test blocks (search for `parseWorkableMarkdown` /
`parseSmartRecruitersResponse` usage):
- Module-exists checks for `providers/arbeitnow.mjs`, `providers/adzuna.mjs`,
  `providers/jsearch.mjs`.
- Unit-test each `parse*Response` with a small fixture payload → assert it returns
  `[{title,url,company,location}]` with correct mapping and skips malformed rows.
- Assert aggregator providers have **no `detect`** (so they can't be auto-matched to a
  tracked company).
- Usage ledger: `addUsage` then `getMonthlyCount` roundtrip in a temp file.
- A check that `scan.mjs` reads `config.aggregators` (string-includes assertion like
  the existing `scanScript.includes('resolveProvider(company, providers')` check).

---

## 6. Verification steps

```bash
node test-all.mjs                       # all checks green (incl. new provider tests)
node scan.mjs --dry-run                 # no writes; shows per-source breakdown
node scan.mjs --company Adyen --dry-run # greenhouse path still works
node scan.mjs --company Miro --dry-run  # explicit api: path works
node scan.mjs --company Cradle --dry-run# ashby path works
# With ADZUNA_APP_ID/KEY set in .env:
node scan.mjs --dry-run                 # adzuna + arbeitnow return jobs; jsearch skipped (disabled)
```

Confirm: aggregator jobs appear, title/location filters apply to them, dedup works
across sources, `data/api-usage.tsv` increments, and JSearch is skipped when disabled
or capped.

---

## 7. Acceptance criteria

- [ ] `node scan.mjs` (no flags) polls the 3 tracked companies **and** the enabled
      aggregators in one pass, with a single dedup pass across all sources.
- [ ] Missing/blank `.env` keys → affected aggregator silently skipped (no crash);
      Arbeitnow works with zero keys.
- [ ] Summary shows a per-source breakdown of new offers.
- [ ] JSearch never exceeds its monthly cap (guarded by `data/api-usage.tsv`).
- [ ] `tracked_companies` is trimmed to Adyen/Miro/Cradle and all three return jobs.
- [ ] No LLM/token usage anywhere in the scan path.
- [ ] `node test-all.mjs` passes; new provider + ledger tests included.
- [ ] Docs (`portals.example.yml`, `modes/scan.md`, `CLAUDE.md`, `AGENTS.md`,
      `DATA_CONTRACT.md`) updated. ADR 0001 and `CONTEXT.md` already exist — do not
      duplicate them.

---

## 8. Gotchas recap

1. **Miro** needs explicit `provider: greenhouse` + `api:` (host mismatch with
   `detect()` regex).
2. **Aggregator providers must NOT export `detect()`** or they'll be wrongly
   considered for per-company resolution.
3. **JSearch quota** is the only hard limit — guard it; ship it `enabled: false`.
4. **`.env` is user/secret layer** — never commit real keys; `.env.example` is the
   committed template.
5. **One dedup pass** — route aggregator results through the same
   `seenUrls`/`seenCompanyRoles` logic, don't dedup aggregators separately.
6. Keep providers **pure + unit-testable** via the named `parse*Response` export.
