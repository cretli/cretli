/**
 * Orchestrator view model: every agent (chat) from every workspace with one
 * status word each, the ones that need the driver first. Pure: the caller
 * passes chats, the presence map and open cards.
 */

import { t } from '../../i18n/index.js';
import { matchChatBySpokenTitle } from '../voice/voiceChatMatch.js';
import { matchWorkspaceBySpokenName, workspaceSpokenLabel } from '../voice/voiceWorkspaceMatch.js';
import { CAR_STATUS_PRIORITY, deriveCarAgentStatus } from './agentStatus.js';

/**
 * Rows shown at once. Presentation only: lookups (`resolveAgent`, voice switch) always see every
 * agent, and the screen offers "more" for the rest.
 */
export const ORCHESTRATOR_PAGE_SIZE = 20;
/** Horizontal travel (px) that counts as a "drag to switch" gesture. */
export const DRAG_SWITCH_PX = 80;

/**
 * @param {unknown} value
 * @returns {string}
 */
function normPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/$/, '').trim().toLowerCase();
}

/**
 * @typedef {{
 *   chatId: string, title: string, workspaceFile: string, workspaceLabel: string,
 *   status: import('./agentStatus.js').CarAgentStatusId, active: boolean, order: number,
 * }} AgentRow
 */

/**
 * @param {{
 *   chats: Array<Record<string, any>>,
 *   workspaces?: Array<Record<string, any>>,
 *   states?: Record<string, any>,
 *   cards?: Array<Record<string, any>>,
 *   activeChatId?: string,
 *   limit?: number,
 * }} input
 * @returns {AgentRow[]} needs_decision first, then errors, working, done, unknown, idle
 */
export function buildAgentList(input) {
  const workspaces = Array.isArray(input.workspaces) ? input.workspaces : [];
  const states = input.states || {};
  const cards = Array.isArray(input.cards) ? input.cards : [];
  const cardsByChat = new Map();
  for (const card of cards) {
    const chatId = String(card?.subject?.chatId || '');
    if (!chatId) continue;
    if (!cardsByChat.has(chatId)) cardsByChat.set(chatId, []);
    cardsByChat.get(chatId).push(card);
  }
  const labelFor = (chat) => {
    const file = normPath(chat.workspaceFile);
    const entry = file ? workspaces.find((workspace) => normPath(workspace.workspaceFile) === file) : null;
    if (entry) return workspaceSpokenLabel(entry);
    const folder = String(chat.workspaceFolder || '').replace(/\\/g, '/').split('/').filter(Boolean).pop();
    return folder || (chat.workspaceFile ? workspaceSpokenLabel({ workspaceFile: chat.workspaceFile }) : '');
  };
  const rows = (Array.isArray(input.chats) ? input.chats : [])
    .filter((chat) => chat && chat.id && !String(chat.archivedAt || '').trim())
    .map((chat, order) => ({
      chatId: String(chat.id),
      title: String(chat.title || '').trim() || t('car.untitled'),
      workspaceFile: String(chat.workspaceFile || ''),
      workspaceLabel: labelFor(chat),
      status: deriveCarAgentStatus(states[chat.id], cardsByChat.get(chat.id) || []),
      active: chat.id === input.activeChatId,
      order,
    }));
  rows.sort((a, b) => CAR_STATUS_PRIORITY[a.status] - CAR_STATUS_PRIORITY[b.status] || a.order - b.order);
  return input.limit ? rows.slice(0, input.limit) : rows;
}

/**
 * The agent that most needs the driver, other than the one already open when
 * another waits too.
 *
 * @param {AgentRow[]} rows
 * @returns {AgentRow|null}
 */
export function pickWaitingAgent(rows) {
  const waiting = rows.filter((row) => row.status === 'needs_decision');
  return waiting.find((row) => !row.active) || waiting[0] || null;
}

/**
 * Resolves a spoken agent reference. An id wins; "waiting" takes the first
 * agent that needs a decision; a name matches chat titles, optionally narrowed
 * by a spoken workspace. Several matches are reported, never guessed.
 *
 * @param {AgentRow[]} rows
 * @param {{ chatId?: string, name?: string, workspace?: string, waiting?: boolean }} ref
 * @returns {{ ok: true, row: AgentRow } | { ok: false, code: 'not_found'|'ambiguous'|'none_waiting'|'bad_reference', candidates?: string[] }}
 */
export function resolveAgent(rows, ref) {
  if (ref.chatId) {
    const row = rows.find((entry) => entry.chatId === ref.chatId);
    return row ? { ok: true, row } : { ok: false, code: 'not_found' };
  }
  if (ref.waiting) {
    const row = pickWaitingAgent(rows);
    return row ? { ok: true, row } : { ok: false, code: 'none_waiting' };
  }
  const name = String(ref.name || '').trim();
  if (!name) return { ok: false, code: 'bad_reference' };
  let pool = rows;
  const workspace = String(ref.workspace || '').trim();
  if (workspace) {
    const files = new Map();
    for (const row of rows) {
      if (row.workspaceFile && !files.has(row.workspaceFile)) {
        files.set(row.workspaceFile, { name: row.workspaceLabel, workspaceFile: row.workspaceFile });
      }
    }
    const hit = matchWorkspaceBySpokenName([...files.values()], workspace);
    if (hit.ambiguous) return { ok: false, code: 'ambiguous', candidates: hit.candidates };
    if (!hit.match) return { ok: false, code: 'not_found' };
    pool = rows.filter((row) => row.workspaceFile === /** @type {any} */ (hit.match).workspaceFile);
  }
  const result = matchChatBySpokenTitle(pool.map((row) => ({ id: row.chatId, title: row.title })), name);
  if (result.ambiguous) return { ok: false, code: 'ambiguous', candidates: result.candidates };
  if (!result.match) return { ok: false, code: 'not_found' };
  return { ok: true, row: /** @type {AgentRow} */ (pool.find((row) => row.chatId === result.match.id)) };
}

/**
 * Drag gesture on an agent row: a long, mostly horizontal drag switches.
 *
 * @param {{ x: number, y: number }} start
 * @param {{ x: number, y: number }} end
 * @returns {'switch'|'tap'|null}
 */
export function dragIntent(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return 'tap';
  if (Math.abs(dx) >= DRAG_SWITCH_PX && Math.abs(dx) > Math.abs(dy) * 1.5) return 'switch';
  return null;
}

/**
 * One line for the ear: "3 agents: 1 needs you, 2 working".
 *
 * @param {AgentRow[]} rows
 * @param {(key: string, vars?: object) => string} translate
 * @returns {string}
 */
export function summarizeAgents(rows, translate) {
  const counts = new Map();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) || 0) + 1);
  const parts = ['needs_decision', 'error', 'working', 'done']
    .filter((status) => counts.get(status))
    .map((status) => `${counts.get(status)} ${translate(`car.status.${status}`).toLowerCase()}`);
  return translate('car.agentsSummary', { count: rows.length, parts: parts.join(', ') || translate('car.status.idle').toLowerCase() });
}
