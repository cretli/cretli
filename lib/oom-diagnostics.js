/**
 * OOM diagnostics: external evidence of why a process died, a durable marker
 * that records the source and confidence of that conclusion, a memory ledger
 * for the server and its executors, and a guard / pre-flight check.
 *
 * A process killed by SIGKILL (kernel OOM killer, earlyoom, systemd-oomd)
 * cannot write its own marker. The marker is therefore written by a *later*
 * observer (the next boot or a supervisor) from external evidence only. Without
 * evidence the cause stays `unknown`; absence of proof is never reported as
 * "no OOM", and inference is labelled `probable`, never `confirmed`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getProcessStartTime } from './delegation-owner-lock.js';
import { writeJsonAtomic } from './persist/atomic-write.js';

/** @typedef {Record<string, any>} Dict Loosely shaped JSON-like record from journals, markers and registries. */

export const OOM_MARKER_FILE = 'oom-markers.jsonl';
export const MEMORY_LEDGER_FILE = 'memory-ledger.jsonl';
/** Identity of the running server, written at boot and kept after a crash. */
export const SERVER_RUNTIME_FILE = 'server-runtime.json';
/** Graceful-shutdown marker; a SIGKILLed process can never write it. */
export const SERVER_SHUTDOWN_FILE = 'server-shutdown.json';
export const OOM_BOOT_WARNING_STATE_FILE = 'oom-boot-warning-state.json';
/**
 * Boot summary only announces a marker younger than this. An older marker is
 * history: it stays in the marker file and the diagnostics API but no longer
 * repeats a warning on a host whose warning-state file is missing (F5).
 */
export const OOM_BOOT_WARNING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Bounded window used when the monitor has no previous journal cursor. */
export const TERMINATION_JOURNAL_LOOKBACK_MS = 10 * 60 * 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_MARKER_TARGETS = 20;
export const MAX_IDENTITY_HISTORY = 8;
export const MAX_EXIT_EVENTS = 100;

export const DEFAULT_MEMORY_GUARD_CONFIG = Object.freeze({
  /** Host MemAvailable below this ratio of MemTotal => warn. */
  warnAvailableRatio: 0.15,
  /** Host MemAvailable below this ratio => critical (pre-flight refuses). */
  criticalAvailableRatio: 0.07,
  /** A new executor needs at least this much headroom on top of the critical line. */
  executorReserveBytes: 512 * 1024 * 1024,
  /**
   * The reserve is also capped at this share of the memory total, so a small
   * host (4 GiB) in the `ok` band is not refused by a fixed 512 MiB reserve.
   */
  executorReserveMaxRatio: 0.05,
});

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * `journalctl -o short-iso` prefixes every line with the event time, e.g.
 * `2026-10-09T14:00:00+0200`. The kernel/unit/earlyoom text is only meaningful
 * for a process whose lifetime contains that moment, so the timestamp is kept
 * with the evidence and compared with the target's recorded start time.
 *
 * The fraction is captured separately because it decides the timestamp
 * precision: `short-iso` prints whole seconds unless microseconds are asked
 * for, so `13:00:00` names an *interval* `[13:00:00.000, 13:00:00.999]`, not a
 * point. Comparing only the point against a millisecond process start would
 * discard a real OOM that fired in the same second as the start (R7-F1).
 */
const SHORT_ISO_LINE_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})\b/;

/**
 * Time interval named by one `short-iso` timestamp.
 *
 * `at` is the earliest instant the line can describe and `atEnd` the latest:
 * `at + 999 ms` for a whole-second timestamp, or `at + precision - 1` for a
 * fractional one (`.500` is accurate to 1 ms). Digits past millisecond
 * resolution are truncated, so they add no measurable range.
 *
 * @param {RegExpExecArray} match
 * @returns {{ at: number, atEnd: number, precisionMs: number } | null}
 */
function journalTimestampRange(match) {
  const fraction = match[2] || '';
  const millis = fraction.slice(0, 3).padEnd(3, '0');
  const parsed = Date.parse(`${match[1]}${fraction ? `.${millis}` : ''}${match[3]}`);
  if (!Number.isFinite(parsed)) return null;
  const precisionMs = fraction ? 10 ** Math.max(0, 3 - fraction.length) : 1000;
  return { at: parsed, atEnd: parsed + precisionMs - 1, precisionMs };
}

/**
 * Extract the `short-iso` timestamp interval at the start of a journal line.
 * Returns `null` when the line has no usable timestamp.
 *
 * @param {unknown} line
 * @returns {{ at: number, atEnd: number, precisionMs: number } | null}
 */
export function parseJournalLineTimestampRange(line) {
  const match = SHORT_ISO_LINE_PATTERN.exec(String(line || '').trim());
  if (!match) return null;
  return journalTimestampRange(match);
}

/**
 * Extract the `short-iso` timestamp at the start of a journal line.
 * Returns epoch milliseconds, or `null` when the line has no usable timestamp.
 * This is the earliest instant of the interval; use
 * `parseJournalLineTimestampRange` when the precision matters.
 *
 * @param {unknown} line
 * @returns {number | null}
 */
export function parseJournalLineTimestamp(line) {
  return parseJournalLineTimestampRange(line)?.at ?? null;
}

/**
 * Parse kernel / systemd / earlyoom journal text into evidence entries.
 * `confidence` = the source states the kill itself (`confirmed`) or only shows
 * a SIGKILL exit status (`probable`). `at`/`atEnd` are the bounds of the event
 * time interval in epoch ms, or `null` when the line carried no timestamp: a
 * whole-second `short-iso` stamp labels up to 999 ms, not a single instant.
 *
 * `confidence` here describes the *statement*, not that it belongs to a given
 * process instance: `classifyExit` correlates `at`/`atEnd` with the target's
 * `startedAt` and can downgrade or discard the evidence.
 *
 * Streams that also carry application output (the server unit journal, earlyoom
 * lines relayed through a producer) must not let message text pose as another
 * source. `options.sources` restricts which evidence sources the stream may
 * produce at all, and `options.requireTimestamp` drops lines without a journal
 * header: a continuation line of a multi-line server message has no header, so
 * it could otherwise begin with `kernel:` and be read as kernel evidence (F6).
 *
 * @param {string} text
 * @param {{ sources?: string[], requireTimestamp?: boolean }} [options]
 * @returns {Array<{ source: string, kind: string, pid: number|null, comm: string, confidence: 'confirmed'|'probable', line: string, at: number|null, atEnd: number|null }>}
 */
export function parseTerminationEvidence(text, options = {}) {
  const allowed = Array.isArray(options.sources) ? new Set(options.sources) : null;
  const all = parseTerminationEvidenceUnfiltered(text, options.requireTimestamp === true);
  return allowed ? all.filter((entry) => allowed.has(entry.source)) : all;
}

