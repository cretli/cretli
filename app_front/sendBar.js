/**
 * Shared send bar: text field, dictation (Speech Recognition), arrows, stop and send.
 * Used by both the Chat and Terminal panels.
 */
import { createSendBarInput, getStoredMultiline } from './features/sendBar/sendBarInput.js';
import { createSendBarAttachments } from './features/sendBar/sendBarAttachments.js';
import { createSendBarMedia } from './features/sendBar/sendBarMedia.js';
import { createSendBarSendMenu } from './features/sendBar/sendBarSendMenu.js';
import { toggleReadAloud } from './features/voice/voiceReadControls.js';
import { getReadMode } from './features/voice/voicePrefs.js';
import { t } from './i18n/index.js';
import { escapeHtml } from './features/chat/chatHtmlUtils.js';

/**
 * Builds the send bar DOM and wires up its behaviour.
 * @param {{
 *   placeholder?: string,
 *   showToggleExtra?: boolean,
 *   getExtraBarWrap?: () => HTMLElement | null,
 *   showArrows?: boolean,
 *   showStop?: boolean,
 *   sendLabel?: string,
 *   multiline?: boolean,
 *   onSend: (text: string, meta?: { rawText: string, hasText: boolean, hasTrimmedText: boolean, attachmentPaths?: string[] }) => boolean | void,
 *   onArrowDown?: () => void,
 *   onStop?: () => void,
 *   setSpecialCharsBarVisibility?: (visible: boolean) => void,
 *   showScreenshotButton?: boolean,
 *   showVoiceReadButton?: boolean,
 *   uploadScreenshot?: (fileOrBase64: File|string) => Promise<{ ok: boolean, path?: string, error?: string }>,
 *   captureHostScreenshot?: () => Promise<{ ok: boolean, file?: File, error?: string, debug?: object }>,
 *   getCaptureHostScreenshot?: () => (() => Promise<{ ok: boolean, file?: File, error?: string, debug?: object }>) | null,
 *   requestHostPagePick?: () => Promise<object>,
 *   getRequestHostPagePick?: () => (() => Promise<object>) | null,
 *   getHostPagePickLabel?: (context: object) => string,
 *   sendActions?: Array<{ id: string, label: string, icon?: string, onSelect: (text: string, meta: { rawText: string, hasText: boolean, hasTrimmedText: boolean, attachmentPaths: string[] }) => boolean | Promise<boolean> }>,
 *   keepInputFocus?: boolean,
 * }} options
 * @returns {{ root: HTMLElement, input: HTMLInputElement|HTMLTextAreaElement, focusInput: () => void, submit: () => void, setPlaceholder: (s: string) => void, stopDictation: () => void, startDictation: () => void, setMultiline: (bool: boolean) => void, isMultiline: () => boolean, addExtraBar: (element: HTMLElement) => void }}
 */
