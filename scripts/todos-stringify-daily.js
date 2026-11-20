#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const INTERVAL_MS = 300_000;
export const BASELINE_DAILY_MS = 261_000 / 3;
const DAY_MS = 86_400_000;

/** Analyze UTC days; only explicit process-exit -> server-start downtime excuses gaps. */
export function analyzeTodosDaily(events, requestedDays) {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const intervals = [];
  const downtime = [];
  const seen = new Map();
  for (const event of sorted) {
    if (event.event === 'todos-write-stats') {
      const d = event.details;
      const end = Date.parse(d?.intervalEnd);
      const start = Date.parse(d?.intervalStart);
      const ms = d?.todosWriteStats?.stringifyMs;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(ms) || ms < 0) throw new Error('Invalid todos-write-stats interval');
      const key = `${event.serverInstanceToken}:${start}:${end}`;
      if (seen.has(key)) {
        if (seen.get(key) !== ms) throw new Error('Conflicting duplicate interval');
        continue;
      }
      seen.set(key, ms);
      intervals.push({ start, end, ms });
    }
    if (event.event === 'process-exit') {
      const next = sorted.find((row) => row.event === 'server-start' && Date.parse(row.at) > Date.parse(event.at));
      if (next) downtime.push({ start: Date.parse(event.at), end: Date.parse(next.at) });
    }
  }
  const eventDays = [...new Set(sorted.map((e) => e.at?.slice(0, 10)).filter(Boolean))].sort();
  const inferredDays = [];
  if (eventDays.length) for (let at = Date.parse(`${eventDays[0]}T00:00:00Z`); at <= Date.parse(`${eventDays.at(-1)}T00:00:00Z`); at += DAY_MS) inferredDays.push(new Date(at).toISOString().slice(0, 10));
  const days = requestedDays ?? inferredDays;
  return days.sort().map((day) => {
    const begin = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(begin)) throw new Error('Invalid UTC day');
    const end = begin + DAY_MS;
    let stringifyMs = 0;
    const spans = [];
    let observedMs = 0;
    for (const interval of intervals) {
      const left = Math.max(begin, interval.start), right = Math.min(end, interval.end);
      if (right <= left) continue;
      // A delayed timer is evidence of a stall, not of extra timer ticks.
      // Ordinary timer jitter must not manufacture gaps. A delay of a whole
      // interval means a tick is missing and cannot certify daily coverage.
      const coveredStart = interval.end - interval.start < 2 * INTERVAL_MS ? left : Math.max(left, interval.end - INTERVAL_MS);
      if (right > coveredStart) spans.push([coveredStart, right]);
      stringifyMs += interval.ms * (right - left) / (interval.end - interval.start);
      observedMs += Math.max(0, right - coveredStart);
    }
    for (const interval of downtime) {
      const left = Math.max(begin, interval.start), right = Math.min(end, interval.end);
      if (right > left) spans.push([left, right]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    let cursor = begin, missingMs = 0;
    for (const [left, right] of spans) {
      if (left > cursor) missingMs += left - cursor;
      cursor = Math.max(cursor, right);
    }
    missingMs += end - cursor;
    stringifyMs = Math.round(stringifyMs * 1e6) / 1e6;
    const reductionPercent = 100 * (1 - stringifyMs / BASELINE_DAILY_MS);
    return { day, stringifyMs, baselineMs: BASELINE_DAILY_MS, reductionPercent, expectedIntervals: 288,
      observedIntervals: observedMs / INTERVAL_MS, missingIntervals: missingMs / INTERVAL_MS,
      coveragePercent: 100 * (1 - missingMs / DAY_MS), verdict: missingMs > 0 ? 'INCOMPLETE' : reductionPercent >= 99 ? 'PASS' : 'FAIL' };
  });
}

export function readDiagnostics(files) {
  return files.flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const days = args.filter((a) => a.startsWith('--day=')).map((a) => a.slice(6));
    const files = args.filter((a) => !a.startsWith('--day='));
    if (!files.length) throw new Error('Usage: node scripts/todos-stringify-daily.js [--day=YYYY-MM-DD] server-diagnostics-*.jsonl');
    const results = analyzeTodosDaily(readDiagnostics(files), days.length ? days : undefined);
    console.log(JSON.stringify({ baselineSource: '74d6ffed:docs/stall-baseline-2026-10.md; 261 s / 3 UTC days; conservative lower bound', allocation: 'Cross-midnight intervals allocated in proportion to duration', results }, null, 2));
    process.exitCode = results.length && results.every((r) => r.verdict === 'PASS') ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
