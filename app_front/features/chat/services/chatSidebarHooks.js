/** Sidebar hooks, notification scheduling and agent-state timers. */
import { createSidebarStatusStabilizer } from '../../sidebar/sidebarChatStatusStability.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { hasConfirmedAgentRun, hasLiveHarnessWork, hasProtocolAgentRun, resolveFinishedReadMeta, SIDEBAR_CONNECTING_GRACE_MS } from '../chatStatusMeta.js';
import { t } from '../../../i18n/index.js';
import { isEmbedWidgetMode } from './newChatHarnessState.js';
import { isWidgetHostNavigationAvailable } from '../../../embed/widgetHostNavigation.js';
import { createRafDebouncer } from '../chatListStateRefresh.js';
import { isUiFreezeTraceActive } from '../../../lib/uiFreezeTrace.js';
import { getUiFreezeMetrics } from '../../sidebar/sidebarRenderMetrics.js';
import { getChatListAgentState, getTerminalStateMeta, scheduleChatListStateRefresh } from './chatSidebarState.js';
import { toggleWidgetUrlPin } from './chatWidgetPin.js';
import { chatShell } from '../state/chatShellState.js';
import { chatHost } from './chatHost.js';

/** Agent state: 'idle' | 'active' | 'disconnected'. Used on the chat list. */
export const AGENT_STATE_IDLE_MS = 1500;

export const TERMINAL_RECENT_OUTPUT_MS = 8000;

export function getChatAgentState(chat) {
  return chat._agentState || 'disconnected';
}

/**
 * Per-chat timers that keep the sidebar row from blinking. Timers only request a
 * sidebar refresh; the next pass re-reads the resolver with the settled signals.
 */
export const sidebarStatusStabilizer = createSidebarStatusStabilizer({
  onExpire: (chatId) => scheduleChatListStateRefresh(chatId ? [chatId] : []),
});

/**
 * True when the chat is supposed to hold a socket right now. Background chats
 * are deliberately kept socket-less by the WS policy, so their absence of a
 * socket is normal idle, not a connection error.
 *
 * @param {object|null|undefined} chat
 * @returns {boolean}
 */
export function chatExpectsLiveSocket(chat) {
  if (!chat) return false;
  if (chat.id === chatRuntime.activeChatId) return true;
  const mode = chat._backgroundMonitorMode;
  if (mode === 'ws' || mode === 'ws-active') return true;
  // Task 3.1: an archived row that is not actually running does not expect a
  // socket; sidebar meta maps stale waiting/attention to idle (see resolver).
  const archived = Boolean(String(chat.archivedAt || '').trim());
  if (archived && !hasConfirmedAgentRun(chat)) return false;
  return hasLiveHarnessWork(chat);
}

/**
 * Sidebar-row meta: the resolver surface plus the stability layer.
 *
 * @param {object|null|undefined} chat
 * @returns {{ tone: string, label: string, activityKey?: string, status?: string }}
 */
export function getSidebarChatStateMeta(chat) {
  if (!chat) return { tone: 'disconnected', label: t('status.disconnected') };
  const meta = getTerminalStateMeta(chat, 'sidebar');
  const stable = sidebarStatusStabilizer.stabilize(chat.id, meta, {
    serverBusy: hasProtocolAgentRun(chat),
    localActive: getChatAgentState(chat) === 'active',
    serverKnown: Boolean(chat._serverRunState) || typeof chat._sdkServerBusy === 'boolean',
  });
  // Finished-run check only paints over a settled row. It sits after the stabilizer, so the
  // working hysteresis never sees it and a new run replaces it immediately.
  if (stable.tone !== 'idle') return stable;
  return resolveFinishedReadMeta(chat, { translate: t }) || stable;
}

/**
 * Sidebar-only connection policy for the legacy PTY branch (the harness branch
 * applies it inside the resolver).
 *
 * @param {{ tone: string, label: string }} meta
 * @param {object} chat
 * @returns {{ tone: string, label: string }}
 */
export function applySidebarConnectionPolicy(meta, chat) {
  const connection = chat?._connectionStatus || 'disconnected';
  if (meta.tone === 'connecting') {
    const connectingForMs = sidebarStatusStabilizer.connectingForMs(chat.id, connection);
    if (connectingForMs < SIDEBAR_CONNECTING_GRACE_MS) {
      return { tone: 'idle', label: t('status.ready') };
    }
  }
  if (meta.tone === 'disconnected' && !chatExpectsLiveSocket(chat)) {
    return { tone: 'idle', label: t('status.ready') };
  }
  return meta;
}

export function getChatsList() {
  return chats;
}

