/**
 * Owner-side actions of the internal operator (stage 2d): the owner message,
 * the status read model, pause/resume, the synthetic `operator_test` event and
 * the cleanup when a run chat is deleted mid-run.
 *
 * Everything here is reached only through the human-only routes of
 * `lib/routes/operator-internal-routes.js`; nothing is exposed as an agent tool.
 */

import { randomUUID } from 'node:crypto';
import { recordOperatorEvent } from '../persist/operator-journal-persist.js';
import { listRegisteredWorkspacesForFolder } from '../workspace-registry-service.js';
import { loadSettings } from '../persist/settings.js';
import { OPERATOR_TEST_KIND } from './operator-constants.js';
import { appendOperatorAudit } from './operator-audit.js';
import { appendOperatorOwnerNotice, ensureOperatorChat } from './operator-chat.js';
import { getMeta, openOperatorStore, releaseRunClaims, setMeta, withImmediateTx } from './operator-internal-store.js';
import { clearBreaker, evaluateDailyBudget, readBreaker, readDailyTokens } from './operator-limits.js';
import { readOperatorSettings } from './operator-settings.js';

export const OPERATOR_OWNER_MESSAGE_MAX = 4000;
/** `operator_test` events accepted per rolling hour; they also count toward the run and token budgets. */
export const OPERATOR_TEST_EVENTS_PER_HOUR = 10;
export const OPERATOR_OWNER_PAUSE_META_KEY = 'owner_paused_at';

const iso = (ms) => new Date(ms).toISOString();
const fail = (status, code, message) => Object.assign(new Error(message || code), { status, code });

/**
 * @param {Record<string, any>} [options] `{ dataDir?, file?, settings?, now? }`
 * @returns {Record<string, any>}
 */
const storeOf = (options = {}) => ({ dataDir: options.dataDir, file: options.file, now: options.now });

/** @param {Record<string, any>} options @returns {{ paused: boolean, pausedAt: string }} */
export function readOwnerPause(options = {}) {
  const db = openOperatorStore(storeOf(options));
  try {
    const at = getMeta(db, OPERATOR_OWNER_PAUSE_META_KEY, '');
    return { paused: at !== '', pausedAt: at };
  } finally { db.close(); }
}

/**
 * Owner pause: event-triggered runs wait, owner messages (priority 0) still run.
 * Resume also clears the circuit breaker, so one button always gets the operator going again.
 *
 * @param {boolean} paused
 * @param {Record<string, any>} [options]
 * @returns {{ paused: boolean }}
 */
export function setOwnerPause(paused, options = {}) {
  const store = storeOf(options);
  const db = openOperatorStore(store);
  try {
    withImmediateTx(db, () => setMeta(db, OPERATOR_OWNER_PAUSE_META_KEY, paused ? iso(options.now ?? Date.now()) : ''));
  } finally { db.close(); }
  if (!paused) clearBreaker(store);
  appendOperatorAudit({ tool: 'operator_owner', action: paused ? 'pause' : 'resume', outcome: 'allowed' }, store);
  return { paused };
}

/**
 * Read model for the UI chip: `off | paused | budget | running | queued | idle`.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function readOperatorStatus(options = {}) {
  const store = storeOf(options);
  const now = options.now ?? Date.now();
  const settings = options.settings ? readOperatorSettings({ settings: options.settings }) : readOperatorSettings();
  const breaker = readBreaker(store);
  const pause = readOwnerPause(options);
  const db = openOperatorStore(store);
  let running; let queued; let best;
  try {
    running = db.prepare("SELECT id, workspace, run_kind, started_at FROM operator_runs WHERE state='running'").get() || null;
    queued = Number(db.prepare("SELECT COUNT(*) AS n FROM operator_internal_queue WHERE state='pending'").get().n) || 0;
    best = db.prepare("SELECT kind FROM operator_internal_queue WHERE state='pending' ORDER BY journal_epoch, event_rowid LIMIT 1").get() || null;
  } finally { db.close(); }
  const daily = evaluateDailyBudget(readDailyTokens(store, now), settings, best ? 0 : 9);
  let state = 'idle';
  if (!settings.enabled) state = 'off';
  else if (pause.paused || breaker.paused) state = 'paused';
  else if (!daily.allowed) state = 'budget';
  else if (running) state = 'running';
  else if (queued > 0) state = 'queued';
  let chatId = '';
  try {
    const ensured = await ensureOperatorChat({ ...store, deps: options.chatDeps });
    if (ensured.ok) chatId = ensured.chatId;
  } catch { /* the status stays usable without the thread */ }
  return {
    ok: true,
    enabled: settings.enabled,
    state,
    queued,
    chatId,
    ownerPaused: pause.paused,
    breaker: { paused: breaker.paused, failures: breaker.failures },
    running: running ? { id: String(running.id), workspace: String(running.workspace || ''), kind: String(running.run_kind || '') } : null,
  };
}

/**
 * Store an owner message, show it in the thread and queue the `owner_message`
 * event (priority 0) that starts a run. Text is data for the run, never a command channel.
 *
 * @param {{ text?: unknown, source?: unknown }} input `source`: `ui` (default) or `voice`
 * @param {Record<string, any>} [options]
 */
