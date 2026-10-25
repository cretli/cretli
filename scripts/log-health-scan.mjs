#!/usr/bin/env node
/**
 * Incremental health scan of the server logs for an unattended operator (for
 * example Claude Code supervising Cretli overnight). The server writes to
 * data/server-restart.log when started with `npm start` and to
 * data/task-restart-server.log after scripts/task-restart-server.sh, so both
 * are scanned.
 *
 * Reads only the bytes appended since the previous run (one offset per file in
 * data/log-health-scan.json; a shrunk file after rotation restarts at 0),
 * folds server and client errors into signatures (ids, timestamps, numbers and
 * bundle query strings stripped) and prints the signatures it has never seen
 * before plus a count of repeats. Exit code 0 always; `--json` prints a
 * machine-readable report; `--reset` forgets known signatures and the offset.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_FILES = ['server-restart.log', 'task-restart-server.log'].map((name) => path.join(ROOT, 'data', name));
const STATE_FILE = path.join(ROOT, 'data', 'log-health-scan.json');
const MAX_READ_BYTES = 32 * 1024 * 1024;
const MAX_KNOWN_SIGNATURES = 2000;

/** Lines worth reporting; network blips from clients are noise. */
const ERROR_PATTERN = /\b(unhandled-rejection|uncaught|TypeError|ReferenceError|RangeError|SyntaxError|ERR_[A-Z_]+|EADDRINUSE|ENOSPC|EMFILE|FATAL|\[error\]|console-error|window-error)\b/i;
const NOISE_PATTERN = /Failed to fetch|signal is aborted|NetworkError|Load failed|ExperimentalWarning|ui-freeze-(trace|budget|http)/;
const CLIENT_HEADER = /^\[client-debug\] \S+ reason=/;

/**
 * @param {string} line
 * @returns {string}
 */
export function signatureOf(line) {
  return line
    .replace(/^\[client-debug\] [0-9:.]+ /, 'client: ')
    .replace(/https?:\/\/[^/\s]+/g, '')
    .replace(/\?v=\d+/g, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>')
    .replace(/:\d+:\d+\)/g, ':<pos>)')
    .replace(/\b\d+(\.\d+)?(ms|s|MiB|KiB)?\b/g, '<n>')
    .trim()
    .slice(0, 240);
}

/**
 * @param {string} text Newly appended log text.
 * @returns {{ signature: string, sample: string, context: string[] }[]}
 */
export function extractErrors(text) {
  const lines = text.split('\n');
  /** @type {{ signature: string, sample: string, context: string[] }[]} */
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || CLIENT_HEADER.test(line) || NOISE_PATTERN.test(line) || !ERROR_PATTERN.test(line)) continue;
    const context = [];
    for (let j = i + 1; j < lines.length && context.length < 4 && /^\s+at /.test(lines[j]); j += 1) {
      context.push(lines[j].trim());
    }
    found.push({ signature: signatureOf(line), sample: line.slice(0, 400), context });
  }
  return found;
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const offsets = parsed.offsets && typeof parsed.offsets === 'object' ? parsed.offsets : {};
    // Version 1 kept a single offset for server-restart.log.
    if (Number(parsed.offset) > 0 && offsets[LOG_FILES[0]] == null) offsets[LOG_FILES[0]] = Number(parsed.offset);
    return { offsets, known: parsed.known && typeof parsed.known === 'object' ? parsed.known : {} };
  } catch {
    return { offsets: {}, known: {} };
  }
}

/**
 * @typedef {{
 *   eventLoopLagMs?: { p50?: number, p99?: number },
 *   routeP95Ms?: number,
 *   children?: { total?: number, claude?: number, opencode?: number, mcp?: number, tests?: number },
 *   disk?: { freeMb?: number | null },
 *   loadAvg?: number[],
 *   alarms?: string[],
 *   lan?: { hosts?: string[], unreachable?: string[] },
 * }} LoadReport
 */

/**
 * Best-effort load section from a running server's /api/health (HTTPS first, HTTP fallback). Null when the
 * server is down or predates the `load` field.
 *
 * @returns {Promise<LoadReport | null>}
 */