export function getWorkspacesList() {
  return chatRuntime.workspaces;
}

export function getActiveChatIdValue() {
  return chatRuntime.activeChatId;
}

export function getChatListAgentStatePublic(chat) {
  return getChatListAgentState(chat);
}

export function getTerminalStateMetaPublic(chat) {
  return getSidebarChatStateMeta(chat);
}

export function getChatFavoritesStore() {
  return chatHost.chatFavorites;
}

export function getChatLastUsedAtPublic(chatId) {
  return chatHost.getChatLastUsedAt(chatId);
}

export function canPinChatToUrl() {
  return isEmbedWidgetMode() && isWidgetHostNavigationAvailable();
}

export function toggleChatUrlPinById(chatId, hintEl = null) {
  const chat = chats.find((item) => item.id === chatId);
  return toggleWidgetUrlPin(chat, hintEl);
}

export function setSidebarRenderHook(fn) {
  chatShell.sidebarRenderHook = typeof fn === 'function' ? fn : null;
}

/**
 * App.js registers `sidebarView.scheduleUpdate` here. The coalesced sidebar pass
 * repaints the in-place visuals that live outside the structural signature (active
 * chat row, settled-group summaries, parent badges) even when the frame's render
 * short-circuits.
 * @param {(() => void)|null} fn
 * @returns {void}
 */
export function setSidebarTransientPatchHook(fn) {
  chatShell.sidebarTransientPatchHook = typeof fn === 'function' ? fn : null;
}

/**
 * App.js registers the sidebar drawer here so voice tools can open it
 * without importing App (that would close a cycle through the send bar).
 * @param {(() => void)|null} fn
 * @returns {void}
 */
export function setSidebarOpenHook(fn) {
  chatShell.sidebarOpenHook = typeof fn === 'function' ? fn : null;
}

/**
 * Open the workspace/chat list sidebar. Idempotent when already open.
 * @returns {boolean}
 */
export function openChatSidebar() {
  if (typeof chatShell.sidebarOpenHook !== 'function') return false;
  chatShell.sidebarOpenHook();
  return true;
}

/**
 * App.js registers the sidebar drawer close here for voice tools.
 * @param {(() => void)|null} fn
 * @returns {void}
 */
export function setSidebarCloseHook(fn) {
  chatShell.sidebarCloseHook = typeof fn === 'function' ? fn : null;
}

/**
 * Hide the workspace/chat list sidebar. Idempotent when already closed.
 * @returns {boolean}
 */
export function closeChatSidebar() {
  if (typeof chatShell.sidebarCloseHook !== 'function') return false;
  chatShell.sidebarCloseHook();
  return true;
}

/**
 * App.js registers header workspace switching here so voice tools can change
 * project without importing App (that would close a cycle through the send bar).
 * @param {((workspaceFile: string, workspaceFolder?: string) => Promise<boolean>|boolean)|null} fn
 * @returns {void}
 */
export function setWorkspaceSwitchHook(fn) {
  chatRuntime.workspaceSwitchHook = typeof fn === 'function' ? fn : null;
}

/**
 * Coalesced sidebar update. notifySidebar() fires from ~20 sites (presence /
 * title / chatsChanged frames, selection, watcher badges); rebuilding per call
 * measured ~13 signatures/sec ≈ 180ms/s of main-thread work. Collapse them to at
 * most one render per animation frame. The render's signature-skip already
 * repaints the in-place visuals (active row, group summaries), so a status/active
 * frame costs no rebuild. Callers that need the DOM immediately use the
 * synchronous sidebarView.forceRerender() instead.
 */
export const sidebarUpdateScheduler = createRafDebouncer(() => {
  const activeOnly = !chatShell.sidebarFullRenderPending;
  chatShell.sidebarFullRenderPending = false;
  if (chatShell.sidebarRenderHook) chatShell.sidebarRenderHook({ activeOnly });
});

export function notifySidebar() {
  if (isUiFreezeTraceActive()) getUiFreezeMetrics()?.recordNotifySidebar();
  chatShell.sidebarFullRenderPending = true;
  sidebarUpdateScheduler.schedule();
}

/**
 * Update request for a pure chat selection: only the active-chat marker changed,
 * so the sidebar may skip the full render pass (it falls back on its own when it
 * cannot prove the structure is unchanged). Any other `notifySidebar()` in the
 * same frame upgrades the frame to a full render.
 */
export function notifySidebarSelectionOnly() {
  if (isUiFreezeTraceActive()) getUiFreezeMetrics()?.recordNotifySidebar();
  sidebarUpdateScheduler.schedule();
}
