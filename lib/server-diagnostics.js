import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import { getHeapStatistics } from 'v8';
import { redactText } from './browser/redaction.js';
import { getWriteStats, resetWriteStats } from './persist/atomic-write.js';
import { getScoutPassPhaseStats, resetScoutPassPhaseStats } from './workspace-watcher-scout-phases.js';

const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
const DEFAULT_RETENTION_DAYS = 14;
const MAX_DAILY_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_MESSAGE_INPUT_LENGTH = 4096;
const MAX_ERROR_RECORD_INTERVAL_MS = 60_000;
const WRITE_FAILURE_LOG_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FILE_PREFIX = 'server-diagnostics-';
const FILE_SUFFIX = '.jsonl';
const ERROR_EVENTS = new Set(['uncaught-exception', 'unhandled-rejection', 'server-error']);
const MAX_ORIGIN_JSON_BYTES = 16 * 1024;
const MAX_WRITE_STATS_JSON_BYTES = 16 * 1024;
const WRITE_STATS_TOP = 10;
const WRITE_STATS_INTERVAL_MS = 5 * 60_000;
const SCOUT_PHASES_TOP = 30;

function finiteNumber(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

/** Validates and bounds a write-stats payload: top 10 by total ms and top 10 by writes. */
function sanitizeWriteStats(input) {
  const rows = Array.isArray(input) ? input : [];
  const clean = rows
    .filter((row) => row && typeof row.key === 'string')
    .map((row) => ({
      key: redactText(row.key).slice(0, 120),
      writes: finiteNumber(row.writes),
      bytes: finiteNumber(row.bytes),
      stringifyMs: finiteNumber(row.stringifyMs),
      ioMs: finiteNumber(row.ioMs),
      maxMs: finiteNumber(row.maxMs),
      writesPerMin: finiteNumber(row.writesPerMin),
    }));
  const byMs = [...clean].sort((a, b) => (b.stringifyMs + b.ioMs) - (a.stringifyMs + a.ioMs)).slice(0, WRITE_STATS_TOP);
  const byCount = [...clean].sort((a, b) => b.writes - a.writes).slice(0, WRITE_STATS_TOP);
  const merged = [...new Map([...byMs, ...byCount].map((row) => [row.key, row])).values()];
  return JSON.stringify(merged).length <= MAX_WRITE_STATS_JSON_BYTES ? merged : { truncated: true };
}

/** Validates and bounds a scout-pass-phases payload (phase names + short ids only). */
function sanitizeScoutPassPhases(input) {
  const rows = Array.isArray(input?.rows) ? input.rows : [];
  const clean = rows
    .filter((row) => row && typeof row.phase === 'string')
    .map((row) => ({
      phase: row.phase.replace(/[^A-Za-z0-9_]/g, '').slice(0, 60),
      workspace: String(row.workspace || '').replace(/[^0-9a-f]/gi, '').slice(0, 8),
      count: finiteNumber(row.count),
      totalMs: finiteNumber(row.totalMs),
      maxMs: finiteNumber(row.maxMs),
    }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, SCOUT_PHASES_TOP);
  return { passes: finiteNumber(input?.passes), rows: clean };
}

function readLinuxMemory() {
  try {
    const contents = readFileSync('/proc/meminfo', 'utf8');
    const values = new Map([...contents.matchAll(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s+kB$/gm)]
      .map((match) => [match[1], Number(match[2]) * 1024]));
    return {
      totalBytes: values.get('MemTotal') ?? os.totalmem(),
      availableBytes: values.get('MemAvailable') ?? os.freemem(),
      swapTotalBytes: values.get('SwapTotal') ?? 0,
      swapFreeBytes: values.get('SwapFree') ?? 0,
    };
  } catch {
    return {
      totalBytes: os.totalmem(),
      availableBytes: os.freemem(),
      swapTotalBytes: null,
      swapFreeBytes: null,
    };
  }
}

function readLargestProcesses(limit = 10) {
  let processIds;
  try {
    processIds = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry));
  } catch {
    return [];
  }
  const processes = [];
  for (const processId of processIds) {
    try {
      const status = readFileSync(`/proc/${processId}/status`, 'utf8');
      const name = status.match(/^Name:\s+(.+)$/m)?.[1]?.trim();
      const residentKb = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] || 0);
      if (name && residentKb > 0) processes.push({ pid: Number(processId), name, rssBytes: residentKb * 1024 });
    } catch {
      // Processes can exit while a snapshot is being collected.
    }
  }
  return processes.sort((left, right) => right.rssBytes - left.rssBytes).slice(0, limit);
}

