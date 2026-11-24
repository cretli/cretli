import { html, nothing, render } from 'lit';
import { getCurrentLang, t } from '../../i18n/index.js';
import { DICTATION_LANGS } from './browserSpeechInput.js';
import { getChatSpeaker, VOICE_ERROR_EVENT, VOICE_SPEAKING_EVENT } from './chatSpeaker.js';
import { getBrowserVoiceMode } from './browserVoiceMode.js';
import { isVoiceSessionActive } from './voiceSessionState.js';
import { resolveTtsEngine } from './ttsEngine.js';
import { getOutputSinkId, getTtsEngineId, setOutputSinkId } from './voicePrefs.js';
import { createVoiceReadOptions } from './voiceReadControls.js';
import {
  collectVoiceDiagnostics,
  createDiagnosticsCoordinator,
  createDisposer,
  shouldCancelOnIntersection,
  runMicTest,
  runRecognitionTest,
  voiceErrorKeys,
} from './voiceDiagnostics.js';
import '../../components/ui/cr-bar-button.js';
import '../../components/ui/cr-bar-select.js';

/** Settings → Interface → Voice → "Microphone and sound". Light DOM, rendered with Lit. */

const SPEAKER_TEST_TOKEN = 'voice-diagnostics-speaker-test';
const ENGINE_LABEL_KEYS = { browser: 'voice.engineBrowser', openai: 'voice.engineOpenAi', azure: 'voice.engineAzure' };

/** @type {HTMLElement|null} */
let mount = null;
let optionsRoot = null;
/** Window/observer registrations of the current mount; released when the host changes. */
const disposer = createDisposer();
const view = {
  report: null,
  micTesting: false,
  micLevel: 0,
  micResult: null,
  recTesting: false,
  recResult: null,
  speakerEngine: '',
  speakerMessage: '',
  sinks: [],
};
const coordinator = createDiagnosticsCoordinator({
  isRealtimeActive: isVoiceSessionActive,
  getVoiceMode: getBrowserVoiceMode,
  isSpeaking: () => getChatSpeaker().isSpeaking?.() === true || view.appSpeaking,
});
/** Speaking state of the app, from VOICE_SPEAKING_EVENT (the recognition test must not hear it). */
view.appSpeaking = false;
/** Safety net: a sample that never reports its end must not lock the other tests. */
const SPEAKER_SAMPLE_MAX_MS = 20000;
let speakerFallbackTimer = 0;
let speakerSession = null;

function recognitionLocale() {
  return DICTATION_LANGS[getCurrentLang()] || DICTATION_LANGS.en;
}

/** Stops the sample and every running test; the UI of a cancelled run is not updated. */
export function cancelVoiceDiagnostics() {
  coordinator.cancel();
  endSpeakerSample(true);
  view.micTesting = false;
  view.micLevel = 0;
  view.recTesting = false;
  update();
}

function endSpeakerSample(stopPlayback) {
  window.clearTimeout(speakerFallbackTimer);
  const session = speakerSession;
  speakerSession = null;
  if (session) {
    session.finish();
    if (stopPlayback) getChatSpeaker().stop();
  }
}

function blockMessage(code) {
  return t(`voice.diag.block.${code}`);
}

function update() {
  if (mount) render(template(), mount);
}

function yesNo(value) {
  return value ? t('voice.diag.yes') : t('voice.diag.no');
}

function permissionLabel(state) {
  return t(`voice.diag.permission.${state}`);
}

function errorLine(result) {
  if (!result || result.ok) return nothing;
  if (result.blocked) return html`<p class="cr-hint" data-tone="error" role="alert">${blockMessage(result.blocked)}</p>`;
  if (result.code === 'cancelled') return nothing;
  if (result.code === 'no-speech') return html`<p class="cr-hint" data-tone="error">${t('voice.diag.noSpeech')}</p>`;
  const keys = voiceErrorKeys(result.code);
  return html`<p class="cr-hint" data-tone="error" role="alert">${t(keys.message)} ${t(keys.advice)}</p>`;
}

async function refreshReport() {
  view.report = await collectVoiceDiagnostics({ win: window, nav: navigator });
  view.sinks = [];
  if (view.report.outputSelection && typeof navigator.mediaDevices?.enumerateDevices === 'function') {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      view.sinks = devices.filter((device) => device.kind === 'audiooutput');
    } catch {
      // Listing outputs is optional; the select just stays empty.
    }
  }
  update();
}

async function testMic() {
  if (view.micTesting) {
    // "Stop test": the cancelled run no longer updates the UI, so reset it here.
    coordinator.cancel();
    view.micTesting = false;
    view.micLevel = 0;
    update();
    return;
  }
  const run = coordinator.start('mic');
  if (!run.ok) {
    view.micResult = { ok: false, blocked: (/** @type {{ ok: false, code: import('./voiceDiagnostics.js').VoiceDiagBlock }} */ (run)).code };
    update();
    return;
  }
  view.micTesting = true;
  view.micResult = null;
  view.micLevel = 0;
  view.stoppedVoiceMode = run.stoppedVoiceMode;
  update();
  const result = await runMicTest({
    win: window,
    nav: navigator,
    signal: run.signal,
    onLevel: (level) => {
      if (run.signal.aborted) return;
      view.micLevel = level;
      update();
    },
  });
  run.finish();
  // A cancelled run belongs to a hidden panel: it must not touch the UI.
  if (run.signal.aborted) return;
  view.micResult = result;
  view.micTesting = false;
  view.micLevel = 0;
  update();
  // The prompt answer changes the permission state shown above.
  void refreshReport();
}

