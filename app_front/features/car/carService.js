/**
 * Car view data and open/close control (no DOM).
 *
 * Presence comes from the HTTP `GET /api/chats/agent-states` map rather than
 * the WebSocket deltas: the HTTP map is complete (it carries `inputRequested`
 * and the child counts) and every successful fetch is a full reconcile, so a
 * reconnect needs no special path. A failed fetch only marks the last data
 * stale; it never invents a state.
 */

import { signal } from '@lit-labs/signals';
import { getChatAgentStates } from '../../core/api/index.js';
import { enterCarReadMode, getCarMode, leaveCarReadMode, setCarMode } from '../voice/voicePrefs.js';
import { carCards, carCardsFresh, getCarChoiceFlow, getCurrentCarCard, getCurrentCarEntry, isCarOnLessonsAggregate, refreshCarCards, stepCarCard } from './carDecisions.js';
import { withoutLessonCards } from './carLessons.js';
import { shortCarLabel } from './carChoice.js';
import { carCardTitle as localizedCardTitle, carOptionLabel, findWorkspaceForCard, pickOpenTarget } from './carCardNav.js';
import { getTodoWorkspaceFolder } from '../todo/todoWorkspaceScope.js';
import { t } from '../../i18n/index.js';
import { buildAgentList } from './orchestratorModel.js';
import { createCarAnnouncer, withCardKeys } from './carAnnouncer.js';
import { readHeadSeq, readShortReplySince } from './carShortReply.js';
import { createCarMediaSession, silentWavDataUri } from './carMediaSession.js';
import { syncCarWakeLock } from '../pwa/wakeLock.js';
import { setCarViewProbe } from './carViewProbe.js';

export const REFRESH_INTERVAL_MS = 4000;

/**
 * @typedef {{ states: Record<string, any>, stale: boolean, at: number }} CarPresence
 */

/** @type {import('@lit-labs/signals').Signal.State<CarPresence>} */
export const carPresence = signal({ states: {}, stale: false, at: 0 });
export const carViewOpen = signal(false);
setCarViewProbe(() => carViewOpen.get());
/** 'choice' = the decision screen, 'agents' = every agent of every workspace. */
export const carScreen = signal('choice');

let timer = null;

/** @type {ReturnType<typeof createCarAnnouncer>|null} */
let announcer = null;

async function loadSpeaker() {
  return (await import('../voice/chatSpeaker.js')).getChatSpeaker();
}

function getAnnouncer() {
  if (!announcer) {
    announcer = createCarAnnouncer({
      translate: t,
      isOpen: () => carViewOpen.get(),
      // The speaker loads lazily: re-check the session after the import before queueing speech.
      say: (text, isCurrent) => void loadSpeaker().then((speaker) => { if (isCurrent()) speaker.speakAnnouncement(text); }),
      readMark: readHeadSeq,
      readReplySince: readShortReplySince,
      cancelSpeech: () => void loadSpeaker().then((speaker) => speaker.cancelAnnouncements()),
    });
  }
  return announcer;
}

/** @type {ReturnType<typeof createCarMediaSession>|null} */
let mediaSession = null;

/**
 * Environment seams for the lifecycle; production uses the globals. Tests replace them through
 * `setCarLifecycleDeps` (and must call it again with `{}` to restore the defaults).
 *
 * @type {{ loadView?: () => Promise<unknown>, navigator?: any, createAudio?: () => any, MediaMetadata?: any }}
 */
let lifecycleDeps = {};

/** @param {typeof lifecycleDeps} [deps] test hook; drops the cached media session */
export function setCarLifecycleDeps(deps = {}) {
  mediaSession?.stop();
  mediaSession = null;
  lifecycleDeps = deps;
}

/** Mirrors `cr-car-view` #toggleMic: a live Realtime session keeps the microphone. */
async function toggleMicFromMedia() {
  const { isVoiceSessionActive } = await import('../voice/voiceSessionState.js');
  if (isVoiceSessionActive()) return;
  const { getBrowserVoiceMode } = await import('../voice/browserVoiceMode.js');
  getBrowserVoiceMode().toggle();
}

/** Next/previous agent, then names it through the announcement queue (never cancels the user's answer). */
async function cycleAgentFromMedia(direction) {
  const { commandHandlers } = await import('../voice/commandHandlers.js');
  const result = await commandHandlers.cycleChat(direction);
  if (!carViewOpen.get()) return;
  const spoken = result?.ok ? result.title || t('car.noChat') : String(result?.error || '');
  if (spoken) (await loadSpeaker()).speakAnnouncement(spoken);
  if (result?.ok) mediaSession?.setMetadata({ title: result.title || t('car.noChat'), artist: t('car.title') });
}

/** Bumped on every open and close so a late `start()` settlement can tell it is stale. */
let mediaGeneration = 0;
// Touch devices grant user activation on pointerup/click, not pointerdown.
const MEDIA_GESTURES = ['pointerup', 'click', 'keydown'];

function disarmMediaGesture() {
  if (typeof document === 'undefined') return;
  for (const type of MEDIA_GESTURES) document.removeEventListener(type, onMediaGesture);
}