export async function postOwnerMessage(input, options = {}) {
  const text = String(input?.text ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) throw fail(400, 'text_required');
  if (text.length > OPERATOR_OWNER_MESSAGE_MAX) throw fail(400, 'text_too_long');
  const source = input?.source === 'voice' ? 'voice' : 'ui';
  const settings = options.settings ? readOperatorSettings({ settings: options.settings }) : readOperatorSettings();
  if (!settings.enabled) throw fail(409, 'operator_disabled');
  const store = storeOf(options);
  const ensured = await ensureOperatorChat({ ...store, workspaceFolder: options.workspaceFolder, deps: options.chatDeps });
  if (ensured.ok === false) throw fail(500, 'operator_chat_unavailable', ensured.reason);
  const id = randomUUID();
  const db = openOperatorStore(store);
  try {
    db.prepare("INSERT INTO operator_owner_messages(id, direction, text, run_id, created_at, read_at) VALUES (?, 'owner', ?, NULL, ?, NULL)")
      .run(id, text, iso(options.now ?? Date.now()));
  } finally { db.close(); }
  const workspace = String(ensured.chat?.workspaceFolder || options.workspaceFolder || process.cwd());
  await appendOperatorOwnerNotice({ text, kind: 'owner_message', level: 'info' }, { ...store, deps: options.chatDeps });
  recordOperatorEvent(workspace, 'owner_message', `owner_message: ${source} message ${id}`, store);
  appendOperatorAudit({ tool: 'operator_owner', action: 'message', outcome: 'allowed', args: { source, length: text.length } }, store);
  return { ok: true, id, source, chatId: ensured.chatId };
}

/** @param {Record<string, any>} settings @param {string} folder @returns {boolean} */
function isRegisteredFolder(settings, folder) {
  return listRegisteredWorkspacesForFolder(settings, folder).length > 0;
}

/**
 * Synthetic `operator_test` event. Only for an enabled operator, only for a
 * workspace of the registry, at most {@link OPERATOR_TEST_EVENTS_PER_HOUR} per
 * rolling hour. The event takes the normal path, so the run it triggers counts
 * toward the hourly run limit and the daily token budget.
 *
 * @param {{ workspaceFolder?: unknown }} input
 * @param {Record<string, any>} [options] `deps.isRegisteredWorkspace(folder)` injects the registry check (tests)
 */
export function postTestEvent(input, options = {}) {
  const folder = String(input?.workspaceFolder ?? '').trim();
  if (!folder) throw fail(400, 'workspaceFolder_required');
  const settings = options.settings ? readOperatorSettings({ settings: options.settings }) : readOperatorSettings();
  if (!settings.enabled) throw fail(409, 'operator_disabled');
  const registered = options.deps?.isRegisteredWorkspace
    ? options.deps.isRegisteredWorkspace(folder)
    : isRegisteredFolder(options.fullSettings || safeLoadSettings(), folder);
  if (!registered) throw fail(403, 'workspace_not_registered');
  const store = storeOf(options);
  const now = options.now ?? Date.now();
  const since = iso(now - 3_600_000);
  const db = openOperatorStore(store);
  try {
    // Count and reserve in one transaction so concurrent calls cannot exceed the limit.
    withImmediateTx(db, () => {
      const used = Number(db.prepare("SELECT COUNT(*) AS n FROM operator_audit WHERE tool = 'operator_test_event' AND outcome = 'allowed' AND created_at >= ?").get(since).n);
      if (used >= OPERATOR_TEST_EVENTS_PER_HOUR) throw fail(429, 'test_event_rate_limited');
      db.prepare("INSERT INTO operator_audit(run_id, tool, action, outcome, detail, created_at) VALUES ('', 'operator_test_event', 'post', 'allowed', ?, ?)")
        .run(JSON.stringify({ workspace: folder.slice(0, 300) }), iso(now));
    });
  } finally { db.close(); }
  recordOperatorEvent(folder, OPERATOR_TEST_KIND, `${OPERATOR_TEST_KIND}: test event ${randomUUID()}`, store);
  return { ok: true, kind: OPERATOR_TEST_KIND, workspaceFolder: folder };
}

function safeLoadSettings() {
  try { return loadSettings(); } catch { return null; }
}

/**
 * A run chat was deleted while its run was live: mark the run `interrupted` and
 * release its events (one retry, then parked). Not a counted failure and it
 * frees the single run slot at once. Works from any process (no instance ownership).
 *
 * @param {string} chatId
 * @param {Record<string, any>} [options]
 * @returns {{ interrupted: boolean, runId: string }}
 */
export function interruptRunForDeletedChat(chatId, options = {}) {
  const id = String(chatId || '').trim();
  if (!id) return { interrupted: false, runId: '' };
  const store = storeOf(options);
  const at = iso(options.now ?? Date.now());
  const db = openOperatorStore(store);
  try {
    return withImmediateTx(db, () => {
      const run = db.prepare("SELECT id FROM operator_runs WHERE state='running' AND chat_id = ?").get(id);
      if (!run) return { interrupted: false, runId: '' };
      db.prepare("UPDATE operator_runs SET state='interrupted', finished_at=?, failure_reason='chat_deleted' WHERE id=?").run(at, run.id);
      releaseRunClaims(db, String(run.id), at);
      return { interrupted: true, runId: String(run.id) };
    });
  } finally { db.close(); }
}