async function testRecognition() {
  const run = coordinator.start('recognition');
  if (!run.ok) {
    view.recResult = { ok: false, blocked: (/** @type {{ ok: false, code: import('./voiceDiagnostics.js').VoiceDiagBlock }} */ (run)).code };
    update();
    return;
  }
  view.recTesting = true;
  view.recResult = null;
  view.stoppedVoiceMode = run.stoppedVoiceMode;
  update();
  const result = await runRecognitionTest({ win: window, lang: recognitionLocale(), signal: run.signal });
  run.finish();
  if (run.signal.aborted) {
    // Interrupted because the app started speaking (a hidden panel is cleaned up by cancelVoiceDiagnostics).
    if (view.recTesting) {
      view.recTesting = false;
      view.recResult = { ok: false, blocked: 'speaking' };
      update();
    }
    return;
  }
  view.recResult = result;
  view.recTesting = false;
  update();
}

function testSpeaker() {
  if (speakerSession) {
    // The button toggles: a second click stops the sample.
    endSpeakerSample(true);
    update();
    return;
  }
  const run = coordinator.start('speaker');
  if (!run.ok) {
    view.speakerMessage = blockMessage((/** @type {{ ok: false, code: import('./voiceDiagnostics.js').VoiceDiagBlock }} */ (run)).code);
    update();
    return;
  }
  speakerSession = run;
  const engineId = getTtsEngineId();
  // The engine that will actually run (an unavailable one resolves to the browser voice).
  view.speakerEngine = resolveTtsEngine(engineId).id;
  view.speakerMessage = '';
  speakerFallbackTimer = window.setTimeout(() => {
    endSpeakerSample(true);
    update();
  }, SPEAKER_SAMPLE_MAX_MS);
  run.signal.addEventListener('abort', () => endSpeakerSample(true), { once: true });
  update();
  getChatSpeaker().toggleSpeakMarkdown(t('voice.diag.speakerSample'), SPEAKER_TEST_TOKEN);
}

function row(label, value, ok) {
  return html`<li class="voice-diag__row" data-ok=${ok ? 'true' : 'false'}>
    <span class="voice-diag__label">${label}</span><span class="voice-diag__value">${value}</span>
  </li>`;
}