function parseTerminationEvidenceUnfiltered(text, requireTimestamp) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const stamp = parseJournalLineTimestampRange(line);
    if (requireTimestamp && !stamp) continue;
    const at = stamp ? stamp.at : null;
    const atEnd = stamp ? stamp.atEnd : null;
    // Read the identifier from the journal header, not from message text:
    // an application message may quote a kernel OOM line verbatim.
    const header = stamp ? line.slice(SHORT_ISO_LINE_PATTERN.exec(line)?.[0].length || 0).trimStart() : line;
    const origin = (stamp ? /^(?:[^\s:]+\s+)?([^:\s]+):/ : /^([^:\s]+):/).exec(header)?.[1]?.toLowerCase() || '';
    let m = /Out of memory: Killed process (\d+) \(([^)]*)\)/i.exec(line);
    if (m && origin === 'kernel') {
      out.push({ source: 'kernel', kind: 'oom-kill', pid: Number(m[1]), comm: m[2], confidence: 'confirmed', line, at, atEnd });
      continue;
    }
    m = /earlyoom.*sending (SIGTERM|SIGKILL) to process (\d+) "([^"]*)"/i.exec(line);
    if (m && origin.startsWith('earlyoom')) {
      out.push({ source: 'earlyoom', kind: 'oom-kill', pid: Number(m[2]), comm: m[3], confidence: 'confirmed', line, at, atEnd });
      continue;
    }
    m = /systemd-oomd.*Killed (\S+)/i.exec(line);
    if (m && origin.startsWith('systemd-oomd')) {
      // oomd names the killed cgroup path; keep it so the kill is only ever
      // attributed to a target that lives in that cgroup / unit.
      const cgroup = m[1].startsWith('/') ? m[1].replace(/\/+$/, '') : '';
      out.push({
        source: 'systemd-oomd',
        kind: 'oom-kill',
        pid: null,
        comm: m[1],
        cgroup,
        unit: cgroup ? path.posix.basename(cgroup) : '',
        confidence: 'confirmed',
        line,
        at,
        atEnd,
      });
      continue;
    }
    if (origin.startsWith('systemd[') && /(of unit \S+ )?(Failed with result 'oom-kill'|oom-kill)/i.test(line)) {
      const unitMatch = /systemd\[\d+\]:\s*(\S+\.(?:service|scope|slice))\b/i.exec(line)
        || /of unit (\S+\.(?:service|scope|slice))\b/i.exec(line);
      out.push({
        source: 'systemd',
        kind: 'oom-kill',
        pid: null,
        comm: '',
        cgroup: '',
        unit: unitMatch ? unitMatch[1].replace(/:$/, '') : '',
        confidence: 'confirmed',
        line,
        at,
        atEnd,
      });
      continue;
    }
    // The unit journal stream also carries application output, so the message
    // text alone is not proof that the supervisor saw the exit. Only a line
    // whose journal header is systemd itself (`systemd[<pid>]:`) may cite the
    // supervisor; an application line quoting the same text stays inert
    // (R17-AUD-F1).
    if (origin.startsWith('systemd[') && /Main process exited, code=killed, status=9\/KILL/i.test(line)) {
      out.push({ source: 'systemd', kind: 'sigkill-exit', pid: null, comm: '', confidence: 'probable', line, at, atEnd });
    }
  }
  return out;
}

/** Cached `/proc/stat` `btime`; the value cannot change during a process run. */
let cachedBootTimeMs = null;

/**
 * Wall-clock start of a recorded process instance in epoch milliseconds.
 *
 * Registry entries store the `/proc/<pid>/stat` start time: field 22 expressed
 * in `USER_HZ` clock ticks (always 100 Hz on Linux) since boot, so it needs the
 * boot time from `/proc/stat` to become a comparable wall-clock value. ISO-8601
 * values and explicit epoch-ms values are accepted as-is for tests and newer
 * producers. `null` means the start time is unknown and no time correlation is
 * possible.
 *
 * @param {unknown} startedAt
 * @param {number} [bootTimeMs]
 * @returns {number | null}
 */
export function resolveProcessStartMs(startedAt, bootTimeMs) {
  const raw = String(startedAt ?? '').trim();
  if (!raw) return null;
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  // Anything past 2001-09-09 is already epoch milliseconds (a tick count would
  // mean centuries of uptime), so it is used directly.
  if (numeric >= 1e12) return Math.round(numeric);
  const boot = Number.isFinite(bootTimeMs) ? bootTimeMs : readBootTimeMs();
  if (!Number.isFinite(boot) || boot <= 0) return null;
  return Math.round(boot + numeric * 10);
}

