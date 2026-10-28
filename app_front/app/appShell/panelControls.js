/** Small panel-level controls: terminal copy buttons, active send bar lookup, language select. */
import { getActiveSendBar } from '../../features/chat/index.js';
import { copyFromTerminal } from '../../features/terminal/services/panelCopy.js';
import { t, getCurrentLang, setLang } from '../../i18n/index.js';
import {
  getTasksTerminalState,
  getTerminalPanelState,
  getTerminalSendBar,
} from './panelLoader.js';

export function initPanelCopyButtons() {
  async function handleCopy(getTerm) {
    const term = getTerm();
    const ok = await copyFromTerminal(term);
    if (ok) {
      const prev = this.textContent;
      this.textContent = t('app.copied');
      setTimeout(() => { this.textContent = prev; }, 1500);
    }
  }
  const terminalCopyBtn = document.getElementById('terminal-copy-btn');
  if (terminalCopyBtn) {
    terminalCopyBtn.addEventListener('click', async function () {
      await handleCopy.call(this, () => getTerminalPanelState()?.getActiveTerminal?.()?.term ?? null);
    });
  }
  const tasksCopyBtn = document.getElementById('tasks-copy-btn');
  if (tasksCopyBtn) {
    tasksCopyBtn.addEventListener('click', async function () {
      await handleCopy.call(this, () => getTasksTerminalState()?.term ?? null);
    });
  }
}

export function getActiveSendBarForPanel() {
  const chatPanel = document.getElementById('chat-panel');
  const terminalPanel = document.getElementById('terminal-panel');
  if (chatPanel?.classList.contains('active')) return getActiveSendBar();
  if (terminalPanel?.classList.contains('active')) return getTerminalSendBar();
  return null;
}

export function initLangSelect() {
  const select = document.getElementById('lang-select');
  if (!select) return;
  if (select.tagName === 'CR-BAR-SELECT') {
    select.options = [
      { value: 'en', label: 'English' },
      { value: 'pl', label: 'Polski' },
    ];
  }
  select.value = getCurrentLang();
  select.addEventListener('change', () => void setLang(select.value));
}