function template() {
  const r = view.report;
  const speakerPlaying = Boolean(speakerSession);
  const otherBusy = (own) => (view.micTesting && own !== 'mic') || (view.recTesting && own !== 'rec') || (speakerPlaying && own !== 'speaker');
  const hint = r?.hint ? voiceErrorKeys(r.hint) : null;
  const engineId = view.speakerEngine;
  return html`
    ${hint ? html`<p class="cr-hint" data-tone="error" role="alert" data-testid="voice-diag-hint">${t(hint.message)} ${t(hint.advice)}</p>` : nothing}
    ${r ? html`<ul class="voice-diag__list" data-testid="voice-diag-report">
      ${row(t('voice.diag.secure'), r.secure ? t('voice.diag.secureYes') : t('voice.diag.secureNo', { protocol: r.protocol }), r.secure)}
      ${row(t('voice.diag.permissionLabel'), r.permissionsApi ? permissionLabel(r.permission) : t('voice.diag.permission.unknown'), r.permission !== 'denied')}
      ${row(t('voice.diag.getUserMedia'), yesNo(r.getUserMedia), r.getUserMedia)}
      ${row(t('voice.diag.speechRecognition'), yesNo(r.speechRecognition), r.speechRecognition)}
      ${row('MediaRecorder', yesNo(r.mediaRecorder), r.mediaRecorder)}
      ${row('speechSynthesis', yesNo(r.speechSynthesis), r.speechSynthesis)}
    </ul>` : html`<p class="cr-hint">${t('voice.diag.checking')}</p>`}
    <div class="cr-row">
      <cr-bar-button data-testid="voice-diag-refresh" @click=${() => refreshReport()}>${t('voice.diag.refresh')}</cr-bar-button>
    </div>

    <div class="voice-diag__group">
      <p class="cr-hint" data-testid="voice-diag-lang">${t('voice.diag.recLang', { lang: recognitionLocale() })}</p>
      ${view.stoppedVoiceMode ? html`<p class="cr-hint" data-testid="voice-diag-stopped-voice">${t('voice.diag.stoppedVoiceMode')}</p>` : nothing}
      <div class="cr-row voice-diag__actions">
        <cr-bar-button variant="primary" data-testid="voice-diag-mic" ?disabled=${otherBusy('mic')} @click=${testMic}>${view.micTesting ? t('voice.diag.micStop') : t('voice.diag.micTest')}</cr-bar-button>
        <cr-bar-button data-testid="voice-diag-recognition" ?disabled=${view.recTesting || otherBusy('rec')} @click=${testRecognition}>${view.recTesting ? t('voice.diag.recListening') : t('voice.diag.recTest')}</cr-bar-button>
        <cr-bar-button data-testid="voice-diag-speaker" ?disabled=${otherBusy('speaker')} @click=${testSpeaker}>${speakerPlaying ? t('voice.diag.speakerStop') : t('voice.diag.speakerTest')}</cr-bar-button>
      </div>
      ${view.micTesting ? html`<progress class="voice-diag__meter" max="1" .value=${view.micLevel} aria-label=${t('voice.diag.level')}></progress>` : nothing}
      ${view.micResult?.ok ? html`<p class="cr-hint" data-tone="success">${view.micResult.peak > 0.05 ? t('voice.diag.micHeard') : t('voice.diag.micSilent')}</p>` : errorLine(view.micResult)}
      ${view.recResult?.ok ? html`<p class="cr-hint" data-tone="success">${t('voice.diag.recHeard')} (${recognitionLocale()}): „${view.recResult.text}”</p>` : errorLine(view.recResult)}
      ${engineId ? html`<p class="cr-hint">${t('voice.diag.speakerEngine', { engine: t(ENGINE_LABEL_KEYS[engineId] || ENGINE_LABEL_KEYS.browser) })}</p>` : nothing}
      ${view.speakerMessage ? html`<p class="cr-hint" data-tone="error">${view.speakerMessage}</p>` : nothing}
    </div>

    <div class="voice-diag__group">
      <h4 class="cr-section-title">${t('voice.diag.playbackTitle')}</h4>
      <p class="cr-hint">${t('voice.diag.playbackHint')}</p>
      ${optionsRoot}
      ${r?.outputSelection && view.sinks.length
      ? html`<div class="cr-field">
          <label class="cr-field-label">${t('voice.diag.outputDevice')}</label>
          <cr-bar-select
            .options=${[{ value: '', label: t('voice.diag.outputDefault') }, ...view.sinks.map((d) => ({ value: d.deviceId, label: d.label || d.deviceId }))]}
            .value=${getOutputSinkId()}
            @cr-change=${(event) => setOutputSinkId(event.detail?.value || '')}
          ></cr-bar-select>
          <p class="cr-hint">${t('voice.diag.outputDeviceHint')}</p>
        </div>`
      : html`<p class="cr-hint" data-testid="voice-diag-no-sink">${t('voice.diag.outputSystem')}</p>`}
    </div>
  `;
}

/** Stops every test and releases the listeners and the observer of the current host. */
function unmountVoiceDiagnostics() {
  if (!mount) return;
  cancelVoiceDiagnostics();
  disposer.dispose();
  mount = null;
}

/** Mounts the panel on first use and re-reads the device state every time the tab opens. */
export function refreshVoiceDiagnostics() {
  const host = document.getElementById('voice-mic-diagnostics-body');
  if (!host) {
    // The settings markup is gone: nothing may keep running against a detached host.
    unmountVoiceDiagnostics();
    return;
  }
  if (mount !== host) {
    disposer.dispose();
    mount = host;
    mount.classList.add('voice-diag');
    optionsRoot = createVoiceReadOptions().root;
    disposer.listen(window, VOICE_ERROR_EVENT, (event) => {
      const detail = /** @type {CustomEvent} */ (event).detail || {};
      if (!speakerSession) return;
      view.speakerMessage = `${t('voice.engineFallback')} ${String(detail.message || '').trim()}`.trim();
      endSpeakerSample(false);
      update();
    });
    disposer.listen(window, VOICE_SPEAKING_EVENT, (event) => {
      const detail = /** @type {CustomEvent} */ (event).detail || {};
      view.appSpeaking = detail.active === true;
      coordinator.noteSpeaking(view.appSpeaking);
      if (!view.appSpeaking && speakerSession && detail.token === SPEAKER_TEST_TOKEN) {
        endSpeakerSample(false);
        update();
      }
    });
    // Leaving the tab, the settings panel or the page hides the block: stop everything then.
    disposer.listen(window, 'cr-settings-tab-changed', (event) => {
      if (/** @type {CustomEvent} */ (event).detail?.tabId !== 'interface-voice') cancelVoiceDiagnostics();
    });
    // Scrolling the section out of view keeps it rendered and must not cancel a test; a hidden
    // tab/panel (display:none, hidden ancestor) or a hidden page does.
    const host_ = mount;
    const isRendered = () => host_.isConnected && host_.getClientRects().length > 0;
    if (typeof IntersectionObserver === 'function') {
      const observer = new IntersectionObserver((entries) => {
        if (!host_.isConnected) unmountVoiceDiagnostics();
        else if (shouldCancelOnIntersection(entries, isRendered)) cancelVoiceDiagnostics();
      });
      observer.observe(host_);
      disposer.add(() => observer.disconnect());
    }
    disposer.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') cancelVoiceDiagnostics();
    });
  }
  update();
  void refreshReport();
}
