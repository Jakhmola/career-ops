#!/usr/bin/env node

/**
 * usage-ledger.mjs — Monthly API-call counter for quota-limited aggregators.
 *
 * Persists per-source call counts to data/api-usage.tsv so scan.mjs can guard
 * free-tier monthly caps (e.g. JSearch ~200/mo). The file is generated user
 * data — gitignored, never committed.
 *
 * Format (tab-separated):
 *   month   source  calls
 *   2026-06 jsearch 12
 *
 * Pure functions, no LLM/token usage. All take an optional `file` arg so tests
 * can roundtrip against a temp path.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

export const DEFAULT_USAGE_PATH = 'data/api-usage.tsv';
const HEADER = 'month\tsource\tcalls';

/** Current month as YYYY-MM (UTC). */
export function thisMonth(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

/**
 * Read the ledger into a Map keyed by `${month}\t${source}` → calls.
 * Missing file → empty Map. Malformed rows are skipped.
 *
 * @param {string} [file]
 * @returns {Map<string, number>}
 */
export function readUsage(file = DEFAULT_USAGE_PATH) {
  const map = new Map();
  if (!existsSync(file)) return map;
  const lines = readFileSync(file, 'utf-8').split('\n');
  for (const line of lines.slice(1)) {
    // skip header
    if (!line.trim()) continue;
    const [month, source, calls] = line.split('\t');
    if (!month || !source) continue;
    const n = Number.parseInt(calls, 10);
    if (!Number.isFinite(n)) continue;
    map.set(`${month}\t${source}`, n);
  }
  return map;
}

/**
 * How many calls have been recorded for a source this month.
 *
 * @param {string} source
 * @param {string} [month]
 * @param {string} [file]
 * @returns {number}
 */
export function getMonthlyCount(source, month = thisMonth(), file = DEFAULT_USAGE_PATH) {
  return readUsage(file).get(`${month}\t${source}`) || 0;
}

/**
 * Merge per-source counts into the ledger and write it back.
 *
 * @param {Map<string, number>|Record<string, number>} countsBySource
 * @param {string} [month]
 * @param {string} [file]
 * @returns {Map<string, number>} the updated ledger map
 */
export function addUsage(countsBySource, month = thisMonth(), file = DEFAULT_USAGE_PATH) {
  const entries =
    countsBySource instanceof Map
      ? [...countsBySource.entries()]
      : Object.entries(countsBySource || {});
  const map = readUsage(file);
  let changed = false;
  for (const [source, n] of entries) {
    const inc = Number(n);
    if (!source || !Number.isFinite(inc) || inc === 0) continue;
    const key = `${month}\t${source}`;
    map.set(key, (map.get(key) || 0) + inc);
    changed = true;
  }
  if (!changed) return map;

  const dir = path.dirname(file);
  if (dir) mkdirSync(dir, { recursive: true });
  const out = [HEADER];
  for (const [key, calls] of map) out.push(`${key}\t${calls}`);
  writeFileSync(file, out.join('\n') + '\n', 'utf-8');
  return map;
}