/** Resolve a known process end timestamp using the same accepted formats. */
function resolveProcessEndMs(endedAt) {
  if (endedAt === undefined || endedAt === null || endedAt === '') return null;
  const value = Number(endedAt);
  if (Number.isFinite(value) && value > 0) return value >= 1e12 ? Math.round(value) : null;
  const parsed = Date.parse(String(endedAt));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Boot time (epoch ms) from `/proc/stat`, or `null` when unavailable (non-Linux
 * or unreadable). Cached because the monitor reads it for every target.
 *
 * @param {(filePath: string) => string} [readFile]
 * @returns {number | null}
 */
export function readBootTimeMs(readFile = (filePath) => fs.readFileSync(filePath, 'utf8')) {
  if (cachedBootTimeMs !== null) return cachedBootTimeMs;
  let parsed = null;
  try {
    const match = /^btime\s+(\d+)\s*$/m.exec(String(readFile('/proc/stat')));
    if (match) parsed = Number(match[1]) * 1000;
  } catch {
    parsed = null;
  }
  cachedBootTimeMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  return cachedBootTimeMs || null;
}

/**
 * Interval in time that one evidence entry can describe. Entries produced by
 * `parseTerminationEvidence` carry both bounds; a manually built entry may
 * carry only `at` (a point) or a `line` whose timestamp can be re-parsed.
 *
 * @param {{ at?: number|null, atEnd?: number|null, line?: string } | null | undefined} entry
 * @returns {{ at: number, atEnd: number } | null}
 */
function evidenceTimeRange(entry) {
  const at = Number.isFinite(entry?.at) ? Number(entry.at) : null;
  if (at === null) return null;
  let atEnd = Number.isFinite(entry?.atEnd) ? Number(entry.atEnd) : null;
  if (atEnd === null && typeof entry?.line === 'string') {
    const parsed = parseJournalLineTimestampRange(entry.line);
    if (parsed && parsed.at === at) atEnd = parsed.atEnd;
  }
  return { at, atEnd: atEnd === null || atEnd < at ? at : atEnd };
}

/**
 * Whether evidence can describe the target instance in time.
 *
 * The comparison uses the *interval* a journal timestamp names, not a single
 * point: a whole-second `short-iso` line labels up to 999 ms, so a process
 * started at `13:00:00.500` is still covered by a `13:00:00` line (R7-F1).
 * A line whose interval ends before the recorded start belongs to a previous
 * owner of the recycled pid and is discarded.
 *
 * - `true`: both times are known and the line interval overlaps the lifetime.
 * - `false`: the line ends before the recorded process start (PID reuse), or
 *   it starts after the known end of the instance.
 * - `null`: the line or the start time is unknown, so it cannot be verified.
 *
 * @param {{ at?: number|null, atEnd?: number|null, line?: string } | null | undefined} entry
 * @param {number|null} startMs
 * @param {number|null} [endMs] known end of the process instance, when recorded
 * @returns {boolean | null}
 */
function evidenceCoversInstance(entry, startMs, endMs = null) {
  const range = evidenceTimeRange(entry);
  if (!range || !Number.isFinite(startMs)) return null;
  if (range.atEnd < startMs) return false;
  if (Number.isFinite(endMs) && range.at > Number(endMs)) return false;
  return true;
}

/** Parse a cgroup v2 `memory.events` file. */
export function parseCgroupMemoryEvents(text) {
  const result = {};
  for (const line of String(text || '').split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    const n = toNumber(value);
    if (key && n !== null) result[key] = n;
  }
  return result;
}

/** Read cgroup v2 memory counters of a cgroup directory; missing files yield nulls. */
export function readCgroupMemory(cgroupDir, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const read = (name) => {
    try { return readFile(path.join(cgroupDir, name)); } catch { return null; }
  };
  const events = read('memory.events');
  const current = read('memory.current');
  const max = read('memory.max');
  return {
    available: events !== null || current !== null,
    events: events === null ? null : parseCgroupMemoryEvents(events),
    currentBytes: current === null ? null : toNumber(current),
    maxBytes: max === null || max.trim() === 'max' ? null : toNumber(max),
  };
}

/**
 * Read host memory totals from `/proc/meminfo`. A missing or unreadable file is
 * reported as unknown (`null`), never as `os.freemem()`: on Linux free memory
 * excludes page cache and would refuse launches on a healthy host.
 */
export function readHostMemory(readFile = (p) => fs.readFileSync(p, 'utf8')) {
  try {
    const text = String(readFile('/proc/meminfo'));
    const values = new Map([...text.matchAll(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/gm)]
      .map((match) => [match[1], Number(match[2]) * 1024]));
    const totalBytes = values.get('MemTotal');
    const availableBytes = values.get('MemAvailable');
    return {
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
      availableBytes: Number.isFinite(availableBytes) ? availableBytes : null,
    };
  } catch {
    return { totalBytes: null, availableBytes: null };
  }
}

/**
 * Resolve the cgroup v2 memory directory of a cgroup entry. v1 layouts are not
 * mapped because their mount point varies; callers treat that as unavailable.
 */
export function resolveCgroupMemoryDir(entry) {
  if (!entry || entry.version !== 2 || !entry.path) return null;
  const normalized = path.posix.normalize(String(entry.path));
  if (!normalized.startsWith('/')) return null;
  return path.posix.join('/sys/fs/cgroup', normalized);
}

/**
 * Parse `/proc/<pid>/cgroup`. cgroup v2 is the unified `0::<path>` line; a v1
 * memory-controller line is reported without a directory hint.
 * @returns {{ version: number, controllers: string, path: string, memoryDir: string|null } | null}
 */
export function parseProcCgroup(text) {
  const lines = String(text || '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const first = line.indexOf(':');
    if (first < 0) continue;
    const second = line.indexOf(':', first + 1);
    if (second < 0) continue;
    const hierarchyId = line.slice(0, first);
    const controllers = line.slice(first + 1, second);
    const cgroupPath = line.slice(second + 1).trim();
    if (hierarchyId === '0' && controllers === '' && cgroupPath.startsWith('/')) {
      const entry = { version: 2, controllers: '', path: cgroupPath };
      return { ...entry, memoryDir: resolveCgroupMemoryDir(entry) };
    }
  }
  for (const raw of lines) {
    const line = raw.trim();
    const first = line.indexOf(':');
    const second = first < 0 ? -1 : line.indexOf(':', first + 1);
    if (second < 0) continue;
    const controllers = line.slice(first + 1, second);
    if (!controllers.split(',').includes('memory')) continue;
    return { version: 1, controllers, path: line.slice(second + 1).trim(), memoryDir: null };
  }
  return null;
}

/** Read the cgroup entry of a process; null when `/proc` or the file is unavailable. */
export function readProcessCgroup(pid, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return parseProcCgroup(readFile(`/proc/${pid}/cgroup`));
  } catch {
    return null;
  }
}

/**
 * Whether pidless evidence names the unit / cgroup the target ran in.
 * @param {{ unit?: string, cgroup?: string }} evidence
 * @param {{ targetUnits?: string[], targetCgroups?: string[] }} input
 * @returns {boolean}
 */
export function evidenceMatchesTarget(evidence, input = {}) {
  const units = (input.targetUnits || []).filter(Boolean);
  const cgroups = (input.targetCgroups || []).filter(Boolean);
  // The full cgroup path takes precedence whenever it is present. A user-scope
  // kill (e.g. `/user.slice/user-1001.slice/.../cretli.service`) shares the
  // basename with the system-scope target (`/system.slice/cretli.service`) but
  // lives in a different scope, so a basename match would falsely attribute it.
  // The basename `unit` fallback is only used when there is no cgroup to
  // disambiguate (systemd unit-only evidence).
  if (evidence.cgroup) {
    return cgroups.some((target) => target === evidence.cgroup || target.startsWith(`${evidence.cgroup}/`));
  }
  if (evidence.unit && units.includes(evidence.unit)) return true;
  return false;
}

/**
 * Decide the cause of an unexpected exit from external evidence only.
 *
 * A pid match is only trustworthy when the evidence line can be placed inside
 * the lifetime of the process instance that held that pid. A line older than
 * `startedAt` belongs to a previous pid owner and is discarded; when the line
 * time or the start time is unknown the match cannot be verified, so it stays
 * `probable` — a coincident pid alone never proves `confirmed`.
 *
 * @param {{ pid?: number, startedAt?: string, cleanShutdown?: boolean, evidence?: Array, cgroupBefore?: Dict, cgroupAfter?: Dict, targetUnits?: string[], targetCgroups?: string[], exitSignal?: string, endMs?: any, exitedAt?: any, endedAt?: any }} input
 * @returns {{ cause: string, source: string, confidence: 'confirmed'|'probable'|'unknown', basis: string }}
 */
