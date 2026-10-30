import { t } from '../../../../i18n/index.js';
import * as api from '../../../../core/api/index.js';
import { delegationStatusLabel } from '../../chatDelegations.js';
import { RECOVERY_ACTION, createLatestRequestGuard, notifyRecoveryWidgets, readRecoveryRunsResponse, recoveryResumeNeedsConfirm, registerRecoveryWidget, resolveRecoveryActionFeedback, resolveRecoveryConfirmUnknown } from '../../recoveryActions.js';
import { confirmRecoveryUnknownResume } from '../../recoveryConfirm.js';
import { syncChildren } from '../../../../lib/childrenSync.js';

/**
 * Recovery banner and recovery run rows.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installRecoveryWidgets(rv) {
  const { chat } = rv;
  rv.appendRecoveryActions = appendRecoveryActions;
  rv.refreshChatRecoveryBanner = refreshChatRecoveryBanner;

  /**
   * Register the recovery refresher for one rendered host and keep the returned
   * unregister function reachable. The delegation card owns the registration
   * when the host lives inside one, so evicting the card releases the listener
   * as well as `destroy()`.
   *
   * Returns the registered refresher itself: a row action runs it once and can
   * hand it back to `notifyRecoveryWidgets` as `skipRefresh`.
   *
   * @param {HTMLElement} hostEl
   * @param {string} chatId
   * @returns {(feedback?: object | null) => Promise<boolean> | void}
   */
  function registerRecoveryHost(hostEl, chatId) {
    const existing = rv.recoveryHostRefreshes.get(hostEl);
    if (existing) return existing;
    let unregister = () => {};
    const cleanup = () => {
      unregister();
      rv.recoveryWidgetCleanups.delete(cleanup);
      rv.recoveryHostRefreshes.delete(hostEl);
    };
    const refresh = (feedback) => {
      // A replay keeps the card off-document for one synchronous pass. Only a
      // host that is still detached on the next task is gone for good.
      if (!hostEl.isConnected) {
        scheduleDetachedRecoveryCleanup(hostEl, cleanup);
        return Promise.resolve(false);
      }
      return renderRecoveryWidget(hostEl, chatId, { feedback });
    };
    unregister = registerRecoveryWidget(chatId, refresh);
    rv.recoveryHostRefreshes.set(hostEl, refresh);
    rv.recoveryWidgetCleanups.add(cleanup);
    const cardRoot = hostEl.closest?.('.sdk-rich-delegation');
    if (cardRoot instanceof HTMLElement) {
      rv.mountedViewResourceLedger.registerLoop(cardRoot, cleanup);
    }
    return refresh;
  }

  /**
   * Re-check a detached host after the current task. The delay lets a replay
   * reinsert a temporarily detached card before its registration is dropped.
   *
   * @param {HTMLElement} hostEl
   * @param {() => void} cleanup
   */
  function scheduleDetachedRecoveryCleanup(hostEl, cleanup) {
    if (rv.recoveryDetachCleanupPending.has(hostEl)) return;
    rv.recoveryDetachCleanupPending.add(hostEl);
    const recheck = () => {
      rv.recoveryDetachCleanupPending.delete(hostEl);
      if (!hostEl.isConnected) cleanup();
    };
    if (typeof setTimeout === 'function') setTimeout(recheck, 0);
    else queueMicrotask(recheck);
  }

  /**
   * Recovery widget for one chat: persisted run status plus the actions the
   * server says are available. It owns its region and feedback node so a
   * refresh never removes the delegation buttons next to it.
   *
   * @param {HTMLElement} hostEl
   * @returns {{ widget: HTMLElement, region: HTMLElement, feedback: HTMLElement }}
   */
  function ensureRecoveryWidget(hostEl) {
    let widget = hostEl.querySelector(':scope > .sdk-rich-recovery');
    if (!(widget instanceof HTMLElement)) {
      widget = document.createElement('div');
      widget.className = 'sdk-rich-recovery';
      hostEl.appendChild(widget);
    }
    let region = widget.querySelector(':scope > .sdk-rich-recovery-list');
    if (!(region instanceof HTMLElement)) {
      region = document.createElement('div');
      region.className = 'sdk-rich-recovery-list';
      widget.appendChild(region);
    }
    let feedback = widget.querySelector(':scope > .sdk-rich-recovery-feedback');
    if (!(feedback instanceof HTMLElement)) {
      feedback = document.createElement('p');
      feedback.className = 'sdk-rich-recovery-feedback';
      feedback.dataset.tone = 'info';
      feedback.setAttribute('role', 'status');
      feedback.hidden = true;
      widget.appendChild(feedback);
    }
    return { widget, region, feedback };
  }

  /**
   * @param {HTMLElement | null} feedbackEl
   * @param {{ tone?: 'success' | 'error' | 'info', key?: string } | null} feedback
   */
  function showRecoveryFeedback(feedbackEl, feedback) {
    if (!(feedbackEl instanceof HTMLElement)) return;
    if (!feedback?.key) {
      feedbackEl.hidden = true;
      feedbackEl.textContent = '';
      return;
    }
    feedbackEl.hidden = false;
    feedbackEl.dataset.tone = feedback.tone || 'info';
    feedbackEl.textContent = t(feedback.key);
  }

  /**
   * @param {string} action
   * @param {string} text
   * @param {(action: string, button: HTMLButtonElement) => Promise<void>} onRun
   * @returns {HTMLButtonElement}
   */
  function createRecoveryButton(action, text, onRun) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sdk-rich-delegation-btn sdk-rich-recovery-btn';
    button.dataset.recoveryAction = action;
    button.textContent = text;
    button.addEventListener('click', () => {
      // The action itself reports errors through the feedback element; never
      // leave an unhandled rejection if a refresh fails afterwards.
      onRun(action, button).catch(() => {});
    });
    return button;
  }

  /**
   * One persisted run row. `refresh` re-reads the server after the action so a
   * reload, a second device and this tab all render the persisted state.
   *
   * @param {object} run
   * @param {string} chatId
   * @param {(feedback?: { tone?: string, key?: string } | null) => Promise<void>} refresh
   * @returns {HTMLElement}
   */
  function createRecoveryRunRow(run, chatId, refresh) {
    const row = document.createElement('div');
    row.className = 'sdk-rich-recovery-row';
    row.dataset.recoveryState = String(run?.state || '');
    const status = document.createElement('span');
    status.className = 'sdk-rich-recovery-status';
    status.textContent = delegationStatusLabel(run?.status);
    row.appendChild(status);

    const runAction = async (action, button) => {
      button.disabled = true;
      let feedback = null;
      try {
        let response;
        if (action === RECOVERY_ACTION.RESUME) {
          // `unknown` liveness is never confirmed automatically: ask the user
          // first. A run in `interrupted` can still need this when the liveness
          // probe answers `unknown`; the server then returns `liveness_unknown`
          // and the same explicit confirmation is required before a retry.
          if (recoveryResumeNeedsConfirm(run)) {
            const confirmed = await confirmRecoveryUnknownResume();
            if (!confirmed) {
              button.disabled = false;
              return;
            }
            response = await api.postRecoveryResume(
              chatId,
              run,
              resolveRecoveryConfirmUnknown(run, true),
            );
          } else {
            response = await api.postRecoveryResume(chatId, run, false);
            if (response?.status === 'liveness_unknown') {
              const confirmed = await confirmRecoveryUnknownResume();
              if (!confirmed) {
                // Declining is not an error: keep the row as it was.
                button.disabled = false;
                return;
              }
              response = await api.postRecoveryResume(chatId, run, true);
            }
          }
        } else {
          response = await api.postRecoveryKeepStopped(chatId, run);
        }
        feedback = resolveRecoveryActionFeedback(action, response);
      } catch {
        feedback = { tone: 'error', key: 'chat.recoveryActionFailed' };
      }
      try {
        // Refresh this surface first (the button stays disabled until the read
        // settles), then tell the other surfaces of the same chat with the same
        // action feedback. The refreshed surface is skipped to avoid a
        // duplicate GET; a host without a registration still falls back to the
        // row's own refresh.
        if (typeof refresh === 'function') await refresh(feedback);
        notifyRecoveryWidgets(chatId, feedback, refresh);
      } finally {
        // A failed read keeps this row rendered: never leave it disabled.
        button.disabled = false;
      }
    };

    if (run?.canResume) {
      row.appendChild(createRecoveryButton(
        RECOVERY_ACTION.RESUME,
        t('chat.delegationResume'),
        runAction,
      ));
    }
    if (run?.canKeepStopped) {
      row.appendChild(createRecoveryButton(
        RECOVERY_ACTION.KEEP_STOPPED,
        t('chat.delegationKeepStopped'),
        runAction,
      ));
    }
    return row;
  }

  /**
   * Read + render the persisted recovery runs of one chat into `hostEl`.
   * Returns false when the request failed or the host left the document.
   *
   * @param {HTMLElement} hostEl
   * @param {string} chatId
   * @param {{ feedback?: { tone?: string, key?: string } | null }} [options]
   * @returns {Promise<boolean>}
   */
  async function renderRecoveryWidget(hostEl, chatId, options = {}) {
    if (!(hostEl instanceof HTMLElement)) return false;
    const guard = rv.recoveryWidgetGuards.get(hostEl) || createLatestRequestGuard();
    rv.recoveryWidgetGuards.set(hostEl, guard);
    const refresh = registerRecoveryHost(hostEl, chatId);
    const ticket = guard.begin();
    let runs = null;
    try {
      runs = readRecoveryRunsResponse(await api.getChatRecoveryRuns(chatId));
    } catch {
      runs = null;
    }
    if (!guard.isCurrent(ticket)) return false;
    // Render even when the card is temporarily detached by a prepend-offscreen
    // replay: the node is inserted with the rendered actions afterwards.
    const { region, feedback } = ensureRecoveryWidget(hostEl);
    if (runs === null) {
      // Keep the last rendered state and still surface the action feedback.
      showRecoveryFeedback(feedback, options.feedback || null);
      return false;
    }
    syncChildren(region, `${chatId}:${JSON.stringify(runs)}`, () => runs.map((run) => createRecoveryRunRow(run, chatId, refresh)));
    showRecoveryFeedback(feedback, options.feedback || null);
    return runs.length > 0;
  }

  /**
   * Resume / Keep stopped for persisted recovery runs of the child chat. State
   * is read from the server, so a reload or another device shows the same.
   *
   * @param {Element | null} actions
   * @param {string} childChatId
   */
  async function appendRecoveryActions(actions, childChatId) {
    if (!(actions instanceof HTMLElement)) return;
    await renderRecoveryWidget(actions, childChatId);
  }

  /**
   * Banner heading is created once and kept across refreshes so feedback can be
   * rendered even when the run list is now empty.
   */
  function ensureRecoveryBannerHeading() {
    if (rv.recoveryBannerEl.querySelector(':scope > .sdk-rich-recovery-banner-title')) return;
    const heading = document.createElement('strong');
    heading.className = 'sdk-rich-recovery-banner-title';
    heading.textContent = t('chat.recoveryHeading');
    rv.recoveryBannerEl.appendChild(heading);
  }

  /**
   * Chat-level recovery surface for ordinary runs (no delegation card exists
   * for them). The banner reflects the persisted server state and stays above
   * the stream, so history replay never wipes it.
   *
   * @param {{ tone?: string, key?: string } | null} [feedback]
   * @returns {Promise<void>}
   */
  async function refreshChatRecoveryBanner(feedback = null) {
    const chatId = String(chat?.id || '');
    if (!chatId) return;
    const ticket = rv.recoveryBannerGuard.begin();
    let runs = null;
    try {
      runs = readRecoveryRunsResponse(await api.getChatRecoveryRuns(chatId));
    } catch {
      runs = null;
    }
    if (!rv.recoveryBannerGuard.isCurrent(ticket)) return;
    if (runs === null) {
      if (!feedback?.key) return;
      rv.recoveryBannerEl.hidden = false;
      ensureRecoveryBannerHeading();
      const { feedback: feedbackEl } = ensureRecoveryWidget(rv.recoveryBannerEl);
      showRecoveryFeedback(feedbackEl, feedback);
      return;
    }
    if (runs.length === 0) {
      // A successful action can remove the last row (e.g. Keep stopped moves
      // the run to canceled). Keep the banner so its confirmation stays
      // visible; only hide it when there is neither state nor feedback.
      if (!feedback?.key) {
        rv.recoveryBannerEl.hidden = true;
        rv.recoveryBannerEl.replaceChildren();
        return;
      }
      rv.recoveryBannerEl.hidden = false;
      ensureRecoveryBannerHeading();
      const { region, feedback: feedbackEl } = ensureRecoveryWidget(rv.recoveryBannerEl);
      syncChildren(region, '', () => []);
      showRecoveryFeedback(feedbackEl, feedback);
      return;
    }
    rv.recoveryBannerEl.hidden = false;
    ensureRecoveryBannerHeading();
    const { region, feedback: feedbackEl } = ensureRecoveryWidget(rv.recoveryBannerEl);
    syncChildren(region, `${chatId}:${JSON.stringify(runs)}`, () => runs.map((run) => createRecoveryRunRow(run, chatId, refreshChatRecoveryBanner)));
    showRecoveryFeedback(feedbackEl, feedback);
  }
}
