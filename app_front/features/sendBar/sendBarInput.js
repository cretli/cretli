import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../lib/storageKeyAlias.js';
import { t } from '../../i18n/index.js';

const MULTILINE_STORAGE_KEY = 'cretli-sendbar-multiline';

export function getStoredMultiline() {
  if (typeof localStorage === 'undefined') return false;
  try {
    return readStorageValueWithAlias(localStorage, MULTILINE_STORAGE_KEY, '') === 'true';
  } catch {
    return false;
  }
}

export function createSendBarInput(options) {
  const {
    root,
    inputSlot,
    initialMultiline = false,
    basePlaceholder = '',
    getTextareaBarWrap,
    getAttachmentPlaceholder,
  } = options;

  if (!(root instanceof HTMLElement)) {
    throw new Error('sendBarInput: root element is required');
  }
  if (!(inputSlot instanceof HTMLElement)) {
    throw new Error('sendBarInput: inputSlot element is required');
  }

  let multiline = !!initialMultiline;
  let currentBasePlaceholder = basePlaceholder ?? '';
  let inputElementOverride = null;
  let textareaBarContainer = null;
  let onSendShortcut = null;

  function getInputElement() {
    return inputElementOverride ?? root.querySelector('.send-keys-input');
  }

  function getInputPlaceholder() {
    if (typeof getAttachmentPlaceholder === 'function') {
      return getAttachmentPlaceholder();
    }
    return currentBasePlaceholder;
  }

  function updateInputPlaceholder() {
    const el = getInputElement();
    if (!el) return;
    el.placeholder = getInputPlaceholder();
  }

  function bindSendShortcut(callback) {
    onSendShortcut = typeof callback === 'function' ? callback : null;
    attachInputKeydown(getInputElement());
  }

  function attachInputKeydown(el) {
    if (!el) return;
    if (el._sendBarKeydownBound) return;
    el._sendBarKeydownBound = true;
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (typeof onSendShortcut !== 'function') return;
      const isTextarea = el.tagName === 'TEXTAREA';
      if (isTextarea) {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        onSendShortcut();
        return;
      }
      e.preventDefault();
      onSendShortcut();
    });
  }

  function getCommonInputAttrs() {
    return {
      'aria-label': t('sendBar.messageAria'),
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
    };
  }

  function applyCommonInputAttrs(el) {
    const attrs = getCommonInputAttrs();
    Object.keys(attrs).forEach((key) => {
      el.setAttribute(key, attrs[key]);
    });
  }

  function createTextInput(placeholder, value) {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'send-keys-input';
    inp.placeholder = placeholder;
    inp.value = value;
    applyCommonInputAttrs(inp);
    return inp;
  }

  function createTextareaInput(placeholder, value) {
    const ta = document.createElement('textarea');
    ta.className = 'send-keys-input send-keys-input-fullwidth';
    ta.rows = 3;
    ta.placeholder = placeholder;
    ta.value = value;
    applyCommonInputAttrs(ta);
    return ta;
  }

  function restoreInputSlotWithOverride() {
    if (!inputElementOverride) return;
    inputSlot.textContent = '';
    inputSlot.appendChild(inputElementOverride);
    inputSlot.classList.add('send-keys-input-slot-placeholder');
  }

  function removeOtherTextareaBarsAndAddOurs(bar, keepBar = null) {
    if (typeof getTextareaBarWrap !== 'function') return;
    const textareaWrap = getTextareaBarWrap();
    if (!textareaWrap) return;
    const existing = textareaWrap.querySelectorAll('.send-bar-textarea-bar');
    existing.forEach((existingBar) => {
      if (existingBar === keepBar) return;
      if (typeof existingBar._sendBarRestore === 'function') existingBar._sendBarRestore();
      existingBar.remove();
    });
    if (bar !== keepBar) textareaWrap.insertBefore(bar, textareaWrap.firstChild);
    textareaWrap.classList.add('is-visible');
    textareaWrap.setAttribute('aria-hidden', 'false');
  }

  function createTextareaBar(textarea) {
    const bar = document.createElement('div');
    bar.className = 'send-bar-textarea-bar';
    bar.appendChild(textarea);
    bar._sendBarRestore = () => {
      if (textareaBarContainer !== bar || !inputElementOverride) return;
      restoreInputSlotWithOverride();
      textareaBarContainer = null;
    };
    return bar;
  }

  function moveCurrentInputToTextareaWrap() {
    if (typeof getTextareaBarWrap !== 'function') return false;
    const textareaWrap = getTextareaBarWrap();
    if (!textareaWrap) return false;
    const el = getInputElement();
    if (!el) return false;

    const placeholder = el.placeholder ?? currentBasePlaceholder;
    const value = el.value ?? '';
    const textarea = el.tagName === 'TEXTAREA' ? el : createTextareaInput(placeholder, value);
    if (textarea !== el) el.remove();
    const bar = createTextareaBar(textarea);
    removeOtherTextareaBarsAndAddOurs(bar);
    textareaBarContainer = bar;
    inputElementOverride = textarea;
    restoreInputSlotWithOverride();
    attachInputKeydown(textarea);
    updateInputPlaceholder();
    return true;
  }

  function setMultiline(enable) {
    const normalizedEnable = !!enable;
    if (normalizedEnable === multiline) return;
    const el = getInputElement();
    const placeholder = (el && el.placeholder) ?? currentBasePlaceholder;
    const value = (el && el.value) ?? '';

    if (normalizedEnable) {
      const textarea = createTextareaInput(placeholder, value);
      if (moveCurrentInputToTextareaWrap()) {
        multiline = true;
      } else {
        const slotInput = inputSlot.querySelector('.send-keys-input');
        if (slotInput) slotInput.replaceWith(textarea);
        inputElementOverride = null;
        textareaBarContainer = null;
        multiline = true;
        attachInputKeydown(textarea);
      }
    } else {
      const input = createTextInput(placeholder, value);
      if (textareaBarContainer && textareaBarContainer.parentNode) {
        const wrap = textareaBarContainer.parentNode;
        textareaBarContainer.remove();
        textareaBarContainer = null;
        inputElementOverride = null;
        if (wrap && wrap.classList && wrap.querySelectorAll('.send-bar-textarea-bar').length === 0) {
          wrap.classList.remove('is-visible');
          wrap.setAttribute('aria-hidden', 'true');
        }
      }
      inputSlot.classList.remove('send-keys-input-slot-placeholder');
      inputSlot.textContent = '';
      inputSlot.appendChild(input);
      multiline = false;
      attachInputKeydown(input);
    }
    updateInputPlaceholder();
    try {
      writeStorageValueWithAlias(localStorage, MULTILINE_STORAGE_KEY, normalizedEnable ? 'true' : 'false');
    } catch {}
  }

  function attachTextareaToWrap() {
    if (!multiline) return;
    if (!moveCurrentInputToTextareaWrap()) return;
    if (textareaBarContainer && textareaBarContainer.parentNode) {
      removeOtherTextareaBarsAndAddOurs(textareaBarContainer, textareaBarContainer);
    }
  }

  function focusInput() {
    getInputElement()?.focus();
  }

  function setPlaceholder(placeholder) {
    currentBasePlaceholder = placeholder ?? '';
    updateInputPlaceholder();
  }

  function getBasePlaceholder() {
    return currentBasePlaceholder;
  }

  function isMultiline() {
    return multiline;
  }

  attachInputKeydown(getInputElement());
  if (multiline) attachTextareaToWrap();
  updateInputPlaceholder();

  return {
    getInputElement,
    focusInput,
    bindSendShortcut,
    setPlaceholder,
    getBasePlaceholder,
    updateInputPlaceholder,
    setMultiline,
    isMultiline,
    attachTextareaToWrap,
  };
}
