/**
 * Terminal settings: font size and read-only mode (localStorage), wired to the Settings panel UI.
 */
import { TERMINAL_FONT_SIZE_KEY, TERMINAL_FONT_SIZE_PRESETS } from './config.js';
import { getTerminalFontSizeOverride } from './terminalViewport.js';
import { t } from './i18n/index.js';
import {
  readStorageValueWithAlias,
  removeStorageValueWithAlias,
  writeStorageValueWithAlias,
} from './lib/storageKeyAlias.js';

const TERMINAL_READONLY_KEY = 'cretli-terminal-readonly';

function triggerTerminalRefit() {
  if (typeof window === 'undefined') return;
  const emit = () => window.dispatchEvent(new Event('resize'));
  emit();
  requestAnimationFrame(emit);
  setTimeout(emit, 120);
}

export function getTerminalReadOnly() {
  if (typeof localStorage === 'undefined') return false;
  return readStorageValueWithAlias(localStorage, TERMINAL_READONLY_KEY, '') === '1';
}

function setTerminalReadOnly(value) {
  if (typeof localStorage === 'undefined') return;
  writeStorageValueWithAlias(localStorage, TERMINAL_READONLY_KEY, value ? '1' : '0');
}

/**
 * Initializes the terminal font-size select: fills the options, loads the stored value,
 * and persists plus refits the terminal on change.
 */
/**
 * @param {HTMLElement} select
 */
function fillTerminalFontSizeOptions(select) {
  const options = TERMINAL_FONT_SIZE_PRESETS.map(({ value, labelKey }) => ({
    value: String(value),
    label: t(labelKey),
  }));
  if (select.tagName === 'CR-BAR-SELECT') {
    select.options = options;
    return;
  }
  select.replaceChildren();
  options.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.value;
    opt.textContent = item.label;
    select.appendChild(opt);
  });
}

export function initTerminalFontSizeSettings() {
  const select = document.getElementById('terminal-font-size-select');
  if (!select) return;

  fillTerminalFontSizeOptions(select);
  window.addEventListener('cr-lang-changed', () => fillTerminalFontSizeOptions(select));

  const current = getTerminalFontSizeOverride();
  select.value = current === 0 ? '0' : String(current);

  select.addEventListener('change', () => {
    const v = select.value;
    const num = v === '' || v === '0' ? 0 : parseInt(v, 10);
    if (num === 0) {
      removeStorageValueWithAlias(localStorage, TERMINAL_FONT_SIZE_KEY);
    } else {
      writeStorageValueWithAlias(localStorage, TERMINAL_FONT_SIZE_KEY, String(num));
    }
    triggerTerminalRefit();
  });

  const readonlyCheckbox = document.getElementById('terminal-readonly-checkbox');
  if (readonlyCheckbox) {
    readonlyCheckbox.checked = getTerminalReadOnly();
    readonlyCheckbox.addEventListener('change', () => setTerminalReadOnly(!!readonlyCheckbox.checked));
  }
}
