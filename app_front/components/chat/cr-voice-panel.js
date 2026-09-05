import { LitElement, css, html } from 'lit';
import { t } from '../../i18n/index.js';
import { getSettings } from '../../api.js';
import { createRealtimeSession } from '../../features/voice/realtimeSession.js';
import { createGeminiLiveSession } from '../../features/voice/geminiLiveSession.js';
import { formatUsd } from '../../features/voice/voiceCost.js';
import { appendVoiceLog } from '../../features/voice/voiceLog.js';
import {
  GEMINI_LIVE_VOICES,
  REALTIME_PROVIDER_MODELS,
  REALTIME_VOICE_OPTIONS,
  getGeminiLiveVoice,
  getReadMode,
  getRealtimeProvider,
  getRealtimeVoice,
  setGeminiLiveVoice,
  setReadMode,
  setRealtimeProvider,
  setRealtimeVoice,
} from '../../features/voice/voicePrefs.js';
import { getChatSpeaker } from '../../features/voice/chatSpeaker.js';
import { setVoiceSessionStatus, setVoiceSessionUsd } from '../../features/voice/voiceSessionState.js';
import { classifyMicKind, createMicLevelMonitor, playLiveOutputTest } from '../../features/voice/liveAudioRoute.js';
import { watchVoiceAgentRun } from '../../features/voice/voiceAgentRunWatch.js';
import { listVoiceCommandGroups } from '../../features/voice/voiceCommandCatalog.js';
import {
  appendVoiceSessionEvent,
  copyVoiceSessionIdToClipboard,
  finishVoiceSessionLog,
  startVoiceSessionLog,
} from '../../features/voice/voiceSessionLog.js';
import '../ui/cr-dialog.js';
import '../ui/cr-bar-button.js';
import '../ui/cr-bar-select.js';

/** Keeps the live transcript short — this is a session view, not chat history. */
const MAX_LOG_ENTRIES = 14;

/**
 * Voice conversation panel: connects the Realtime session and shows what it
 * heard, said, and did. The session itself lives in `realtimeSession.js`; this
 * component only drives it and renders its state.
 */