export function classifyExit(input = {}) {
  if (input.cleanShutdown) {
    return { cause: 'clean-shutdown', source: 'shutdown-marker', confidence: 'confirmed', basis: 'graceful shutdown was recorded' };
  }
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const pid = input.pid ?? null;
  const startMs = resolveProcessStartMs(input.startedAt);
  const endMs = resolveProcessEndMs(input.endMs ?? input.exitedAt ?? input.endedAt);
  const matching = evidence.filter((e) => e.kind === 'oom-kill' && (e.pid === null || pid === null || e.pid === pid));
  const exact = matching.find((e) => e.pid !== null && e.pid === pid && evidenceCoversInstance(e, startMs, endMs) !== false);
  if (exact) {
    const timeVerified = evidenceCoversInstance(exact, startMs, endMs) === true;
    return {
      cause: 'oom-kill',
      source: exact.source,
      confidence: timeVerified ? 'confirmed' : 'probable',
      basis: timeVerified
        ? `${exact.source} names pid ${pid} and the line timestamp falls inside the recorded process lifetime`
        : `${exact.source} names pid ${pid}, but its line timestamp and the process start cannot be correlated`,
    };
  }
  // A pidless kill (systemd-oomd, a unit result) only counts for a target that
  // lives in the killed unit / cgroup; an unrelated cgroup kill proves nothing.
  const unitLevel = matching.find((e) => e.pid === null
    && evidenceMatchesTarget(e, input)
    && evidenceCoversInstance(e, startMs, endMs) !== false);
  if (unitLevel) {
    return { cause: 'oom-kill', source: unitLevel.source, confidence: 'probable', basis: `${unitLevel.source} reports an OOM kill without a pid` };
  }
  const before = input.cgroupBefore?.events?.oom_kill;
  const after = input.cgroupAfter?.events?.oom_kill;
  if (Number.isFinite(before) && Number.isFinite(after) && after > before) {
    return { cause: 'oom-kill', source: 'cgroup', confidence: 'probable', basis: `cgroup oom_kill counter rose ${before} -> ${after}` };
  }
  if (evidence.some((e) => e.kind === 'sigkill-exit')) {
    return { cause: 'sigkill', source: 'systemd', confidence: 'probable', basis: 'supervisor saw SIGKILL; sender unknown' };
  }
  if (input.exitSignal === 'SIGKILL') {
    return { cause: 'sigkill', source: 'exit-status', confidence: 'probable', basis: 'child exited with SIGKILL (recorded at exit); sender unknown' };
  }
  return { cause: 'unknown', source: 'none', confidence: 'unknown', basis: 'no external evidence available' };
}

function capFile(file) {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch { /* missing file is fine */ }
}

function endsWithoutNewline(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    if (size === 0) return false;
    const buffer = Buffer.alloc(1);
    fs.readSync(fd, buffer, 0, 1, size - 1);
    return buffer[0] !== 0x0a;
  } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  capFile(file);
  // A torn write can leave a tail without a newline; start on a fresh line so
  // the new record is not glued to (and dropped with) the invalid fragment.
  fs.appendFileSync(file, `${endsWithoutNewline(file) ? '\n' : ''}${JSON.stringify(record)}\n`);
}

function readJsonl(file, limit) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  return limit ? rows.slice(-limit) : rows;
}

/** Build the durable marker record without writing it (dry runs, tests). */
export function createOomMarkerRecord(marker, now = Date.now()) {
  return {
    recordedAt: new Date(now).toISOString(),
    writer: 'external-observer',
    observer: 'memory-monitor',
    ...marker,
  };
}

/** Durably append a marker written by an observer other than the dead process. */
export function writeOomMarker(dataDir, marker, now = Date.now()) {
  const record = createOomMarkerRecord(marker, now);
  const identity = terminationTargetKey(record);
  const files = [path.join(dataDir, OOM_MARKER_FILE), `${path.join(dataDir, OOM_MARKER_FILE)}.1`];
  // Strongest existing record that already covers this one; scanning everything
  // keeps an old weak marker from masking a later stronger one after an append.
  let dominating = null;
  const strengthOf = (m) => (m.cause === 'oom-kill' ? 2 : m.cause === 'sigkill' ? 1 : 0) * 10
    + (m.confidence === 'confirmed' ? 2 : m.confidence === 'probable' ? 1 : 0);
  const keep = (m) => { if (!dominating || strengthOf(m) > strengthOf(dominating)) dominating = m; };
  for (const file of files) {
    for (const previous of readJsonl(file, 0)) {
      if (terminationTargetKey(previous) !== identity) continue;
      const previousRank = previous.confidence === 'confirmed' ? 2 : previous.confidence === 'probable' ? 1 : 0;
      const nextRank = record.confidence === 'confirmed' ? 2 : record.confidence === 'probable' ? 1 : 0;
      // OOM evidence outranks a bare SIGKILL regardless of the confidence label, so
      // a later oom-kill/probable is appended over an earlier sigkill/probable and
      // a different cause is never treated as an equivalent duplicate.
      const causeStrength = (c) => (c === 'oom-kill' ? 2 : c === 'sigkill' ? 1 : 0);
      const previousStrength = causeStrength(previous.cause);
      const nextStrength = causeStrength(record.cause);
      if (previous.cause !== 'unknown') {
        if (previousStrength > nextStrength) { keep(previous); continue; }
        if (previous.cause === record.cause && previousRank >= nextRank) { keep(previous); continue; }
      }
      if (previous.cause === record.cause && previous.source === record.source
        && previous.confidence === record.confidence
        && JSON.stringify(previous.evidence || []) === JSON.stringify(record.evidence || [])) keep(previous);
    }
  }
  if (dominating) return dominating;
  appendJsonl(files[0], record);
  return record;
}

export function readOomMarkers(dataDir, limit = 50) {
  return readJsonl(path.join(dataDir, OOM_MARKER_FILE), limit);
}

function readJsonObjectFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist the identity of this server process. The file is intentionally left
 * behind when the process is SIGKILLed: the external monitor compares its pid +
 * `/proc` start time with a live process to decide whether the server died.
 *
 * @param {string} dataDir
 * @param {{ pid?: number, startedAt?: string, instanceToken?: string, node?: string, platform?: string, previous?: Dict | null }} [info]
 * @param {number} [now]
 */
export function writeServerRuntimeMarker(dataDir, info = {}, now = Date.now()) {
  const pid = Number(info.pid) || process.pid;
  const previous = info.previous && Number(info.previous.pid) > 0
    ? {
        pid: Number(info.previous.pid),
        startedAt: String(info.previous.startedAt || ''),
        instanceToken: String(info.previous.instanceToken || ''),
        bootAt: String(info.previous.bootAt || ''),
      }
    : null;
  // Older superseded identities, newest first. A fast restart chain (A crash,
  // B boot, C boot before the monitor runs) must not lose A.
  const history = [];
  const seenHistory = new Set();
  for (const item of [info.previous, ...(Array.isArray(info.previous?.history) ? info.previous.history : [])]) {
    const normalized = normalizeServerRuntimeRecord(item);
    if (!normalized) continue;
    const key = `${normalized.pid}:${normalized.startedAt}`;
    if (seenHistory.has(key)) continue;
    seenHistory.add(key);
    history.push({ pid: normalized.pid, startedAt: normalized.startedAt, instanceToken: normalized.instanceToken, bootAt: normalized.bootAt });
  }
  const record = {
    pid,
    startedAt: String(info.startedAt || getProcessStartTime(pid) || ''),
    instanceToken: String(info.instanceToken || ''),
    bootAt: new Date(now).toISOString(),
    node: String(info.node || process.version),
    platform: String(info.platform || process.platform),
    previous,
    history: history.slice(0, MAX_IDENTITY_HISTORY),
  };
  writeJsonAtomic(path.join(dataDir, SERVER_RUNTIME_FILE), record);
  return record;
}

function normalizeServerRuntimeRecord(record) {
  if (!record || !Number.isInteger(Number(record.pid)) || Number(record.pid) <= 0) return null;
  return {
    pid: Number(record.pid),
    startedAt: String(record.startedAt || ''),
    instanceToken: String(record.instanceToken || ''),
    bootAt: String(record.bootAt || ''),
    node: String(record.node || ''),
    platform: String(record.platform || ''),
  };
}

