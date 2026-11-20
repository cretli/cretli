/**
 * Embed (page widget) chat-mode chooser, shown when the host page has no
 * pinned chat. Two modes:
 * - page: a chat pinned to the current URL (same flow as the launcher "+");
 * - general: one unpinned chat shared by the whole workspace across pages.
 * Without it the panel showed an empty pane with a "Connecting…" pill that never
 * resolved, because there was no chat to connect to.
 */
import { t } from '../../../i18n/index.js';

const ROOT_ID = 'embed-no-chat-state';
const MODE_STORAGE_KEY = 'cretli-embed-chat-mode';

/** Window event the embed bridge forwards to the host page as a "+" request. */
export const EMBED_REQUEST_PAGE_CHAT_EVENT = 'cr-widget-request-page-chat';
/** Window event handled by chat selection: open the general workspace chat. */
export const EMBED_OPEN_GENERAL_CHAT_EVENT = 'cr-widget-open-general-chat';

/** @returns {'page' | 'general' | ''} */
export function readEmbedChatMode() {
  try {
    const value = localStorage.getItem(MODE_STORAGE_KEY);
    return value === 'page' || value === 'general' ? value : '';
  } catch {
    return '';
  }
}

/** @param {'page' | 'general'} mode */
export function saveEmbedChatMode(mode) {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // Storage may be blocked in a third-party iframe; the chooser just shows again.
  }
}

function isEmbedBody() {
  return typeof document !== 'undefined' && document.body?.classList.contains('embed-mode');
}

/**
 * @param {string} label
 * @param {'primary' | ''} variant
 * @param {string} eventName
 * @param {'page' | 'general'} mode
 */
function buildChoice(label, variant, eventName, mode) {
  const button = document.createElement('cr-bar-button');
  if (variant) button.setAttribute('variant', variant);
  button.className = 'embed-no-chat-state__choice';
  button.textContent = label;
  button.addEventListener('click', () => {
    if (button.hasAttribute('disabled')) return;
    button.setAttribute('disabled', '');
    saveEmbedChatMode(mode);
    window.dispatchEvent(new CustomEvent(eventName));
    // Re-enable in case the flow fails; a successful selection hides the chooser.
    setTimeout(() => button.removeAttribute('disabled'), 4000);
  });
  return button;
}

function buildRoot() {
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'embed-no-chat-state';
  root.setAttribute('role', 'status');

  const icon = document.createElement('span');
  icon.className = 'mdi mdi-chat-plus-outline embed-no-chat-state__icon';
  icon.setAttribute('aria-hidden', 'true');

  const title = document.createElement('p');
  title.className = 'embed-no-chat-state__title';
  title.textContent = t('widget.embedNoChatTitle');

  const hint = document.createElement('p');
  hint.className = 'embed-no-chat-state__hint';
  hint.textContent = t('widget.embedNoChatHint');

  const choices = document.createElement('div');
  choices.className = 'embed-no-chat-state__choices';
  choices.append(
    buildChoice(t('widget.embedNoChatCreate'), 'primary', EMBED_REQUEST_PAGE_CHAT_EVENT, 'page'),
    buildChoice(t('widget.embedNoChatGeneral'), '', EMBED_OPEN_GENERAL_CHAT_EVENT, 'general'),
  );

  root.append(icon, title, hint, choices);
  return root;
}

/**
 * @param {boolean} visible
 */
export function setEmbedNoChatState(visible) {
  if (!isEmbedBody()) return;
  const host = document.querySelector('#chat-panel .chat-main');
  if (!host) return;
  const existing = document.getElementById(ROOT_ID);
  document.body.classList.toggle('embed-no-chat', !!visible);
  if (!visible) {
    existing?.remove();
    return;
  }
  if (existing) return;
  host.appendChild(buildRoot());
}
