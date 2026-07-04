#!/usr/bin/env python3
"""jobspy_runner.py — thin CLI wrapper around python-jobspy for the scanner.

Invoked as a subprocess by providers/jobspy.mjs (the Node "scraper" provider).
It scrapes ONE board for ONE search term and prints a single JSON envelope to
stdout. Keeping each invocation single-board / single-term lets the Node side
apply per-board result caps and isolate a board failure (e.g. a LinkedIn 429)
from the others.

Output contract (ALWAYS a single JSON object on stdout — never a bare array):

    {"jobs": [ {title, company, location, url, url_direct, description}, ... ]}
    {"jobs": [], "error": "missing_dependency", "detail": "..."}   # jobspy not installed
    {"jobs": [], "error": "scrape_failed",      "detail": "..."}   # runtime failure

Exit code is 0 whenever a JSON envelope was printed (including the error
envelopes above) so the Node side parses the envelope rather than guessing from
exit codes. python-jobspy logs to stderr via its own logger; stdout stays clean.

Dependency: pip install python-jobspy   (Python 3.10+)
"""

import argparse
import html
import json
import sys


def emit(envelope):
    """Print the JSON envelope to stdout and exit 0."""
    sys.stdout.write(json.dumps(envelope))
    sys.stdout.flush()
    sys.exit(0)


def parse_args(argv):
    p = argparse.ArgumentParser(description="Scrape one board via python-jobspy.")
    p.add_argument("--site", required=True,
                   help="Single board: linkedin | indeed | google")
    p.add_argument("--search-term", default="",
                   help="OR-grouped query string (used by linkedin/indeed).")
    p.add_argument("--google-search-term", default="",
                   help="Natural-language query for Google Jobs. Falls back to --search-term.")
    p.add_argument("--location", default="",
                   help="Location string, e.g. 'Netherlands'.")
    p.add_argument("--results-wanted", type=int, default=20)
    p.add_argument("--country-indeed", default="",
                   help="Country for Indeed/Glassdoor, e.g. 'Netherlands'.")
    p.add_argument("--hours-old", type=int, default=0,
                   help="Only postings newer than N hours (0 = no limit).")
    p.add_argument("--is-remote", action="store_true",
                   help="Filter to remote postings (jobspy is_remote).")
    p.add_argument("--linkedin-fetch-description", action="store_true",
                   help="Pull the full JD while on the LinkedIn page (1 extra request/job).")
    return p.parse_args(argv)


def main(argv):
    args = parse_args(argv)

    try:
        from jobspy import scrape_jobs
    except Exception as exc:  # ImportError or a broken transitive dep
        emit({"jobs": [], "error": "missing_dependency", "detail": str(exc)})

    site = args.site.strip().lower()
    google_term = args.google_search_term.strip() or args.search_term.strip()

    kwargs = {
        "site_name": [site],
        "search_term": args.search_term,
        "results_wanted": max(1, args.results_wanted),
        "verbose": 0,  # keep jobspy's own chatter out of the way (it goes to stderr anyway)
    }
    if args.location:
        kwargs["location"] = args.location
    if args.hours_old and args.hours_old > 0:
        kwargs["hours_old"] = args.hours_old
    if site == "google" and google_term:
        kwargs["google_search_term"] = google_term
    # Glassdoor shares Indeed's country table in python-jobspy; without this it
    # silently defaults to country_indeed="usa" (glassdoor.com, not the NL domain).
    if site in ("indeed", "glassdoor") and args.country_indeed:
        kwargs["country_indeed"] = args.country_indeed
    if args.is_remote:
        kwargs["is_remote"] = True
    if site == "linkedin" and args.linkedin_fetch_description:
        kwargs["linkedin_fetch_description"] = True

    try:
        df = scrape_jobs(**kwargs)
    except Exception as exc:  # network error, 429, markup change, etc.
        emit({"jobs": [], "error": "scrape_failed", "detail": f"{type(exc).__name__}: {exc}"})

    jobs = []
    if df is not None and not df.empty:
        df = df.fillna("")
        records = df.to_dict(orient="records")

        # JobSpy passes board markup through, so titles/companies/descriptions can
        # carry HTML entities (e.g. "Data &amp; AI Engineer"). Decode them once here
        # so the pipeline, dedup keys, and saved JDs read cleanly.
        def clean(value):
            return html.unescape(str(value)).strip()

        for r in records:
            jobs.append({
                "title": clean(r.get("title", "")),
                "company": clean(r.get("company", "")),
                "location": clean(r.get("location", "")),
                "url": str(r.get("job_url", "")).strip(),
                "url_direct": str(r.get("job_url_direct", "")).strip(),
                "description": clean(r.get("description", "")),
                # date_posted (jobspy column, e.g. "2026-06-22") rides along so
                # downstream consumers can compute posting freshness. Mapped to
                # an epoch `postedAt` in mapJobspyRecords; scan.mjs ignores it.
                "date_posted": str(r.get("date_posted", "")).strip(),
            })

    emit({"jobs": jobs})


if __name__ == "__main__":
    main(sys.argv[1:])