export function readServerRuntimeMarker(dataDir) {
  const record = readJsonObjectFile(path.join(dataDir, SERVER_RUNTIME_FILE));
  const normalized = normalizeServerRuntimeRecord(record);
  if (!normalized) return null;
  return {
    ...normalized,
    // The identity this boot superseded. Preserved so a monitor that never saw
    // the previous process (state reset, first install, fast restart) can still
    // classify its termination from evidence.
    previous: normalizeServerRuntimeRecord(record.previous),
    history: (Array.isArray(record.history) ? record.history : [])
      .map(normalizeServerRuntimeRecord)
      .filter(Boolean)
      .slice(0, MAX_IDENTITY_HISTORY),
  };
}

/** Persist proof that this process shut down gracefully before exiting. */
export function writeCleanShutdownMarker(dataDir, info = {}, now = Date.now()) {
  const pid = Number(info.pid) || process.pid;
  // Keep earlier graceful identities so A clean, B clean, C boot never reports
  // A or B as a crash.
  const earlier = readCleanShutdownMarker(dataDir);
  const history = earlier
    ? [{ pid: earlier.pid, startedAt: earlier.startedAt }, ...earlier.history].slice(0, MAX_IDENTITY_HISTORY)
    : [];
  const record = {
    pid,
    startedAt: String(info.startedAt || getProcessStartTime(pid) || ''),
    signal: String(info.signal || ''),
    shutdownAt: new Date(now).toISOString(),
    history,
  };
  writeJsonAtomic(path.join(dataDir, SERVER_SHUTDOWN_FILE), record);
  return record;
}

export function readCleanShutdownMarker(dataDir) {
  const record = readJsonObjectFile(path.join(dataDir, SERVER_SHUTDOWN_FILE));
  if (!record || !Number.isInteger(Number(record.pid)) || Number(record.pid) <= 0) return null;
  return {
    pid: Number(record.pid),
    startedAt: String(record.startedAt || ''),
    signal: String(record.signal || ''),
    shutdownAt: String(record.shutdownAt || ''),
    history: (Array.isArray(record.history) ? record.history : [])
      .filter((item) => Number.isInteger(Number(item?.pid)) && Number(item.pid) > 0)
      .map((item) => ({ pid: Number(item.pid), startedAt: String(item.startedAt || '') }))
      .slice(0, MAX_IDENTITY_HISTORY),
  };
}

/**
 * Whether a graceful shutdown was recorded for exactly this process instance.
 * Considers the latest marker and the bounded history of earlier ones.
 *
 * @param {{ pid?: number, startedAt?: string, history?: Dict[] } | null | undefined} clean
 * @param {{ pid?: number, startedAt?: string } | null | undefined} identity
 * @returns {boolean}
 */
export function isCoveredByCleanShutdown(clean, identity) {
  if (!clean || !identity?.pid) return false;
  return [clean, ...(clean.history || [])].some((item) => matchesCleanShutdown(item, identity));
}

/**
 * Whether an exit should be recorded as a graceful shutdown. Fatal / server-error
 * exits (non-zero forced code) and non-signal reasons are unexpected deaths and
 * must stay visible to the external observer.
 *
 * @param {{ signal?: string, exitCode?: number | null }} input
 * @returns {boolean}
 */
export function shouldRecordCleanShutdown(input = {}) {
  if (Number.isInteger(input.exitCode) && input.exitCode !== 0) return false;
  return input.signal === 'SIGTERM' || input.signal === 'SIGINT';
}

/**
 * Boot wiring: write the runtime identity first, then surface markers written by
 * the external monitor while this server was dead. The diagnostics recorder gets
 * a compact summary; the full markers stay in `data/oom-markers.jsonl` and are
 * exposed by the diagnostics API.
 *
 * @param {{
 *   dataDir: string,
 *   serverPid?: number,
 *   startedAt?: string,
 *   instanceToken?: string,
 *   diagnostics?: { record?: (event: string, details?: Dict) => unknown } | null,
 *   now?: number,
 *   markerLimit?: number,
 * }} options
 */
export function bootOomDiagnostics(options) {
  const dataDir = options.dataDir;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const markerLimit = Number.isInteger(options.markerLimit) && options.markerLimit > 0
    ? Math.min(100, options.markerLimit)
    : 10;
  const previousRuntime = readServerRuntimeMarker(dataDir);
  const serverPid = options.serverPid ?? process.pid;
  const startedAt = String(options.startedAt || '');
  const supersedesPrevious = Boolean(previousRuntime)
    && (previousRuntime.pid !== Number(serverPid)
      || (Boolean(previousRuntime.startedAt) && Boolean(startedAt) && previousRuntime.startedAt !== startedAt));
  const runtime = writeServerRuntimeMarker(dataDir, {
    pid: serverPid,
    startedAt,
    instanceToken: options.instanceToken,
    previous: supersedesPrevious ? previousRuntime : null,
  }, now);
  const markers = readOomMarkers(dataDir, markerLimit);
  const lastMarker = markers.length > 0 ? markers[markers.length - 1] : null;
  const markerKey = lastMarker
    ? [lastMarker.target, lastMarker.pid, lastMarker.startedAt, lastMarker.cause, lastMarker.confidence, lastMarker.recordedAt].join(':')
    : '';
  const warningStatePath = path.join(dataDir, OOM_BOOT_WARNING_STATE_FILE);
  const warningState = readJsonObjectFile(warningStatePath);
  const recordedAtMs = Date.parse(String(lastMarker?.recordedAt || ''));
  // An unparseable timestamp is treated as fresh: dropping the warning would
  // hide a real marker, and the once-per-marker state still bounds repeats.
  const markerIsFresh = !Number.isFinite(recordedAtMs) || now - recordedAtMs <= OOM_BOOT_WARNING_MAX_AGE_MS;
  const hasNewMarker = Boolean(markerKey && markerIsFresh && warningState?.lastMarkerKey !== markerKey);
  if (markerKey) {
    try { writeJsonAtomic(warningStatePath, { lastMarkerKey: markerKey, updatedAt: new Date(now).toISOString() }); } catch { /* warning dedupe is best-effort */ }
  }
  try {
    options.diagnostics?.record?.('oom-diagnostics-boot', {
      runtimePid: runtime.pid,
      markerCount: markers.length,
      lastMarkerCause: lastMarker ? String(lastMarker.cause || 'unknown') : '',
      lastMarkerConfidence: lastMarker ? String(lastMarker.confidence || 'unknown') : '',
      lastMarkerRecordedAt: lastMarker ? String(lastMarker.recordedAt || '') : '',
    });
  } catch {
    // Diagnostics must never block boot.
  }
  return { runtime, markers, markerCount: markers.length, lastMarker, hasNewMarker };
}

/** Record a graceful shutdown before the process exits. */
export function recordCleanShutdown(options) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const marker = writeCleanShutdownMarker(options.dataDir, {
    pid: options.serverPid ?? process.pid,
    startedAt: options.startedAt,
    signal: options.signal,
  }, now);
  try {
    options.diagnostics?.record?.('oom-diagnostics-clean-shutdown', {
      pid: marker.pid,
      signal: marker.signal,
    });
  } catch {
    // Diagnostics must never block shutdown.
  }
  return marker;
}

