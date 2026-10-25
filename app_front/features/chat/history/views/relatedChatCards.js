import { t } from '../../../../i18n/index.js';
import { escapeHtml } from '../../chatHtmlUtils.js';
import { parseDelegationHistoryPayload } from '../../chatDelegations.js';
import { parseRelatedChatPayload } from '../../../../../lib/chat-relation-payload.js';
import { registerHistoryCardReportFullText } from '../../../../lib/delegationHistoryCardReport.js';
import { planRelatedChatChildBackfill } from '../../relatedChatBackfill.js';

/**
 * Delegation rating, mailbox cards, related chat links and the context advisory.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installRelatedChatCards(rv) {
  const { hooks } = rv;
  rv.renderDelegationRating = renderDelegationRating;
  rv.refreshDuplicateMailboxReports = refreshDuplicateMailboxReports;
  rv.renderMailboxCard = renderMailboxCard;
  rv.relatedChatDomId = relatedChatDomId;
  rv.renderRelatedChatCard = renderRelatedChatCard;
  rv.ensureRelatedChatLinks = ensureRelatedChatLinks;
  rv.updateContextAdvisory = updateContextAdvisory;

  /**
   * @param {string | undefined} raw
   * @returns {any}
   */
  function parseCardJson(raw) {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Star rating block on a delegation card: read-only once the persisted user
   * rating exists, otherwise stars + allow-listed tags + an optional note.
   *
   * The card keeps draft/busy/error state on the element (not in a closure) so
   * a history re-render neither loses the selection nor duplicates controls.
   * Every visible string is set through `textContent`, so an untrusted note or
   * tag can never inject markup.
   *
   * @param {HTMLElement} card
   * @param {HTMLElement} content
   * @param {string} delegationId
   * @param {ReturnType<typeof buildDelegationCardModel>} model
   */
  function renderDelegationRating(card, content, delegationId, model) {
    const previous = content.querySelector('.sdk-rich-delegation-rate');
    if (previous instanceof HTMLElement) previous.remove();
    if (!model.userRating && !parseCardJson(card.dataset.userRating)) return;
    const wrap = document.createElement('div');
    wrap.className = 'sdk-rich-delegation-rate';
    content.appendChild(wrap);

    const rated = model.userRating || parseCardJson(card.dataset.userRating);
    if (rated) {
      const line = document.createElement('div');
      line.className = 'sdk-rich-delegation-rate-rated';
      const stars = document.createElement('span');
      stars.className = 'sdk-rich-delegation-rate-stars';
      stars.textContent = '★'.repeat(Math.max(1, Math.min(5, Number(rated.score) || 1)));
      line.appendChild(stars);
      line.appendChild(document.createTextNode(
        ` ${t('chat.delegationRatedLabel', { score: String(Number(rated.score) || '') })}`,
      ));
      wrap.appendChild(line);
      const tags = Array.isArray(rated.tags) ? rated.tags : [];
      if (tags.length > 0) {
        const tagLine = document.createElement('div');
        tagLine.className = 'sdk-rich-delegation-rate-tags';
        for (const tag of tags) {
          const chip = document.createElement('span');
          chip.className = 'sdk-rich-delegation-rate-tag';
          chip.textContent = t(`chat.delegationRateTags.${tag}`);
          tagLine.appendChild(chip);
        }
        wrap.appendChild(tagLine);
      }
      const note = String(rated.note || '').trim();
      if (note) {
        const noteEl = document.createElement('div');
        noteEl.className = 'sdk-rich-delegation-rate-note';
        noteEl.textContent = note;
        wrap.appendChild(noteEl);
      }
      return;
    }
  }

  /** Collapse repeated replies while keeping delivery status and retry controls visible. */
  function refreshDuplicateMailboxReports() {
    const delegations = new Map(Array.from(rv.stream.querySelectorAll('[data-delegation-id]'))
      .map((card) => [card.dataset.delegationId, card]));
    for (const card of rv.stream.querySelectorAll('[data-mailbox-id]')) {
      const details = card.querySelector('.sdk-rich-mailbox-details');
      if (!(details instanceof HTMLDetailsElement)) continue;
      const delegation = delegations.get(card.dataset.mailboxDelegationId);
      const key = card.dataset.mailboxContentKey;
      const duplicate = card.dataset.mailboxKind === 'reply' && !!key && !!delegation
        && (key === delegation.dataset.reportContentKey || key === delegation.dataset.errorContentKey);
      if (card.dataset.duplicateReport !== String(duplicate)) details.open = !duplicate;
      card.dataset.duplicateReport = String(duplicate);
      details.querySelector('summary').hidden = !duplicate;
    }
  }

  /**
   * @param {unknown} payload
   * @param {string} createdAt
   */
  function renderMailboxCard(payload, createdAt) {
    const data = parseDelegationHistoryPayload(payload);
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) return;
    const safeId = id.replace(/"/g, '');
    const kind = String(data.kind || 'reply');
    const status = String(data.status || '');
    const fromChatId = String(data.fromChatId || '');
    const fromTitle = String(data.fromTitle || '').trim() || fromChatId.slice(0, 8);
    const body = String(data.body || '').trim();
    const queued = status === 'queued' || status === 'dispatching'
      ? `<span class="sdk-rich-badge sdk-rich-badge--warn">${escapeHtml(t('chat.mailboxQueued'))}</span>`
      : status === 'delivered'
        ? `<span class="sdk-rich-badge">${escapeHtml(t('chat.mailboxDelivered'))}</span>`
        : status === 'failed'
          ? `<span class="sdk-rich-badge sdk-rich-badge--warn">${escapeHtml(t('chat.mailboxFailed'))}</span>`
          : status === 'uncertain'
            ? `<span class="sdk-rich-badge sdk-rich-badge--warn">${escapeHtml(t('chat.mailboxUncertain'))}</span>`
            : '';
    let card = rv.stream.querySelector(`[data-mailbox-id="${safeId}"]`);
    const historySeq = Number(rv.renderedRecordHistorySeq) || 0;
    const previousHistorySeq = Number(card?.dataset.mailboxHistorySeq) || 0;
    if (previousHistorySeq > 0 && historySeq > 0 && historySeq <= previousHistorySeq) return;
    if (!(card instanceof HTMLElement)) {
      rv.lineMeta('sdk-rich-mailbox', '', createdAt);
      card = rv.lastStreamChild;
      if (card instanceof HTMLElement) {
        card.dataset.mailboxId = safeId;
        rv.moveHistoryCardToAnchor(card, data.anchorSeq);
      }
    }
    if (!(card instanceof HTMLElement)) return;
    rv.frameHistoryCard(card, 'sdk-rich-mailbox');
    card.dataset.mailboxStatus = status;
    card.dataset.mailboxDelegationId = String(data.delegationId || '');
    card.dataset.mailboxKind = kind;
    card.dataset.mailboxContentKey = body ? registerHistoryCardReportFullText(body) : '';
    if (historySeq > 0) card.dataset.mailboxHistorySeq = String(historySeq);
    const content = card.querySelector('.sdk-rich-line__content');
    if (!(content instanceof HTMLElement)) return;
    const replyOpen = card.dataset.duplicateReport !== 'true'
      || content.querySelector('.sdk-rich-mailbox-details')?.open === true;
    const title = kind === 'task'
      ? t('chat.mailboxTaskFromParent')
      : t('chat.mailboxReplyFromChild');
    content.innerHTML = [
      `<strong class="sdk-rich-delegation-title">${escapeHtml(title)}</strong> ${queued}`,
      `<details class="sdk-rich-mailbox-details"${replyOpen ? ' open' : ''}>`,
      `<summary>${escapeHtml(t('chat.mailboxRepeatedReply'))}</summary>`,
      fromChatId ? `<div class="sdk-rich-delegation-meta">${escapeHtml(t('chat.mailboxFromChat'))}: ${escapeHtml(fromTitle)}</div>` : '',
      rv.renderHistoryCardProse(body),
      `<div class="sdk-rich-delegation-actions"></div>`,
      '</details>',
      '<div class="sdk-rich-mailbox-delivery-actions sdk-rich-delegation-actions"></div>',
    ].filter(Boolean).join('');
    rv.decorateHistoryCardReports(content);
    const actions = content.querySelector('.sdk-rich-delegation-actions');
    if (actions instanceof HTMLElement && fromChatId) {
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'sdk-rich-delegation-btn';
      openBtn.textContent = kind === 'task' ? t('chat.delegationOpenParent') : t('chat.delegationOpenChild');
      openBtn.addEventListener('click', () => {
        hooks.onOpenDelegationChat?.(fromChatId);
      });
      actions.appendChild(openBtn);
    }
    const deliveryActions = content.querySelector('.sdk-rich-mailbox-delivery-actions');
    if (deliveryActions instanceof HTMLElement && (status === 'failed' || status === 'uncertain')) {
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'sdk-rich-delegation-btn';
      retryBtn.textContent = t('chat.mailboxRetry');
      retryBtn.addEventListener('click', () => {
        hooks.onRetryMailbox?.(id);
      });
      deliveryActions.appendChild(retryBtn);
    }
    refreshDuplicateMailboxReports();
    rv.scrollToBottom();
  }

  /**
   * @param {string} chatId
   * @returns {string}
   */
  function relatedChatDomId(chatId) {
    return String(chatId || '').replace(/"/g, '');
  }

  /**
   * @param {unknown} payload
   * @param {string} createdAt
   * @param {{ prepend?: boolean, insertBefore?: Element | null }} [opts]
   */
  function renderRelatedChatCard(payload, createdAt, opts = {}) {
    const data = parseRelatedChatPayload(payload);
    const chatId = data?.chatId || '';
    if (!chatId) return;
    const safeId = relatedChatDomId(chatId);
    const visible = typeof hooks.isRelatedChatVisible !== 'function' || hooks.isRelatedChatVisible(chatId);
    let card = rv.stream.querySelector(`[data-related-chat-id="${safeId}"]`);
    if (!visible) {
      if (card instanceof HTMLElement) card.remove();
      return;
    }
    if (!(card instanceof HTMLElement)) {
      rv.lineMeta('sdk-rich-line--notice sdk-rich-related-chat', '', createdAt);
      card = rv.lastStreamChild;
      if (card instanceof HTMLElement) card.dataset.relatedChatId = safeId;
      const anchor = opts.insertBefore;
      if (card instanceof HTMLElement && anchor instanceof HTMLElement && anchor.parentNode === rv.stream) {
        rv.stream.insertBefore(card, anchor);
      } else if (opts.prepend === true && card instanceof HTMLElement && rv.stream.firstChild !== card) {
        rv.stream.insertBefore(card, rv.stream.firstChild);
      }
    }
    if (!(card instanceof HTMLElement)) return;
    const content = card.querySelector('.sdk-rich-line__content');
    if (!(content instanceof HTMLElement)) return;
    const title = data.title || chatId.slice(0, 8);
    const label = data.role === 'parent'
      ? t('chat.relatedChatParent', { title })
      : t('chat.relatedChatChild', { title });
    content.replaceChildren();
    const textEl = document.createElement('strong');
    textEl.textContent = label;
    const actions = document.createElement('div');
    actions.className = 'sdk-rich-delegation-actions';
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'sdk-rich-delegation-btn';
    openBtn.textContent = t('chat.relatedChatOpen');
    openBtn.addEventListener('click', () => {
      hooks.onOpenDelegationChat?.(chatId);
    });
    actions.appendChild(openBtn);
    content.append(textEl, actions);
    rv.scrollToBottom();
  }

  /**
   * Find the delegation card that created a child chat, if it is mounted.
   *
   * @param {string} childChatId
   * @returns {HTMLElement | null}
   */
  function findDelegationCardByChildChatId(childChatId) {
    const safeId = relatedChatDomId(childChatId);
    if (!safeId) return null;
    const card = rv.stream.querySelector(`[data-child-chat-id="${safeId}"]`);
    return card instanceof HTMLElement ? card : null;
  }

  /**
   * Backfill missing parent/child links from chat metadata for older chats.
   *
   * Parent links stay a top navigation affordance. Child links are only placed
   * next to the delegation card that created them: history already paints each
   * link inline, and appending the rest at the tail dumped older children at the
   * bottom of the stream after every resume.
   *
   * @param {{
   *   parent?: { chatId: string, title?: string, reason?: string } | null,
   *   children?: Array<{ chatId: string, title?: string, reason?: string }>,
   * }} input
   */
  function ensureRelatedChatLinks(input = {}) {
    if (typeof hooks.isRelatedChatVisible === 'function') {
      rv.stream.querySelectorAll('[data-related-chat-id]').forEach((el) => {
        const id = el instanceof HTMLElement ? el.dataset.relatedChatId : '';
        if (id && !hooks.isRelatedChatVisible(id)) el.remove();
      });
    }
    const parent = input.parent;
    if (parent?.chatId) {
      const existing = rv.stream.querySelector(`[data-related-chat-id="${relatedChatDomId(parent.chatId)}"]`);
      if (!(existing instanceof HTMLElement)) {
        renderRelatedChatCard({
          role: 'parent',
          chatId: parent.chatId,
          title: parent.title || '',
          reason: parent.reason || '',
        }, '', { prepend: true });
      }
    }
    const backfill = planRelatedChatChildBackfill({
      children: input.children,
      hasRelatedCard: (chatId) => (
        rv.stream.querySelector(`[data-related-chat-id="${relatedChatDomId(chatId)}"]`) instanceof HTMLElement
      ),
      findAnchor: (chatId) => findDelegationCardByChildChatId(chatId),
    });
    for (const { child, anchor } of backfill) {
      renderRelatedChatCard({
        role: 'child',
        chatId: child.chatId,
        title: child.title || '',
        reason: child.reason || '',
      }, '', { insertBefore: anchor });
    }
  }

  /** @type {HTMLElement | null} */
  let contextAdvisoryEl = null;

  /**
   * Remove the inline context pressure advisory from the chat stream.
   */
  function removeContextAdvisory() {
    if (!contextAdvisoryEl) return;
    contextAdvisoryEl.remove();
    contextAdvisoryEl = null;
  }

  /**
   * Show or update the context pressure advisory as a normal chat stream block.
   *
   * @param {Record<string, unknown>} opts
   */
  function updateContextAdvisory(opts = {}) {
    const visible = opts.visible === true;
    if (!visible) {
      removeContextAdvisory();
      return;
    }
    const levelRaw = typeof opts.level === 'string' ? opts.level : 'warn';
    const level = levelRaw === 'critical' || levelRaw === 'danger' ? levelRaw : 'warn';
    const message = opts.message == null ? '' : String(opts.message);
    const actionLabel = opts.actionLabel == null ? '' : String(opts.actionLabel);
    const dismissLabel = opts.dismissLabel == null ? '' : String(opts.dismissLabel);
    if (!contextAdvisoryEl) {
      contextAdvisoryEl = document.createElement('div');
      contextAdvisoryEl.className = 'sdk-rich-context-advisory';
      rv.stream.appendChild(contextAdvisoryEl);
    }
    contextAdvisoryEl.classList.remove('is-warn', 'is-danger', 'is-critical');
    contextAdvisoryEl.classList.add(`is-${level}`);
    contextAdvisoryEl.replaceChildren();
    const textEl = document.createElement('div');
    textEl.className = 'sdk-rich-context-advisory-text';
    textEl.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'sdk-rich-context-advisory-actions';
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'sdk-rich-context-advisory-action';
    actionBtn.textContent = actionLabel;
    actionBtn.addEventListener('click', () => {
      if (typeof opts.onSummarize === 'function') opts.onSummarize();
    });
    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'sdk-rich-context-advisory-dismiss';
    dismissBtn.textContent = dismissLabel;
    dismissBtn.addEventListener('click', () => {
      removeContextAdvisory();
      if (typeof opts.onDismiss === 'function') opts.onDismiss();
    });
    actions.appendChild(actionBtn);
    actions.appendChild(dismissBtn);
    contextAdvisoryEl.appendChild(textEl);
    contextAdvisoryEl.appendChild(actions);
    rv.stream.appendChild(contextAdvisoryEl);
    rv.scrollToBottom({ force: true });
  }
}
