/**
 * Shared layer for copying xterm terminal contents in the Terminal, Chat,
 * Tasks and Agents panels.
 * Source: the xterm selection, or the whole buffer when nothing is selected.
 */

import { writeTextToClipboard } from './lib/clipboard.js';
import { t } from './i18n/index.js';

/**
 * Returns the text to copy from the terminal: the selection or the whole buffer.
 * @param {import('@xterm/xterm').Terminal | null | undefined} term
 * @returns {string}
 */
export function getCopyableTextFromTerminal(term) {
  if (!term || typeof term.getSelection !== 'function') return '';
  const sel = term.getSelection();
  if (sel && sel.length > 0) return sel;
  const buf = term.buffer?.active;
  if (!buf || typeof buf.getLine !== 'function') return '';
  let text = '';
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (line && typeof line.translateToString === 'function') {
      text += line.translateToString(true) + '\n';
    }
  }
  return text.trimEnd();
}

/**
 * Copies the terminal contents (selection or buffer) to the clipboard.
 * @param {import('@xterm/xterm').Terminal | null | undefined} term
 * @returns {Promise<boolean>} true when the text was copied
 */
export async function copyFromTerminal(term) {
  const text = getCopyableTextFromTerminal(term);
  if (!text) return false;
  return writeTextToClipboard(text);
}

/**
 * Creates a copy button for a panel bar.
 * @param {() => { term: import('@xterm/xterm').Terminal | null } | null} getTerminalState - returns { term } for the active context
 * @param {string} [title] - tooltip; defaults to the translated copy hint
 * @returns {{ button: HTMLButtonElement }}
 */
export function createCopyButton(getTerminalState, title = null) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-settings-btn panel-copy-btn';
  button.title = title || t('terminal.copyTitle');
  button.setAttribute('aria-label', t('common.copy'));
  button.textContent = t('common.copy');
  button.addEventListener('click', async () => {
    const state = getTerminalState?.();
    const term = state?.term ?? null;
    const ok = await copyFromTerminal(term);
    if (ok) {
      const prev = button.textContent;
      button.textContent = t('common.copied');
      setTimeout(() => { button.textContent = prev; }, 1500);
    }
  });
  return { button };
}
