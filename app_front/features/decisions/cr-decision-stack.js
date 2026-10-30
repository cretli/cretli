import { LitElement, css, html } from 'lit';
import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { bindDecisionFlush, canSwipe, createDecisionQueue, decisionRequestInit, directionForPointer, groupDecisions, swipeOption } from './decisionLogic.js';

function safeLink(value) {
  try {
    const url = new URL(String(value), location.origin);
    return url.origin === location.origin && /^https?:$/.test(url.protocol) ? url.href : '';
  } catch { return ''; }
}

class CrDecisionStack extends LitElement {
  static properties = { cards: { state: true }, detailId: { state: true }, notice: { state: true }, pending: { state: true }, expanded: { state: true } };
  static styles = css`
    :host { display:block; height:100%; overflow:auto; color:var(--cr-text); font-family:var(--cr-font-ui); }
    .wrap { max-width:45rem; margin:auto; padding:var(--cr-space-4); }
    h2 { font-size:var(--cr-font-size-xl); margin:0 0 var(--cr-space-3); }
    .notice, .empty, .error { color:var(--cr-text-muted); padding:var(--cr-space-3); }
    .error { color:var(--cr-error); }
    .group, .card, .details { background:var(--cr-surface); border:1px solid var(--cr-border-strong); border-radius:var(--cr-radius-lg); padding:var(--cr-space-4); margin-bottom:var(--cr-space-3); }
    .card { touch-action:pan-y; cursor:pointer; }
    .gesture-handle { touch-action:none; user-select:none; border:1px dashed var(--cr-border-strong); border-radius:var(--cr-radius-sm); padding:var(--cr-space-2); margin-bottom:var(--cr-space-3); color:var(--cr-text-muted); text-align:center; font-size:var(--cr-font-size-sm); }
    .card:focus-visible, button:focus-visible { outline:2px solid var(--cr-accent); outline-offset:2px; }
    .summary { color:var(--cr-text-muted); white-space:pre-wrap; }
    .actions, .row { display:flex; flex-wrap:wrap; gap:var(--cr-space-2); align-items:center; }
    button { min-height:var(--cr-control-height); border:1px solid var(--cr-border-strong); border-radius:var(--cr-radius-sm); color:var(--cr-text); background:var(--cr-bg); padding:var(--cr-space-2) var(--cr-space-3); cursor:pointer; font:inherit; }
    button.primary { background:var(--cr-primary); color:var(--cr-text); }
    .meta { font-size:var(--cr-font-size-sm); color:var(--cr-text-muted); }
    .details { margin-top:var(--cr-space-3); }
    .evidence { overflow-wrap:anywhere; }
    .evidence img { max-width:100%; height:auto; border-radius:var(--cr-radius-sm); }
    .evidence pre { white-space:pre-wrap; font:inherit; }
    textarea { width:100%; box-sizing:border-box; min-height:5rem; background:var(--cr-field-bg); color:var(--cr-text); border:1px solid var(--cr-field-border); border-radius:var(--cr-radius-sm); font:inherit; }
  `;
  constructor() {
    super();
    this.cards = [];
    this.detailId = '';
    this.notice = '';
    this.pending = new Map();
    this.expanded = new Set();
    this.queue = createDecisionQueue((entry, keepalive) => this.sendDecision(entry, keepalive));
    this.onLanguage = () => this.requestUpdate();
  }
  connectedCallback() {
    super.connectedCallback();
    this.unbindFlush = bindDecisionFlush(this.queue, window, document);
    window.addEventListener('cr-lang-changed', this.onLanguage);
  }
  disconnectedCallback() {
    this.queue.flush();
    this.unbindFlush?.();
    window.removeEventListener('cr-lang-changed', this.onLanguage);
    super.disconnectedCallback();
  }
  setCards(cards) { this.cards = Array.isArray(cards) ? cards : []; }
  select(card, optionId, reason = '') {
    if (optionId === '__other__' && !reason.trim()) { this.detailId = card.id; return; }
    if (this.pending.has(card.id)) return;
    this.queue.enqueue(card, optionId, reason);
    this.pending = new Map(this.queue.pending);
    this.detailId = '';
    this.requestUpdate();
  }
  undo(id) {
    if (this.queue.undo(id)) {
      this.pending = new Map(this.queue.pending);
      this.notice = t('decisions.undone');
    }
  }
  async sendDecision(entry, keepalive) {
    this.pending = new Map(this.queue.pending);
    const { card } = entry;
    try {
      const response = await cretliApiFetch(`/api/decisions/${encodeURIComponent(card.id)}`,
        decisionRequestInit(entry, keepalive));
      if (response.status === 409) {
        this.cards = this.cards.filter((item) => item.id !== card.id);
        this.notice = t('decisions.stale');
        this.dispatchEvent(new CustomEvent('cr-decisions-refresh', { bubbles: true, composed: true }));
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.cards = this.cards.filter((item) => item.id !== card.id);
      this.notice = t('decisions.sent');
      this.dispatchEvent(new CustomEvent('cr-decisions-refresh', { bubbles: true, composed: true }));
    } catch {
      this.notice = t('decisions.sendError');
    }
  }
  onGesture(card, direction) {
    const option = swipeOption(card, direction);
    if (option) this.select(card, option.id);
  }
  onKey(event, card) {
    if (event.target !== event.currentTarget) return;
    const direction = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up' }[event.key];
    if (direction) { event.preventDefault(); this.onGesture(card, direction); }
    if (event.key === 'Enter') { event.preventDefault(); this.detailId = card.id; }
  }
  onPointerDown(event, card) {
    if (event.target.closest('button, a, textarea')) return;
    const onHandle = Boolean(canSwipe(card) && event.target.closest('.gesture-handle'));
    this.pointerStart = { id: card.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, onHandle };
    if (onHandle) event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  onPointerUp(event, card) {
    const start = this.pointerStart;
    this.pointerStart = null;
    if (!start || start.id !== card.id || start.pointerId !== event.pointerId || event.target.closest('button, a, textarea')) return;
    const direction = directionForPointer(start, { x: event.clientX, y: event.clientY });
    if (direction === 'tap') { this.detailId = card.id; return; }
    if (!canSwipe(card)) return;
    if (direction) this.onGesture(card, direction);
  }
  evidence(item) {
    if (typeof item === 'string') return html`<pre>${item}</pre>`;
    const link = safeLink(item?.url || item?.chatUrl || item?.screenshotUrl || item?.imageUrl || item?.screenshot || '');
    const image = link && (/screenshot|image/i.test(String(item?.type || item?.kind || '')) || item?.screenshotUrl || item?.imageUrl || item?.screenshot);
    const detail = item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).filter(([key]) => !['label', 'type', 'kind', 'url', 'chatUrl', 'screenshotUrl', 'imageUrl', 'screenshot', 'summary', 'diffStat', 'verdict', 'verify'].includes(key))) : {};
    return html`<div class="evidence"><strong>${item?.label || item?.type || item?.kind || t('decisions.evidence')}</strong>
      ${item?.summary ? html`<pre>${item.summary}</pre>` : ''}
      ${item?.diffStat ? html`<pre>${typeof item.diffStat === 'string' ? item.diffStat : JSON.stringify(item.diffStat)}</pre>` : ''}
      ${item?.verdict ? html`<pre>${item.verdict}</pre>` : ''}
      ${item?.verify ? html`<pre>${typeof item.verify === 'string' ? item.verify : JSON.stringify(item.verify)}</pre>` : ''}
      ${Object.keys(detail).length ? html`<pre>${JSON.stringify(detail, null, 2)}</pre>` : ''}
      ${link ? html`<a href=${link} target="_blank" rel="noopener noreferrer">${t('decisions.openEvidence')}</a>` : ''}
      ${image ? html`<img src=${link} alt=${t('decisions.screenshot')}>` : ''}
    </div>`;
  }
  renderCard(card) {
    const queued = this.pending.has(card.id);
    return html`<article class="card" tabindex="0" aria-label=${card.title || ''}
      @keydown=${(event) => this.onKey(event, card)}
      @pointerdown=${(event) => this.onPointerDown(event, card)}
      @pointerup=${(event) => this.onPointerUp(event, card)}
      @pointercancel=${() => { this.pointerStart = null; }}>
      ${canSwipe(card) ? html`<div class="gesture-handle">${t('decisions.swipeHint')}</div>` : ''}
      <h3>${card.title}</h3><p class="summary">${card.summary}</p>
      ${card.why ? html`<p class="meta">${t('decisions.recommended')}: ${card.why}</p>` : ''}
      ${queued ? html`<div class="row"><span>${t('decisions.waiting')}</span><button @click=${() => this.undo(card.id)}>${t('decisions.undo')}</button></div>` : html`
        <div class="actions"><button @click=${() => { this.detailId = card.id; }}>${t('decisions.details')}</button>
        ${!canSwipe(card) ? card.options.map((option) => html`<button class=${option.id === card.recommended ? 'primary' : ''} @click=${() => this.select(card, option.id)}>${option.label}</button>`) : ''}</div>`}
      ${this.detailId === card.id ? html`<section class="details"><h4>${t('decisions.details')}</h4>
        <p>${card.why || ''}</p>
        ${card.subject?.chatId ? html`<p><a href=${`/chat?chat=${encodeURIComponent(card.subject.chatId)}`}>${t('decisions.openChat')}</a></p>` : ''}
        ${(card.evidence || []).map((item) => this.evidence(item))}
        <div class="actions">${card.options.map((option) => html`<button @click=${() => this.select(card, option.id)}>${option.label}: ${option.effect}</button>`)}</div>
        ${card.otherOption !== null ? html`<label>${t('decisions.other')}<textarea id=${`other-${card.id}`}></textarea></label>
        <button @click=${() => { const input = /** @type {HTMLTextAreaElement | null} */ (this.renderRoot.querySelector(`#other-${card.id}`)); const reason = input?.value?.trim(); if (reason) this.select(card, '__other__', reason); }}>${t('decisions.sendOther')}</button>` : ''}
        <button @click=${() => { this.detailId = ''; }}>${t('decisions.close')}</button>
      </section>` : ''}
    </article>`;
  }
  render() {
    const groups = groupDecisions(this.cards.filter((card) => card.status === 'pending'));
    return html`<div class="wrap"><h2>${t('decisions.title')}</h2>
      ${this.notice ? html`<p class="notice" role="status">${this.notice}</p>` : ''}
      ${groups.length ? groups.map((group) => group.cards.length > 1 ? html`
        <section class="group"><button @click=${() => { const next = new Set(this.expanded); next.has(group.key) ? next.delete(group.key) : next.add(group.key); this.expanded = next; }}
          aria-expanded=${this.expanded.has(group.key)}>${t('decisions.integrationGroup', { count: group.cards.length, tree: group.treeId })}</button>
          ${this.expanded.has(group.key) ? group.cards.map((card) => this.renderCard(card)) : this.renderCard(group.cards[0])}</section>` : this.renderCard(group.cards[0]))
        : html`<p class="empty">${t('decisions.empty')}</p>`}
    </div>`;
  }
}

if (!customElements.get('cr-decision-stack')) customElements.define('cr-decision-stack', CrDecisionStack);
export { CrDecisionStack };