/** Retries the silent audio on each gesture until it plays, then stops listening. */
function onMediaGesture() {
  const generation = mediaGeneration;
  void Promise.resolve(mediaSession?.resume()).then((playing) => {
    if (playing && generation === mediaGeneration) disarmMediaGesture();
  });
}

function startMediaSession() {
  const nav = lifecycleDeps.navigator || (typeof navigator === 'undefined' ? undefined : navigator);
  const createAudio = lifecycleDeps.createAudio || (typeof Audio === 'function' ? () => new Audio(silentWavDataUri()) : null);
  if (!nav || !nav.mediaSession || !createAudio) return;
  if (!mediaSession) {
    mediaSession = createCarMediaSession({
      navigator: nav,
      MediaMetadata: lifecycleDeps.MediaMetadata || (typeof MediaMetadata === 'undefined' ? undefined : MediaMetadata),
      createAudio,
      handlers: { toggleMic: toggleMicFromMedia, cycleAgent: cycleAgentFromMedia },
    });
  }
  const generation = ++mediaGeneration;
  void mediaSession.start().then((playing) => {
    // Car mode was closed (or reopened) while start() was pending: attach nothing.
    if (generation !== mediaGeneration || !carViewOpen.get()) return;
    mediaSession?.setMetadata({ title: t('car.title'), artist: 'Cretli' });
    // Autoplay needs a gesture: retry on every tap until the audio is running.
    if (!playing && typeof document !== 'undefined') {
      for (const type of MEDIA_GESTURES) document.addEventListener(type, onMediaGesture);
    }
  });
}

function stopMediaSession() {
  mediaGeneration += 1;
  disarmMediaGesture();
  mediaSession?.stop();
}

/** Feeds the announcer after a fresh poll; stale data is never diffed (it would invent changes). */
async function announceAgentChanges() {
  if (!carViewOpen.get() || isCarDataStale()) return;
  try {
    const rows = await loadAgentRows({ refresh: false });
    if (carViewOpen.get()) getAnnouncer().ingest(withCardKeys(rows, withoutLessonCards(carCards.get())));
  } catch {
    // Announcements are best effort; the next poll tries again.
  }
}

/**
 * "What's new / repeat": speaks the newest announcement again.
 *
 * @returns {{ ok: true, message: string, chatId?: string }}
 */
export function repeatLastAnnouncement() {
  return getAnnouncer().repeat();
}

/** @returns {string} chat id of the newest announcement ("switch" target), '' when none */
export function getLastAnnouncedChatId() {
  return getAnnouncer().getLast()?.chatId || '';
}

/**
 * Full presence reconcile. On failure the previous map stays and is marked stale.
 *
 * @returns {Promise<boolean>} whether the data is fresh
 */
export async function refreshCarPresence() {
  try {
    const data = await getChatAgentStates();
    const states = data && typeof data.states === 'object' && data.states ? data.states : {};
    carPresence.set({ states, stale: false, at: Date.now() });
    return true;
  } catch {
    carPresence.set({ ...carPresence.get(), stale: true });
    return false;
  }
}

/** @returns {Promise<void>} */
export async function refreshCarData() {
  const [fresh] = await Promise.all([refreshCarPresence(), refreshCarCards()]);
  if (!fresh && typeof navigator !== 'undefined' && navigator.onLine === false) {
    carPresence.set({ ...carPresence.get(), stale: true });
  }
}

function onVisibleAgain() {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') void pollOnce();
}

function pollOnce() {
  return refreshCarData().then(announceAgentChanges);
}

function startPolling() {
  if (timer) return;
  void pollOnce();
  timer = setInterval(() => void pollOnce(), REFRESH_INTERVAL_MS);
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onVisibleAgain);
    window.addEventListener('focus', onVisibleAgain);
    window.addEventListener('cr-decisions-changed', onVisibleAgain);
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibleAgain);
}

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
  if (typeof window !== 'undefined') {
    window.removeEventListener('online', onVisibleAgain);
    window.removeEventListener('focus', onVisibleAgain);
    window.removeEventListener('cr-decisions-changed', onVisibleAgain);
  }
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibleAgain);
}

/**
 * Mounts the car view once and starts refreshing.
 *
 * @returns {Promise<{ ok: true }>}
 */
export async function openCarView() {
  await (lifecycleDeps.loadView ? lifecycleDeps.loadView() : import('./cr-car-view.js'));
  if (typeof document !== 'undefined') {
    let view = document.querySelector('cr-car-view');
    if (!view) {
      view = document.createElement('cr-car-view');
      document.body.appendChild(view);
    }
  }
  carViewOpen.set(true);
  setCarMode(true);
  enterCarReadMode();
  startPolling();
  syncCarWakeLock(true);
  startMediaSession();
  return { ok: true };
}

/**
 * Agents of every workspace with their status, needs-decision first.
 *
 * @param {{ refresh?: boolean }} [options]
 * @returns {Promise<import('./orchestratorModel.js').AgentRow[]>}
 */