function readParentProcessId(processId) {
  try {
    const stat = readFileSync(`/proc/${processId}/stat`, 'utf8');
    const closeIndex = stat.lastIndexOf(')');
    const fields = stat.slice(closeIndex + 2).split(' ');
    return Number(fields[1]) || 0;
  } catch {
    return 0;
  }
}

/**
 * Every descendant of the server process with its RSS. Keeps server memory
 * separate from child memory (PTY, harness CLI, MCP stdio, webpack) so an
 * incident can be attributed to the right process.
 *
 * @param {number} rootPid
 * @returns {Array<{ pid: number, ppid: number, name: string, rssBytes: number }>}
 */
function readChildProcesses(rootPid) {
  let processIds;
  try {
    processIds = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).map(Number);
  } catch {
    return [];
  }
  const childrenByParent = new Map();
  const parentByChild = new Map();
  for (const processId of processIds) {
    if (processId === rootPid) continue;
    const parentId = readParentProcessId(processId);
    parentByChild.set(processId, parentId);
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(processId);
  }
  const children = [];
  const queue = [...(childrenByParent.get(rootPid) || [])];
  while (queue.length > 0) {
    const processId = queue.shift();
    try {
      const status = readFileSync(`/proc/${processId}/status`, 'utf8');
      const name = status.match(/^Name:\s+(.+)$/m)?.[1]?.trim() || '';
      const residentKb = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] || 0);
      if (name) children.push({ pid: processId, ppid: parentByChild.get(processId) || rootPid, name, rssBytes: residentKb * 1024 });
    } catch {
      // Processes can exit while a snapshot is being collected.
    }
    for (const childId of childrenByParent.get(processId) || []) queue.push(childId);
  }
  return children.sort((left, right) => right.rssBytes - left.rssBytes);
}

function getDailyFilePath(dataDir, at) {
  const date = new Date(at).toISOString().slice(0, 10);
  return path.join(dataDir, `${FILE_PREFIX}${date}${FILE_SUFFIX}`);
}

function pruneOldFiles(dataDir, retentionDays, now) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let filenames;
  try {
    filenames = readdirSync(dataDir);
  } catch {
    return;
  }
  for (const filename of filenames) {
    if (!filename.startsWith(FILE_PREFIX) || !filename.endsWith(FILE_SUFFIX)) continue;
    const date = filename.slice(FILE_PREFIX.length, -FILE_SUFFIX.length);
    const timestamp = Date.parse(`${date}T00:00:00.000Z`);
    if (Number.isFinite(timestamp) && timestamp < cutoff) {
      try {
        unlinkSync(path.join(dataDir, filename));
      } catch {
        // A retention cleanup failure must not prevent the server from starting.
      }
    }
  }
}

/**
 * Creates a bounded, persistent process and host diagnostics recorder.
 * @param {{ dataDir: string, serverInstanceToken: string, serverStartedAt: number, sampleIntervalMs?: number, retentionDays?: number }} options
 */
