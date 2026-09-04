/**
 * Special keys bar: a single tap sends the key's escape sequence.
 */
import { t } from './i18n/index.js';
import { escapeHtml } from './features/chat/chatHtmlUtils.js';

const SPECIAL_KEYS = [
  { id: 'esc', label: 'ESC', titleKey: 'specialChars.escape', sequence: '\x1b' },
  { id: 'enter', label: 'Enter', titleKey: 'specialChars.enter', sequence: '\r' },
  { id: 'tab', label: 'Tab', titleKey: 'specialChars.tab', sequence: '\t' },
  { id: 'up', label: '↑', titleKey: 'specialChars.arrowUp', sequence: '\x1b[A' },
  { id: 'down', label: '↓', titleKey: 'specialChars.arrowDown', sequence: '\x1b[B' },
  { id: 'left', label: '←', titleKey: 'specialChars.arrowLeft', sequence: '\x1b[D' },
  { id: 'right', label: '→', titleKey: 'specialChars.arrowRight', sequence: '\x1b[C' },
];

let onSpecialCharSelect = null;

/**
 * @param {(sequence: string) => void} fn - called with the key sequence
 */
export function setSpecialCharHandler(fn) {
  onSpecialCharSelect = fn;
}

/**
 * Shows or hides the special characters bar (e.g. when switching tabs).
 * @param {boolean} visible
 */
export function setSpecialCharsBarVisibility(visible) {
  const bar = document.getElementById('special-chars-bar');
  if (!bar) return;
  bar.style.display = visible ? 'flex' : 'none';
}

/**
 * Initializes the bar: renders the buttons and wires up click handlers.
 */
export function initSpecialChars() {
  const bar = document.getElementById('special-chars-bar');
  if (!bar) return;
  bar.innerHTML = SPECIAL_KEYS.map((key) => {
    const title = escapeAttr(t(key.titleKey));
    return (
      '<button type="button" class="special-char-btn" data-key="' +
      escapeAttr(key.id) +
      '" title="' +
      title +
      '" aria-label="' +
      title +
      '">' +
      escapeHtml(key.label) +
      '</button>'
    );
  }).join('');
  bar.querySelectorAll('.special-char-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const keyId = btn.dataset.key;
      if (!keyId || !onSpecialCharSelect) return;
      const key = SPECIAL_KEYS.find((item) => item.id === keyId);
      if (!key) return;
      const sequence = key.sequence;
      onSpecialCharSelect(sequence);
    });
  });
  bar.style.display = 'none';
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
