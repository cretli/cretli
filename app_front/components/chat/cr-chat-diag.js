import { LitElement, css, html } from 'lit';

/**
 * Chat diagnostic panel — shows client and server signals useful when a chat
 * hangs (RUNNING state with no progress).
 *
 * @property {boolean} enabled - whether the panel is visible
 * @property {object}  data    - diagnostic snapshot (client + server)
 */
class CrChatDiag extends LitElement {
  static properties = {
    enabled: { type: Boolean },
    data: { type: Object },
  };

  static styles = css`
    :host {
      display: block;
      margin: 0 0 0.35rem;
      font-family: inherit;
    }

    .panel {
      border: 1px solid var(--cr-border);
      border-radius: var(--cr-radius-md, 6px);
      background: var(--cr-code-bg);
      color: var(--cr-text);
      font-size: 0.72rem;
      line-height: 1.4;
      padding: 0.4rem 0.55rem;
    }

    .head {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      cursor: pointer;
      user-select: none;
      font-weight: 600;
      color: var(--cr-text);
    }

    .badge {
      font-size: 0.66rem;
      padding: 0.08rem 0.4rem;
      border-radius: 999px;
      border: 1px solid var(--cr-neutral-border);
      background: var(--cr-neutral-bg);
      color: var(--cr-neutral);
    }

    .badge--ok {
      color: var(--cr-success);
      border-color: var(--cr-success-border);
    }

    .badge--warn {
      color: var(--cr-warn);
      border-color: var(--cr-warn-border);
    }

    .badge--bad {
      color: var(--cr-error);
      border-color: var(--cr-error-border);
    }

    .body {
      margin-top: 0.4rem;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 0.3rem 0.8rem;
    }

    .row {
      display: flex;
      justify-content: space-between;
      gap: 0.4rem;
    }

    .k {
      color: var(--cr-text-muted);
    }

    .v {
      color: var(--cr-text);
      font-variant-numeric: tabular-nums;
    }

    .v--bad {
      color: var(--cr-error);
    }

    .v--warn {
      color: var(--cr-warn);
    }

    .hint {
      margin-top: 0.35rem;
      color: var(--cr-text-muted);
      font-size: 0.68rem;
    }

  `;

  constructor() {
    super();
    this.enabled = false;
    this.data = null;
    this._collapsed = false;
  }

  toggle() {
    this._collapsed = !this._collapsed;
    this.requestUpdate();
  }

  _verdict() {
    const d = this.data;
    if (!d) return { tone: 'warn', label: 'no data' };
    const wsOpen = d.wsState === 'OPEN';
    if (!wsOpen) return { tone: 'bad', label: 'WS closed' };
    if (d.serverBusy && d.serverStuckInSetup) {
      return { tone: 'bad', label: 'stuck in setup' };
    }
    if (d.serverBusy && d.serverLastEventAgoMs != null && d.serverLastEventAgoMs > 30000) {
      return { tone: 'bad', label: 'stuck (busy, no events)' };
    }
    if (d.roomEventSeqGap != null && d.roomEventSeqGap > 0) {
      return { tone: 'warn', label: `seq gap ${d.roomEventSeqGap}` };
    }
    if (d.serverBusy) return { tone: 'warn', label: 'server working' };
    if (d.queuedCount > 0) return { tone: 'warn', label: 'queued' };
    if (d.agentState === 'active') return { tone: 'warn', label: 'active' };
    return { tone: 'ok', label: 'ok' };
  }

  _fmtAgo(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms / 60000)}min`;
  }

  render() {
    if (!this.enabled) return null;
    const d = this.data || {};
    const v = this._verdict();
    const wsStateLabel = d.wsState || '—';
    const showBody = !this._collapsed;
    return html`
      <div class="panel">
        <div class="head" @click=${this.toggle}>
          <span>Diagnostics</span>
          <span class="badge badge--${v.tone}">${v.label}</span>
          ${showBody ? null : html`<span class="k">…</span>`}
        </div>
        ${showBody
          ? html`
              <div class="body">
                <div class="row"><span class="k">WS</span><span class="v">${wsStateLabel}</span></div>
                <div class="row">
                  <span class="k">connection</span>
                  <span class="v">${d.connectionStatus || '—'}</span>
                </div>
                <div class="row">
                  <span class="k">agent</span>
                  <span class="v">${d.agentState || '—'}</span>
                </div>
                <div class="row">
                  <span class="k">last pong</span>
                  <span class="v">${this._fmtAgo(d.lastPongAgoMs)}</span>
                </div>
                <div class="row">
                  <span class="k">last SDK event</span>
                  <span class="v">${this._fmtAgo(d.lastSdkEventAgoMs)}</span>
                </div>
                <div class="row">
                  <span class="k">reconnect</span>
                  <span class="v">${d.reconnectAttempts ?? 0}</span>
                </div>
                <div class="row">
                  <span class="k">server busy</span>
                  <span class="v ${d.serverBusy ? 'v--warn' : ''}">${d.serverBusy ? 'yes' : 'no'}</span>
                </div>
                <div class="row">
                  <span class="k">setup phase</span>
                  <span class="v ${d.serverStuckInSetup ? 'v--bad' : ''}">${d.serverSetupPhase || '—'}</span>
                </div>
                <div class="row">
                  <span class="k">current run</span>
                  <span class="v">${d.serverHasCurrentRun ? 'yes' : 'no'}</span>
                </div>
                <div class="row">
                  <span class="k">queue</span>
                  <span class="v ${d.queuedCount > 0 ? 'v--warn' : ''}">${d.queuedCount ?? 0}</span>
                </div>
                <div class="row">
                  <span class="k">last server event</span>
                  <span class="v">${this._fmtAgo(d.serverLastEventAgoMs)}</span>
                </div>
                <div class="row">
                  <span class="k">clients</span>
                  <span class="v">${d.serverClients ?? '—'}</span>
                </div>
                <div class="row">
                  <span class="k">last type</span>
                  <span class="v">${d.serverLastEventType || '—'}</span>
                </div>
                <div class="row">
                  <span class="k">client seq</span>
                  <span class="v">${d.clientRoomEventSeq ?? '—'}</span>
                </div>
                <div class="row">
                  <span class="k">server seq</span>
                  <span class="v">${d.serverRoomEventSeq ?? '—'}</span>
                </div>
                <div class="row">
                  <span class="k">seq gap</span>
                  <span class="v ${d.roomEventSeqGap != null && d.roomEventSeqGap > 0 ? 'v--warn' : ''}">${d.roomEventSeqGapLabel || '—'}</span>
                </div>
              </div>
              ${d.serverStuckInSetup
                ? html`<div class="hint">
                    Server is busy without an active run — likely stuck in agent.send()/connect.
                    Use Cancel run or wait for setup timeout.
                  </div>`
                : d.serverLastEventAgoMs != null && d.serverBusy && d.serverLastEventAgoMs > 30000
                ? html`<div class="hint">
                    Server reports busy but no event for &gt;30s — the SDK stream is likely stuck.
                    Try Stop, or reload the chat if that does not help.
                  </div>`
                : null}
            `
          : null}
      </div>
    `;
  }
}

if (!customElements.get('cr-chat-diag')) {
  customElements.define('cr-chat-diag', CrChatDiag);
}
