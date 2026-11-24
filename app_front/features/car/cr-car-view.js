import { LitElement, html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { SignalWatcher } from '@lit-labs/signals';
import { t } from '../../i18n/index.js';
import '../voice/cr-voice-listen-bar.js';
import { isVoiceSessionActive } from '../voice/voiceSessionState.js';
import { browserVoiceState, pendingVoiceSend, voiceSendOutcome } from '../voice/browserVoiceState.js';
import { commandHandlers } from '../voice/commandHandlers.js';
import { deriveCarAgentStatus } from './agentStatus.js';
import { buildCarChoice, CAR_TOUCH, shortCarLabel } from './carChoice.js';
import { briefToSpeech, buildCardBrief, carCardTitle, carOptionEffect, carOptionLabel, carPickReadback, cursorIndex } from './carCardNav.js';
import {
  carFocusChatId, fetchCardPlanMarkdown, getCarChoiceFlow, getCarNavCards, getCurrentCarEntry, getVisibleCarCards,
  snoozeCarCard, stepCarCard,
} from './carDecisions.js';
import { isLessonAggregateCard } from './carLessons.js';
import { carPresence, carScreen, closeCarView, isCarDataStale, openCardInApp } from './carService.js';
import { createStopHold } from './carStopHold.js';
import './cr-car-agents.js';

const TICK_MS = 1000;
const COUNTDOWN_TICK_MS = 250;

/**
 * Car mode: one screen, one decision. Big status, the pending decision card as
 * 2-4 thumb-sized buttons with a separate confirm step, a microphone and stop.
 * Light DOM; styles in `css/features/car/_car-view.scss`.
 */
export class CrCarView extends SignalWatcher(LitElement) {
  static properties = {
    chat: { state: true },
    notice: { state: true },
    typing: { state: true },
    draft: { state: true },
    summary: { state: true },
    stopPhase: { state: true },
  };

  constructor() {
    super();
    /** @type {{ id: string, title: string, workspace: string }|null} */
    this.chat = null;
    /** @type {{ kind: 'error'|'info', text: string }|null} */
    this.notice = null;
    this.typing = false;
    this.draft = '';
    /** @type {{ cardId: string, text?: string, brief?: object|null, loading: boolean }|null} */
    this.summary = null;
    this.timer = null;
    this.countdownTimer = null;
    /** @type {'idle'|'holding'|'armed'} */
    this.stopPhase = 'idle';
    // Hold ~1 s to stop (pointer or key); assistive technology confirms with a second activation.
    this.stopHold = createStopHold({
      onStop: () => void this.#stop(),
      onChange: (phase) => { this.stopPhase = phase; },
    });
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.#readChat();
    this.timer = setInterval(() => {
      void this.#readChat();
      this.requestUpdate();
    }, TICK_MS);
  }

  disconnectedCallback() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.#stopCountdown();
    this.stopHold.cancel();
    super.disconnectedCallback();
  }

  updated() {
    // Redraw the undo countdown quickly, but only while a prompt waits.
    if (pendingVoiceSend.get() && !this.countdownTimer) {
      this.countdownTimer = setInterval(() => this.requestUpdate(), COUNTDOWN_TICK_MS);
    } else if (!pendingVoiceSend.get()) {
      this.#stopCountdown();
    }
  }

  #stopCountdown() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  }

  async #undoSend() {
    const { getVoiceSendGate } = await import('../voice/voiceSendGate.js');
    getVoiceSendGate().undo();
    this.notice = { kind: 'info', text: t('car.undo.cancelled') };
  }

  async #sendNow() {
    const { getVoiceSendGate } = await import('../voice/voiceSendGate.js');
    const result = await getVoiceSendGate().sendNow();
    // null: the window closed first and the timer already reported the outcome.
    if (!result) return;
    this.notice = result.ok === false
      ? { kind: 'error', text: String(result.error || t('car.err.generic')) }
      : { kind: 'info', text: t('car.sent') };
  }

  #renderUndoBar() {
    const pending = pendingVoiceSend.get();
    if (!pending) return nothing;
    const seconds = Math.max(1, Math.ceil((pending.held ? this.#windowMs() : Math.max(0, pending.deadline - Date.now())) / 1000));
    return html`<section class="cr-car__undo" data-testid="car-undo" role="status" aria-live="polite">
      <p class="cr-car__undo-text" data-testid="car-undo-text">${t('car.undo.bar', { chat: pending.chatTitle || t('car.untitled'), text: pending.text })}</p>
      <p class="cr-car__undo-count" data-testid="car-undo-count">${t('car.undo.countdown', { seconds })}</p>
      <div class="cr-car__undo-track" aria-hidden="true">
        ${keyed(pending.startedAt, html`<div class="cr-car__undo-fill ${pending.held ? 'is-held' : ''}" style=${`animation-duration:${this.#windowMs()}ms`}></div>`)}
      </div>
      <div class="cr-car__row">
        <button type="button" class="cr-car__btn cr-car__btn--primary" data-testid="car-undo-cancel" @click=${() => this.#undoSend()}>${t('car.undo.undo')}</button>
        <button type="button" class="cr-car__btn" data-testid="car-undo-send" @click=${() => this.#sendNow()}>${t('car.undo.sendNow')}</button>
      </div>
    </section>`;
  }

  #windowMs() {
    const pending = pendingVoiceSend.get();
    return pending ? Math.max(1, pending.deadline - pending.startedAt) : 0;
  }

  async #readChat() {
    try {
      const chatModule = await import('../chat/index.js');
      const id = chatModule.getActiveChatIdValue();
      const chat = id ? chatModule.getChatsList().find((entry) => entry.id === id) : null;
      const folder = String(chat?.workspaceFolder || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
      const next = chat ? { id: chat.id, title: String(chat.title || '').trim(), workspace: folder } : null;
      if (next?.id !== this.chat?.id || next?.title !== this.chat?.title || next?.workspace !== this.chat?.workspace) this.chat = next;
      carFocusChatId.set(next?.id || '');
    } catch {
      // Without the chat module there is simply no chat to show.
    }
  }

  /** The card on screen: the cursor card among the visible (not snoozed) ones, this chat's first; may be a lessons aggregate. */
  #currentCard() {
    return getCurrentCarEntry();
  }

  #choose(card, index) {
    const result = getCarChoiceFlow().choose({ cardId: card.id, option: index, source: CAR_TOUCH });
    this.notice = result.ok === false ? { kind: 'error', text: t(`car.err.${result.code}`) } : null;
    this.requestUpdate();
  }

  async #confirm() {
    const result = await getCarChoiceFlow().confirm({ source: CAR_TOUCH });
    this.notice = result.ok
      ? { kind: 'info', text: t('car.sent') }
      : { kind: 'error', text: t(`car.err.${result.code}`) };
    this.requestUpdate();
  }

  #cancel() {
    getCarChoiceFlow().cancel();
    this.notice = { kind: 'info', text: t('car.cancelled') };
    this.requestUpdate();
  }

  #step(direction) {
    stepCarCard(direction, { includeAggregates: true });
    this.summary = null;
    this.notice = null;
    this.requestUpdate();
  }

  async #openInApp(card) {
    const result = await openCardInApp(card);
    if (result.ok === false) {
      this.notice = { kind: 'error', text: t(`car.err.${result.code}`) };
      this.requestUpdate();
    }
  }

  #snooze(card) {
    snoozeCarCard(card.id);
    this.summary = null;
    this.notice = { kind: 'info', text: t('car.snoozed') };
    this.requestUpdate();
  }

  async #toggleSummary(card) {
    if (this.summary?.cardId === card.id) {
      (await import('../voice/chatSpeaker.js')).getChatSpeaker().stop();
      this.summary = null;
      return;
    }
    this.summary = { cardId: card.id, brief: null, loading: true };
    const planMarkdown = card.kind === 'plan_approval' ? await fetchCardPlanMarkdown(card) : '';
    // The driver may have moved on while the plan loaded.
    if (this.summary?.cardId !== card.id) return;
    const brief = buildCardBrief(card, { planMarkdown }, t);
    this.summary = { cardId: card.id, brief, loading: false };
    const text = briefToSpeech(card, brief, t);
    if (text) {
      try {
        (await import('../voice/chatSpeaker.js')).getChatSpeaker().toggleSpeakMarkdown(text, `car-summary:${card.id}`);
      } catch {
        // Reading aloud is optional; the text is on screen.
      }
    }
  }

  #stopPress(event) {
    if (event.button > 0) return;
    this.stopHold.press();
  }

  #stopKey(event, down) {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    // Also swallows the click the browser would synthesize from the key.
    event.preventDefault();
    if (down) {
      if (!event.repeat) this.stopHold.press();
    } else {
      this.stopHold.release();
    }
  }

  #stopClick(event) {
    // A mouse or touch click (detail > 0) follows the hold and does nothing by itself.
    // detail 0 is an activation by assistive technology: arm, then confirm with a second one.
    if (event.detail === 0) this.stopHold.activate();
  }

  async #stop() {
    const result = await commandHandlers.stopAgent();
    this.notice = result.ok ? null : { kind: 'error', text: t('car.err.generic') };
  }

  async #toggleMic() {
    // One microphone owner at a time: a live Realtime session keeps it, so the panel opens instead.
    if (isVoiceSessionActive()) {
      try {
        (await import('../../components/chat/cr-voice-panel.js')).openVoiceModePanel();
      } catch {
        this.notice = { kind: 'error', text: t('car.micUnavailable') };
      }
      return;
    }
    const { getBrowserVoiceMode } = await import('../voice/browserVoiceMode.js');
    // Without SpeechRecognition (or with the microphone denied) the mode reports it and the
    // embedded bar shows the large message with "Type instead".
    getBrowserVoiceMode().toggle();
  }

  async #sendTyped() {
    const text = this.draft.trim();
    if (!text) return;
    const result = await commandHandlers.sendPrompt(text);
    if (result.ok === false) {
      this.notice = { kind: 'error', text: String(result.error || t('car.err.generic')) };
      return;
    }
    this.draft = '';
    this.typing = false;
    this.notice = { kind: 'info', text: t('car.sent') };
  }

  #renderTyping() {
    return html`<div class="cr-car__typing" data-testid="car-typing">
      <textarea class="cr-car__input" data-testid="car-typing-input" rows="3"
        placeholder=${t('car.typePlaceholder')} .value=${this.draft}
        @input=${(event) => { this.draft = event.target.value; }}></textarea>
      <div class="cr-car__row">
        <button type="button" class="cr-car__btn cr-car__btn--primary" data-testid="car-typing-send" @click=${() => this.#sendTyped()}>${t('car.send')}</button>
        <button type="button" class="cr-car__btn" data-testid="car-typing-close" @click=${() => { this.typing = false; }}>${t('car.cancel')}</button>
      </div>
    </div>`;
  }

  #cardOption(card, option) {
    return (Array.isArray(card.options) ? card.options : []).find((entry) => entry.id === option.id) || option;
  }

  #optionLabel(card, option) {
    return shortCarLabel(carOptionLabel(card, this.#cardOption(card, option), t));
  }

  #optionEffect(card, option) {
    return carOptionEffect(card, this.#cardOption(card, option), t);
  }

  #renderBrief(summary) {
    if (summary.loading) return html`<p class="cr-car__summary" data-testid="car-summary" role="status">${t('car.summaryLoading')}</p>`;
    const brief = summary.brief;
    const empty = !brief.about && !brief.body && !brief.recommendation && !brief.options.some((option) => option.effect);
    if (empty) return html`<p class="cr-car__summary" data-testid="car-summary" role="status">${t('car.summaryNone')}</p>`;
    return html`<div class="cr-car__summary cr-car__brief" data-testid="car-summary" role="status">
      ${brief.workspace ? html`<p class="cr-car__brief-meta">${t('car.brief.workspace', { name: brief.workspace })}</p>` : nothing}
      ${brief.about ? html`<p class="cr-car__brief-section"><span class="cr-car__brief-heading">${t('car.brief.about')}</span>${brief.about}</p>` : nothing}
      ${brief.body ? html`<p class="cr-car__brief-section"><span class="cr-car__brief-heading">${t('car.brief.content')}</span>${brief.body}</p>` : nothing}
      ${brief.recommendation ? html`<p class="cr-car__brief-section cr-car__brief-rec"><span class="cr-car__brief-heading">${t('car.brief.recommendedHeading')}</span>${brief.recommendation.label}${brief.recommendation.why ? ` — ${brief.recommendation.why}` : ''}</p>` : nothing}
    </div>`;
  }

  /** Prev / position / next row; the position counts real cards only, never the lessons aggregate. */
  #renderNav(card, cards, navCards) {
    if (navCards.length <= 1) return nothing;
    const position = isLessonAggregateCard(card) ? '' : t('car.cardPositionShort', { n: cursorIndex(cards, card.id) + 1, total: cards.length });
    return html`<div class="cr-car__nav" data-testid="car-nav">
      <button type="button" class="cr-car__btn cr-car__nav-btn" data-testid="car-prev" title=${t('car.prevCard')} aria-label=${t('car.prevCard')} @click=${() => this.#step(-1)}>‹</button>
      <span class="cr-car__nav-pos" data-testid="car-position">${position}</span>
      <button type="button" class="cr-car__btn cr-car__nav-btn" data-testid="car-next" title=${t('car.nextCard')} aria-label=${t('car.nextCard')} @click=${() => this.#step(1)}>›</button>
    </div>`;
  }

  /** One card for all review-lesson proposals of a workspace: no decision, only a way into the app. */
  #renderLessonsAggregate(card, cards, navCards) {
    return html`<section class="cr-car__card" data-testid="car-card" data-kind=${card.kind}>
      ${this.#renderNav(card, cards, navCards)}
      <h2 class="cr-car__card-title">${carCardTitle(card, t)}</h2>
      <p class="cr-car__note" data-testid="car-card-note">${t('car.lessonsAggregateHint')}</p>
      <div class="cr-car__card-actions" data-testid="car-card-actions">
        <button type="button" class="cr-car__btn cr-car__btn--primary" data-testid="car-open-app" @click=${() => this.#openInApp(card)}>${t('car.openInApp')}</button>
      </div>
    </section>`;
  }

  #renderCard(card) {
    const cards = getVisibleCarCards();
    const navCards = getCarNavCards();
    if (isLessonAggregateCard(card)) return this.#renderLessonsAggregate(card, cards, navCards);
    const choice = buildCarChoice(card, { source: CAR_TOUCH });
    const pending = getCarChoiceFlow().getPending();
    const more = cards.length - 1;
    const title = carCardTitle(card, t);
    // Readback uses the label the button shows, not the server's English one.
    const pickedOption = pending?.cardId === card.id && choice.ok ? choice.options.find((option) => option.id === pending.optionId) : null;
    const pickedLabel = pickedOption ? this.#optionLabel(card, pickedOption) : pending?.label;
    let body;
    if (!choice.ok) {
      body = html`<p class="cr-car__note" data-testid="car-card-note">${t('car.cardOptions')}</p>`;
    } else {
      body = html`<div class="cr-car__options" data-count=${choice.options.length}>
        ${choice.options.map((option) => html`<button
          type="button"
          class="cr-car__option ${pending?.cardId === card.id && pending.optionId === option.id ? 'is-picked' : ''}"
          data-testid=${`car-option-${option.index}`}
          aria-pressed=${pending?.cardId === card.id && pending.optionId === option.id ? 'true' : 'false'}
          @click=${() => this.#choose(card, option.index)}>
          <span class="cr-car__option-n">${option.index}</span>
          <span class="cr-car__option-text">
            <span class="cr-car__option-label">${this.#optionLabel(card, option)}</span>
            ${this.#optionEffect(card, option) ? html`<span class="cr-car__option-effect">${this.#optionEffect(card, option)}</span>` : nothing}
          </span>
        </button>`)}
      </div>`;
    }
    return html`<section class="cr-car__card" data-testid="car-card" data-kind=${card.kind || ''}>
      ${this.#renderNav(card, cards, navCards)}
      <h2 class="cr-car__card-title">${title}</h2>
      ${this.summary?.cardId === card.id ? this.#renderBrief(this.summary) : nothing}
      ${body}
      ${pending && pending.cardId === card.id ? html`<div class="cr-car__confirm" data-testid="car-confirm">
        <p class="cr-car__confirm-text">${choice.ok && choice.humanOnly ? carPickReadback(card, pickedLabel, t) : t('car.choosing', { label: pickedLabel })}</p>
        <div class="cr-car__row">
          <button type="button" class="cr-car__btn cr-car__btn--primary" data-testid="car-confirm-btn" @click=${() => this.#confirm()}>${t('car.confirm')}</button>
          <button type="button" class="cr-car__btn" data-testid="car-cancel-btn" @click=${() => this.#cancel()}>${t('car.cancel')}</button>
        </div>
      </div>` : nothing}
      <div class="cr-car__card-actions" data-testid="car-card-actions">
        <button type="button" class="cr-car__btn" data-testid="car-summary-btn" aria-pressed=${this.summary?.cardId === card.id ? 'true' : 'false'} @click=${() => this.#toggleSummary(card)}>${this.summary?.cardId === card.id ? t('car.summaryClose') : t('car.summary')}</button>
        <button type="button" class="cr-car__btn" data-testid="car-snooze" title=${t('car.snoozeTitle')} @click=${() => this.#snooze(card)}>${t('car.snooze')}</button>
        <button type="button" class="cr-car__btn" data-testid="car-open-app" @click=${() => this.#openInApp(card)}>${t('car.openInApp')}</button>
      </div>
      ${more > 0 ? html`<button type="button" class="cr-car__more" data-testid="car-more" @click=${() => this.#step(1)}>${t('car.more', { count: more })}</button>` : nothing}
    </section>`;
  }

  render() {
    const presence = carPresence.get();
    const card = this.#currentCard();
    // Any open card needs the driver, whichever chat it belongs to.
    const status = deriveCarAgentStatus(this.chat ? presence.states[this.chat.id] : null, card && !isLessonAggregateCard(card) ? [card] : []);
    const mic = browserVoiceState.get().active;
    const agentsScreen = carScreen.get() === 'agents';
    return html`<div class="cr-car" role="dialog" aria-label=${t('car.title')} data-status=${status} data-testid="car-view">
      <header class="cr-car__top">
        <span class="cr-car__status" data-status=${status} data-testid="car-status">${t(`car.status.${status}`)}</span>
        <span class="cr-car__chat" data-testid="car-chat" data-chat-id=${this.chat?.id || ''} data-workspace=${this.chat?.workspace || ''}>${this.chat?.title || t('car.noChat')}${this.chat?.workspace ? ` · ${this.chat.workspace}` : ''}</span>
        <button type="button" class="cr-car__close" title=${t('car.closeTitle')} aria-label=${t('car.closeTitle')} data-testid="car-close" @click=${() => closeCarView()}>
          <span class="mdi mdi-close" aria-hidden="true"></span>
        </button>
      </header>
      ${isCarDataStale() ? html`<p class="cr-car__stale" role="status" data-testid="car-stale">${t('car.stale')}</p>` : nothing}
      <main class="cr-car__main" @cr-car-type-instead=${() => { this.typing = true; }}>
        ${agentsScreen ? html`<cr-car-agents></cr-car-agents>` : html`
          ${card ? this.#renderCard(card) : html`<p class="cr-car__empty">${t('car.noCard')}</p>`}
          ${(this.notice || voiceSendOutcome.get()) ? html`<p class="cr-car__notice" data-kind=${(this.notice || voiceSendOutcome.get()).kind} role="status">${(this.notice || voiceSendOutcome.get()).text}</p>` : nothing}`}
        ${this.#renderUndoBar()}
        ${this.typing ? this.#renderTyping() : nothing}
        <div data-voice-listen-slot><cr-voice-listen-bar class="cr-car-voice-listen"></cr-voice-listen-bar></div>
      </main>
      <footer class="cr-car__controls" data-testid="car-controls">
        <button type="button" class="cr-car__btn cr-car__btn--mic ${mic ? 'is-on' : ''}" data-testid="car-mic" aria-pressed=${mic ? 'true' : 'false'} title=${t('car.micTitle')} @click=${() => this.#toggleMic()}>
          <span class="mdi ${mic ? 'mdi-microphone' : 'mdi-microphone-outline'}" aria-hidden="true"></span>
          <span>${mic ? t('car.micStop') : t('car.mic')}</span>
        </button>
        <button type="button" class="cr-car__btn cr-car__btn--agents" data-testid="car-agents-toggle" aria-pressed=${agentsScreen ? 'true' : 'false'} @click=${() => carScreen.set(agentsScreen ? 'choice' : 'agents')}>
          <span class="mdi mdi-account-group-outline" aria-hidden="true"></span>
          <span>${agentsScreen ? t('car.agentsBack') : t('car.agentsOpen')}</span>
        </button>
        <button type="button" class="cr-car__btn cr-car__btn--stop" data-testid="car-stop"
          data-phase=${this.stopPhase} style=${`--cr-car-stop-hold:${this.stopHold.holdMs}ms`}
          aria-describedby="cr-car-stop-hint"
          @pointerdown=${(event) => this.#stopPress(event)}
          @pointerup=${() => this.stopHold.release()}
          @pointercancel=${() => this.stopHold.release()}
          @blur=${() => this.stopHold.release()}
          @pointerleave=${() => this.stopHold.release()}
          @contextmenu=${(event) => event.preventDefault()}
          @keydown=${(event) => this.#stopKey(event, true)}
          @keyup=${(event) => this.#stopKey(event, false)}
          @click=${(event) => this.#stopClick(event)}>
          <span class="cr-car__stop-progress" aria-hidden="true"></span>
          <span class="mdi mdi-stop" aria-hidden="true"></span>
          <span>${t('car.stop')}</span>
          <span class="cr-car__stop-hint" id="cr-car-stop-hint" role="status">${this.stopPhase === 'armed' ? t('car.stopArmed') : this.stopPhase === 'holding' ? t('car.stopHolding') : t('car.stopHint')}</span>
        </button>
      </footer>
    </div>`;
  }
}

if (!customElements.get('cr-car-view')) customElements.define('cr-car-view', CrCarView);