async function fetchLoad() {
  const port = process.env.PORT || '3011';
  const explicit = process.env.CRETLI_HEALTH_URL;
  const httpOff = ['0', 'false', 'off', 'no'].includes(String(process.env.USE_HTTPS ?? '').trim().toLowerCase());
  // The server defaults to HTTPS (USE_HTTPS=0 opts out); try it first, then plain HTTP.
  const bases = explicit ? [explicit] : httpOff ? [`http://127.0.0.1:${port}`] : [`https://127.0.0.1:${port}`, `http://127.0.0.1:${port}`];
  for (const base of bases) {
    const json = await getJson(`${base.replace(/\/$/, '')}/api/health`);
    if (json?.load) return json.load;
  }
  return null;
}

/**
 * GET + JSON parse with a 3 s timeout. Self-signed certificates are accepted:
 * this only talks to the local server (or an explicit CRETLI_HEALTH_URL).
 *
 * @param {string} url
 * @returns {Promise<any | null>}
 */
function getJson(url) {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith('https:') ? https : http;
      const req = lib.get(url, { timeout: 3000, rejectUnauthorized: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const state = args.has('--reset') ? { offsets: {}, known: {} } : readState();
  let scannedBytes = 0;
  /** @type {{ signature: string, sample: string, context: string[] }[]} */
  const errors = [];
  for (const file of LOG_FILES) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    let offset = Number(state.offsets[file]) || 0;
    if (size < offset) offset = 0;
    const start = Math.max(offset, size - MAX_READ_BYTES);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    errors.push(...extractErrors(buffer.toString('utf8')));
    state.offsets[file] = size;
    scannedBytes += size - start;
  }
  /** @type {Map<string, { sample: string, context: string[], count: number }>} */
  const fresh = new Map();
  let repeats = 0;
  const now = new Date().toISOString();
  for (const error of errors) {
    const known = state.known[error.signature];
    if (known) {
      known.count += 1;
      known.lastSeen = now;
      repeats += 1;
      continue;
    }
    const entry = fresh.get(error.signature);
    if (entry) entry.count += 1;
    else fresh.set(error.signature, { sample: error.sample, context: error.context, count: 1 });
  }
  for (const [signature, entry] of fresh) {
    state.known[signature] = { firstSeen: now, lastSeen: now, count: entry.count };
  }
  const signatures = Object.entries(state.known)
    .sort((a, b) => String(b[1].lastSeen).localeCompare(String(a[1].lastSeen)))
    .slice(0, MAX_KNOWN_SIGNATURES);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ offsets: state.offsets, known: Object.fromEntries(signatures) }, null, 2));

  const report = {
    scannedBytes,
    newSignatures: [...fresh].map(([signature, entry]) => ({ signature, ...entry })),
    repeats,
    load: args.has('--no-load') ? null : await fetchLoad(),
  };
  if (args.has('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (report.load) {
    const l = report.load;
    console.log(`load: loop p50/p99 ${l.eventLoopLagMs?.p50}/${l.eventLoopLagMs?.p99} ms, route p95 ${l.routeP95Ms} ms, children ${l.children?.total} (claude ${l.children?.claude}, opencode ${l.children?.opencode}, mcp ${l.children?.mcp}, tests ${l.children?.tests}), free disk ${l.disk?.freeMb} MB, loadavg ${(l.loadAvg || []).join('/')}${l.alarms?.length ? `, ALARMS: ${l.alarms.join(',')}` : ''}`);
    if (l.alarms?.includes('lanUnreachable')) {
      console.log(`lanUnreachable: configured LAN address(es) not accepting connections: ${(l.lan?.unreachable || []).join(', ')} (localhost is fine; phones cannot connect)`);
    }
  }
  console.log(`scanned ${report.scannedBytes} bytes; ${report.newSignatures.length} new error signature(s), ${repeats} repeat(s) of known ones`);
  for (const entry of report.newSignatures) {
    console.log(`\n[x${entry.count}] ${entry.sample}`);
    for (const frame of entry.context) console.log(`    ${frame}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