export function createServerDiagnostics({
  dataDir,
  serverInstanceToken,
  serverStartedAt,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  retentionDays = DEFAULT_RETENTION_DAYS,
}) {
  let isAvailable = true;
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    isAvailable = false;
    console.error('[server-diagnostics] Recorder disabled:', error?.message || error);
  }
  let sampleTimer = null;
  let writeStatsTimer = null;
  let writeStatsSince = Date.now();
  let lastPrunedDay = '';
  let lastErrorRecordedAt = 0;
  let suppressedErrorCount = 0;
  let sizeLimitNotifiedDay = '';
  let lastWriteFailureLoggedAt = 0;
  let processExitHandler = null;

  function trackErrorWriteFailure(event, fatal, now) {
    if (!ERROR_EVENTS.has(event)) return;
    suppressedErrorCount += 1;
    if (!fatal) lastErrorRecordedAt = now;
  }

  function snapshot(event = 'sample', details = {}) {
    const memory = process.memoryUsage();
    const heapStatistics = getHeapStatistics();
    const hostMemory = readLinuxMemory();
    const childProcesses = readChildProcesses(process.pid);
    const childrenRssBytes = childProcesses.reduce((sum, child) => sum + (child.rssBytes || 0), 0);
    return {
      at: new Date().toISOString(),
      event,
      details,
      serverInstanceToken,
      serverStartedAt,
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      uptimeSeconds: Math.floor(process.uptime()),
      processMemory: {
        rssBytes: memory.rss,
        heapTotalBytes: memory.heapTotal,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
      },
      v8: {
        mallocedMemory: heapStatistics.malloced_memory,
        peakMallocedMemory: heapStatistics.peak_malloced_memory,
        totalPhysicalSize: heapStatistics.total_physical_size,
        externalMemory: heapStatistics.external_memory,
      },
      // Server RSS above vs. its descendants below: an incident must be
      // attributable to the server process or to a spawned child (PTY, harness
      // CLI, MCP stdio, webpack), never to a single undifferentiated number.
      processTree: {
        serverRssBytes: memory.rss,
        childCount: childProcesses.length,
        childrenRssBytes,
        combinedRssBytes: memory.rss + childrenRssBytes,
        children: childProcesses.slice(0, 10),
      },
      hostMemory,
      loadAverage: os.loadavg(),
      largestProcesses: readLargestProcesses(),
    };
  }

  function record(event, details = {}, { fatal = false } = {}) {
    if (!isAvailable) return null;
    try {
      const now = Date.now();
      if (ERROR_EVENTS.has(event) && !fatal && now - lastErrorRecordedAt < MAX_ERROR_RECORD_INTERVAL_MS) {
        suppressedErrorCount += 1;
        return null;
      }
      const safeDetails = {};
      if (typeof details.signal === 'string') safeDetails.signal = details.signal.slice(0, 20);
      if (Number.isInteger(details.exitCode)) safeDetails.exitCode = details.exitCode;
      if (Number.isInteger(details.suppressedCount) && details.suppressedCount > 0) {
        safeDetails.suppressedCount = details.suppressedCount;
      }
      if ((event === 'process-exit' || event === 'shutdown-signal') && suppressedErrorCount > 0) {
        safeDetails.suppressedCount = suppressedErrorCount;
      }
      if (event === 'shutdown-origin' && details.origin && typeof details.origin === 'object') {
        // Built by lib/shutdown-origin.js (already redacted and capped); the size
        // check only guards against a malformed caller.
        const serialized = JSON.stringify(details.origin);
        safeDetails.origin = serialized.length <= MAX_ORIGIN_JSON_BYTES
          ? details.origin
          : { truncated: true, ppid: details.origin.ppid, parent: details.origin.parent };
      }
      if (event === 'write-stats') safeDetails.writeStats = sanitizeWriteStats(details.writeStats);
      if (event === 'scout-pass-phases') safeDetails.scoutPassPhases = sanitizeScoutPassPhases(details.scoutPassPhases);
      if (typeof details.errorName === 'string') safeDetails.errorName = redactText(details.errorName.slice(0, 120)).slice(0, 80);
      if (typeof details.message === 'string') {
        safeDetails.message = redactText(details.message.slice(0, MAX_ERROR_MESSAGE_INPUT_LENGTH)).slice(0, 300);
      }
      const pendingSuppressedCount = suppressedErrorCount;
      if (ERROR_EVENTS.has(event) && pendingSuppressedCount > 0) safeDetails.suppressedCount = pendingSuppressedCount;
      const entry = snapshot(event, safeDetails);
      const filePath = getDailyFilePath(dataDir, Date.now());
      const isNewFile = !existsSync(filePath);
      const line = `${JSON.stringify(entry)}\n`;
      const currentSize = isNewFile ? 0 : statSync(filePath).size;
      if (!fatal && currentSize + Buffer.byteLength(line) > MAX_DAILY_FILE_BYTES) {
        const currentDay = new Date().toISOString().slice(0, 10);
        if (sizeLimitNotifiedDay !== currentDay) {
          sizeLimitNotifiedDay = currentDay;
          console.error(`[server-diagnostics] Daily log limit reached (${MAX_DAILY_FILE_BYTES} bytes).`);
        }
        trackErrorWriteFailure(event, fatal, now);
        return null;
      }
      appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
      if (isNewFile) chmodSync(filePath, 0o600);
      lastWriteFailureLoggedAt = 0;
      if (ERROR_EVENTS.has(event)) {
        suppressedErrorCount = 0;
        lastErrorRecordedAt = now;
      } else if ((event === 'error-events-suppressed' || event === 'shutdown-signal' || event === 'process-exit')
        && safeDetails.suppressedCount > 0) {
        suppressedErrorCount = Math.max(0, suppressedErrorCount - safeDetails.suppressedCount);
      }
      return entry;
    } catch (error) {
      const now = Date.now();
      trackErrorWriteFailure(event, fatal, now);
      if (now - lastWriteFailureLoggedAt >= WRITE_FAILURE_LOG_INTERVAL_MS) {
        lastWriteFailureLoggedAt = now;
        console.error('[server-diagnostics] Could not write diagnostics:', error?.message || error);
      }
    }
    return null;
  }

  function readRecent(limit = 200) {
    if (!isAvailable) return [];
    const now = Date.now();
    const parsedLimit = Number.isFinite(limit) ? Math.floor(limit) : 200;
    const safeLimit = Math.max(1, Math.min(1000, parsedLimit));
    const entries = [];
    for (let dayOffset = 0; dayOffset < Math.ceil(retentionDays) && entries.length < safeLimit; dayOffset += 1) {
      const filePath = getDailyFilePath(dataDir, now - dayOffset * 24 * 60 * 60 * 1000);
      if (!existsSync(filePath)) continue;
      try {
        const lines = readFileSync(filePath, 'utf8').split('\n');
        for (let index = lines.length - 1; index >= 0 && entries.length < safeLimit; index -= 1) {
          if (!lines[index]) continue;
          try {
            entries.push(JSON.parse(lines[index]));
          } catch {
            // Ignore a partial or malformed final record and keep reading older entries.
          }
        }
      } catch {
        // A partially unavailable diagnostics file should not break the API.
      }
    }
    return entries.reverse();
  }

  /** Snapshots, resets and records the Scout pass phase aggregates. Returns null when nothing ran. */
  function flushScoutPassPhases() {
    const stats = getScoutPassPhaseStats();
    resetScoutPassPhaseStats();
    if (!stats.passes && stats.rows.length === 0) return null;
    return record('scout-pass-phases', { scoutPassPhases: stats });
  }

  function start() {
    if (sampleTimer) return sampleTimer;
    const now = Date.now();
    pruneOldFiles(dataDir, retentionDays, now);
    lastPrunedDay = new Date(now).toISOString().slice(0, 10);
    record('server-start');
    sampleTimer = setInterval(() => {
      const currentDay = new Date().toISOString().slice(0, 10);
      if (currentDay !== lastPrunedDay) {
        pruneOldFiles(dataDir, retentionDays, Date.now());
        lastPrunedDay = currentDay;
      }
      if (suppressedErrorCount > 0 && Date.now() - lastErrorRecordedAt >= MAX_ERROR_RECORD_INTERVAL_MS) {
        const count = suppressedErrorCount;
        record('error-events-suppressed', { suppressedCount: count });
      }
      record('sample');
    }, sampleIntervalMs);
    sampleTimer.unref?.();
    writeStatsSince = Date.now();
    writeStatsTimer = setInterval(() => {
      const snapshotStats = getWriteStats();
      const minutes = Math.max((Date.now() - writeStatsSince) / 60_000, 1 / 60);
      writeStatsSince = Date.now();
      const rows = snapshotStats.rows.map((row) => ({ ...row, writesPerMin: row.writes / minutes }));
      resetWriteStats();
      record('write-stats', { writeStats: rows });
      flushScoutPassPhases();
    }, WRITE_STATS_INTERVAL_MS);
    writeStatsTimer.unref?.();
    processExitHandler = (code) => record('process-exit', { exitCode: code, suppressedCount: suppressedErrorCount });
    process.once('exit', processExitHandler);
    return sampleTimer;
  }

  function stop() {
    if (sampleTimer) clearInterval(sampleTimer);
    if (writeStatsTimer) clearInterval(writeStatsTimer);
    writeStatsTimer = null;
    if (processExitHandler) process.removeListener('exit', processExitHandler);
    sampleTimer = null;
    processExitHandler = null;
  }

  return { snapshot, record, readRecent, start, stop, flushScoutPassPhases };
}
