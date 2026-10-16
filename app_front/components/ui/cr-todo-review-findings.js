import { LitElement, css, html, nothing } from 'lit';
import { t } from '../../i18n/index.js';
import { getReviewFindings, postRejectReviewFinding } from '../../api.js';
import { getTodoWorkspaceFolder } from '../../features/todo/todoWorkspaceScope.js';
import './cr-bar-button.js';

/** Outcomes a human may not reject (they never become suppress candidates). */
const NOT_REJECTABLE = new Set(['out_of_scope', 'follow_up']);

/**
 * Per-finding review actions of a todo leaf: lists the findings ledger and lets
 * a human reject a single finding with a reason. A human rejection overrides an
 * orchestrator one on the server. The list is loaded on demand; a CAS conflict
 * (409) reloads it and shows a message instead of overwriting.
 *
 * Domain component (todo ledger), so it is not part of the `ui/index.js` barrel.
 * Finding text is rendered through Lit text bindings only (escaped).
 */
class CrTodoReviewFindings extends LitElement {
  static properties = {
    todoId: { type: String },
    _open: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _data: { state: true },
    _rejecting: { state: true },
    _reason: { state: true },
    _note: { state: true },
    _message: { state: true },
    _busy: { state: true },
  };

  static styles = css`
    :host { display: block; min-width: 0; }
    .head { display: flex; align-items: center; gap: var(--cr-space-2); flex-wrap: wrap; }
    ul { list-style: none; margin: var(--cr-space-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--cr-space-2); }
    li { border: 1px solid var(--cr-border); border-radius: var(--cr-radius-sm); padding: var(--cr-space-2); background: var(--cr-surface); min-width: 0; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cr-space-1); font-size: 0.75rem; color: var(--cr-text-muted); }
    .badge { border: 1px solid var(--cr-border-strong); border-radius: var(--cr-radius-sm); padding: 0 var(--cr-space-2); }
    .badge[data-outcome='rejected'] { color: var(--cr-success); border-color: var(--cr-success); }
    .badge[data-outcome='open'], .badge[data-outcome='still_open_at_stop'] { color: var(--cr-error); border-color: var(--cr-error); }
    .summary { margin: var(--cr-space-1) 0; overflow-wrap: anywhere; color: var(--cr-text); }
    .form { display: flex; flex-wrap: wrap; gap: var(--cr-space-2); align-items: center; margin-top: var(--cr-space-1); }
    select, input { min-height: var(--cr-control-height); background: var(--cr-bg); color: var(--cr-text); border: 1px solid var(--cr-border-strong); border-radius: var(--cr-radius-sm); font: inherit; padding: 0 var(--cr-space-2); max-width: 100%; box-sizing: border-box; }
    input { flex: 1 1 10rem; }
    .status { font-size: 0.8rem; color: var(--cr-text-muted); }
    .status[data-tone='error'] { color: var(--cr-error); }
    .status[data-tone='success'] { color: var(--cr-success); }
  `;

  constructor() {
    super();
    this.todoId = '';
    this._open = false;
    this._loading = false;
    this._error = '';
    this._data = null;
    this._rejecting = '';
    this._reason = 'false_positive';
    this._note = '';
    this._message = null;
    this._busy = false;
  }

  async _load() {
    this._loading = true;
    this._error = '';
    try {
      const res = await getReviewFindings(this.todoId, { workspaceFolder: getTodoWorkspaceFolder() });
      if (!res?.ok) throw new Error(res?.error || 'load failed');
      this._data = res;
    } catch (_err) {
      this._error = t('todo.findingsLoadFailed');
    } finally {
      this._loading = false;
    }
  }

  async _toggle() {
    this._open = !this._open;
    if (this._open) await this._load();
  }

  _startReject(finding) {
    this._rejecting = finding.key;
    this._reason = 'false_positive';
    this._note = '';
  }

