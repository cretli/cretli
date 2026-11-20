import { LitElement, html, css } from 'lit';
import '../../components/ui/index.js';
import { t } from '../../i18n/index.js';
import { apiFetchJson } from '../../core/api/runtime.js';

export class CrChatArchivist extends LitElement {
  static properties = { report: { state: true }, busy: { state: true }, message: { state: true }, idleDays: { state: true } };
  static styles = css`
    :host { display: block; margin-top: var(--cr-space-5); font-size: var(--cr-font-size-sm); }
    h3 { font-size: var(--cr-font-size-lg); }
    h4 { font-size: var(--cr-font-size-md); }
    p, small { color: var(--cr-text-muted); }
    .controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cr-space-2); }
    cr-bar-input { width: 6rem; }
    .rows { max-height: 28rem; overflow: auto; margin-top: var(--cr-space-3); }
    article { padding: var(--cr-space-3) 0; border-bottom: 1px solid var(--cr-border); overflow-wrap: anywhere; }
    .title { display: block; margin-bottom: var(--cr-space-1); }
    .message { color: var(--cr-text); }
    .verdict { font-weight: 600; }
  `;
  constructor() {
    super();
    this.report = null;
    this.busy = false;
    this.message = '';
    this.idleDays = 7;
  }
  label(key) { return t(`settings.archivist${key}`); }
  reason(reason) {
    const key = `settings.archivistReason_${reason}`;
    const localized = t(key);
    return localized === key ? reason : localized;
  }
  async request(action, body) {
    return apiFetchJson(`/api/chat-archivist${action ? `/${action}` : `?idleDays=${this.idleDays}`}`, action ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : { cache: 'no-store' }, 'chatArchivist', { timeoutMs: 120000 });
  }
  async run(action = '', body) {
    if (this.busy) return;
    this.busy = true;
    this.message = this.label('Working');
    try {
      const result = await this.request(action, body);
      if (!result?.ok) throw Object.assign(new Error(), { code: result?.code });
      const report = action ? await this.request('') : result;
      if (!report?.ok) throw new Error();
      this.report = report.report;
      this.message = '';
    } catch (error) {
      this.message = error.code ? this.reason(error.code) : this.label('Failed');
    } finally { this.busy = false; }
  }
  download() {
    if (!this.report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...this.report }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'chat-archivist-report.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  render() {
    const items = this.report?.items || [];
    const latest = new Map();
    for (const item of items) if (item.kind === 'assessment' && !latest.has(item.chatId)) latest.set(item.chatId, item);
    return html`
      <h3>${this.label('Title')}</h3>
      <p>${this.label('Intro')}</p>
      <p>${this.label('Cost')}</p>
      <div class="controls">
        <label for="idle-days">${this.label('IdleDays')}</label>
        <cr-bar-input id="idle-days" type="number" min="1" max="3650" .ariaLabel=${this.label('IdleDays')} .value=${String(this.idleDays)} ?disabled=${this.busy}
          @input=${(event) => { const n = Number(event.target.value); if (Number.isInteger(n) && n >= 1 && n <= 3650) this.idleDays = n; }}></cr-bar-input>
        <cr-bar-button ?disabled=${this.busy} @click=${() => this.run()}>${this.label('Refresh')}</cr-bar-button>
        <cr-bar-button ?disabled=${this.busy || !this.report} @click=${() => this.download()}>${this.label('Export')}</cr-bar-button>
      </div>
      <p class="message" role="status" aria-live="polite">${this.message}</p>
      ${this.report ? html`
        <h4>${this.label('Candidates')} (${this.report.totalCandidates})</h4>
        <p>${this.label('CandidateHint')}</p>
        <div class="rows">${this.report.candidates.length ? this.report.candidates.map((chat) => {
          const assessment = latest.get(chat.id);
          const used = items.some((row) => row.kind === 'archive' && row.assessmentId === assessment?.id);
          return html`<article>
            <strong class="title">${chat.title || chat.id}</strong>
            <small>${chat.updatedAt}</small>
            ${assessment ? html`<p><span class="verdict">${this.label(`Verdict_${assessment.verdict}`)}</span>: ${this.reason(assessment.reason)}</p>` : ''}
            <div class="controls">
              <cr-bar-button ?disabled=${this.busy} @click=${() => this.run('assess', { chatId: chat.id, idleDays: this.idleDays })}>${this.label('Assess')}</cr-bar-button>
              ${assessment?.verdict === 'completed' && !used ? html`<cr-bar-button ?disabled=${this.busy} @click=${() => this.run('archive', { assessmentId: assessment.id, confirm: true })}>${this.label('Archive')} (${assessment.members.length})</cr-bar-button>` : ''}
            </div>
          </article>`;
        }) : html`<p>${this.label('Empty')}</p>`}</div>
        <h4>${this.label('History')}</h4>
        <p>${this.label('HistoryHint')}</p>
        <div class="rows">${items.length ? items.map((item) => html`<article>
          <strong class="title">${item.title || item.chatId}</strong>
          <small>${item.createdAt} · ${this.label(`Status_${item.status || item.verdict}`)}</small>
          ${item.reason ? html`<p>${this.reason(item.reason)}</p>` : ''}
          ${item.members?.length ? html`<p>${item.members.map((member) => member.title || member.id).join(' · ')}</p>` : ''}
          ${item.kind === 'archive' && item.status === 'archived' && !items.some((row) => row.archiveId === item.id && row.status === 'restored') ? html`<cr-bar-button ?disabled=${this.busy} @click=${() => this.run('restore', { actionId: item.id })}>${this.label('Restore')}</cr-bar-button>` : ''}
        </article>`) : html`<p>${this.label('Empty')}</p>`}</div>
      ` : ''}
    `;
  }
}
if (!customElements.get('cr-chat-archivist')) customElements.define('cr-chat-archivist', CrChatArchivist);
