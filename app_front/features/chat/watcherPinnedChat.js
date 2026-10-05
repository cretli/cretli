/**
 * Pinned Workspace Chat — user commands (option A).
 *
 * The pinned chat is a UI shell over the existing watcher/todo REST APIs. There
 * is no resident assistant and no new harness mode: a command typed into the
 * pinned chat is parsed here and translated into one existing endpoint call.
 * This keeps the feature deterministic, cheap and testable. The trade-off is
 * that free-form natural language is not understood — only the documented
 * slash commands are (the chat shows `/help`).
 *
 * The server side is `lib/workspace-watcher-pinned-chat.js` +
 * `lib/routes/workspace-watcher-routes.js`.
 */

import { getWorkspaceWatcherView } from '../watcher/watcherGetCoalesce.js';

/** Canonical command list, used for help text and tests. */
export const WATCHER_PINNED_COMMANDS = Object.freeze([
  { command: 'help', usage: '/help', descriptionKey: 'watcherPinned.cmdHelp' },
  { command: 'status', usage: '/status', descriptionKey: 'watcherPinned.cmdStatus' },
  { command: 'pause', usage: '/pause', descriptionKey: 'watcherPinned.cmdPause' },
  { command: 'resume', usage: '/resume', descriptionKey: 'watcherPinned.cmdResume' },
  { command: 'stop', usage: '/stop [reason]', descriptionKey: 'watcherPinned.cmdStop' },
  { command: 'clear-stop', usage: '/clear-stop', descriptionKey: 'watcherPinned.cmdClearStop' },
  { command: 'tick', usage: '/tick', descriptionKey: 'watcherPinned.cmdTick' },
  { command: 'cycle', usage: '/cycle', descriptionKey: 'watcherPinned.cmdCycle' },
  { command: 'skip', usage: '/skip <todoId>', descriptionKey: 'watcherPinned.cmdSkip' },
]);

/**
 * @param {unknown} chat
 * @returns {boolean}
 */
export function isWatcherPinnedChat(chat) {
  return Boolean(chat && typeof chat === 'object' && chat.watcherPinned === true);
}

/**
 * Parse a slash command. Returns null for plain text so the caller can fall back
 * to the normal agent send path.
 *
 * @param {unknown} text
 * @returns {{ command: string, args: string, raw: string } | null}
 */
export function parseWatcherCommand(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw.startsWith('/')) return null;
  const match = /^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/.exec(raw);
  if (!match) return null;
  return {
    command: match[1].toLowerCase(),
    args: match[2].trim(),
    raw,
  };
}

/**
 * @returns {string[]} `usage — description` lines, ready to render.
 */
export function watcherCommandHelpLines(translate = (key) => key) {
  return WATCHER_PINNED_COMMANDS.map(
    (entry) => `${entry.usage} — ${translate(entry.descriptionKey)}`,
  );
}

/**
 * Execute one parsed command against the existing APIs.
 *
 * @param {{
 *   command: string,
 *   args?: string,
 *   workspaceFolder?: string,
 *   chatId?: string,
 *   fetchImpl?: typeof fetch,
 * }} input
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function runWatcherCommand(input = {}) {
  const command = String(input.command || '').trim().toLowerCase();
  const args = String(input.args || '').trim();
  const workspaceFolder = String(input.workspaceFolder || '').trim();
  const chatId = String(input.chatId || '').trim();
  const fetchImpl = typeof input.fetchImpl === 'function' ? input.fetchImpl : fetch;

  const call = async (path, method, body) => {
    const response = await fetchImpl(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    return { status: response.status, ok: response.ok && payload.ok !== false, payload };
  };

  try {
    switch (command) {
      case 'status': {
        const statusPath = `/api/workspace-watcher?workspaceFolder=${encodeURIComponent(workspaceFolder)}`;
        const result = fetchImpl === fetch
          ? await getWorkspaceWatcherView(statusPath).then((view) => ({
            status: view.status,
            ok: view.json?.ok !== false,
            payload: view.json || {},
          }))
          : await call(statusPath, 'GET');
        const watcher = result.payload?.watcher || {};
        return {
          ok: result.ok,
          message: `mode=${watcher.mode || 'off'} paused=${watcher.paused === true} cycles=${Array.isArray(watcher.activeCycles) ? watcher.activeCycles.length : 0} stop=${watcher.stopReason || '—'}`,
        };
      }
      case 'pause': {
        const result = await call('/api/workspace-watcher/pause', 'POST', { workspaceFolder });
        return { ok: result.ok, message: result.ok ? 'Watcher paused.' : 'Could not pause the watcher.' };
      }
      case 'resume': {
        const result = await call('/api/workspace-watcher/resume', 'POST', { workspaceFolder });
        return { ok: result.ok, message: result.ok ? 'Watcher resumed.' : 'Could not resume the watcher.' };
      }
      case 'stop': {
        const reason = args || 'stopped_from_pinned_chat';
        const result = await call('/api/workspace-watcher', 'PATCH', { workspaceFolder, stopReason: reason });
        return { ok: result.ok, message: result.ok ? `Watcher stopped (${reason}).` : 'Could not stop the watcher.' };
      }
      case 'clear-stop': {
        const result = await call('/api/workspace-watcher/clear-stop', 'POST', { workspaceFolder });
        return { ok: result.ok, message: result.ok ? 'Stop reason cleared.' : 'Could not clear the stop reason.' };
      }
      case 'tick': {
        const result = await call('/api/workspace-watcher/tick', 'POST', { workspaceFolder });
        const kind = result.payload?.tick?.action || 'unknown';
        return { ok: result.ok, message: `Tick: ${kind}` };
      }
      case 'cycle': {
        const result = await call('/api/workspace-watcher/run-cycle', 'POST', { workspaceFolder });
        return { ok: result.ok, message: result.ok ? 'Cycle requested.' : 'Could not start a cycle.' };
      }
      case 'skip': {
        if (!args) return { ok: false, message: 'Usage: /skip <todoId>' };
        const result = await call(`/api/todos/${encodeURIComponent(args)}`, 'PATCH', {
          workspaceFolder,
          status: 'done',
          chatId,
          appendChangelog: {
            kind: 'note',
            chatId,
            text: 'Skipped from the pinned workspace watcher chat.',
          },
        });
        return { ok: result.ok, message: result.ok ? `Todo ${args.slice(0, 8)} skipped.` : 'Could not skip that todo.' };
      }
      default:
        return { ok: false, message: `Unknown command "${command}". Try /help.` };
    }
  } catch (error) {
    return { ok: false, message: `Command failed: ${error?.message || error}` };
  }
}
