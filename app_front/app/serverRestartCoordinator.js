import * as api from '../core/api/index.js';
import { t } from '../i18n/index.js';
import {
  canStartServerRestart,
  evaluateRestartHealth,
  isServerRestartPhaseActive,
  isServerRestartTimedOut,
  shouldSuppressDisconnectUi,
} from './serverRestartState.js';

export const SERVER_RESTART_READY_EVENT = 'cretli-server-restart-ready';

const STORAGE_KEY = 'cretli-server-restart';
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 90000;
const STABLE_PROBE_COUNT = 2;
const RECOVERING_TRANSITION_MS = 1200;
const SUCCESS_AUTO_DISMISS_MS = 1800;
const RECOVERING_WATCHDOG_MS = 5000;
const RECOVERING_DISMISSIBLE_MS = 2500;

let initialized = false;
let state = null;
let pollTimerId = null;
let successTransitionTimerId = null;
let recoveringWatchdogTimerId = null;
let stableToken = '';
let stableProbeCount = 0;
let suppressDisconnectUiUntil = 0;
let pollGeneration = 0;
let userCanDismissModal = false;
let restartFlowFinished = false;
let recoveringDismissFallbackTimerId = null;
let visibilityListenerBound = false;
let modalWatchdogIntervalId = null;
let recoveringBackendPollTimerId = null;

