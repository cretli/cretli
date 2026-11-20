import { LitElement, html, nothing } from 'lit';
import { SignalWatcher } from '@lit-labs/signals';
import { t } from '../../i18n/index.js';
import { browserVoiceState } from './browserVoiceState.js';
import { getBrowserVoiceMode } from './browserVoiceMode.js';
import { carViewOpen } from '../car/carService.js';
import { voiceErrorKeys } from './voiceDiagnostics.js';
import { openMicSettings } from './voiceSettingsLink.js';

/**
 * Status strip for browser voice mode: listening state, what is being heard,
 * the result of the last utterance and, when the microphone cannot be used, a
 * large message with a way to type instead. Light DOM; styles live in
 * `css/features/car/_voice-listen.scss`.
 */
export class CrVoiceListenBar extends SignalWatcher(LitElement) {
  createRenderRoot() {
    return this;
  }

  async #typeInstead() {
    getBrowserVoiceMode().stop();
    // Inside car mode the send field is hidden behind the view: it offers its own input instead.
    if (this.closest('cr-car-view')) {
      this.dispatchEvent(new CustomEvent('cr-car-type-instead', { bubbles: true, composed: true }));
      return;
    }
    try {
      const chatModule = await import('../chat/index.js');
      chatModule.getActiveSendBar()?.input?.focus();
    } catch {
      // The bar closes either way; focusing the field is a convenience.
    }
  }

  #errorText(code) {
    const keys = voiceErrorKeys(code);
    return html`${t(keys.message)} <span class="cr-voice-listen__advice">${t(keys.advice)}</span>`;
  }

  #noticeText(notice) {
    if (notice.kind === 'failed') return t('voice.browser.commandFailed', { error: notice.text });
    if (notice.kind === 'message') return notice.text;
    if (notice.kind === 'sent') return `${t('voice.browser.sent')}: ${notice.text}`;
    return t('voice.browser.commandDone');
  }

  render() {
    const state = browserVoiceState.get();
    if (!state.active && !state.error) return nothing;
    const mode = getBrowserVoiceMode();
    const embeddedInCar = Boolean(this.closest('cr-car-view'));
    // While the car view is open its embedded bar is the only listen UI; the body-level one renders nothing.
    if (!embeddedInCar && carViewOpen.get()) return nothing;
    if (state.error) {
      return html`<div class="cr-voice-listen cr-voice-listen--error" role="alert" data-testid="voice-listen-error">
        <p class="cr-voice-listen__message">${this.#errorText(state.error)}</p>
        <div class="cr-voice-listen__actions">
          <button type="button" class="cr-voice-listen__btn" data-testid="voice-type-instead" @click=${() => this.#typeInstead()}>
            ${t('voice.browser.typeInstead')}
          </button>
          <button type="button" class="cr-voice-listen__btn" data-testid="voice-mic-settings" @click=${() => openMicSettings()}>
            ${t('voice.browser.micSettings')}
          </button>
          <button type="button" class="cr-voice-listen__btn cr-voice-listen__btn--quiet" @click=${() => mode.stop()}>
            ${t('voice.browser.stop')}
          </button>
        </div>
      </div>`;
    }
    const status = state.paused ? t('voice.browser.pausedSpeaking') : t('voice.browser.listening');
    return html`<div class="cr-voice-listen" role="status" data-paused=${state.paused ? 'true' : 'false'}>
      <span class="cr-voice-listen__dot" aria-hidden="true"></span>
      <div class="cr-voice-listen__text">
        <span class="cr-voice-listen__status">${status}</span>
        ${state.interim ? html`<span class="cr-voice-listen__interim">${state.interim}</span>` : nothing}
        ${state.notice ? html`<span class="cr-voice-listen__notice" data-kind=${state.notice.kind}>${this.#noticeText(state.notice)}</span>` : nothing}
      </div>
      <button type="button" class="cr-voice-listen__btn" title=${t('voice.browser.stopTitle')} data-testid="voice-listen-stop" @click=${() => mode.stop()}>
        ${t('voice.browser.stop')}
      </button>
    </div>`;
  }
}

if (!customElements.get('cr-voice-listen-bar')) customElements.define('cr-voice-listen-bar', CrVoiceListenBar);

/**
 * Mounts the bar once; safe to call on every start.
 *
 * @returns {CrVoiceListenBar}
 */
export function ensureVoiceListenBar() {
  // Car mode embeds its own bar in the layout so it can never cover the controls.
  const embedded = /** @type {CrVoiceListenBar|null} */ (document.querySelector('cr-car-view cr-voice-listen-bar'));
  if (embedded) return embedded;
  let bar = /** @type {CrVoiceListenBar|null} */ (document.querySelector('cr-voice-listen-bar'));
  if (!bar) {
    bar = /** @type {CrVoiceListenBar} */ (document.createElement('cr-voice-listen-bar'));
    document.body.appendChild(bar);
  }
  return bar;
}