export async function loadAgentRows(options = {}) {
  if (options.refresh !== false) await refreshCarData();
  const chatModule = await import('../chat/index.js');
  return buildAgentList({
    chats: chatModule.getChatsList(),
    workspaces: chatModule.getWorkspacesList(),
    states: carPresence.get().states,
    cards: withoutLessonCards(carCards.get()),
    activeChatId: chatModule.getActiveChatIdValue(),
  });
}

/**
 * Opens the car view on the agents screen (or back on the decision screen).
 *
 * @param {boolean} [enable]
 * @returns {Promise<{ ok: true, screen: string }>}
 */
export async function setOrchestratorScreen(enable = true) {
  if (enable) {
    await openCarView();
    carScreen.set('agents');
    return { ok: true, screen: 'agents' };
  }
  carScreen.set('choice');
  return { ok: true, screen: 'choice' };
}

/** @returns {{ ok: true }} */
export function closeCarView() {
  carViewOpen.set(false);
  carScreen.set('choice');
  setCarMode(false);
  leaveCarReadMode();
  announcer?.reset();
  stopPolling();
  stopMediaSession();
  syncCarWakeLock(false);
  getCarChoiceFlow().cancel();
  // Whatever mic or Realtime left waiting must not be sent after the view is gone.
  void import('../voice/voiceSendGate.js').then(({ resetSharedVoiceSendGate }) => resetSharedVoiceSendGate());
  if (typeof document !== 'undefined') {
    const view = document.querySelector('cr-car-view');
    // Stopping the mode also drops a prompt still waiting in the undo window.
    if (view) import('../voice/browserVoiceMode.js').then(({ getBrowserVoiceMode }) => getBrowserVoiceMode().stop());
    view?.remove();
  }
  return { ok: true };
}

/**
 * "Open in the app": leaves car mode and shows the decisions panel (which lists the card and
 * links its todo); the lessons aggregate card opens Settings → Delegations → Lessons instead. The decision stays pending on the server.
 *
 * @param {Record<string, any>|null} [card] defaults to the card on screen
 * @returns {Promise<{ ok: boolean, code?: string }>}
 */
export async function openCardInApp(card = getCurrentCarEntry()) {
  const target = pickOpenTarget(card, getTodoWorkspaceFolder());
  if (target.switchTo) {
    // A card of another workspace is only listed once the app shows that workspace.
    const switched = await switchAppToCardWorkspace(card);
    // Stay in car mode (which shows the notice) instead of opening a panel without the card.
    if (!switched) return { ok: false, code: 'workspace_switch_failed' };
  }
  closeCarView();
  try {
    const { getSharedSpaNavigation } = await import('../../app/appShell/spaNavigationBridge.js');
    if (target.kind === 'lessons') {
      await /** @type {any} */ (getSharedSpaNavigation())?.navigate({ panel: 'settings', settingsTab: 'delegations-lessons' }, { explicit: true });
      (await import('../settings/reviewLessonsSettings.js')).showReviewLessonsCandidates();
      return { ok: true };
    }
    await /** @type {any} */ (getSharedSpaNavigation())?.navigate({ panel: 'decisions' }, { explicit: true });
    if (target.cardId) {
      const panel = await import('../decisions/decisionsPanel.js');
      panel.focusDecisionCard(target.cardId);
    }
    return { ok: true };
  } catch {
    return { ok: false, code: 'navigation_failed' };
  }
}

/**
 * @param {Record<string, any>|null} card
 * @returns {Promise<boolean>}
 */
async function switchAppToCardWorkspace(card) {
  try {
    const chatModule = await import('../chat/index.js');
    const found = findWorkspaceForCard(card, chatModule.getWorkspacesList() || []);
    if (!found) return false;
    const { applyVoiceWorkspaceSwitch } = await import('../chat/services/voiceWorkspaces.js');
    return (await applyVoiceWorkspaceSwitch(found.workspaceFile, found.folder)) === true;
  } catch {
    return false;
  }
}

/** Reopens the view after a reload when it was left open. */
export function restoreCarView() {
  if (getCarMode()) void openCarView();
}

/**
 * The view is stale when either source failed: a presence map without cards (or the reverse)
 * would show a calm state that is wrong.
 *
 * @returns {boolean}
 */
export function isCarDataStale() {
  return carPresence.get().stale || !carCardsFresh.get();
}

/** @param {Record<string, any>} card */
export function carCardTitle(card) {
  return localizedCardTitle(card, t);
}

/**
 * Spoken/readback label of a pick: the same localized, shortened text the button shows.
 *
 * @param {string} cardId
 * @param {string} optionId
 * @param {string} fallback server label
 * @returns {string}
 */
export function localizedPickLabel(cardId, optionId, fallback) {
  const card = carCards.get().find((entry) => entry.id === cardId);
  const option = (Array.isArray(card?.options) ? card.options : []).find((entry) => entry.id === optionId) || { id: optionId, label: fallback };
  return shortCarLabel(carOptionLabel(card, option, t));
}

export { carCards, carCardsFresh, getCarChoiceFlow, getCurrentCarCard, isCarOnLessonsAggregate, refreshCarCards, stepCarCard };