function readStoredState() {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.previousToken !== 'string' || !parsed.previousToken) return null;
    if (!Number.isFinite(parsed.startedAt)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function storeState() {
  if (typeof sessionStorage === 'undefined') return;
  try {
    if (!state) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Restart flow can continue without sessionStorage persistence after reload.
  }
}

function bumpPollGeneration() {
  pollGeneration += 1;
  return pollGeneration;
}

function resetRestartFlowFlags() {
  userCanDismissModal = false;
  restartFlowFinished = false;
}

function isPollingPhase() {
  if (!state) return false;
  return state.phase === 'requesting' || state.phase === 'waiting';
}

function setModalContent({ title, hint, loading, canClose }) {
  const modal = document.getElementById('restart-server-loading-modal');
  const titleEl = document.getElementById('restart-server-loading-text');
  const hintEl = document.getElementById('restart-server-loading-hint');
  const spinnerEl = modal?.querySelector('.restart-server-loading-spinner');
  const closeBtn = document.getElementById('restart-server-loading-close');
  if (!modal || !titleEl || !hintEl) return;
  titleEl.textContent = title;
  hintEl.textContent = hint;
  if (spinnerEl) spinnerEl.style.display = loading ? '' : 'none';
  userCanDismissModal = canClose === true;
  if (closeBtn) closeBtn.style.display = canClose ? 'inline-block' : 'none';
  modal.hidden = false;
}

function showWaitingModal() {
  setModalContent({
    title: t('serverRestart.restarting'),
    hint: t('serverRestart.waitingHint'),
    loading: true,
    canClose: false,
  });
}

function clearPollTimer() {
  if (pollTimerId == null) return;
  clearTimeout(pollTimerId);
  pollTimerId = null;
}

function clearRecoveringBackendPollTimer() {
  if (recoveringBackendPollTimerId == null) return;
  clearTimeout(recoveringBackendPollTimerId);
  recoveringBackendPollTimerId = null;
}

function clearSuccessTransitionTimers() {
  if (successTransitionTimerId != null) {
    clearTimeout(successTransitionTimerId);
    successTransitionTimerId = null;
  }
  if (recoveringWatchdogTimerId != null) {
    clearTimeout(recoveringWatchdogTimerId);
    recoveringWatchdogTimerId = null;
  }
  if (recoveringDismissFallbackTimerId != null) {
    clearTimeout(recoveringDismissFallbackTimerId);
    recoveringDismissFallbackTimerId = null;
  }
}

function stopModalWatchdog() {
  if (modalWatchdogIntervalId == null) return;
  clearInterval(modalWatchdogIntervalId);
  modalWatchdogIntervalId = null;
}

function startModalWatchdog() {
  if (modalWatchdogIntervalId != null) return;
  modalWatchdogIntervalId = setInterval(() => {
    if (!isRestartLoadingModalVisible()) {
      stopModalWatchdog();
      return;
    }
    if (restartFlowFinished) {
      forceDismissRestartModalIfVisible();
      stopModalWatchdog();
      return;
    }
    if (state?.phase === 'recovering') {
      ensureRecoveringCompletionScheduled();
      const recoveringSince = Number(state.recoveringSince);
      const elapsed = Number.isFinite(recoveringSince) ? Date.now() - recoveringSince : RECOVERING_WATCHDOG_MS;
      if (elapsed >= RECOVERING_TRANSITION_MS) {
        completeRecoveringUi();
      }
      return;
    }
    forceDismissRestartModalIfVisible();
    stopModalWatchdog();
  }, 1000);
}

function isRestartLoadingModalVisible() {
  const modal = document.getElementById('restart-server-loading-modal');
  return !!modal && modal.hidden !== true;
}

function forceDismissRestartModalIfVisible() {
  if (!isRestartLoadingModalVisible()) return;
  dismissRestartModal();
}

function dismissRestartModal() {
  clearPollTimer();
  clearSuccessTransitionTimers();
  clearRecoveringBackendPollTimer();
  stopModalWatchdog();
  bumpPollGeneration();
  state = null;
  stableToken = '';
  stableProbeCount = 0;
  resetRestartFlowFlags();
  storeState();
  const modal = document.getElementById('restart-server-loading-modal');
  if (modal) modal.hidden = true;
}

function closeModal() {
  if (restartFlowFinished) {
    dismissRestartModal();
    return;
  }
  if (isServerRestartActive() && !userCanDismissModal) return;
  dismissRestartModal();
}

function showRecoveryCompleteModal() {
  state = null;
  storeState();
  restartFlowFinished = true;
  setModalContent({
    title: t('serverRestart.restoredTitle'),
    hint: t('serverRestart.restoredHint'),
    loading: false,
    canClose: true,
  });
}

function scheduleAutoDismissSuccessModal() {
  clearSuccessTransitionTimers();
  successTransitionTimerId = setTimeout(() => {
    successTransitionTimerId = null;
    closeModal();
  }, SUCCESS_AUTO_DISMISS_MS);
}

function completeRecoveringUi() {
  if (restartFlowFinished) {
    forceDismissRestartModalIfVisible();
    return;
  }
  clearPollTimer();
  clearSuccessTransitionTimers();
  clearRecoveringBackendPollTimer();
  bumpPollGeneration();
  showRecoveryCompleteModal();
  scheduleAutoDismissSuccessModal();
}

function enableRecoveringDismissFallback() {
  recoveringDismissFallbackTimerId = null;
  if (restartFlowFinished) {
    forceDismissRestartModalIfVisible();
    return;
  }
  if (state?.phase !== 'recovering') return;
  setModalContent({
    title: t('serverRestart.recoveringTitle'),
    hint: t('serverRestart.recoveringDismissHint'),
    loading: false,
    canClose: true,
  });
}

function ensureRecoveringCompletionScheduled() {
  if (state?.phase !== 'recovering' || restartFlowFinished) return;
  if (successTransitionTimerId != null || recoveringWatchdogTimerId != null) return;
  scheduleRecoveringCompletionTimers();
}

function scheduleRecoveringBackendPoll(delayMs = 500) {
  if (state?.phase !== 'recovering' || restartFlowFinished) return;
  clearRecoveringBackendPollTimer();
  recoveringBackendPollTimerId = setTimeout(() => {
    recoveringBackendPollTimerId = null;
    pollRecoveringBackend();
  }, delayMs);
}

function pollRecoveringBackend() {
  if (state?.phase !== 'recovering' || restartFlowFinished) return;
  api.getServerHealth().then((health) => {
    if (state?.phase !== 'recovering' || restartFlowFinished) return;
    if (!health?.ok) {
      scheduleRecoveringBackendPoll(1000);
      return;
    }
    completeRecoveringUi();
  }).catch(() => {
    if (state?.phase !== 'recovering' || restartFlowFinished) return;
    scheduleRecoveringBackendPoll(1000);
  });
}

function scheduleRecoveringCompletionTimers() {
  clearSuccessTransitionTimers();
  successTransitionTimerId = setTimeout(() => {
    successTransitionTimerId = null;
    completeRecoveringUi();
  }, RECOVERING_TRANSITION_MS);
  recoveringWatchdogTimerId = setTimeout(() => {
    recoveringWatchdogTimerId = null;
    completeRecoveringUi();
  }, RECOVERING_WATCHDOG_MS);
  recoveringDismissFallbackTimerId = setTimeout(() => {
    enableRecoveringDismissFallback();
  }, RECOVERING_DISMISSIBLE_MS);
}

function startRecoveringPhase(serverInstanceToken) {
  if (!state || restartFlowFinished) return;
  if (state.phase === 'recovering') {
    ensureRecoveringCompletionScheduled();
    scheduleRecoveringBackendPoll(0);
    startModalWatchdog();
    return;
  }
  bumpPollGeneration();
  clearPollTimer();
  const detail = {
    serverInstanceToken,
    restartRequestId: state.restartRequestId || '',
    source: state.source || 'unknown',
  };
  state = {
    ...state,
    phase: 'recovering',
    recoveringSince: Date.now(),
  };
  suppressDisconnectUiUntil = Date.now() + 10000;
  storeState();
  setModalContent({
    title: t('serverRestart.recoveringTitle'),
    hint: t('serverRestart.recoveringHint'),
    loading: true,
    canClose: false,
  });
  startModalWatchdog();
  scheduleRecoveringCompletionTimers();
  scheduleRecoveringBackendPoll(0);
  try {
    window.dispatchEvent(new CustomEvent(SERVER_RESTART_READY_EVENT, { detail }));
  } catch (err) {
    console.warn('[server-restart] recovery event handler failed', err);
  }
  if (restartFlowFinished) {
    forceDismissRestartModalIfVisible();
    return;
  }
  ensureRecoveringCompletionScheduled();
}

function finishWithError(message) {
  bumpPollGeneration();
  clearPollTimer();
  clearSuccessTransitionTimers();
  state = null;
  stableToken = '';
  stableProbeCount = 0;
  restartFlowFinished = false;
  storeState();
  setModalContent({
    title: t('serverRestart.failedTitle'),
    hint: message || t('serverRestart.failedHint'),
    loading: false,
    canClose: true,
  });
}

function finishSuccessfully(serverInstanceToken) {
  if (!isPollingPhase() || restartFlowFinished) return;
  startRecoveringPhase(serverInstanceToken);
}

function schedulePoll(delayMs = POLL_INTERVAL_MS) {
  if (!isPollingPhase() || restartFlowFinished) return;
  clearPollTimer();
  pollTimerId = setTimeout(() => {
    pollTimerId = null;
    poll();
  }, delayMs);
}

function poll() {
  if (!isPollingPhase() || restartFlowFinished) return;
  if (isServerRestartTimedOut({
    startedAt: state.startedAt,
    timeoutMs: POLL_TIMEOUT_MS,
  })) {
    finishWithError(t('serverRestart.timeout'));
    return;
  }
  const generation = pollGeneration;
  api.getServerHealth().then((health) => {
    if (generation !== pollGeneration || !isPollingPhase() || restartFlowFinished) return;
    const result = evaluateRestartHealth({
      health,
      previousToken: state.previousToken,
      stableToken,
      stableProbeCount,
      requiredStableProbes: STABLE_PROBE_COUNT,
    });
    stableToken = result.stableToken;
    stableProbeCount = result.stableProbeCount;
    if (result.status === 'waiting') {
      schedulePoll();
      return;
    }
    if (result.status === 'stabilizing') {
      schedulePoll(750);
      return;
    }
    finishSuccessfully(result.stableToken);
  }).catch(() => {
    if (generation !== pollGeneration || !isPollingPhase() || restartFlowFinished) return;
    stableToken = '';
    stableProbeCount = 0;
    schedulePoll();
  });
}

/**
 * Called when chat/tasks confirm live connections after a coordinated server restart.
 */
export function notifyServerRestartRecoveryComplete() {
  if (restartFlowFinished) {
    forceDismissRestartModalIfVisible();
    return;
  }
  if (state?.phase !== 'recovering') {
    if (isRestartLoadingModalVisible()) {
      completeRecoveringUi();
    }
    return;
  }
  completeRecoveringUi();
}

/**
 * Best-effort recovery kick when backend responds but restart state was lost (e.g. HMR).
 */
export function kickServerRestartRecoveryIfStuck() {
  if (!isRestartLoadingModalVisible()) return;
  if (restartFlowFinished) {
    forceDismissRestartModalIfVisible();
    return;
  }
  if (state?.phase === 'recovering') {
    completeRecoveringUi();
    return;
  }
  forceDismissRestartModalIfVisible();
}

function bindRecoveringVisibilityHandler() {
  if (visibilityListenerBound || typeof document === 'undefined') return;
  visibilityListenerBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (restartFlowFinished) {
      forceDismissRestartModalIfVisible();
      return;
    }
    if (state?.phase !== 'recovering') return;
    const recoveringSince = Number(state.recoveringSince);
    const elapsed = Number.isFinite(recoveringSince) ? Date.now() - recoveringSince : RECOVERING_TRANSITION_MS;
    if (elapsed < RECOVERING_TRANSITION_MS) return;
    completeRecoveringUi();
  });
}

