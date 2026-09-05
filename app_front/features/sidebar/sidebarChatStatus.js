/**
 * Sidebar status chip: connection, working, and needs-action use the same
 * glyph size as the trash/star actions; other tones keep the text label.
 */

const DISCONNECTED_ICON_HTML = '<span class="mdi mdi-link-variant-off" aria-hidden="true"></span>';
const CONNECTING_ICON_HTML = '<span class="mdi mdi-loading mdi-spin" aria-hidden="true"></span>';
const WORKING_ICON_HTML = '<span class="mdi mdi-cog-outline mdi-spin" aria-hidden="true"></span>';
const NEEDS_ACTION_ICON_HTML = '<span class="mdi mdi-alert-circle-outline" aria-hidden="true"></span>';

const NEEDS_ACTION_TONES = new Set([
  'awaiting',
  'approval',
  'question',
  'textarea',
  'choice',
]);

/**
 * @param {string} tone
 * @returns {boolean}
 */
export function isIconOnlySidebarStatus(tone) {
  return tone === 'disconnected'
    || tone === 'connecting'
    || tone === 'active'
    || NEEDS_ACTION_TONES.has(tone);
}

/**
 * @param {{ tone?: string, label?: string } | null | undefined} meta
 * @param {(value: string) => string} escapeHtml
 * @returns {string}
 */
export function renderSidebarChatStatusHtml(meta, escapeHtml) {
  const tone = String(meta?.tone || '');
  const label = typeof meta?.label === 'string' ? meta.label : '';
  if (tone === 'disconnected') return DISCONNECTED_ICON_HTML;
  if (tone === 'connecting') return CONNECTING_ICON_HTML;
  if (tone === 'active') return WORKING_ICON_HTML;
  if (NEEDS_ACTION_TONES.has(tone)) return NEEDS_ACTION_ICON_HTML;
  const escape = typeof escapeHtml === 'function' ? escapeHtml : (value) => String(value || '');
  return escape(label);
}

/**
 * Updates the status chip without replacing its DOM when the tone is unchanged,
 * so CSS spin/blink animations keep running across sidebar polls.
 *
 * @param {HTMLElement | null | undefined} el
 * @param {{ tone?: string, label?: string } | null | undefined} meta
 * @param {{ escapeHtml?: (value: string) => string, title?: string }} [options]
 * @returns {boolean} true when the inner markup was rewritten
 */
export function applySidebarChatStatusEl(el, meta, options = {}) {
  if (!el) return false;
  const tone = String(meta?.tone || '');
  const show = tone !== 'idle';
  const nextClass = 'sidebar-chat-item-awaiting sidebar-chat-item-awaiting--' + tone;
  const title = typeof options.title === 'string' ? options.title : '';
  el.hidden = !show;
  if (el.className !== nextClass) el.className = nextClass;
  if (title && el.getAttribute('title') !== title) el.setAttribute('title', title);
  const currentTone = el.getAttribute('data-status-tone') || '';
  if (currentTone === tone) return false;
  el.setAttribute('data-status-tone', tone);
  el.innerHTML = renderSidebarChatStatusHtml(meta, options.escapeHtml);
  return true;
}