class CrVoicePanel extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    status: { type: String },
    micMuted: { type: Boolean },
    totalUsd: { type: Number },
    errorText: { type: String },
    noticeText: { type: String },
    log: { type: Array },
    provider: { type: String },
    openAiReady: { type: Boolean },
    geminiReady: { type: Boolean },
    micLabel: { type: String },
    micDeviceId: { type: String },
    micInputs: { type: Array },
    speakerDeviceId: { type: String },
    speakerOutputs: { type: Array },
    agentRunStatus: { type: String },
    commandsOpen: { type: Boolean },
    testingOutput: { type: Boolean },
    sessionId: { type: String },
    sessionCopied: { type: Boolean },
  };

  static styles = css`
    :host {
      display: contents;
      --cr-dialog-max-width: 30rem;
    }
    .status {
      display: flex;
      align-items: center;
      gap: var(--cr-space-2);
      margin-bottom: var(--cr-space-3);
      font-size: 0.85rem;
      color: var(--cr-text-muted);
    }
    .dot {
      width: 0.6rem;
      height: 0.6rem;
      border-radius: 50%;
      background: var(--cr-text-muted);
      flex: 0 0 auto;
    }
    .dot[data-state='connecting'] {
      background: var(--cr-accent);
      animation: pulse 1s ease-in-out infinite;
    }
    .dot[data-state='live'] {
      background: var(--cr-success);
    }
    .dot[data-state='error'] {
      background: var(--cr-error);
    }
    @keyframes pulse {
      50% {
        opacity: 0.25;
      }
    }
    .cost {
      font-variant-numeric: tabular-nums;
    }
    .status-actions {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: var(--cr-space-2);
      flex: 0 0 auto;
    }
    .help-btn {
      box-sizing: border-box;
      min-height: var(--cr-control-height);
      padding: 0 0.55rem;
      border: 1px solid var(--cr-border-subtle);
      border-radius: var(--cr-radius-sm);
      background: var(--cr-control-idle-bg);
      color: var(--cr-text-muted);
      font: inherit;
      font-size: 0.78rem;
      cursor: pointer;
    }
    .help-btn:hover,
    .help-btn[aria-expanded='true'] {
      color: var(--cr-text);
      border-color: var(--cr-border-strong);
    }
    .help-btn:focus {
      outline: none;
      border-color: var(--cr-input-focus-border);
    }
    .commands {
      max-height: 16rem;
      overflow-y: auto;
      border: 1px solid var(--cr-border-strong);
      border-radius: var(--cr-radius-sm);
      background: var(--cr-bg);
      padding: var(--cr-space-2) var(--cr-space-3);
      margin-bottom: var(--cr-space-3);
    }
    .commands-hint {
      margin: 0 0 var(--cr-space-3);
      font-size: 0.78rem;
      color: var(--cr-text-muted);
      line-height: 1.4;
    }
    .commands-group {
      margin: 0 0 var(--cr-space-3);
    }
    .commands-group:last-child {
      margin-bottom: 0;
    }
    .commands-group-title {
      margin: 0 0 var(--cr-space-1);
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--cr-text-muted);
    }
    .commands-list {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .commands-list li {
      margin: 0 0 0.35rem;
      font-size: 0.82rem;
      line-height: 1.4;
    }
    .commands-list li:last-child {
      margin-bottom: 0;
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--cr-space-2);
      margin-bottom: var(--cr-space-3);
      flex-wrap: wrap;
    }
    .row-label {
      font-size: 0.8rem;
      color: var(--cr-text-muted);
    }
    .log {
      max-height: 15rem;
      overflow-y: auto;
      border: 1px solid var(--cr-border-strong);
      border-radius: var(--cr-radius-sm);
      background: var(--cr-bg);
      padding: var(--cr-space-2);
      font-size: 0.82rem;
      line-height: 1.45;
    }
    .log-empty {
      color: var(--cr-text-muted);
    }
    .entry {
      margin: 0 0 var(--cr-space-1);
      word-break: break-word;
    }
    .entry:last-child {
      margin-bottom: 0;
    }
    .entry-role {
      color: var(--cr-text-muted);
      margin-right: 0.35rem;
    }
    .entry[data-kind='tool'] {
      color: var(--cr-accent);
      font-family: var(--cr-font-mono);
      font-size: 0.78rem;
    }
    .entry[data-kind='tool'][data-failed] {
      color: var(--cr-error);
    }
    .message {
      margin: 0 0 var(--cr-space-3);
      padding: var(--cr-space-2) var(--cr-space-3);
      border-radius: var(--cr-radius-sm);
      border: 1px solid transparent;
      font-size: 0.82rem;
    }
    .message[data-tone='error'] {
      background: var(--cr-error-bg);
      color: var(--cr-error);
      border-color: var(--cr-error-border);
    }
    .message[data-tone='warn'] {
      background: var(--cr-surface);
      color: var(--cr-text);
      border-color: var(--cr-border-strong);
    }
    /* cr-dialog exposes the actions slot bare, so the row is laid out here. */
    .actions {
      display: flex;
      gap: var(--cr-space-2);
      justify-content: flex-end;
      flex-wrap: wrap;
      margin-top: var(--cr-space-3);
    }
    .actions cr-bar-button {
      flex: 1 1 auto;
    }
    .mic-meter {
      margin-bottom: var(--cr-space-3);
    }
    .mic-meter-head {
      display: flex;
      align-items: baseline;
      gap: var(--cr-space-2);
      margin-bottom: var(--cr-space-1);
      font-size: 0.8rem;
      min-width: 0;
    }
    .mic-meter-kind {
      font-weight: 600;
      flex: 0 0 auto;
      color: var(--cr-text);
    }
    .mic-meter[data-kind='headset'] .mic-meter-kind {
      color: var(--cr-success);
    }
    .mic-meter[data-kind='phone'] .mic-meter-kind {
      color: var(--cr-accent);
    }
    .mic-meter-device {
      color: var(--cr-text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .mic-meter-bar {
      height: 0.45rem;
      border-radius: 999px;
      background: var(--cr-surface);
      border: 1px solid var(--cr-border-strong);
      overflow: hidden;
    }
    .mic-meter-fill {
      height: 100%;
      width: 100%;
      transform: scaleX(0);
      transform-origin: left center;
      background: var(--cr-success);
      transition: transform 80ms linear;
    }
    .mic-meter[data-muted] .mic-meter-fill {
      background: var(--cr-text-muted);
    }
    .agent-run {
      margin: 0 0 var(--cr-space-3);
      padding: var(--cr-space-2) var(--cr-space-3);
      border-radius: var(--cr-radius-sm);
      border: 1px solid var(--cr-border-strong);
      background: var(--cr-surface);
      font-size: 0.82rem;
      color: var(--cr-text);
    }
    .agent-run[data-phase='working'] {
      border-color: var(--cr-accent);
    }
    .agent-run[data-phase='awaiting'] {
      border-color: var(--cr-accent);
    }
    .agent-run[data-phase='finished'] {
      color: var(--cr-text-muted);
    }
    .session-id {
      margin: 0 0 var(--cr-space-3);
      font-size: 0.78rem;
      color: var(--cr-text-muted);
      word-break: break-all;
    }
    .session-id code {
      font-family: var(--cr-font-mono);
      color: var(--cr-text);
    }
  `;

  constructor() {
    super();
    this.open = false;
    this.status = 'idle';
    this.micMuted = false;
    this.totalUsd = 0;
    this.errorText = '';
    this.noticeText = '';
    /** @type {Array<{ kind: string, role?: string, text: string, failed?: boolean }>} */
    this.log = [];
    this.provider = getRealtimeProvider();
    this.openAiReady = false;
    this.geminiReady = false;
    this.micLabel = '';
    this.micDeviceId = '';
    /** @type {Array<{ deviceId: string, label: string, kind: string }>} */
    this.micInputs = [];
    this.speakerDeviceId = '';
    /** @type {Array<{ deviceId: string, label: string, kind: string }>} */
    this.speakerOutputs = [];
    this.agentRunStatus = '';
    this.commandsOpen = false;
    this.testingOutput = false;
    this.sessionId = '';
    this.sessionCopied = false;
    this._closeAfterVoiceEnd = false;
    this._savedReadMode = '';
    /** @type {ReturnType<typeof createRealtimeSession>|null} */
    this._session = null;
    this._sessionProvider = '';
    /** @type {{ stop: () => void }|null} */
    this._micMonitor = null;
    /** @type {(() => void)|null} */
    this._stopAgentWatchFn = null;
    void this._loadKeyStatus();
  }

  async _loadKeyStatus() {
    try {
      const settings = await getSettings();
      this.openAiReady = settings?.openaiApiKeyEffective === true;
      this.geminiReady = settings?.geminiApiKeyEffective === true;
    } catch {
      this.openAiReady = false;
      this.geminiReady = false;
    }
  }

  disconnectedCallback() {
    this._stopMicMonitor();
    this._stopAgentWatch();
    this._session?.stop();
    this._restoreReadMode();
    getChatSpeaker().setAnswerTracking(false);
    void finishVoiceSessionLog();
    super.disconnectedCallback();
  }

  /**
   * @param {Map<string, unknown>} changed
   * @returns {void}
   */
  updated(changed) {
    if (!changed.has('status')) return;
    if (this.status === 'live') {
      this._startMicMonitor();
      return;
    }
    this._stopMicMonitor();
    this.micLabel = '';
    this.micDeviceId = '';
    this.micInputs = [];
    this.speakerDeviceId = '';
    this.speakerOutputs = [];
    this._stopAgentWatch();
    this.agentRunStatus = '';
  }

  _startMicMonitor() {
    this._stopMicMonitor();
    const stream = this._session?.getMicStream?.();
    const track = stream?.getAudioTracks?.()[0];
    this.micLabel = String(track?.label || '');
    this.micDeviceId = String(track?.getSettings?.()?.deviceId || '');
    void this._refreshAudioDevices();
    if (!this.micLabel) {
      window.setTimeout(() => {
        const later = this._session?.getMicStream?.()?.getAudioTracks?.()[0];
        if (later?.label) this.micLabel = later.label;
      }, 400);
    }
    this._micMonitor = createMicLevelMonitor(stream, (level) => {
      const fill = this.renderRoot?.querySelector?.('.mic-meter-fill');
      if (!fill) return;
      fill.style.transform = `scaleX(${this.micMuted ? 0 : level})`;
    });
  }

  _stopMicMonitor() {
    this._micMonitor?.stop();
    this._micMonitor = null;
  }

  _stopAgentWatch() {
    this._stopAgentWatchFn?.();
    this._stopAgentWatchFn = null;
  }

  /**
   * @returns {Promise<void>}
   */
  async _watchAgentAfterPrompt() {
    this._stopAgentWatch();
    this.agentRunStatus = 'working';
    let chatModule = null;
    try {
      chatModule = await import('../../chat.js');
    } catch {
      this.agentRunStatus = '';
      return;
    }
    this._stopAgentWatchFn = watchVoiceAgentRun({
      isBusy: () => {
        const activeId = chatModule.getActiveChatIdValue();
        const chat = chatModule.getChatsList().find((item) => item.id === activeId);
        const state = chat ? chatModule.getChatListAgentStatePublic(chat) : 'disconnected';
        return state === 'active';
      },
      isAwaiting: () => {
        const activeId = chatModule.getActiveChatIdValue();
        const chat = chatModule.getChatsList().find((item) => item.id === activeId);
        const state = chat ? chatModule.getChatListAgentStatePublic(chat) : 'disconnected';
        return state === 'awaiting';
      },
      onBusy: (phase) => {
        this.agentRunStatus = phase;
      },
      onIdle: ({ timedOut }) => {
        this.agentRunStatus = timedOut ? '' : 'finished';
        if (!timedOut) this.noticeText = t('voice.agentFinished');
      },
    });
  }

  async _refreshAudioDevices() {
    const inputs = (await this._session?.listMicInputs?.()) || [];
    const outputs = (await this._session?.listSpeakerOutputs?.()) || [];
    this.micInputs = inputs;
    this.speakerOutputs = outputs;
    if (!this.micDeviceId) {
      const current = this._session?.getMicStream?.()?.getAudioTracks?.()[0];
      this.micDeviceId = String(current?.getSettings?.()?.deviceId || inputs[0]?.deviceId || '');
    }
    if (!this.speakerDeviceId) {
      const headset = outputs.find((item) => item.kind === 'headset');
      this.speakerDeviceId = String(headset?.deviceId || outputs[0]?.deviceId || '');
    }
  }

  /**
   * @param {string} deviceId
   * @returns {Promise<void>}
   */
  async _onSpeakerOutputChange(deviceId) {
    if (!deviceId || !this._session?.switchSpeaker) return;
    try {
      const ok = await this._session.switchSpeaker(deviceId);
      if (!ok) {
        this.noticeText = t('voice.speakerOnlyPhone');
        return;
      }
      this.speakerDeviceId = deviceId;
    } catch (error) {
      this.noticeText = error instanceof Error ? error.message : String(error);
    }
  }

  async _onMicInputChange(deviceId) {
    if (!deviceId || !this._session?.switchMic) return;
    try {
      const label = await this._session.switchMic(deviceId);
      this.micDeviceId = deviceId;
      this.micLabel =
        label || this.micInputs.find((item) => item.deviceId === deviceId)?.label || '';
      this._startMicMonitor();
    } catch (error) {
      this.noticeText = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * @param {{ kind: string, role?: string, text: string, failed?: boolean }} entry
   * @returns {void}
   */
  _pushLog(entry) {
    this.log = appendVoiceLog(this.log, entry, MAX_LOG_ENTRIES);
    if (entry.kind === 'speech') {
      appendVoiceSessionEvent('transcript', { role: entry.role, text: entry.text });
    }
  }

  _restoreReadMode() {
    if (!this._savedReadMode) return;
    if (this._savedReadMode !== 'off') setReadMode(this._savedReadMode);
    this._savedReadMode = '';
  }

  async _beginVoiceSessionLog(provider, model) {
    let chatId = '';
    try {
      const chatModule = await import('../../chat.js');
      chatId = chatModule.getActiveChatIdValue?.() || '';
    } catch {
      chatId = '';
    }
    this.sessionId = startVoiceSessionLog(chatId, { provider, model });
    this.sessionCopied = false;
  }

  async _copySessionId() {
    const copied = await copyVoiceSessionIdToClipboard();
    this.sessionCopied = copied;
    if (copied) {
      this.noticeText = t('voice.sessionIdCopied');
      window.setTimeout(() => {
        if (this.sessionCopied) this.sessionCopied = false;
      }, 1800);
    }
  }

  _sessionCallbacks() {
    return {
      onStatusChange: (status, detail) => {
        this.status = status;
        setVoiceSessionStatus(status);
        appendVoiceSessionEvent('status', { status, detail: detail || '' });
        if (status === 'error') {
          this.errorText = detail ? this._translateNotice(detail) : t('voice.realtimeFailed');
        }
        if (status === 'live' || status === 'idle') this.micMuted = false;
        if (status !== 'live') this.micLabel = '';
        if (status === 'idle') {
          void finishVoiceSessionLog({ status, totalUsd: this.totalUsd });
          this._restoreReadMode();
        }
        if (status === 'idle' && this._closeAfterVoiceEnd) {
          this._closeAfterVoiceEnd = false;
          this._stopAgentWatch();
          this.agentRunStatus = '';
          getChatSpeaker().setAnswerTracking(false);
          this.open = false;
          this.dispatchEvent(new CustomEvent('cr-voice-panel-close', { bubbles: true, composed: true }));
        }
      },
      onTranscript: ({ role, text }) => this._pushLog({ kind: 'speech', role, text }),
      onToolCall: ({ name, result }) => {
        this._pushLog({ kind: 'tool', text: `${name}: ${result?.ok ? 'ok' : result?.error || 'error'}`, failed: !result?.ok });
        if (name === 'send_prompt' && result?.ok) this._watchAgentAfterPrompt();
        if (name === 'end_voice_mode' && result?.ok) this._closeAfterVoiceEnd = true;
      },
      onCostChange: ({ totalUsd }) => {
        this.totalUsd = totalUsd;
        setVoiceSessionUsd(totalUsd);
      },
      onNotice: (message) => {
        this.noticeText = this._translateNotice(message);
      },
    };
  }

  _ensureSession() {
    const provider = getRealtimeProvider();
    if (this._session && this._sessionProvider === provider) return this._session;
    this._session?.stop();
    this._sessionProvider = provider;
    this._session =
      provider === 'gemini'
        ? createGeminiLiveSession(this._sessionCallbacks())
        : createRealtimeSession(this._sessionCallbacks());
    return this._session;
  }

  /**
   * Session notices arrive as `key:value` so the session stays free of i18n.
   *
   * @param {string} message
   * @returns {string}
   */
  _translateNotice(message) {
    const raw = String(message || '');
    if (raw.startsWith('voice.costWarn:')) {
      return t('voice.costWarn', { amount: formatUsd(Number(raw.split(':')[1])) });
    }
    if (raw.startsWith('voice.costCap:')) {
      return t('voice.costCap', { amount: formatUsd(Number(raw.split(':')[1])) });
    }
    // Bare keys come from the session layer, which stays free of i18n.
    if (raw.startsWith('voice.')) return t(raw);
    return raw;
  }

  async _toggleSession() {
    const session = this._ensureSession();
    if (session.isLive() || this.status === 'connecting') {
      session.stop();
      this._stopAgentWatch();
      this.agentRunStatus = '';
      this._restoreReadMode();
      getChatSpeaker().setAnswerTracking(false);
      return;
    }
    this.errorText = '';
    this.noticeText = '';
    this.totalUsd = 0;
    setVoiceSessionUsd(0);
    this._closeAfterVoiceEnd = false;
    this._savedReadMode = getReadMode();
    setReadMode('off');
    getChatSpeaker().stop();
    getChatSpeaker().setAnswerTracking(true);
    const provider = getRealtimeProvider();
    await this._beginVoiceSessionLog(provider, REALTIME_PROVIDER_MODELS[provider]);
    const started = await session.start({
      voice: provider === 'gemini' ? getGeminiLiveVoice() : getRealtimeVoice(),
      model: REALTIME_PROVIDER_MODELS[provider],
    });
    if (!started) {
      getChatSpeaker().setAnswerTracking(false);
      this._restoreReadMode();
      void finishVoiceSessionLog({ status: 'error' });
    }
  }

  _toggleMic() {
    if (!this._session?.isLive()) return;
    const next = !this.micMuted;
    this._session.setMicMuted(next);
    this.micMuted = next;
  }

  show() {
    this.open = true;
  }

  /**
   * Closes the window but leaves the conversation running, so the user can work
   * in the app while talking. The header button keeps a live marker, so the
   * still-billing session is not invisible.
   *
   * @returns {void}
   */
  hide() {
    this.open = false;
  }

  _onDialogClose() {
    // Leaving the panel open in the background would keep billing silently.
    this._session?.stop();
    this._stopAgentWatch();
    this.agentRunStatus = '';
    this.commandsOpen = false;
    this._restoreReadMode();
    getChatSpeaker().setAnswerTracking(false);
    void finishVoiceSessionLog({ status: this.status, totalUsd: this.totalUsd });
    this.open = false;
    this.dispatchEvent(new CustomEvent('cr-voice-panel-close', { bubbles: true, composed: true }));
  }

  /**
   * @returns {Array<{ value: string, label: string }>}
   */
  _providerOptions() {
    return [
      { value: 'openai-mini', label: t('voice.providerMini') },
      { value: 'openai', label: t('voice.providerFlagship') },
      {
        value: 'gemini',
        label: this.geminiReady ? t('voice.providerGemini') : `${t('voice.providerGemini')} (${t('voice.noKey')})`,
      },
    ];
  }

  /**
   * @returns {Array<{ value: string, label: string }>}
   */
  _voiceOptions() {
    const voices = this.provider === 'gemini' ? GEMINI_LIVE_VOICES : REALTIME_VOICE_OPTIONS;
    return voices.map((voice) => ({ value: voice, label: voice }));
  }

  /**
   * @param {string} value
   * @returns {void}
   */
  _onProviderChange(value) {
    if (value === 'gemini' && !this.geminiReady) {
      this.noticeText = t('voice.geminiNeedsKey');
      return;
    }
    if ((value === 'openai' || value === 'openai-mini') && !this.openAiReady) {
      this.noticeText = t('voice.engineNeedsKey');
    }
    setRealtimeProvider(value);
    this.provider = getRealtimeProvider();
    this.noticeText = '';
  }

  /**
   * @param {string} value
   * @returns {void}
   */
  _onVoiceChange(value) {
    if (this.provider === 'gemini') setGeminiLiveVoice(value);
    else setRealtimeVoice(value);
  }

  _toggleCommands() {
    this.commandsOpen = !this.commandsOpen;
  }

  async _playOutputTest() {
    if (this.testingOutput) return;
    this.testingOutput = true;
    this.errorText = '';
    try {
      const play = this._session?.playTestTone;
      const ok = play
        ? await play(this.speakerDeviceId)
        : await playLiveOutputTest({ sinkId: this.speakerDeviceId });
      this.noticeText = ok ? t('voice.testOutputHint') : t('voice.testOutputFailed');
    } catch (error) {
      this.noticeText = error instanceof Error ? error.message : t('voice.testOutputFailed');
    } finally {
      this.testingOutput = false;
    }
  }

  _renderCommands() {
    return html`
      <div class="commands" role="region" aria-label=${t('voice.commandsTitle')}>
        <p class="commands-hint">${t('voice.commandsHint')}</p>
        ${listVoiceCommandGroups().map(
          (group) => html`
            <section class="commands-group">
              <h3 class="commands-group-title">${t(`voice.commandsGroup.${group.id}`)}</h3>
              <ul class="commands-list">
                ${group.commands.map((entry) => html`<li>${t(`voice.command.${entry.id}`)}</li>`)}
              </ul>
            </section>
          `
        )}
      </div>
    `;
  }

  _renderMicMeter() {
    const live = this.status === 'live';
    if (!live && this.status !== 'connecting') return '';
    const kind = classifyMicKind(this.micLabel);
    const device = this.micLabel || t('voice.micUnnamed');
    return html`
      <div
        class="mic-meter"
        data-kind=${kind}
        ?data-muted=${this.micMuted}
        ?data-live=${live}
      >
        <div class="mic-meter-head">
          <span class="mic-meter-kind">${t('voice.micLevel')}</span>
          <span class="mic-meter-device">${t(`voice.micKind.${kind}`)}: ${device}</span>
        </div>
        <div
          class="mic-meter-bar"
          role="meter"
          aria-label=${t('voice.micLevel')}
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div class="mic-meter-fill"></div>
        </div>
        ${this.speakerOutputs.length > 0
          ? html`
              <div class="row" style="margin-top: var(--cr-space-2); margin-bottom: 0">
                <span class="row-label">${t('voice.speakerOutput')}</span>
                <cr-bar-select
                  size="sm"
                  .options=${this.speakerOutputs.map((item) => ({
                    value: item.deviceId,
                    label: `${t(`voice.micKind.${item.kind}`)}: ${item.label}`,
                  }))}
                  .value=${this.speakerDeviceId}
                  @cr-change=${(event) => this._onSpeakerOutputChange(event.detail?.value || '')}
                ></cr-bar-select>
              </div>
            `
          : ''}
        ${this.micInputs.length > 0
          ? html`
              <div class="row" style="margin-top: var(--cr-space-2); margin-bottom: 0">
                <span class="row-label">${t('voice.micInput')}</span>
                <cr-bar-select
                  size="sm"
                  .options=${this.micInputs.map((item) => ({
                    value: item.deviceId,
                    label: `${t(`voice.micKind.${item.kind}`)}: ${item.label}`,
                  }))}
                  .value=${this.micDeviceId}
                  @cr-change=${(event) => this._onMicInputChange(event.detail?.value || '')}
                ></cr-bar-select>
              </div>
            `
          : ''}
        ${live && this.speakerOutputs.length > 0 && !this.speakerOutputs.some((item) => item.kind === 'headset')
          ? html`<p class="message" data-tone="warn" style="margin-top: var(--cr-space-2); margin-bottom: 0">
              ${t('voice.speakerOnlyPhone')}
            </p>`
          : ''}
        ${live && this.micInputs.length > 0 && !this.micInputs.some((item) => item.kind === 'headset')
          ? html`<p class="message" data-tone="warn" style="margin-top: var(--cr-space-2); margin-bottom: 0">
              ${t('voice.micOnlyPhone')}
            </p>`
          : ''}
      </div>
    `;
  }

  _renderLog() {
    if (this.log.length === 0) {
      return html`<div class="log"><p class="entry log-empty">${t('voice.logEmpty')}</p></div>`;
    }
    return html`
      <div class="log">
        ${this.log.map((entry) =>
          entry.kind === 'tool'
            ? html`<p class="entry" data-kind="tool" ?data-failed=${entry.failed}>${entry.text}</p>`
            : html`<p class="entry" data-kind="speech">
                <span class="entry-role"
                  >${entry.role === 'user' ? t('voice.roleUser') : t('voice.roleAgent')}:</span
                >${entry.text}
              </p>`
        )}
      </div>
    `;
  }

  render() {
    const live = this.status === 'live';
    const busy = this.status === 'connecting';
    return html`
      <cr-dialog
        .open=${this.open}
        heading=${t('voice.realtimeTitle')}
        @cr-dialog-close=${this._onDialogClose}
      >
        <div class="status">
          <span class="dot" data-state=${this.status}></span>
          <span>${t(`voice.status.${this.status}`)}</span>
          <span class="status-actions">
            <button
              type="button"
              class="help-btn"
              aria-expanded=${this.commandsOpen ? 'true' : 'false'}
              title=${t('voice.commandsTitle')}
              @click=${() => this._toggleCommands()}
            >
              ${this.commandsOpen ? t('voice.commandsClose') : t('voice.commandsOpen')}
            </button>
            <span class="cost">${formatUsd(this.totalUsd)}</span>
          </span>
        </div>
        ${this.agentRunStatus
          ? html`<p class="agent-run" data-phase=${this.agentRunStatus}>
              ${t(`voice.agentRun.${this.agentRunStatus}`)}
            </p>`
          : ''}

        ${this.errorText ? html`<p class="message" data-tone="error">${this.errorText}</p>` : ''}
        ${this.noticeText ? html`<p class="message" data-tone="warn">${this.noticeText}</p>` : ''}
        ${this.sessionId
          ? html`<p class="session-id">
              ${t('voice.sessionId')}: <code>${this.sessionId}</code>
            </p>`
          : ''}

        <div class="row">
          <span class="row-label">${t('voice.model')}</span>
          <cr-bar-select
            size="sm"
            .options=${this._providerOptions()}
            .value=${this.provider}
            ?disabled=${live || busy}
            @cr-change=${(event) => this._onProviderChange(event.detail?.value || '')}
          ></cr-bar-select>
        </div>
        <div class="row">
          <span class="row-label">${t('voice.voice')}</span>
          <cr-bar-select
            size="sm"
            .options=${this._voiceOptions()}
            .value=${this.provider === 'gemini' ? getGeminiLiveVoice() : getRealtimeVoice()}
            ?disabled=${live || busy}
            @cr-change=${(event) => this._onVoiceChange(event.detail?.value || '')}
          ></cr-bar-select>
        </div>

        ${this._renderMicMeter()}
        ${this.commandsOpen ? this._renderCommands() : this._renderLog()}

        <div class="actions" slot="actions">
          <cr-bar-button
            variant=${live || busy ? 'default' : 'primary'}
            @click=${() => this._toggleSession()}
            >${live || busy ? t('voice.stopSession') : t('voice.startSession')}</cr-bar-button
          >
          <cr-bar-button ?disabled=${!live} @click=${() => this._toggleMic()}
            >${this.micMuted ? t('voice.unmute') : t('voice.mute')}</cr-bar-button
          >
          <cr-bar-button ?disabled=${!live} @click=${() => this._session?.interrupt()}
            >${t('voice.interrupt')}</cr-bar-button
          >
          <cr-bar-button
            ?disabled=${this.testingOutput}
            title=${t('voice.testOutputTitle')}
            @click=${() => this._playOutputTest()}
            >${t('voice.testOutput')}</cr-bar-button
          >
          ${this.sessionId
            ? html`<cr-bar-button
                title=${t('voice.copySessionIdTitle')}
                @click=${() => this._copySessionId()}
                >${this.sessionCopied ? t('voice.sessionIdCopiedShort') : t('voice.copySessionId')}</cr-bar-button
              >`
            : ''}
          ${live || busy
            ? html`<cr-bar-button title=${t('voice.hidePanelTitle')} @click=${() => this.hide()}
                >${t('voice.hidePanel')}</cr-bar-button
              >`
            : ''}
        </div>
      </cr-dialog>
    `;
  }
}

if (!customElements.get('cr-voice-panel')) {
  customElements.define('cr-voice-panel', CrVoicePanel);
}

/** @type {CrVoicePanel|null} */
let sharedPanel = null;

/**
 * Opens the single shared voice panel, creating it on first use.
 *
 * @returns {CrVoicePanel}
 */
export function openVoiceModePanel() {
  if (!sharedPanel) {
    sharedPanel = /** @type {CrVoicePanel} */ (document.createElement('cr-voice-panel'));
    document.body.appendChild(sharedPanel);
  }
  sharedPanel.show();
  return sharedPanel;
}

export { CrVoicePanel };