export function isServerRestartActive() {
  return isServerRestartPhaseActive(state?.phase);
}

export function shouldSuppressServerDisconnectUi() {
  return shouldSuppressDisconnectUi({
    phase: state?.phase,
    suppressUntil: suppressDisconnectUiUntil,
  });
}

export async function restartServer({ source = 'manual' } = {}) {
  initServerRestartCoordinator();
  if (!canStartServerRestart(state?.phase)) {
    showWaitingModal();
    return { ok: false, busy: true, error: t('serverRestart.busy') };
  }
  bumpPollGeneration();
  clearSuccessTransitionTimers();
  resetRestartFlowFlags();
  stableToken = '';
  stableProbeCount = 0;
  state = {
    phase: 'requesting',
    source,
    previousToken: '',
    restartRequestId: '',
    startedAt: Date.now(),
  };
  showWaitingModal();
  let settings;
  try {
    settings = await api.getSettings();
  } catch {
    finishWithError(t('serverRestart.settingsUnavailable'));
    return { ok: false, error: t('serverRestart.settingsUnavailable') };
  }
  if (settings?.canRestartServer === false) {
    finishWithError(t('serverRestart.disabledHint'));
    return { ok: false, error: t('serverRestart.disabledHint') };
  }
  const previousToken = typeof settings?.serverInstanceToken === 'string'
    ? settings.serverInstanceToken.trim()
    : '';
  if (!settings?.ok || !previousToken) {
    finishWithError(t('serverRestart.missingInstanceId'));
    return { ok: false, error: t('serverRestart.missingInstanceId') };
  }
  state.previousToken = previousToken;
  storeState();
  let response;
  try {
    response = await api.postDevAction('restart-server');
  } catch {
    state.phase = 'waiting';
    storeState();
    schedulePoll(500);
    return { ok: true, uncertain: true };
  }
  if (!response?.ok) {
    finishWithError(response?.error || t('serverRestart.rejected'));
    return response || { ok: false };
  }
  state.phase = 'waiting';
  state.previousToken = response.previousServerInstanceToken || previousToken;
  state.restartRequestId = response.restartRequestId || '';
  storeState();
  schedulePoll(500);
  return response;
}

export function initServerRestartCoordinator() {
  if (initialized) return;
  initialized = true;
  bindRecoveringVisibilityHandler();
  const closeBtn = document.getElementById('restart-server-loading-close');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  const modal = document.getElementById('restart-server-loading-modal');
  const backdrop = modal?.querySelector('.chat-settings-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeModal);
  const stored = readStoredState();
  if (!stored) return;
  if (isServerRestartTimedOut({
    startedAt: stored.startedAt,
    timeoutMs: POLL_TIMEOUT_MS,
  })) {
    state = null;
    storeState();
    return;
  }
  if (stored.phase === 'recovering') {
    restartFlowFinished = false;
    state = {
      ...stored,
      phase: 'recovering',
      recoveringSince: Number.isFinite(stored.recoveringSince) ? stored.recoveringSince : Date.now(),
    };
    startModalWatchdog();
    completeRecoveringUi();
    if (isRestartLoadingModalVisible()) {
      ensureRecoveringCompletionScheduled();
      scheduleRecoveringBackendPoll(0);
    }
    return;
  }
  bumpPollGeneration();
  resetRestartFlowFlags();
  state = { ...stored, phase: 'waiting' };
  showWaitingModal();
  schedulePoll(100);
}