export function createSendBar(options) {
  const {
    placeholder = '',
    showToggleExtra = false,
    getExtraBarWrap = null,
    showArrows = true,
    showStop = true,
    sendLabel = t('sendBar.send'),
    multiline: optionMultiline = getStoredMultiline(),
    onSend,
    onArrowDown,
    onStop,
    setSpecialCharsBarVisibility,
    showScreenshotButton = false,
    uploadScreenshot,
    captureHostScreenshot = null,
    getCaptureHostScreenshot = null,
    requestHostPagePick = null,
    getRequestHostPagePick = null,
    getHostPagePickLabel = null,
    showVoiceReadButton = false,
    sendActions = [],
    keepInputFocus = false,
  } = options;

  if (typeof onSend !== 'function') throw new Error('sendBar: onSend is required');

  const root = document.createElement('div');
  root.className = 'chat-pane-toolbar chat-send-bar';

  const inputHtml = optionMultiline
    ? '<textarea class="send-keys-input" rows="2" placeholder="' + escapeAttr(placeholder) + '" aria-label="' + escapeAttr(t('sendBar.messageAria')) + '" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>'
    : '<input type="text" class="send-keys-input" placeholder="' + escapeAttr(placeholder) + '" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">';

  const parts = [
    '<span class="send-keys-wrap" title="' + escapeAttr(t('sendBar.sendTitle')) + '">',
  ];
  if (showToggleExtra) {
    parts.push(
      '<button type="button" class="send-keys-toggle-extra-btn" title="' + escapeAttr(t('sendBar.toggleCommands')) + '" aria-expanded="false"><span class="mdi mdi-chevron-up toggle-extra-icon" aria-hidden="true"></span></button>'
    );
  }
  parts.push('<span class="send-keys-input-slot">', inputHtml, '</span>');
  if (showScreenshotButton) {
    parts.push(
      '<input type="file" accept="image/png,image/jpeg,image/webp" multiple class="send-keys-screenshot-input" aria-hidden="true" tabindex="-1" style="position:absolute;width:0;height:0;opacity:0;">',
      '<input type="file" accept="image/*" capture="environment" class="send-keys-camera-input" aria-hidden="true" tabindex="-1" style="position:absolute;width:0;height:0;opacity:0;">',
      '<button type="button" class="send-keys-screenshot-btn send-keys-attach-btn" title="' + escapeAttr(t('sendBar.attach')) + '" aria-label="' + escapeAttr(t('sendBar.attach')) + '"><span class="mdi mdi-paperclip" aria-hidden="true"></span></button>'
    );
  }
  parts.push(
    '<button type="button" class="send-keys-mic-btn" title="' + escapeAttr(t('sendBar.dictateTitle')) + '" aria-label="' + escapeAttr(t('sendBar.dictate')) + '"><span class="mic-icon mdi mdi-microphone" aria-hidden="true"></span><span class="mic-recording-dot" aria-hidden="true"></span></button>'
  );
  if (showVoiceReadButton) {
    parts.push(
      '<button type="button" class="send-keys-voice-btn" title="' + escapeAttr(t('voice.readAloud')) + '" aria-label="' + escapeAttr(t('voice.readAloud')) + '" aria-pressed="false"><span class="mdi mdi-volume-off" aria-hidden="true"></span></button>'
    );
  }
  if (showArrows) {
    parts.push(
      '<button type="button" class="send-keys-down-btn" title="' + escapeAttr(t('sendBar.arrowDown')) + '"><span class="mdi mdi-arrow-down-bold" aria-hidden="true"></span></button>'
    );
  }
  if (showStop && !showToggleExtra) {
    parts.push(
      '<button type="button" class="send-keys-stop-btn" title="' + escapeAttr(t('sendBar.stopTitle')) + '" aria-label="' + escapeAttr(t('sendBar.stop')) + '"><span class="mdi mdi-stop" aria-hidden="true"></span></button>'
    );
  }
  parts.push(
    '<button type="button" class="send-keys-btn">' +
      escapeHtml(sendLabel) +
      '</button>',
    '</span>'
  );
  root.innerHTML = parts.join('');

  const sendBtn = root.querySelector('.send-keys-btn');
  const toggleExtraBtn = root.querySelector('.send-keys-toggle-extra-btn');
  const micBtn = root.querySelector('.send-keys-mic-btn');
  const voiceBtn = root.querySelector('.send-keys-voice-btn');
  const downBtn = root.querySelector('.send-keys-down-btn');
  const stopBtn = root.querySelector('.send-keys-stop-btn');
  const inputSlot = root.querySelector('.send-keys-input-slot');
  const attachmentsBar = document.createElement('div');
  attachmentsBar.className = 'send-keys-attachments-bar';
  attachmentsBar.hidden = true;
  root.prepend(attachmentsBar);

  let dictationSettingsRow = null;
  let stopActionRow = null;

  function getTextareaBarWrap() {
    return typeof document !== 'undefined' ? document.getElementById('send-bar-textarea-wrap') : null;
  }

  function getExtraWrapElement() {
    return typeof getExtraBarWrap === 'function' ? getExtraBarWrap() : null;
  }

  let attachmentsController = null;
  const inputController = createSendBarInput({
    root,
    inputSlot,
    initialMultiline: optionMultiline,
    basePlaceholder: placeholder,
    getTextareaBarWrap,
    getAttachmentPlaceholder: () => {
      if (!attachmentsController) return placeholder;
      return attachmentsController.getAttachmentPlaceholder();
    },
  });

  attachmentsController = createSendBarAttachments({
    attachmentsBar,
    sendBtn,
    getInputElement: () => inputController.getInputElement(),
    getBasePlaceholder: () => inputController.getBasePlaceholder(),
  });
  inputController.updateInputPlaceholder();

  const mediaController = createSendBarMedia({
    root,
    micBtn,
    showScreenshotButton,
    uploadScreenshot,
    captureHostScreenshot,
    getCaptureHostScreenshot,
    requestHostPagePick,
    getRequestHostPagePick,
    getHostPagePickLabel,
    getInputElement: () => inputController.getInputElement(),
    addUploadingAttachment: (...args) => attachmentsController.addUploadingAttachment(...args),
    finishUploadingAttachment: (...args) => attachmentsController.finishUploadingAttachment(...args),
    removePendingAttachment: (...args) => attachmentsController.removePendingAttachment(...args),
    setPageSelectionAttachment: (...args) => attachmentsController.setPageSelectionAttachment(...args),
  });

  function resumeDictationAfterSendIfNeeded() {
    if (!mediaController.shouldResumeAfterSend()) return;
    mediaController.clearResumeAfterSend();
    mediaController.startDictation();
  }

  function getSendPayload() {
    const el = inputController.getInputElement();
    const rawText = el?.value ?? '';
    const attachmentSuffix = attachmentsController.getAttachmentSuffix();
    const rawTextWithAttachments = attachmentSuffix
      ? (rawText ? rawText.trimEnd() + '\n' : '') + attachmentSuffix
      : rawText;
    const text = rawTextWithAttachments.trim();
    return {
      text,
      meta: {
        rawText: rawTextWithAttachments,
        hasText: rawTextWithAttachments.length > 0,
        hasTrimmedText: text.length > 0,
        attachmentPaths: attachmentsController.getAttachmentPaths(),
        pageSelectionContext: attachmentsController.getPageSelectionContext(),
      },
    };
  }

  function clearAcceptedPayload() {
    const el = inputController.getInputElement();
    if (el) el.value = '';
    attachmentsController.clearPendingAttachments();
    setTimeout(() => {
      const current = inputController.getInputElement();
      if (current) current.value = '';
      resumeDictationAfterSendIfNeeded();
    }, 120);
  }

  let sendActionRunning = false;

  function doSend() {
    if (sendActionRunning) return;
    const payload = getSendPayload();
    mediaController.stopDictation();
    const accepted = onSend(payload.text || '', payload.meta);
    if (accepted === false) {
      resumeDictationAfterSendIfNeeded();
      return;
    }
    clearAcceptedPayload();
    if (keepInputFocus) inputController.focusInput();
  }

  async function runSendAction(actionId) {
    if (sendActionRunning) return;
    const action = sendActions.find((item) => item.id === actionId);
    if (!action || typeof action.onSelect !== 'function') return;
    const payload = getSendPayload();
    if (!payload.meta.hasTrimmedText) {
      alert(t('sendBar.messageRequired'));
      return;
    }
    sendActionRunning = true;
    sendBtn?.setAttribute('aria-busy', 'true');
    mediaController.stopDictation();
    try {
      const accepted = await action.onSelect(payload.text, payload.meta);
      if (accepted === false) {
        resumeDictationAfterSendIfNeeded();
        return;
      }
      clearAcceptedPayload();
      if (keepInputFocus) inputController.focusInput();
    } catch (_) {
      resumeDictationAfterSendIfNeeded();
    } finally {
      sendActionRunning = false;
      sendBtn?.removeAttribute('aria-busy');
    }
  }

  inputController.bindSendShortcut(doSend);
  const sendMenu = createSendBarSendMenu({
    sendBtn,
    actions: sendActions,
    onShortPress: doSend,
    onSelect: runSendAction,
  });
  if (sendBtn && !sendMenu) sendBtn.addEventListener('click', doSend);

  function getDictationSettingsRow() {
    const wrap = getExtraWrapElement();
    if (!wrap) return null;
    let row = dictationSettingsRow && dictationSettingsRow.parentNode === wrap
      ? dictationSettingsRow
      : wrap.querySelector('.send-bar-dictation-options-row');
    if (!row) {
      row = document.createElement('div');
      row.className = 'send-bar-options-row send-bar-dictation-options-row';
      row.hidden = true;
      row.innerHTML =
        '<label class="send-bar-inline-checkbox">' +
        '<input type="checkbox" class="send-bar-dictation-resume-checkbox">' +
        '<span>' + escapeHtml(t('sendBar.resumeDictationAfterSend')) + '</span>' +
        '</label>';
      wrap.insertBefore(row, wrap.firstChild);
    }
    const checkbox = row.querySelector('.send-bar-dictation-resume-checkbox');
    if (checkbox) {
      checkbox.checked = mediaController.getDictationResumeAfterSend();
      checkbox.onchange = () => {
        mediaController.setDictationResumeAfterSend(!!checkbox.checked);
      };
    }
    dictationSettingsRow = row;
    return row;
  }

  function syncVoiceButton() {
    if (!voiceBtn) return;
    const active = getReadMode() !== 'off';
    voiceBtn.classList.remove('is-error');
    voiceBtn.classList.toggle('is-active', active);
    voiceBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    voiceBtn.title = active ? t('voice.readAloudOnTitle') : t('voice.readAloudOffTitle');
    const icon = voiceBtn.querySelector('.mdi');
    if (icon) icon.className = `mdi ${active ? 'mdi-volume-high' : 'mdi-volume-off'}`;
  }

  if (voiceBtn) {
    voiceBtn.addEventListener('click', () => {
      toggleReadAloud();
      syncVoiceButton();
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('cr-voice-read-mode-changed', syncVoiceButton);
      // Speech failures are otherwise invisible: nothing plays and nothing says why.
      window.addEventListener('cr-voice-error', (event) => {
        const message = String(event.detail?.message || '').trim();
        voiceBtn.classList.add('is-error');
        voiceBtn.title = message
          ? `${t('voice.speakFailed')}: ${message}`
          : t('voice.speakFailed');
      });
    }
    syncVoiceButton();
  }

  function getStopActionRow() {
    if (!showStop) return null;
    const wrap = getExtraWrapElement();
    if (!wrap) return null;
    let row = stopActionRow && stopActionRow.parentNode === wrap
      ? stopActionRow
      : wrap.querySelector('.send-bar-stop-action-row');
    if (!row) {
      row = document.createElement('div');
      row.className = 'send-bar-options-row send-bar-stop-action-row';
      row.hidden = true;
      row.innerHTML =
        '<button type="button" class="send-bar-extra-stop-btn send-bar-extra-action-btn" title="'
        + escapeAttr(t('sendBar.stopTitle')) + '" aria-label="' + escapeAttr(t('sendBar.stop')) + '">' +
        '<span class="mdi mdi-stop" aria-hidden="true"></span> ' + escapeHtml(t('sendBar.stop')) +
        '</button>';
      wrap.insertBefore(row, wrap.firstChild);
    }
    const btn = row.querySelector('.send-bar-extra-stop-btn');
    if (btn) {
      btn.onclick = () => {
        if (typeof onStop !== 'function') return;
        onStop();
      };
    }
    stopActionRow = row;
    return row;
  }

  function setExtraWrapVisible(visible) {
    const wrap = getExtraWrapElement();
    if (!wrap) return;
    const row = getDictationSettingsRow();
    if (row) row.hidden = !visible;
    const stopRow = getStopActionRow();
    if (stopRow) stopRow.hidden = !visible;
    wrap.classList.toggle('is-visible', visible);
    wrap.setAttribute('aria-hidden', !visible);
    if (toggleExtraBtn) {
      toggleExtraBtn.classList.toggle('is-open', visible);
      toggleExtraBtn.setAttribute('aria-expanded', visible ? 'true' : 'false');
      toggleExtraBtn.title = visible ? t('sendBar.hideCommands') : t('sendBar.showCommands');
    }
    if (setSpecialCharsBarVisibility) setSpecialCharsBarVisibility(visible);
  }

  if (toggleExtraBtn && typeof getExtraBarWrap === 'function') {
    toggleExtraBtn.addEventListener('click', () => {
      const wrap = getExtraWrapElement();
      if (!wrap) return;
      const visible = !wrap.classList.contains('is-visible');
      setExtraWrapVisible(visible);
    });
  }
  if (downBtn && onArrowDown) downBtn.addEventListener('click', onArrowDown);
  if (stopBtn && onStop) stopBtn.addEventListener('click', onStop);

  function addExtraBar(element) {
    const extraWrap = typeof getExtraBarWrap === 'function' ? getExtraBarWrap() : null;
    if (!extraWrap || !(element instanceof HTMLElement)) return;
    extraWrap.insertBefore(element, extraWrap.firstChild);
  }

  return {
    root,
    get input() {
      return inputController.getInputElement();
    },
    focusInput: () => inputController.focusInput(),
    /** Sends whatever is in the input, as if the Send button was clicked. */
    submit: () => doSend(),
    setPlaceholder: (s) => inputController.setPlaceholder(s),
    stopDictation: () => mediaController.stopDictation(),
    startDictation: () => mediaController.startDictation(),
    setMultiline: (enable) => inputController.setMultiline(enable),
    isMultiline: () => inputController.isMultiline(),
    closeSendMenu: () => sendMenu?.close(),
    destroy: () => sendMenu?.destroy(),
    addExtraBar,
    attachTextareaToWrap: () => inputController.attachTextareaToWrap(),
  };
}

function escapeAttr(s) {
  return escapeHtml(s ?? '').replace(/"/g, '&quot;');
}
