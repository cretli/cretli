/**
 * Special keys bar: a single tap sends the key's escape sequence.
 */
import { t } from '../../../i18n/index.js';

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
  bar.replaceChildren(...SPECIAL_KEYS.map((key) => {
    const title = t(key.titleKey);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'special-char-btn';
    btn.dataset.key = key.id;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.textContent = key.label;
    btn.addEventListener('click', () => {
      if (!onSpecialCharSelect) return;
      onSpecialCharSelect(key.sequence);
    });
    return btn;
  }));
  bar.style.display = 'none';
}
