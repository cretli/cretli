import path from 'node:path';
import { createStallWatchdog } from './stall-watchdog.js';
import { signatureMarker, buildProfileSections } from './cpu-profile-summary.js';

/** Loaded lazily: the persist layer binds to the data dir at import time. */
/** @param {...any} args */
async function defaultUpdateTodo(...args) {
  const { updateTodo } = await import('../persist/todos-store.js');
  return /** @type {(...a: any[]) => any} */ (updateTodo)(...args);
}

const OPEN_STATUSES = ['idea', 'ready', 'doing', 'deferred'];
export const STALE_AFTER_MS = 7 * 24 * 3600 * 1000;
export const AUTO_DEFER_REASON = 'No recurrence of this event-loop stall for 7 days (auto-deferred by the stall watchdog)';
const STACK_HEADING = '## Longest stall profile';
const LEGACY_STACK_HEADING = '## Last stack';
/** A stall at least this long always replaces the stored profile and is logged to server-diagnostics. */
export const LONG_STALL_MS = 10000;
const MERGED_RE = /^stall-merged-into: (\S+)$/m;

export const isStallTitle = (title) => String(title || '').startsWith('Event-loop stall:');

/** Todo that the migration folded into a primary one; never a dedupe target. */
export const isMergedDuplicate = (todo) => MERGED_RE.test(String(todo?.body || ''));

/** Escape a string for use inside a RegExp. */
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function readField(body, name) {
  return new RegExp(`^${esc(name)}: (.+)$`, 'm').exec(body)?.[1]?.trim();
}

/** Replace a `name: value` line in the body or append it. */
function setField(body, name, value) {
  const re = new RegExp(`^${esc(name)}: .*$`, 'm');
  const line = `${name}: ${value}`;
  return re.test(body) ? body.replace(re, () => line) : `${body.replace(/\s+$/, '')}\n${line}\n`;
}

