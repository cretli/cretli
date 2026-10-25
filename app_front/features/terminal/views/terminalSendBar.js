/**
 * The shared send bar of the terminal panel.
 */
import { createSendBar } from '../../sendBar/index.js';
import {
  getChatSendBarResizeObserver,
  scheduleChatSendBarReserveSync,
} from '../../chat/chatSendBarLayout.js';
import { t } from '../../../i18n/index.js';
import { setSpecialCharsBarVisibility } from '../components/specialChars.js';
import { sendSequenceToTerminalState } from '../services/inputDispatch.js';
import { findTerminal, terminalState } from '../state/terminalStore.js';

export function initTerminalSendBar() {
  const wrap = document.getElementById('terminal-send-bar-wrap');
  if (!wrap || wrap.children.length > 0) return;

  function sendToActive(text) {
    const target = findTerminal(terminalState.activeId) ?? null;
    const toSend = text ? text + '\r' : '\r';
    return sendSequenceToTerminalState(target, toSend, { focus: false });
  }

  const sendBar = createSendBar({
    placeholder: t('terminal.commandPlaceholder'),
    showToggleExtra: true,
    getExtraBarWrap: () => document.getElementById('chat-extra-bar-wrap'),
    showArrows: true,
    showStop: true,
    keepInputFocus: true,
    onSend: sendToActive,
    // @ts-ignore -- option consumed by the send bar at runtime
    onArrowUp: () => sendToActive('\x1b[A'),
    onArrowDown: () => sendToActive('\x1b[B'),
    onStop: () => sendToActive('\x03'),
    setSpecialCharsBarVisibility,
  });
  terminalState.sendBar = sendBar;
  wrap.appendChild(sendBar.root);
  const sendBarObserver = getChatSendBarResizeObserver();
  if (sendBarObserver) sendBarObserver.observe(wrap);
  scheduleChatSendBarReserveSync();
}

/**
 * Returns the terminal panel send bar, used to toggle multiline mode.
 * @returns {{ setMultiline: (b: boolean) => void, isMultiline: () => boolean } | null}
 */
export function getTerminalSendBar() {
  return terminalState.sendBar;
}
