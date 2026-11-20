import path from 'node:path';
import { createStallWatchdog } from './stall-watchdog.js';
import { signatureMarker } from './cpu-profile-summary.js';

/** Loaded lazily: the persist layer binds to the data dir at import time. */
/** @param {...any} args */
async function defaultUpdateTodo(...args) {
  const { updateTodo } = await import('../persist/todos-store.js');
  return /** @type {(...a: any[]) => any} */ (updateTodo)(...args);
}

const OPEN_STATUSES = ['idea', 'ready', 'doing', 'deferred'];
export const STALE_AFTER_MS = 7 * 24 * 3600 * 1000;
export const AUTO_DEFER_REASON = 'No recurrence of this event-loop stall for 7 days (auto-deferred by the stall watchdog)';
const STACK_HEADING = '## Last stack';
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

function formatStack(summary) {
  const rows = (summary?.causes?.length ? summary.causes : summary?.lib?.length ? summary.lib : summary?.top || []).slice(0, 5);
  if (!rows.length) return '- (no frames)';
  return rows.map((r) => `- \`${r.functionName}\` — ${r.file}:${r.line}`).join('\n');
}

/** Most recent time an occurrence was recorded in the body (fall back to the creation line). */
export function lastSeenOf(todo) {
  const body = String(todo?.body || '');
  const raw = readField(body, 'stall-last-seen') || /^- Detected at: (.+)$/m.exec(body)?.[1]?.trim() || todo?.updatedAt || todo?.createdAt;
  const ms = Date.parse(raw || '');
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Body after one more occurrence: count, last-seen, max delay and last stack.
 * Counters live in the body because changelog entries are normalized to plain notes.
 */
export function applyOccurrenceToBody(body, { detectedAt, stalledForMs, summary }) {
  let next = String(body || '');
  const occurrences = (Number(readField(next, 'stall-occurrences')) || 1) + 1;
  next = setField(next, 'stall-occurrences', occurrences);
  next = setField(next, 'stall-last-seen', detectedAt);
  const max = Math.max(Number(readField(next, 'stall-max-ms')) || 0, Number(stalledForMs) || 0);
  next = setField(next, 'stall-max-ms', max);
  const section = `${STACK_HEADING}\n${formatStack(summary)}\n`;
  const idx = next.indexOf(`\n${STACK_HEADING}\n`);
  if (idx >= 0) {
    const after = next.indexOf('\n## ', idx + 1);
    const tail = after >= 0 ? next.slice(after) : '';
    next = `${next.slice(0, idx)}\n${section}${tail}`;
  } else {
    next = `${next.replace(/\s+$/, '')}\n\n${section}`;
  }
  return { body: next, occurrences };
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
  repoRoot, dataDir, addTodo, listTodos, publishNotification,
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
    onDuplicate: async (todo, { signature, detectedAt, stalledForMs, reason, summary }) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = (await listTodos(dataDir, repoRoot)).items.find((item) => item.id === todo.id) || todo;
        const { body, occurrences } = applyOccurrenceToBody(current.body, { detectedAt, stalledForMs, summary });
        try {
          return await updateTodo(dataDir, repoRoot, current.id, {
            body,
            // A recurrence wakes a todo that the auto-defer sweep parked.
            ...(current.status === 'deferred' && current.deferredReason === AUTO_DEFER_REASON ? { status: 'idea' } : {}),
            expectedUpdatedAt: current.updatedAt,
            appendChangelog: {
              kind: 'note',
              text: `Event-loop stall ${signature} occurrence #${occurrences} observed at ${detectedAt}; delayed ${stalledForMs} ms (${reason || 'heartbeat'}).`,
            },
          });
        } catch (failure) {
          if (attempt === 2) throw failure;
        }
      }
      return null;
    },
    sweepStale: () => deferStaleStallTodos({ dataDir, repoRoot, listTodos, updateTodo, now }),
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