/** Drop `## ` sections whose heading starts with one of `prefixes` (up to the next section or field line). */
function removeSections(body, prefixes) {
  const out = [];
  let skipping = false;
  for (const line of body.split('\n')) {
    if (/^## /.test(line)) skipping = prefixes.some((p) => line.startsWith(p));
    else if (skipping && /^[a-z][a-z-]*: /.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

const PROFILE_SECTIONS = ['## Dominant causes', '## Top functions under lib/', '## Top functions overall', STACK_HEADING, LEGACY_STACK_HEADING];

/** Replace the whole stored profile (header lines and all CPU sections) with the new stall's. */
function replaceProfile(body, { detectedAt, stalledForMs, profileMs, summary }) {
  let next = removeSections(body, PROFILE_SECTIONS);
  next = next.replace(/^- Detected at: .*$/m, () => `- Detected at: ${detectedAt}`)
    .replace(/^- Main thread unresponsive for: .*$/m, () => `- Main thread unresponsive for: ${stalledForMs} ms`)
    .replace(/^- CPU profile window: .*$/m, () => `- CPU profile window: ${profileMs ?? '?'} ms (total sampled self time ${summary?.totalMs ?? 0} ms)`);
  const section = [
    STACK_HEADING,
    `Recorded at ${detectedAt}; main thread blocked for ${stalledForMs} ms; CPU profile window ${profileMs ?? '?'} ms (total sampled self time ${summary?.totalMs ?? 0} ms).`,
    '',
    ...buildProfileSections(summary, '###'),
  ].join('\n');
  return `${next.replace(/\s+$/, '')}\n\n${section}\n`;
}

/** Most recent time an occurrence was recorded in the body (fall back to the creation line). */
export function lastSeenOf(todo) {
  const body = String(todo?.body || '');
  const raw = readField(body, 'stall-last-seen') || /^- Detected at: (.+)$/m.exec(body)?.[1]?.trim() || todo?.updatedAt || todo?.createdAt;
  const ms = Date.parse(raw || '');
  return Number.isFinite(ms) ? ms : null;
}

/** Largest stall already recorded in a body: the counter line or the creation line. */
function recordedMaxMs(body) {
  const created = /^- Main thread unresponsive for: (\d+) ms$/m.exec(body)?.[1];
  return Math.max(Number(readField(body, 'stall-max-ms')) || 0, Number(created) || 0);
}

/**
 * Body after one more occurrence: count, last-seen, max delay and the profile of the
 * longest stall. Counters live in the body because changelog entries are normalized
 * to plain notes. The profile section is replaced (and dated) only when this stall is
 * longer than the stored max, or is a long stall (>= LONG_STALL_MS); a shorter one
 * leaves the stored profile untouched. `max-ms` is always kept as the maximum.
 */
export function applyOccurrenceToBody(body, { detectedAt, stalledForMs, summary, profileMs }) {
  let next = String(body || '');
  const occurrences = (Number(readField(next, 'stall-occurrences')) || 1) + 1;
  const duration = Number(stalledForMs) || 0;
  const previousMax = recordedMaxMs(next);
  const replaced = duration > previousMax || duration >= LONG_STALL_MS;
  next = setField(next, 'stall-occurrences', occurrences);
  next = setField(next, 'stall-last-seen', detectedAt);
  next = setField(next, 'stall-max-ms', Math.max(previousMax, duration));
  if (replaced) next = replaceProfile(next, { detectedAt, stalledForMs: duration, profileMs, summary });
  return { body: next, occurrences, replaced };
}

/** Park open `idea` stall todos that have not recurred for `maxAgeMs`. Returns the ids moved. */
export async function deferStaleStallTodos({
  dataDir, repoRoot, listTodos, updateTodo = defaultUpdateTodo, now = Date.now, maxAgeMs = STALE_AFTER_MS,
}) {
  const moved = [];
  for (const todo of (await listTodos(dataDir, repoRoot)).items) {
    if (todo.status !== 'idea' || !isStallTitle(todo.title) || isMergedDuplicate(todo)) continue;
    const seen = lastSeenOf(todo);
    if (seen == null || now() - seen < maxAgeMs) continue;
    try {
      await updateTodo(dataDir, repoRoot, todo.id, {
        status: 'deferred',
        deferredReason: AUTO_DEFER_REASON,
        expectedUpdatedAt: todo.updatedAt,
        appendChangelog: { kind: 'note', text: AUTO_DEFER_REASON },
      });
      moved.push(todo.id);
    } catch {
      // Concurrent edit: the next sweep sees the fresh row.
    }
  }
  return moved;
}

/** Keep server-wide incidents in the server checkout, independent of the active workspace. */
export function createServerStallWatchdog({
  repoRoot, dataDir, addTodo, listTodos, publishNotification, recordDiagnostic,
  updateTodo = defaultUpdateTodo, now = Date.now,
  createWatchdog = createStallWatchdog,
}) {
  return createWatchdog({
    repoRoot,
    heartbeatFile: path.join(dataDir, 'server-heartbeat.json'),
    registryPath: path.join(dataDir, 'stall-watchdog-registry.json'),
    // Leave enough of a seven-second stall to capture its hot frames.
    thresholdMs: 3000,
    heartbeatMs: 250,
    checkMs: 250,
    profileMs: 2000,
    createTodo: (input) => addTodo(dataDir, repoRoot, { ...input, status: 'idea' }),
    // Match by signature, by the function/file marker, or by the identical title
    // (older todos carry only the title), skipping duplicates folded by the migration.
    findTodoBySignature: async (signature, /** @type {{ causeKey?: string, title?: string }} */ { causeKey, title } = {}) => (await listTodos(dataDir, repoRoot)).items
      .find((item) => OPEN_STATUSES.includes(item.status) && !isMergedDuplicate(item)
        && (String(item.body || '').includes(signatureMarker(signature))
          || (causeKey && String(item.body || '').split('\n').includes(`stall-cause: ${causeKey}`))
          || (title && item.title === title))),
    onDuplicate: async (todo, { signature, detectedAt, stalledForMs, reason, summary, profileMs }) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = (await listTodos(dataDir, repoRoot)).items.find((item) => item.id === todo.id) || todo;
        const { body, occurrences, replaced } = applyOccurrenceToBody(current.body, { detectedAt, stalledForMs, summary, profileMs });
        try {
          return await updateTodo(dataDir, repoRoot, current.id, {
            body,
            // A recurrence wakes a todo that the auto-defer sweep parked.
            ...(current.status === 'deferred' && current.deferredReason === AUTO_DEFER_REASON ? { status: 'idea' } : {}),
            expectedUpdatedAt: current.updatedAt,
            appendChangelog: {
              kind: 'note',
              text: `Event-loop stall ${signature} occurrence #${occurrences} observed at ${detectedAt}; blocked for ${stalledForMs} ms (${reason || 'heartbeat'})${replaced ? '; profile replaced' : ''}.`,
            },
          });
        } catch (failure) {
          if (attempt === 2) throw failure;
        }
      }
      return null;
    },
    sweepStale: () => deferStaleStallTodos({ dataDir, repoRoot, listTodos, updateTodo, now }),
    longStallMs: LONG_STALL_MS,
    onLongStall: ({ signature, stalledForMs, detectedAt }) => {
      recordDiagnostic?.('long-event-loop-stall', {
        message: `signature=${signature} stalledForMs=${stalledForMs} detectedAt=${detectedAt}`,
      });
    },
    notify: ({ signature, outcome, stalledForMs }) => publishNotification({
      category: 'system',
      severity: 'warning',
      title: 'Server event-loop stall',
      body: `Main thread heartbeat delayed by ${stalledForMs} ms; incident ${outcome}.`,
      fingerprint: `stall-watchdog:${signature}`,
      actionUrl: '',
    }),
  });
}