/** Bounded durable log of executor exits, consumed by the external monitor. */
export const CHILD_EXIT_EVENTS_FILE = 'child-exit-events.json';

/**
 * Append one executor exit event. The active registry drops an entry on exit,
 * so an executor SIGKILLed between two monitor samples would otherwise leave no
 * trace. Only the newest `MAX_EXIT_EVENTS` are kept.
 *
 * @param {string} dataDir
 * @param {{ pid: number, startedAt?: string, type?: string, label?: string, signal?: string|null, code?: number|null }} event
 * @param {number} [now]
 */
export function appendChildExitEvent(dataDir, event, now = Date.now()) {
  const events = readChildExitEvents(dataDir);
  events.push({
    pid: Number(event.pid),
    startedAt: String(event.startedAt || ''),
    type: String(event.type || 'child').slice(0, 40),
    label: String(event.label || '').slice(0, 200),
    signal: event.signal ? String(event.signal) : '',
    code: Number.isInteger(event.code) ? event.code : null,
    exitedAt: new Date(now).toISOString(),
  });
  writeJsonAtomic(path.join(dataDir, CHILD_EXIT_EVENTS_FILE), { events: events.slice(-MAX_EXIT_EVENTS) });
}

/** @returns {Dict[]} */
export function readChildExitEvents(dataDir) {
  const raw = readJsonObjectFile(path.join(dataDir, CHILD_EXIT_EVENTS_FILE));
  return Array.isArray(raw?.events)
    ? raw.events.filter((e) => Number.isInteger(Number(e?.pid)) && Number(e.pid) > 0).slice(-MAX_EXIT_EVENTS)
    : [];
}

