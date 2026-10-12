import { LitElement, css, html, nothing } from 'lit';
import { t } from '../../i18n/index.js';
import {
  resolveAggregateReviewBadge,
  resolveIndependenceMarkerKey,
  resolveReviewBadge,
  resolveReviewerReportLinkState,
  resolveVerdictKey,
  resolveVerifyStatusKey,
  shouldShowLeafReviewBadge,
} from '../../features/todo/todoReviewBadge.js';

/**
 * Review badge of a todo (`docs/todo-review-contract.md`).
 *
 * Domain component (it knows the `todo.review` snapshot), so it is intentionally
 * NOT part of the `components/ui/index.js` barrel. It follows the `cr-*` rules:
 * Shadow DOM, `static styles` with `--cr-*` tokens only, and MDI icons as LIGHT
 * DOM children projected through named slots (`::slotted(.mdi)`), because the
 * global `.mdi` font rules do not pierce a shadow root. The component owns those
 * light-DOM icon spans (`data-cr-icon`) and reconciles them after each render.
 *
 * - Row mode (default): one compact line. A leaf shows the code review badge, an
 *   optional plan badge and an independence marker; a container shows the
 *   derived "N/M reviewed" aggregate and never a single PASS.
 * - Detail mode (`detail`): reviewers, implementer, verify, date, acceptance and
 *   the report link with an explicit fallback state.
 *
 * Code and plan reviews are always separate badges (contract §3.4). Labels
 * collapse to the icon below 640px in pure CSS, so a resize needs no JS.
 */
