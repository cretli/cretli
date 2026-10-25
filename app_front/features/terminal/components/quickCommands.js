/**
 * Quick commands: list persisted in localStorage, button bar above the panels,
 * sends the command to the terminal or to the chat send field.
 */
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../../lib/storageKeyAlias.js';

const QUICK_COMMANDS_KEY = 'cretli-quick-commands';
const DEFAULT_COMMANDS = ['git status', 'npm run dev', 'git pull'];

export function getQuickCommands() {
  if (typeof localStorage === 'undefined') return [...DEFAULT_COMMANDS];
  try {
    const raw = readStorageValueWithAlias(localStorage, QUICK_COMMANDS_KEY, '');
    if (!raw) return [...DEFAULT_COMMANDS];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c) => typeof c === 'string' && c.trim()) : [...DEFAULT_COMMANDS];
  } catch {
    return [...DEFAULT_COMMANDS];
  }
}

function setQuickCommands(list) {
  if (typeof localStorage === 'undefined') return;
  writeStorageValueWithAlias(localStorage, QUICK_COMMANDS_KEY, JSON.stringify(list));
}

/**
 * Renders the quick command buttons. The bar stays hidden when the list is empty.
 */
function renderBar() {
  const bar = document.getElementById('quick-commands-bar');
  if (!bar) return;
  const commands = getQuickCommands();
  if (commands.length === 0) {
    bar.style.display = 'none';
    bar.replaceChildren();
    return;
  }
  bar.style.display = 'flex';
  bar.replaceChildren(...commands.map((cmd, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-cmd-btn';
    btn.dataset.index = String(i);
    btn.title = cmd;
    btn.textContent = truncate(cmd, 18);
    btn.addEventListener('click', () => {
      const text = getQuickCommands()[i];
      if (text != null && onQuickCommandSelect) onQuickCommandSelect(text);
    });
    return btn;
  }));
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

let onQuickCommandSelect = null;

/**
 * Registers the callback invoked with the command text when a quick command is picked.
 * It is expected to route the text to the terminal or to the chat send field,
 * depending on which panel is active.
 */
export function setQuickCommandHandler(fn) {
  onQuickCommandSelect = typeof fn === 'function' ? fn : null;
}

/**
 * Initializes the Settings section (textarea, save button) and the button bar.
 * Call it once the DOM is ready.
 */
export function initQuickCommands() {
  const textarea = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('quick-commands-input'));
  const saveBtn = document.getElementById('quick-commands-save');
  if (textarea) {
    textarea.value = getQuickCommands().join('\n');
  }
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const raw = textarea?.value || '';
      const list = raw
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      setQuickCommands(list);
      renderBar();
      const status = document.getElementById('quick-commands-save-status');
      if (status) {
        status.textContent = 'Zapisano.';
        setTimeout(() => { status.textContent = ''; }, 2000);
      }
    });
  }
  renderBar();
}

/**
 * Re-renders the bar, e.g. after the command list was saved in Settings.
 */
export function refreshQuickCommandsBar() {
  renderBar();
}