/** Read VmRSS (bytes) of a pid from /proc; null when unreadable. */
export function readProcessRssBytes(pid, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  try {
    const m = /^VmRSS:\s+(\d+)\s+kB$/m.exec(readFile(`/proc/${pid}/status`));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Account server and executor memory. Executors whose RSS cannot be read are
 * counted in `unreadable` rather than silently as zero. Only each process's own
 * VmRSS is summed: descendants of an executor (and short `spawnSync` probes,
 * see `installChildProcessSpawnTracking`) are intentionally not counted, so the
 * figure is a lower bound; host `MemAvailable` covers the rest.
 */
export function measureMemory({ serverPid = process.pid, executors = [], readRss = readProcessRssBytes } = {}) {
  const serverRssBytes = readRss(serverPid);
  const rows = executors.map((e) => ({ pid: e.pid, type: e.type || 'unknown', label: e.label || '', rssBytes: readRss(e.pid) }));
  const readable = rows.filter((r) => r.rssBytes !== null);
  return {
    serverPid,
    serverRssBytes,
    executorCount: rows.length,
    executorsRssBytes: readable.reduce((sum, r) => sum + r.rssBytes, 0),
    unreadable: rows.length - readable.length,
    executors: rows,
  };
}

/**
 * Append one ledger sample (measurement plus host availability). Each executor
 * row keeps its pid/type/label, and `rssBytes: null` marks a process whose RSS
 * could not be read, so an unreadable executor is never silently accounted as
 * zero.
 */
export function appendMemoryLedger(dataDir, sample, now = Date.now()) {
  const executors = (Array.isArray(sample.executors) ? sample.executors : []).slice(0, 100).map((row) => ({
    pid: Number.isInteger(Number(row?.pid)) && Number(row.pid) > 0 ? Number(row.pid) : null,
    type: String(row?.type || 'unknown').slice(0, 40),
    label: String(row?.label || '').slice(0, 200),
    rssBytes: Number.isFinite(row?.rssBytes) ? row.rssBytes : null,
  }));
  const record = {
    at: new Date(now).toISOString(),
    hostTotalBytes: sample.hostTotalBytes ?? null,
    hostAvailableBytes: sample.hostAvailableBytes ?? null,
    serverPid: Number.isInteger(Number(sample.serverPid)) && Number(sample.serverPid) > 0
      ? Number(sample.serverPid)
      : null,
    serverRssBytes: sample.serverRssBytes ?? null,
    executorsRssBytes: sample.executorsRssBytes ?? 0,
    executorCount: sample.executorCount ?? executors.length,
    unreadable: sample.unreadable ?? executors.filter((row) => row.rssBytes === null).length,
    executors,
  };
  appendJsonl(path.join(dataDir, MEMORY_LEDGER_FILE), record);
  return record;
}

export function readMemoryLedger(dataDir, limit = 200) {
  return readJsonl(path.join(dataDir, MEMORY_LEDGER_FILE), limit);
}

/** Memory guard level from host availability. Unknown inputs never block. */
export function evaluateMemoryGuard({ hostTotalBytes, hostAvailableBytes }, config = DEFAULT_MEMORY_GUARD_CONFIG) {
  if (!hostTotalBytes || hostAvailableBytes == null) return { level: 'unknown', ratio: null };
  const ratio = hostAvailableBytes / hostTotalBytes;
  if (ratio < config.criticalAvailableRatio) return { level: 'critical', ratio };
  if (ratio < config.warnAvailableRatio) return { level: 'warn', ratio };
  return { level: 'ok', ratio };
}

/**
 * Reserve a new executor needs, scaled to the memory total so it never exceeds
 * `executorReserveMaxRatio` of it (the configured bytes stay the upper bound).
 */
export function effectiveExecutorReserveBytes(hostTotalBytes, config = DEFAULT_MEMORY_GUARD_CONFIG) {
  const ratio = Number.isFinite(config.executorReserveMaxRatio)
    ? config.executorReserveMaxRatio
    : DEFAULT_MEMORY_GUARD_CONFIG.executorReserveMaxRatio;
  return Math.min(config.executorReserveBytes, hostTotalBytes * ratio);
}

/**
 * Clamp host memory to the tightest cgroup v2 limit that applies to this
 * process: `memory.max` caps the total, `memory.max - memory.current` caps the
 * availability. Walks from the process cgroup up to the root; unreadable or
 * unlimited (`max`) levels are ignored, so a host without cgroups is unchanged.
 *
 * @param {{ totalBytes: number|null, availableBytes: number|null }} host
 * @param {{ readFile?: (p: string) => string, cgroupRoot?: string }} [options]
 */
export function applyCgroupMemoryLimit(host, options = {}) {
  const readFile = options.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const root = options.cgroupRoot || '/sys/fs/cgroup';
  let totalBytes = host.totalBytes;
  let availableBytes = host.availableBytes;
  let relative = '';
  try {
    const line = String(readFile('/proc/self/cgroup')).split('\n').find((row) => row.startsWith('0::'));
    relative = line ? line.slice(3).trim() : '';
  } catch {
    return { totalBytes, availableBytes };
  }
  const parts = relative.split('/').filter(Boolean);
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    const memory = readCgroupMemory(path.join(root, ...parts.slice(0, depth)), readFile);
    if (!Number.isFinite(memory.maxBytes) || memory.maxBytes <= 0) continue;
    if (totalBytes === null || memory.maxBytes < totalBytes) totalBytes = memory.maxBytes;
    if (Number.isFinite(memory.currentBytes)) {
      const free = Math.max(0, memory.maxBytes - memory.currentBytes);
      if (availableBytes === null || free < availableBytes) availableBytes = free;
    }
  }
  return { totalBytes, availableBytes };
}

/** Host memory from `/proc/meminfo`, clamped to the cgroup limit of this process. */
export function readEffectiveHostMemory(options = {}) {
  const host = readHostMemory(options.readFile);
  if (host.totalBytes === null || host.availableBytes === null) return host;
  return applyCgroupMemoryLimit(host, options);
}

/**
 * Pre-flight before starting an executor: refuse when the host is critical or
 * the headroom above the critical line is smaller than the executor reserve.
 */
export function preflightExecutorStart({ hostTotalBytes, hostAvailableBytes }, config = DEFAULT_MEMORY_GUARD_CONFIG) {
  const guard = evaluateMemoryGuard({ hostTotalBytes, hostAvailableBytes }, config);
  if (guard.level === 'unknown') return { allowed: true, level: 'unknown', reason: 'memory state unknown; not blocking' };
  if (guard.level === 'critical') return { allowed: false, level: 'critical', reason: 'host available memory is critical' };
  const headroom = hostAvailableBytes - hostTotalBytes * config.criticalAvailableRatio;
  if (headroom < effectiveExecutorReserveBytes(hostTotalBytes, config)) {
    return { allowed: false, level: guard.level, reason: 'insufficient headroom for a new executor' };
  }
  return { allowed: true, level: guard.level, reason: guard.level === 'warn' ? 'allowed under memory warning' : 'ok' };
}

/** Stable identity of a termination target, used to dedupe repeats across runs. */
export function terminationTargetKey(target) {
  return `${target?.target || 'process'}:${target?.pid ?? ''}:${target?.startedAt || ''}`;
}

/**
 * @param {{ pid?: number, startedAt?: string, alive?: boolean } | null | undefined} previous
 * @param {{ pid?: number, startedAt?: string, alive?: boolean } | null | undefined} observed
 * @returns {boolean}
 */
function sameLiveInstance(previous, observed) {
  if (!previous?.pid || !observed?.pid || previous.pid !== observed.pid) return false;
  if (!observed.alive) return false;
  if (previous.startedAt && observed.startedAt && previous.startedAt !== observed.startedAt) return false;
  return true;
}

/**
 * A clean shutdown marker only covers the exact process instance that wrote it,
 * so a stale marker from an earlier graceful run never hides a later SIGKILL.
 *
 * @param {{ pid?: number, startedAt?: string } | null | undefined} clean
 * @param {{ pid?: number, startedAt?: string } | null | undefined} previous
 * @returns {boolean}
 */
export function matchesCleanShutdown(clean, previous) {
  if (!clean?.pid || !previous?.pid || clean.pid !== previous.pid) return false;
  if (clean.startedAt && previous.startedAt && clean.startedAt !== previous.startedAt) return false;
  return true;
}

/**
 * @param {{ events?: { oom_kill?: number } } | null | undefined} before
 * @param {{ events?: { oom_kill?: number } } | null | undefined} after
 * @returns {boolean}
 */
function hasCgroupOomKillDelta(before, after) {
  const previous = before?.events?.oom_kill;
  const current = after?.events?.oom_kill;
  return Number.isFinite(previous) && Number.isFinite(current) && current > previous;
}

/**
 * Evidence lines that may be cited for a target. Applies the same instance-time
 * filter as `classifyExit`: a line older than the recorded process start must
 * not appear in `basis`/`evidence`, or the marker would quote the kill of a
 * previous pid owner.
 *
 * @param {Array<{ kind?: string, pid?: number|null, at?: number|null, line?: string, unit?: string, cgroup?: string }>} evidence
 * @param {number|null} pid
 * @param {number|null} startMs
 * @returns {string[]}
 */
function evidenceLinesFor(evidence, pid, startMs, endMs, scope = {}) {
  return evidence
    .filter((entry) => entry.kind === 'oom-kill'
      && (entry.pid === pid || (entry.pid === null && evidenceMatchesTarget(entry, scope)))
      && evidenceCoversInstance(entry, startMs, endMs) !== false)
    .map((entry) => String(entry.line || '').slice(0, 500))
    .slice(0, 3);
}

/**
 * Pick unexpected terminations from durable observations and classify each one
 * from external evidence only.
 *
 * - A previously observed server that is no longer the same live process and
 *   has no matching graceful-shutdown marker is always reported (an `unknown`
 *   cause is meaningful on its own).
 * - A registry entry left behind by a dead child is reported: a graceful exit
 *   removes it.
 * - A previously observed child that vanished is reported only when evidence
 *   names its pid or the cgroup OOM counter rose together with unit-level
 *   journal evidence; ordinary task completion stays silent.
 *
 * @param {{
 *   previousServer?: Dict | null,
 *   observedServer?: Dict | null,
 *   cleanShutdown?: Dict | null,
 *   previousExecutors?: Dict[],
 *   liveExecutors?: Dict[],
 *   staleExecutors?: Dict[],
 *   evidence?: Dict[],
 *   evidenceAvailable?: boolean,
 *   cgroupBefore?: Dict | null,
 *   cgroupAfter?: Dict | null,
 *   maxTargets?: number,
 *   maxTotalTargets?: number,
 *   targetUnits?: string[],
 *   targetCgroups?: string[],
 *   reportedKeys?: unknown[],
 *   unknownKeys?: unknown[],
 *   previousServers?: Dict[],
 *   exitEvents?: Dict[],
 * }} [input]
 * @returns {{ targets: Dict[], cgroupDelta: boolean, evidenceCount: number, evidenceAvailable: boolean, overflowCount: number }}
 */
export function detectUnexpectedTerminations(input = {}) {
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const maxTargets = Number.isInteger(input.maxTargets) && input.maxTargets > 0
    ? Math.min(MAX_MARKER_TARGETS, input.maxTargets)
    : MAX_MARKER_TARGETS;
  const maxTotalTargets = Number.isInteger(input.maxTotalTargets) && input.maxTotalTargets >= 0
    ? input.maxTotalTargets
    : Number.POSITIVE_INFINITY;
  const cgroupBefore = input.cgroupBefore || null;
  const cgroupAfter = input.cgroupAfter || null;
  const cgroupDelta = hasCgroupOomKillDelta(cgroupBefore, cgroupAfter);
  const scope = {
    targetUnits: Array.isArray(input.targetUnits) ? input.targetUnits : [],
    targetCgroups: Array.isArray(input.targetCgroups) ? input.targetCgroups : [],
  };
  // Pidless evidence only counts when it names the unit / cgroup of the target.
  const unitOom = evidence.some((entry) => entry.kind === 'oom-kill' && entry.pid === null
    && evidenceMatchesTarget(entry, scope));
  // Fully handled keys (already reported, or queued for a pending retry): they
  // are never re-emitted, and crucially they must NOT consume the per-run batch
  // cap below. Without this, a long acknowledged backlog (e.g. 20 already-marker
  // SIGKILL exit events) would be re-selected every tick and starve the next
  // un-acked target forever (R1A1-F2).
  const skipKeys = new Set((Array.isArray(input.reportedKeys) ? input.reportedKeys : []).map(String));
  // Keys still inside the unknown re-examination window are re-emitted so late
  // evidence can upgrade them, but also stay out of the cap (R1A2-F4).
  const freeKeys = new Set((Array.isArray(input.unknownKeys) ? input.unknownKeys : []).map(String));
  const targets = [];
  const seen = new Set();
  // Key -> index in `targets`, so a candidate that records the end of the
  // instance's life can replace an earlier candidate for the same instance that
  // cannot bound it (R17-R2-REG1).
  const targetIndexByKey = new Map();
  let newWorkCount = 0;
  let overflowCount = 0;
  const push = (target) => {
    const key = terminationTargetKey(target);
    if (skipKeys.has(key)) return; // already handled: do not emit, do not count
    const targetEndMs = resolveProcessEndMs(target.endMs ?? target.exitedAt ?? target.endedAt);
    const existingIndex = targetIndexByKey.get(key);
    if (existingIndex === undefined) {
      if (seen.has(key)) return;
      seen.add(key);
    } else if (!(Number.isFinite(targetEndMs) && !Number.isFinite(targets[existingIndex].endMs))) {
      // A candidate that closes the instance lifetime (an exit event carries
      // `exitedAt`) must not be deduped away by a boundary-less candidate for the
      // same pid owner: otherwise evidence produced after the instance ended
      // could be attributed to it when the pid is reused (R17-R2-REG1). The
      // reverse order stays a plain duplicate.
      return;
    }
    const { exitSignal, ...rest } = target;
    const startedAt = String(target.startedAt || '');
    const startMs = resolveProcessStartMs(startedAt);
    const endMs = targetEndMs;
    const classified = {
      ...rest,
      // Canonical (epoch ms or null) so a later same-key candidate can compare
      // the recorded lifetime boundary without re-parsing an ISO string.
      endMs,
      ...classifyExit({ pid: target.pid, startedAt, endMs, evidence, cgroupBefore, cgroupAfter, exitSignal, ...scope }),
      evidence: evidenceLinesFor(evidence, target.pid, startMs, endMs, scope),
    };
    if (existingIndex !== undefined) {
      // Classify again with the known lifetime boundary instead of adding a
      // second record: identity, counts and order stay unchanged.
      targets[existingIndex] = classified;
      return;
    }
    if (targets.length >= maxTotalTargets) {
      overflowCount += 1;
      return;
    }
    if (freeKeys.has(key)) {
      targetIndexByKey.set(key, targets.length);
      targets.push(classified); // re-examination: keep out of the new-work cap
      return;
    }
    // Evidence has already been consumed from the journal. Keep that target in
    // this run even when the bounded, evidence-free queue is full; otherwise a
    // cursor advance would permanently downgrade the deferred target later.
    const hasDurableEvidence = classified.source !== 'none' || classified.evidence.length > 0 || cgroupDelta;
    if (!hasDurableEvidence && newWorkCount >= maxTargets) return; // bound new work per run
    newWorkCount += 1;
    targetIndexByKey.set(key, targets.length);
    targets.push(classified);
  };

  const previousServers = [
    ...(Array.isArray(input.previousServers) ? input.previousServers : []),
    ...(input.previousServer ? [input.previousServer] : []),
  ];
  for (const previousServer of previousServers) {
    if (!(Number(previousServer?.pid) > 0)) continue;
    if (sameLiveInstance(previousServer, input.observedServer)) continue;
    if (isCoveredByCleanShutdown(input.cleanShutdown, previousServer)) continue;
    push({
      target: 'server',
      pid: Number(previousServer.pid),
      startedAt: String(previousServer.startedAt || ''),
      endMs: previousServer.endMs ?? previousServer.exitedAt ?? previousServer.endedAt,
      type: 'server',
      label: 'cretli server',
      reason: 'server process is gone and no graceful shutdown was recorded',
    });
  }

  const liveKeys = new Set((input.liveExecutors || [])
    .filter((entry) => Number(entry?.pid) > 0)
    .map((entry) => `${Number(entry.pid)}:${String(entry.startedAt || '')}`));
  for (const stale of input.staleExecutors || []) {
    if (!Number(stale?.pid)) continue;
    push({
      target: 'executor',
      pid: Number(stale.pid),
      startedAt: String(stale.startedAt || ''),
      endMs: stale.endMs ?? stale.exitedAt ?? stale.endedAt,
      type: String(stale.type || 'executor'),
      label: String(stale.label || ''),
      reason: 'registry entry left behind; the child did not exit cleanly',
    });
  }
  for (const previous of input.previousExecutors || []) {
    if (!Number(previous?.pid)) continue;
    if (liveKeys.has(`${Number(previous.pid)}:${String(previous.startedAt || '')}`)) continue;
    // A retried marker carries the end of the instance's life when it is known
    // (`endMs` from an earlier classification, or `exitedAt`/`endedAt`); without
    // it the evidence cannot be placed before the death (R17-R2-REG1).
    const previousEndMs = previous.endMs ?? previous.exitedAt ?? previous.endedAt;
    // A stale line from a previous pid owner may not even select the target:
    // the same instance-time filter used by `classifyExit` decides here.
    const exact = evidence.some((entry) => entry.kind === 'oom-kill'
      && entry.pid === previous.pid
      && evidenceCoversInstance(entry, resolveProcessStartMs(previous.startedAt), resolveProcessEndMs(previousEndMs)) !== false);
    if (!exact && !(cgroupDelta && unitOom)) continue;
    push({
      target: 'executor',
      pid: Number(previous.pid),
      startedAt: String(previous.startedAt || ''),
      endMs: previousEndMs,
      type: String(previous.type || 'executor'),
      label: String(previous.label || ''),
      reason: exact
        ? 'journal evidence names this executor'
        : 'cgroup OOM counter rose together with unit-level journal evidence',
    });
  }
  // Executors that exited with SIGKILL between two samples: the registry entry
  // is gone, but the exit event persisted by the server survives.
  for (const event of input.exitEvents || []) {
    if (!Number(event?.pid) || event.signal !== 'SIGKILL') continue;
    if (liveKeys.has(`${Number(event.pid)}:${String(event.startedAt || '')}`)) continue;
    push({
      target: 'executor',
      pid: Number(event.pid),
      startedAt: String(event.startedAt || ''),
      endMs: event.endMs ?? event.exitedAt ?? event.endedAt,
      type: String(event.type || 'executor'),
      label: String(event.label || ''),
      reason: 'executor exited with SIGKILL between monitor samples',
      exitSignal: 'SIGKILL',
    });
  }

  return {
    targets,
    cgroupDelta,
    evidenceCount: evidence.length,
    evidenceAvailable: input.evidenceAvailable !== false,
    overflowCount,
  };
}