  async _confirmReject(finding) {
    if (this._busy) return;
    this._busy = true;
    try {
      const res = await postRejectReviewFinding({
        workspaceFolder: getTodoWorkspaceFolder(),
        leafId: this.todoId,
        key: finding.key,
        reason: this._reason,
        note: this._note,
        expectedSeq: this._data?.seq,
      });
      if (res?.ok) {
        this._rejecting = '';
        this._message = { tone: 'success', text: t('todo.findingsRejected') };
      } else if (res?.code === 'CONFLICT') {
        this._rejecting = '';
        this._message = { tone: 'error', text: t('todo.findingsConflict') };
      } else {
        this._message = { tone: 'error', text: res?.error || t('todo.findingsRejectFailed') };
      }
      if (res?.ok || res?.code === 'CONFLICT') await this._load();
    } catch (_err) {
      this._message = { tone: 'error', text: t('todo.findingsRejectFailed') };
    } finally {
      this._busy = false;
    }
  }

  _renderForm(finding) {
    const reasons = this._data?.rejectReasons || [];
    return html`
      <div class="form">
        <select aria-label=${t('todo.findingsRejectReason')} .value=${this._reason} @change=${(e) => { this._reason = e.target.value; }}>
          ${reasons.map((reason) => html`<option value=${reason} ?selected=${reason === this._reason}>${t(`todo.findingsReason_${reason}`)}</option>`)}
        </select>
        <input type="text" maxlength="500" placeholder=${t('todo.findingsRejectNote')} aria-label=${t('todo.findingsRejectNote')} .value=${this._note} @input=${(e) => { this._note = e.target.value; }} />
        <cr-bar-button class="findings-confirm" variant="primary" ?disabled=${this._busy} @click=${() => this._confirmReject(finding)}>${t('todo.findingsRejectConfirm')}</cr-bar-button>
        <cr-bar-button class="findings-cancel" @click=${() => { this._rejecting = ''; }}>${t('todo.findingsRejectCancel')}</cr-bar-button>
      </div>`;
  }

  _renderFinding(finding) {
    const rejection = finding.rejection;
    const canReject = !NOT_REJECTABLE.has(finding.outcome) && rejection?.actor !== 'human';
    return html`
      <li data-finding-key=${finding.key}>
        <div class="meta">
          <strong>${finding.key}</strong>
          ${finding.priority ? html`<span class="badge">${finding.priority}</span>` : nothing}
          <span class="badge">${finding.category}</span>
          <span class="badge" data-outcome=${finding.outcome}>${t(`todo.findingsOutcome_${finding.outcome}`)}</span>
        </div>
        <p class="summary">${finding.summary}</p>
        ${rejection ? html`<div class="meta">${t('todo.findingsRejectedBy', { reason: t(`todo.findingsReason_${rejection.reason}`), actor: rejection.actor })}${rejection.note ? html` — ${rejection.note}` : nothing}</div>` : nothing}
        ${this._rejecting === finding.key
          ? this._renderForm(finding)
          : canReject
            ? html`<cr-bar-button class="findings-reject" @click=${() => this._startReject(finding)}>${t('todo.findingsReject')}</cr-bar-button>`
            : nothing}
      </li>`;
  }

  render() {
    const findings = this._data?.findings || [];
    return html`
      <div class="head">
        <cr-bar-button class="findings-toggle" @click=${() => this._toggle()}>${this._open ? t('todo.findingsHide') : t('todo.findingsLoad')}</cr-bar-button>
        ${this._message ? html`<span class="status" data-tone=${this._message.tone} aria-live="polite">${this._message.text}</span>` : nothing}
      </div>
      ${this._open ? html`
        ${this._loading ? html`<p class="status">${t('todo.findingsLoading')}</p>` : nothing}
        ${this._error ? html`<p class="status" data-tone="error">${this._error}</p>` : nothing}
        ${!this._loading && !this._error && !findings.length ? html`<p class="status">${t('todo.findingsEmpty')}</p>` : nothing}
        ${findings.length ? html`<ul>${findings.map((finding) => this._renderFinding(finding))}</ul>` : nothing}
      ` : nothing}`;
  }
}

if (!customElements.get('cr-todo-review-findings')) customElements.define('cr-todo-review-findings', CrTodoReviewFindings);
export { CrTodoReviewFindings };
