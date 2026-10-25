import { writeTextToClipboard } from '../../../../lib/clipboard.js';
import { t } from '../../../../i18n/index.js';
import { escapeHtml } from '../../chatHtmlUtils.js';
import { delegationStatusLabel, parseDelegationHistoryPayload, resolveDelegationStatusKey } from '../../chatDelegations.js';
import { buildDelegationCardModel } from '../../../../../lib/delegation-card-model.js';
import { buildPlanPaceLine } from '../../../../lib/delegation-plan-pace-line.js';
import { isActiveDelegationStatus } from '../../../../../lib/delegation-status.js';
import { shouldLoadDelegationRecovery } from '../../recoveryActions.js';
import { buildHistoryCardReportHostHtml, registerHistoryCardReportFullText, wireHistoryCardReportControls } from '../../../../lib/delegationHistoryCardReport.js';
import { shouldPlaceViewCardBefore } from '../../chatHistoryViewOrder.js';
import { reviewerSessionLabel } from '../services/sdkEventNormalize.js';
import { decorateCodeForCopy, renderMarkdownSource } from '../services/markdownEngine.js';

/**
 * Delegation history cards and the accept action.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installDelegationCards(rv) {
  const { hooks } = rv;
  rv.frameHistoryCard = frameHistoryCard;
  rv.moveHistoryCardToAnchor = moveHistoryCardToAnchor;
  rv.renderHistoryCardProse = renderHistoryCardProse;
  rv.decorateHistoryCardReports = decorateHistoryCardReports;
  rv.renderDelegationCard = renderDelegationCard;

  /**
   * Aggregate wait label above existing delegation cards (not a second card system).
   */
  function refreshDelegationWaitBanner() {
    const cards = [...rv.stream.querySelectorAll('.sdk-rich-delegation[data-delegation-id]')];
    const waitingCount = cards.filter((card) => isActiveDelegationStatus(card.dataset.delegationStatus)).length;
    let banner = rv.stream.querySelector('.sdk-rich-delegation-wait');
    if (waitingCount < 1) {
      banner?.remove();
      return;
    }
    const first = cards[0];
    if (!(banner instanceof HTMLElement)) {
      banner = document.createElement('div');
      banner.className = 'sdk-rich-line sdk-rich-delegation-wait';
    }
    banner.textContent = t('chat.delegationWaitingForAgents', { n: String(waitingCount) });
    if (first instanceof HTMLElement && banner.nextElementSibling !== first) {
      first.parentNode?.insertBefore(banner, first);
    }
  }

  /**
   * History cards (delegation / mailbox) are not one-line status chips.
   *
   * @param {HTMLElement} card
   * @param {string} extraClass
   */
  function frameHistoryCard(card, extraClass) {
    card.classList.remove(
      'sdk-rich-line--ok',
      'sdk-rich-line--warn',
      'sdk-rich-line--err',
      'sdk-rich-line--muted',
      'sdk-rich-line--status',
      'sdk-rich-line--task',
      'sdk-rich-line--notice'
    );
    card.classList.add(extraClass);
  }

  /**
   * A status update can be the first record of a card inside a tail-windowed
   * history. Move such a card to where its first event sits (`anchorSeq`) so
   * replies do not pile up at the end of the chat.
   *
   * @param {HTMLElement} card
   * @param {unknown} anchorSeqRaw
   */
  function moveHistoryCardToAnchor(card, anchorSeqRaw) {
    const anchorSeq = Number(anchorSeqRaw) || 0;
    const ownSeq = Number(rv.renderedRecordHistorySeq) || 0;
    if (rv.stream !== rv.realStream || anchorSeq <= 0 || ownSeq <= 0 || anchorSeq >= ownSeq) return;
    const incomingKey = { historySeq: anchorSeq, roomEventSeq: 0, eventStreamId: '' };
    let before = null;
    for (const child of rv.stream.children) {
      if (!(child instanceof HTMLElement) || child === card) continue;
      if (shouldPlaceViewCardBefore(incomingKey, rv.readElementOrderKey(child))) {
        before = child;
        break;
      }
    }
    if (before) rv.stream.insertBefore(card, before);
    card.dataset.historySeq = String(anchorSeq);
    if ('historySeq' in card) /** @type {any} */ (card).historySeq = anchorSeq;
  }

  /**
   * @param {string} text
   * @returns {string}
   */
  const historyCardReportDeps = {
    escapeHtml,
    t,
    renderMarkdown: renderMarkdownSource,
  };
  rv.historyCardReportDeps = historyCardReportDeps;

  /**
   * @param {string} text
   * @returns {string}
   */
  function renderHistoryCardProse(text) {
    return buildHistoryCardReportHostHtml(text, historyCardReportDeps);
  }

  /**
   * @param {HTMLElement} content
   */
  function decorateHistoryCardReports(content) {
    content.querySelectorAll('.sdk-rich-delegation-report').forEach((el) => {
      if (el instanceof HTMLElement) decorateCodeForCopy(el);
    });
    wireHistoryCardReportControls(content, {
      t,
      renderMarkdown: renderMarkdownSource,
      writeTextToClipboard,
      decorateCodeForCopy,
    });
  }

  /**
   * @param {unknown} payload
   * @param {string} createdAt
   */
  function renderDelegationCard(payload, createdAt) {
    const data = parseDelegationHistoryPayload(payload);
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) return;
    const safeId = id.replace(/"/g, '');
    const status = String(data.status || '');
    const childChatId = String(data.childChatId || '');
    const executor = data.executor && typeof data.executor === 'object' ? data.executor : {};
    const executorLabel = [executor.transport, executor.model].filter(Boolean).join(' · ');
    const report = String(data.report || '').trim();
    const error = String(data.error || '').trim();
    let card = rv.stream.querySelector(`[data-delegation-id="${safeId}"]`);
    const historySeq = Number(rv.renderedRecordHistorySeq) || 0;
    const previousHistorySeq = Number(card?.dataset.delegationHistorySeq) || 0;
    // A buffered live start may arrive after HTTP restored the finished card.
    if (previousHistorySeq > 0 && historySeq <= previousHistorySeq) {
      if (card instanceof HTMLElement && childChatId) {
        card.dataset.childChatId = rv.relatedChatDomId(childChatId);
      }
      return;
    }
    if (!(card instanceof HTMLElement)) {
      rv.lineMeta('sdk-rich-delegation', '', createdAt);
      card = rv.lastStreamChild;
      if (card instanceof HTMLElement) {
        card.dataset.delegationId = safeId;
        moveHistoryCardToAnchor(card, data.anchorSeq);
      }
    }
    if (!(card instanceof HTMLElement)) return;
    frameHistoryCard(card, 'sdk-rich-delegation');
    card.dataset.delegationStatus = status;
    if (childChatId) card.dataset.childChatId = rv.relatedChatDomId(childChatId);
    if (historySeq > 0) card.dataset.delegationHistorySeq = String(historySeq);
    const content = card.querySelector('.sdk-rich-line__content');
    if (!(content instanceof HTMLElement)) return;
    const model = buildDelegationCardModel(data);
    const acceptedBadge = model.isAccepted
      ? `<span class="sdk-rich-badge sdk-rich-badge--ok">${escapeHtml(t('chat.delegationAcceptedManual'))}</span>`
      : '';
    const unverified = model.showUnverified
      ? `<span class="sdk-rich-badge sdk-rich-badge--warn">${escapeHtml(t('chat.delegationUnverified'))}</span>`
      : '';
    const uncertain = model.showUncertain
      ? `<span class="sdk-rich-badge sdk-rich-badge--warn">${escapeHtml(t('chat.delegationUncertain'))}</span>`
      : '';
    const waiting = status === 'waiting_for_input'
      ? `<p class="sdk-rich-delegation-waiting">${escapeHtml(t('chat.delegationNeedsInput'))}</p>`
      : '';
    // Show durable interruption reasons without opening the error text.
    const interruptCode = status === 'interrupted' ? String(model.interruptCode || '').trim() : '';
    const interruptKey = interruptCode ? `chat.delegationInterrupt.${interruptCode}` : '';
    const interruptText = interruptKey ? t(interruptKey) : '';
    const interruptLabel = interruptCode
      ? `<div class="sdk-rich-delegation-meta sdk-rich-delegation-interrupt">${escapeHtml(interruptText === interruptKey ? interruptCode : interruptText)}</div>`
      : '';
    const errorProse = status === 'waiting_for_input' || error === report ? '' : renderHistoryCardProse(error);
    const detailsOpen = content.querySelector('.sdk-rich-delegation-details')?.open === true;
    card.dataset.reportContentKey = report ? registerHistoryCardReportFullText(report) : '';
    card.dataset.errorContentKey = error && status !== 'waiting_for_input'
      ? registerHistoryCardReportFullText(error) : '';
    const durationSec = Math.round(model.durationMs / 1000);
    const duration = durationSec > 0
      ? `<div class="sdk-rich-delegation-meta">${escapeHtml(t('chat.delegationDuration', { seconds: String(durationSec) }))}</div>`
      : '';
    const sourceLabel = model.sourceKind
      ? `<div class="sdk-rich-delegation-meta">${escapeHtml(t('chat.delegationSource'))}: ${escapeHtml(model.sourceKind)}</div>`
      : '';
    const attemptLabel = `<div class="sdk-rich-delegation-meta">${escapeHtml(t('chat.delegationAttempt', { n: String(model.attemptNumber) }))}</div>`;
    const deliveryLabel = `<div class="sdk-rich-delegation-meta">${escapeHtml(t('chat.delegationDelivery', { state: t(`chat.delegationDeliveryState.${model.deliveryState}`) }))}</div>`;
    const attemptsLabel = model.attemptHistory.length > 1
      ? `<div class="sdk-rich-delegation-meta">${escapeHtml(t('chat.delegationAttemptsStored', { n: String(model.attemptHistory.length) }))}</div>`
      : '';
    const pickReasonLabel = model.pickReason
      ? `<div class="sdk-rich-delegation-meta sdk-rich-delegation-pick-reason" title="${escapeHtml(model.pickReason)}">${escapeHtml(t('chat.delegationPickReason'))}: ${escapeHtml(model.pickReason)}</div>`
      : '';
    const sel = model.selection;
    const selectionParts = sel ? [
      `${t('chat.delegationSelectionSource')}: ${t(`chat.delegationSelectionOrigin.${sel.detail === 'continuation' ? 'continuation' : sel.detail === 'fallback' ? 'fallback' : sel.origin === 'auto' ? 'auto' : sel.origin === 'manual' ? 'manual' : 'unknown'}`)}`,
      `${t('chat.delegationSelectionContext')}: ${t(`chat.delegationSelectionStartContext.${sel.startContext}`)}`,
      sel.continuationOf ? `${t('chat.delegationSelectionContinuation')}: ${sel.continuationOf.slice(0, 8)}` : '',
      sel.pickFallbackFrom ? `${t('chat.delegationSelectionFallbackFrom')}: ${sel.pickFallbackFrom.slice(0, 8)}` : '',
      sel.fallbackFailureClass ? `${t('chat.delegationSelectionFallbackClass')}: ${sel.fallbackFailureClass}` : '',
      sel.exclusion ? `${t('chat.delegationSelectionExclusion')}: ${sel.exclusion.failureClass} / ${sel.exclusion.scope}${sel.exclusion.expiresAt ? ` (${t('chat.delegationSelectionUntil')} ${sel.exclusion.expiresAt})` : ''}` : '',
    ].filter(Boolean) : [];
    const selectionLabel = selectionParts.length
      ? `<div class="sdk-rich-delegation-meta sdk-rich-delegation-selection" title="${escapeHtml(selectionParts.join(' · '))}">${selectionParts.map((part) => escapeHtml(part)).join('<br>')}</div>`
      : '';
    const planHeadroomText = model.planHeadroom
      ? model.planHeadroom.windows.map((w) => `${w.type} ${w.utilization}%`).join(', ')
      : '';
    const planHeadroomLabel = planHeadroomText
      ? `<div class="sdk-rich-delegation-meta sdk-rich-delegation-plan-headroom" title="${escapeHtml(planHeadroomText)}">${escapeHtml(t('chat.delegationPlanHeadroom'))}: ${escapeHtml(t(`chat.delegationPlanHeadroomLevel.${model.planHeadroom.level}`))} (${escapeHtml(planHeadroomText)})</div>`
      : '';
    // Weekly pace: level, cost factor, measurement time, measured/estimated
    // basis, slack and the neutrality reason of an ineligible window. The body
    // stays compact; the tooltip carries the per-window measurement detail.
    const planPaceLine = model.planPace ? buildPlanPaceLine(model.planPace, t) : { summary: '', detail: '' };
    const planPaceLabel = planPaceLine.summary
      ? `<div class="sdk-rich-delegation-meta sdk-rich-delegation-plan-pace" title="${escapeHtml(planPaceLine.detail)}">${escapeHtml(planPaceLine.summary)}</div>`
      : '';
    // Reviewer session decision: same chat + new round, or why a new chat opened.
    const sessionReasonCode = model.sessionResume?.reasonCode || model.reviewerPolicy?.reuse?.reasonCode || '';
    const sessionReason = reviewerSessionLabel('chat.delegationSessionReasons', sessionReasonCode)
      || model.sessionResume?.reason || model.reviewerPolicy?.reuse?.reason || '';
    const sessionStatus = model.sessionResume?.status || model.reviewerPolicy?.reuse?.status || '';
    const sessionResumeText = sessionStatus === 'resumed'
      ? t(sessionReasonCode === 'resumed_cross_role' ? 'chat.delegationSessionResumedCrossRole' : 'chat.delegationSessionResumed', { n: String(model.sessionResume?.round || 2) })
      : sessionStatus === 'fresh'
        ? t('chat.delegationSessionFresh', { reason: sessionReason })
        : sessionStatus ? t('chat.delegationSessionFallback', { code: model.sessionResume?.reasonCode || model.reviewerPolicy?.reuse?.reasonCode || '' }) : '';
    const sessionResumeLabel = sessionResumeText
      ? `<div class="sdk-rich-delegation-meta sdk-rich-delegation-session-resume" title="${escapeHtml(sessionReason)}">${escapeHtml(sessionResumeText)}${sessionStatus === 'fallback' && sessionReason ? `<br>${escapeHtml(sessionReason)}` : ''}</div>`
      : '';
    const reviewerPolicyLabel = model.reviewerPolicy
      ? `<div class="sdk-rich-delegation-meta sdk-rich-delegation-reviewer-policy">${escapeHtml(t('chat.delegationReviewerPolicy', {
        session: reviewerSessionLabel('chat.delegationReviewerSessions', model.reviewerPolicy.session) || '-',
        membership: reviewerSessionLabel('chat.delegationReviewerMembership', model.reviewerPolicy.membership) || '-',
      }))}</div>`
      : '';
    const childGrantLabel = model.allowChildDelegations
      ? `<div class="sdk-rich-delegation-meta sdk-rich-delegation-child-grant">${escapeHtml(t('chat.delegationChildGrant'))}</div>`
      : '';
    content.innerHTML = [
      `<strong class="sdk-rich-delegation-title">${escapeHtml(t('chat.delegationCardTitle'))}</strong>`,
      `<div class="sdk-rich-delegation-meta">${escapeHtml(delegationStatusLabel(resolveDelegationStatusKey(data)))} ${unverified} ${uncertain} ${acceptedBadge}</div>`,
      executorLabel ? `<div class="sdk-rich-delegation-meta">${escapeHtml(executorLabel)}${durationSec > 0 ? ` · ${escapeHtml(t('chat.delegationDuration', { seconds: String(durationSec) }))}` : ''}</div>` : duration,
      sessionResumeLabel,
      childGrantLabel,
      `<details class="sdk-rich-delegation-details"${detailsOpen ? ' open' : ''}>`,
      `<summary>${escapeHtml(t('chat.delegationDetails'))}</summary>`,
      attemptLabel,
      deliveryLabel,
      attemptsLabel,
      pickReasonLabel,
      selectionLabel,
      planHeadroomLabel,
      planPaceLabel,
      reviewerPolicyLabel,
      sourceLabel,
      '</details>',
      waiting,
      interruptLabel,
      errorProse,
      renderHistoryCardProse(report),
      `<div class="sdk-rich-delegation-actions"></div>`,
    ].filter(Boolean).join('');
    decorateHistoryCardReports(content);
    refreshDelegationWaitBanner();
    const actions = content.querySelector('.sdk-rich-delegation-actions');
    if (actions instanceof HTMLElement) {
      if (childChatId) {
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'sdk-rich-delegation-btn';
        openBtn.textContent = t('chat.delegationOpenChild');
        openBtn.addEventListener('click', () => {
          hooks.onOpenDelegationChat?.(childChatId);
        });
        actions.appendChild(openBtn);
      }
      if (model.canCancel) {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'sdk-rich-delegation-btn';
        cancelBtn.textContent = t('chat.delegationCancel');
        cancelBtn.addEventListener('click', () => {
          hooks.onCancelDelegation?.(id);
        });
        actions.appendChild(cancelBtn);
      }
      if (model.canAck) {
        const ackBtn = document.createElement('button');
        ackBtn.type = 'button';
        ackBtn.className = 'sdk-rich-delegation-btn';
        ackBtn.textContent = t('chat.delegationAcknowledge');
        ackBtn.addEventListener('click', () => {
          hooks.onAcknowledgeDelegation?.(id);
        });
        actions.appendChild(ackBtn);
      }
      if (model.canAccept) {
        renderDelegationAcceptAction(card, actions, id, model);
      }
      if (model.canRetry) {
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'sdk-rich-delegation-btn';
        retryBtn.textContent = t('chat.delegationRetry');
        retryBtn.addEventListener('click', () => {
          hooks.onRetryDelegation?.(id);
        });
        actions.appendChild(retryBtn);
      }
    }
    if (childChatId && shouldLoadDelegationRecovery(status)) {
      void rv.appendRecoveryActions(actions, childChatId);
    }
    rv.renderDelegationRating(card, content, id, model);
    rv.refreshDuplicateMailboxReports();
    rv.scrollToBottom();
  }

  /**
   * Human "Accept" action of a review card (`docs/todo-review-contract.md` §7).
   *
   * The accept is bound to what the card displays. The attempt id comes from the
   * rendered card payload; the material and todo revision are captured ONCE when
   * the card appears (the "pinned" context), shown next to the button and sent
   * back unchanged on click — a later value is never substituted. The server
   * rejects a changed attempt/material/todo revision with 409 and the card
   * explains it. The button stays disabled until the context is pinned; a failed
   * load is reported and retried on click.
   *
   * @param {HTMLElement} card
   * @param {HTMLElement} actions
   * @param {string} delegationId
   * @param {{ attemptId: string }} model
   */
  function renderDelegationAcceptAction(card, actions, delegationId, model) {
    const attemptId = String(model.attemptId || '');
    const key = `${delegationId}:${attemptId}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sdk-rich-delegation-btn sdk-rich-delegation-accept';
    btn.textContent = t('chat.delegationAccept');
    const contextEl = document.createElement('p');
    contextEl.className = 'sdk-rich-delegation-accept-context';
    contextEl.hidden = true;
    const feedback = document.createElement('p');
    feedback.className = 'sdk-rich-delegation-accept-feedback';
    feedback.setAttribute('role', 'status');
    feedback.hidden = true;
    const showFeedback = (text, isError) => {
      feedback.textContent = text;
      feedback.hidden = !text;
      feedback.dataset.tone = isError ? 'error' : 'success';
    };
    const short = (value) => {
      const text = String(value || '').trim();
      if (!text) return '—';
      return text.length > 12 ? text.slice(0, 12) : text;
    };
    const readPinned = () => {
      if (card.dataset.acceptContextKey !== key) return null;
      return {
        attemptId,
        materialRevision: String(card.dataset.acceptMaterialRevision ?? ''),
        todoRevision: String(card.dataset.acceptTodoRevision ?? ''),
      };
    };
    const showContext = (pinned) => {
      contextEl.textContent = t('chat.delegationAcceptContext', {
        attempt: short(pinned.attemptId),
        material: short(pinned.materialRevision),
        todo: short(pinned.todoRevision),
      });
      contextEl.hidden = false;
    };
    const loadContext = () => {
      if (typeof hooks.onLoadDelegationAcceptContext !== 'function') {
        showFeedback(t('chat.delegationAcceptContextMissing'), true);
        return Promise.resolve(false);
      }
      return Promise.resolve(hooks.onLoadDelegationAcceptContext(delegationId)).then((ctx) => {
        if (!ctx?.ok) {
          showFeedback(t('chat.delegationAcceptContextFailed'), true);
          return false;
        }
        if (String(ctx.attemptId || '') !== attemptId) {
          // The job moved to a newer attempt after this card was written.
          showFeedback(t('chat.delegationAcceptStaleAttempt'), true);
          return false;
        }
        // An attributed job whose todo is missing/ambiguous/unreadable cannot
        // be accepted; never pin an empty revision for it.
        const todoResolution = String(ctx.todoResolution ?? '');
        if (todoResolution && todoResolution !== 'exact' && todoResolution !== 'prefix'
          && todoResolution !== 'unattributed') {
          showFeedback(t('chat.delegationAcceptStaleTodo'), true);
          return false;
        }
        // Pin once; a second load (retry) never overwrites a pinned value.
        if (card.dataset.acceptContextKey !== key) {
          card.dataset.acceptContextKey = key;
          card.dataset.acceptMaterialRevision = String(ctx.materialRevision ?? '');
          card.dataset.acceptTodoRevision = String(ctx.todoRevision ?? '');
        }
        showFeedback('', false);
        showContext(readPinned());
        btn.disabled = false;
        return true;
      }).catch(() => {
        showFeedback(t('chat.delegationAcceptContextFailed'), true);
        return false;
      });
    };
    const initial = readPinned();
    btn.disabled = !initial;
    if (initial) showContext(initial);
    else void loadContext();
    btn.addEventListener('click', () => {
      const pinned = readPinned();
      if (!pinned) {
        // Context never loaded: retry visibly instead of staying silent.
        showFeedback(t('chat.delegationAcceptContextMissing'), true);
        void loadContext();
        return;
      }
      if (btn.disabled) return;
      if (typeof window !== 'undefined' && typeof window.confirm === 'function'
        && !window.confirm(t('chat.delegationAcceptConfirm'))) {
        return;
      }
      btn.disabled = true;
      showFeedback('', false);
      void Promise.resolve(hooks.onAcceptDelegation?.(delegationId, pinned)).then((res) => {
        if (res?.ok) {
          showFeedback(t('chat.delegationAcceptDone'), false);
          return;
        }
        btn.disabled = false;
        showFeedback(t(res?.errorKey || 'chat.delegationAcceptFailed'), true);
      }).catch(() => {
        btn.disabled = false;
        showFeedback(t('chat.delegationAcceptFailed'), true);
      });
    });
    actions.appendChild(btn);
    actions.appendChild(contextEl);
    actions.appendChild(feedback);
  }
}