class CrTodoReviewBadge extends LitElement {
  static properties = {
    item: { type: Object },
    hasChildren: { type: Boolean },
    compact: { type: Boolean, reflect: true },
    detail: { type: Boolean, reflect: true },
    _reportStates: { state: true },
  };

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      min-width: 0;
      font-family: var(--cr-font-ui);
    }
    :host([hidden]) {
      display: none;
    }
    :host([detail]) {
      display: block;
    }
    .badge,
    .independence {
      display: inline-flex;
      align-items: center;
      gap: 0.2rem;
      min-width: 0;
      max-width: 100%;
      padding: 0 0.35rem;
      border: 1px solid var(--cr-border-strong);
      border-radius: var(--cr-radius-sm);
      font-size: 0.72rem;
      line-height: 1.35;
      color: var(--cr-text-muted);
      white-space: nowrap;
    }
    .label {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    ::slotted(.mdi) {
      flex: 0 0 auto;
      font-size: 0.9rem;
      line-height: 1;
    }
    .badge[data-tone='success'] {
      color: var(--cr-success);
      border-color: var(--cr-success);
    }
    .badge[data-tone='error'] {
      color: var(--cr-error);
      border-color: var(--cr-error);
    }
    .badge[data-tone='info'] {
      color: var(--cr-accent);
      border-color: var(--cr-accent);
    }
    .badge[data-tone='warn'] {
      color: var(--cr-warn);
      background: var(--cr-warn-bg);
      border-color: var(--cr-warn-border);
    }
    .badge[data-tone='muted'] {
      opacity: 0.8;
    }
    /* Plan review is visibly a different thing: dashed border. */
    .badge[data-subject='plan'] {
      border-style: dashed;
    }
    /* A human acceptance is neither a PASS nor "no review": tinted fill, same
     * box size so the row height never moves. */
    .badge[data-state='manual'] {
      background: color-mix(in srgb, var(--cr-success) 18%, transparent);
    }
    .independence {
      border-style: dotted;
      font-size: 0.68rem;
    }
    :host([compact]) .label,
    :host([compact]) .independence-text {
      display: none;
    }
    @media (max-width: 640px) {
      :host(:not([detail])) .label,
      :host(:not([detail])) .independence-text {
        display: none;
      }
    }
    .detail {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--cr-space-2);
    }
    .detail-heading {
      margin: 0 0 var(--cr-space-1);
      font-size: 0.8rem;
      color: var(--cr-text-muted);
    }
    .detail-line {
      display: flex;
      flex-wrap: wrap;
      gap: var(--cr-space-1);
    }
    .hint {
      margin: 0;
      font-size: 0.75rem;
      color: var(--cr-text-muted);
    }
    .reviewers {
      margin: var(--cr-space-1) 0 0;
      padding: 0;
      list-style: none;
    }
    .reviewer {
      display: flex;
      flex-wrap: wrap;
      gap: var(--cr-space-1) var(--cr-space-2);
      font-size: 0.78rem;
      color: var(--cr-text);
    }
    .report-link {
      border: 0;
      padding: 0;
      background: transparent;
      color: var(--cr-accent);
      font: inherit;
      cursor: pointer;
      text-decoration: underline;
    }
    .report-unavailable {
      color: var(--cr-text-muted);
    }
  `;

  constructor() {
    super();
    this.item = null;
    this.hasChildren = false;
    this.compact = false;
    this.detail = false;
    /** @type {Record<string, string>} report link states resolved on click */
    this._reportStates = {};
    /** @type {Map<string, string>} slot name -> mdi icon class for this render */
    this._icons = new Map();
  }

  /**
   * Reserve a light-DOM icon slot. The icon span is created in `updated()`.
   *
   * @param {string} slotName
   * @param {string} iconName e.g. `mdi-check-circle`
   * @returns {import('lit').TemplateResult}
   */
  _iconSlot(slotName, iconName) {
    this._icons.set(slotName, iconName);
    return html`<slot name=${slotName}></slot>`;
  }

  /** Reconcile the host's light-DOM `.mdi` spans with the slots of this render. */
  updated() {
    const wanted = this._icons;
    for (const el of Array.from(this.children)) {
      if (!el.hasAttribute('data-cr-icon')) continue;
      if (!wanted.has(el.getAttribute('slot') || '')) el.remove();
    }
    for (const [slotName, iconName] of wanted) {
      let el = Array.from(this.children).find((child) => {
        return child.hasAttribute('data-cr-icon') && child.getAttribute('slot') === slotName;
      });
      if (!el) {
        el = document.createElement('span');
        el.setAttribute('data-cr-icon', '');
        el.setAttribute('slot', slotName);
        el.setAttribute('aria-hidden', 'true');
        this.appendChild(el);
      }
      const className = `mdi ${iconName}`;
      if (el.className !== className) el.className = className;
    }
  }

  /**
   * @param {ReturnType<typeof resolveReviewBadge>} badge
   * @returns {string}
   */
  _labelFor(badge) {
    return t(badge.labelKey, badge.labelParams);
  }

  /**
   * Independence markers describe the CODE review only; a plan badge never
   * borrows them.
   *
   * @param {ReturnType<typeof resolveReviewBadge>} badge
   * @returns {string}
   */
  _titleFor(badge) {
    const parts = [this._labelFor(badge)];
    if (badge.subject === 'code') {
      const marker = resolveIndependenceMarkerKey(badge.independenceClass);
      if (marker) parts.push(t(marker));
      if (badge.noImplementer) parts.push(t('todo.reviewIndependence.noImplementer'));
    }
    return parts.join(' · ');
  }

  /**
   * @param {ReturnType<typeof resolveReviewBadge>} badge
   * @returns {import('lit').TemplateResult}
   */
  _renderSubject(badge) {
    const marker = badge.subject === 'code' ? resolveIndependenceMarkerKey(badge.independenceClass) : null;
    const showMarker = badge.subject === 'code' && (marker || badge.noImplementer);
    const markerKey = marker || 'todo.reviewIndependence.noImplementer';
    return html`
      <span
        class="badge"
        data-state=${badge.state}
        data-tone=${badge.tone}
        data-subject=${badge.subject}
        title=${this._titleFor(badge)}
        aria-label=${this._titleFor(badge)}
      >
        ${this._iconSlot(`icon-${badge.subject}`, badge.iconName)}
        <span class="label">${this._labelFor(badge)}</span>
      </span>
      ${showMarker ? html`
        <span
          class="independence"
          data-class=${badge.independenceClass}
          title=${t(markerKey)}
          aria-label=${t(markerKey)}
        >${this._iconSlot('icon-independence', 'mdi-link-variant')}<span class="independence-text">${t(markerKey)}</span></span>
      ` : nothing}
    `;
  }

  _renderAggregate(aggregate) {
    const label = t('todo.reviewBadge.aggregate', {
      reviewed: String(aggregate.reviewed),
      total: String(aggregate.total),
    });
    const counts = aggregate.counts;
    const title = [
      label,
      t('todo.reviewBadge.aggregateBreakdown', {
        passed: String(counts.passed + counts.manual),
        failed: String(counts.failed),
        stale: String(counts.stale),
        pending: String(counts.pending),
        unknown: String(counts.unknown),
        none: String(counts.none),
      }),
      aggregate.truncated ? t('todo.reviewBadge.aggregateTruncated') : '',
    ].filter(Boolean).join(' · ');
    return html`
      <span
        class="badge"
        data-tone=${aggregate.tone}
        data-subject="aggregate"
        title=${title}
        aria-label=${title}
      >
        ${this._iconSlot('icon-aggregate', aggregate.iconName)}
        <span class="label">${aggregate.reviewed}/${aggregate.total}</span>
      </span>
    `;
  }

  /**
   * @param {object} reviewer
   * @returns {import('lit').TemplateResult}
   */
  _renderReviewer(reviewer) {
    const row = reviewer && typeof reviewer === 'object' ? reviewer : {};
    const id = String(row.delegationId || '').trim();
    const linkState = resolveReviewerReportLinkState(row, this._reportStates);
    // `unavailable` = not resolved yet: the click resolves it (contract §11.3)
    // and then relabels the row with the honest state.
    const linkable = !!id && (linkState === 'available' || linkState === 'report_trimmed' || linkState === 'unavailable');
    const model = [row.harness, row.model].map((v) => String(v || '').trim()).filter(Boolean).join('/');
    const independence = resolveIndependenceMarkerKey(row.independence);
    return html`
      <li class="reviewer">
        <span>${model || t('todo.reviewDetails.unknownModel')}</span>
        <span>${t(resolveVerdictKey(row.verdict))}</span>
        <span>${t('todo.reviewDetails.verify')}: ${t(resolveVerifyStatusKey(row.verifyStatus))}</span>
        ${independence ? html`<span>${t(independence)}</span>` : nothing}
        ${linkable ? html`
          <button
            type="button"
            class="report-link"
            data-delegation-id=${id}
            data-link-state=${linkState}
            @click=${() => this._openReport(row)}
          >${t(linkState === 'report_trimmed' ? 'todo.reviewReport.trimmed' : 'todo.reviewReport.open')}</button>
        ` : html`
          <span class="report-unavailable" data-link-state=${linkState}>${t(`todo.reviewReport.${linkState}`)}</span>
        `}
      </li>
    `;
  }

  _openReport(reviewer) {
    const delegationId = String(reviewer?.delegationId || '').trim();
    this.dispatchEvent(new CustomEvent('todo-review-open-report', {
      bubbles: true,
      composed: true,
      detail: {
        delegationId,
        linkState: resolveReviewerReportLinkState(reviewer, this._reportStates),
        // The panel resolves the state on click and reports it back so this row
        // shows `trimmed` / `deleted` / `missing` instead of a dead guess.
        setLinkState: (state) => {
          const next = String(state || '').trim();
          if (!delegationId || !next) return;
          this._reportStates = { ...this._reportStates, [delegationId]: next };
        },
      },
    }));
  }

  /**
   * @param {'code'|'plan'} subject
   * @returns {import('lit').TemplateResult | typeof nothing}
   */
  _renderDetailSubject(subject) {
    const review = this.item?.review;
    const snapshot = review && typeof review === 'object' ? review[subject] : null;
    const badge = resolveReviewBadge(review, subject);
    const reviewers = Array.isArray(snapshot?.reviewers) ? snapshot.reviewers : [];
    const implementer = snapshot?.implementer && typeof snapshot.implementer === 'object'
      ? snapshot.implementer
      : null;
    const implementerLabel = implementer
      ? [implementer.harness, implementer.model].map((v) => String(v || '').trim()).filter(Boolean).join('/')
      : '';
    const acceptance = snapshot?.acceptance && typeof snapshot.acceptance === 'object' ? snapshot.acceptance : null;
    const updatedAt = String(snapshot?.updatedAt || '').trim();
    const stale = snapshot?.stateReason === 'history_truncated';
    return html`
      <section data-subject=${subject}>
        <h4 class="detail-heading">${t(`todo.reviewDetails.${subject}`)}</h4>
        <div class="detail-line">${this._renderSubject({ ...badge })}</div>
        ${reviewers.length ? html`
          <ul class="reviewers">${reviewers.map((row) => this._renderReviewer(row))}</ul>
        ` : html`<p class="hint">${t('todo.reviewDetails.noReviewers')}</p>`}
        ${implementer ? html`
          <p class="hint">${t('todo.reviewDetails.implementer')}: ${implementerLabel || t('todo.reviewDetails.unknownModel')}${implementer.role ? ` (${implementer.role})` : ''}</p>
        ` : (subject === 'code' && badge.state !== 'none' ? html`<p class="hint">${t('todo.reviewIndependence.noImplementer')}</p>` : nothing)}
        ${acceptance ? html`
          <p class="hint">${t('todo.reviewDetails.acceptedBy', { actor: String(acceptance.actor || 'human') })}${acceptance.at ? ` · ${acceptance.at}` : ''}</p>
        ` : nothing}
        ${stale ? html`<p class="hint">${t('todo.reviewDetails.historyTruncated')}</p>` : nothing}
        ${updatedAt ? html`<p class="hint">${t('todo.reviewDetails.updated')}: ${updatedAt}</p>` : nothing}
      </section>
    `;
  }

  render() {
    this._icons = new Map();
    const item = this.item || {};
    if (this.detail) {
      if (this.hasChildren) {
        const aggregate = resolveAggregateReviewBadge(item.review);
        return html`
          <div class="detail">
            ${aggregate ? this._renderAggregate(aggregate) : nothing}
            <p class="hint">${t('todo.reviewDetails.containerHint')}</p>
          </div>
        `;
      }
      // Code and plan detail sections each own their slot names; the same
      // subject is never rendered twice in one pass.
      return html`
        <div class="detail">
          ${this._renderDetailSubject('code')}
          ${this._renderDetailSubject('plan')}
          <p class="hint">${t('todo.reviewDetails.limits')}</p>
        </div>
      `;
    }
    if (this.hasChildren) {
      const aggregate = resolveAggregateReviewBadge(item.review);
      return aggregate ? this._renderAggregate(aggregate) : nothing;
    }
    if (!shouldShowLeafReviewBadge(item)) return nothing;
    const code = resolveReviewBadge(item.review, 'code');
    const plan = resolveReviewBadge(item.review, 'plan');
    // A narrow list row has room for one badge: show the code review, or the
    // plan review when there is no code review yet.
    const narrow = !this.detail && typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 640px)').matches;
    if (narrow && plan.state !== 'none') {
      return this._renderSubject(code.state === 'none' ? plan : code);
    }
    return html`
      ${this._renderSubject(code)}
      ${plan.state !== 'none' ? this._renderSubject(plan) : nothing}
    `;
  }
}

if (!customElements.get('cr-todo-review-badge')) {
  customElements.define('cr-todo-review-badge', CrTodoReviewBadge);
}

export { CrTodoReviewBadge };
