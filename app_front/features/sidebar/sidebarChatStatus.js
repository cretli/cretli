/**
 * Sidebar status chip: connection, working, and needs-action use the same
 * glyph size as the trash/star actions; other tones keep the text label.
 *
 * The active chip has a fixed geometry: the spinning icon is always present and
 * the tool label lives in a fixed-width, ellipsised element. Updating the label
 * only writes `textContent`, so the icon node (and its animation) survives.
 */

const DISCONNECTED_ICON_HTML = '<span class="mdi mdi-link-variant-off" aria-hidden="true"></span>';
const CONNECTING_ICON_HTML = '<span class="mdi mdi-loading mdi-spin" aria-hidden="true"></span>';
const SYNCING_ICON_HTML = '<span class="mdi mdi-sync mdi-spin" aria-hidden="true"></span>';
const WORKING_ICON_HTML = '<span class="mdi mdi-cog-outline mdi-spin" aria-hidden="true"></span>';
const NEEDS_ACTION_ICON_HTML = '<span class="mdi mdi-alert-circle-outline" aria-hidden="true"></span>';
export const ACTIVITY_LABEL_CLASS = 'sidebar-chat-item-activity-label';
const SETTLED_STATUS_ICONS = {
  completed: '<span class="mdi mdi-check-circle-outline" aria-hidden="true"></span>',
  failed: '<span class="mdi mdi-alert-circle-outline" aria-hidden="true"></span>',
  interrupted: '<span class="mdi mdi-pause-circle-outline" aria-hidden="true"></span>',
  cancelled: '<span class="mdi mdi-close-circle-outline" aria-hidden="true"></span>',
};

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
export function isIconOnlySidebarStatus(tone, meta = null) {
  if (tone === 'active' && meta?.activityKey) return false;
  if (tone === 'attention' && SETTLED_STATUS_ICONS[meta?.status]) return true;
  return tone === 'disconnected'
    || tone === 'connecting'
    || tone === 'syncing'
    || tone === 'active'
    || NEEDS_ACTION_TONES.has(tone);
}

/**
 * @param {string} label
 * @param {(value: string) => string} escape
 * @returns {string}
 */
function renderActiveChipHtml(label, escape) {
  // The label element is always rendered (empty when there is no tool) so the
  // chip keeps the same width and the title next to it never reflows.
  return WORKING_ICON_HTML +
    '<span class="' + ACTIVITY_LABEL_CLASS + '">' + escape(label) + '</span>';
}

/**
 * @param {{ tone?: string, label?: string } | null | undefined} meta
 * @param {(value: string) => string} escapeHtml
 * @returns {string}
 */
export function renderSidebarChatStatusHtml(meta, escapeHtml) {
  const tone = String(meta?.tone || '');
  const label = typeof meta?.label === 'string' ? meta.label : '';
  const escape = typeof escapeHtml === 'function' ? escapeHtml : (value) => String(value || '');
  if (tone === 'disconnected') return DISCONNECTED_ICON_HTML;
  if (tone === 'connecting') return CONNECTING_ICON_HTML;
  if (tone === 'syncing') return SYNCING_ICON_HTML;
  if (tone === 'active') {
    return renderActiveChipHtml(meta?.activityKey ? label : '', escape);
  }
  if (tone === 'attention' && SETTLED_STATUS_ICONS[meta?.status]) return SETTLED_STATUS_ICONS[meta.status];
  if (NEEDS_ACTION_TONES.has(tone)) return NEEDS_ACTION_ICON_HTML;
  return escape(label);
}

/**
 * Updates the status chip without replacing its DOM when the tone is unchanged,
 * so CSS spin/blink animations keep running across sidebar polls.
 *
 * @param {HTMLElement | null | undefined} el
 * @param {{ tone?: string, label?: string } | null | undefined} meta
 * @param {{ escapeHtml?: (value: string) => string, title?: string }} [options]
 * @returns {boolean} true when the rendered content changed
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
  const activityKey = typeof meta?.activityKey === 'string' ? meta.activityKey : '';
  const label = typeof meta?.label === 'string' ? meta.label : '';
  const status = typeof meta?.status === 'string' ? meta.status : '';
  const currentTone = el.getAttribute('data-status-tone') || '';
  const currentActivity = el.getAttribute('data-activity-key') || '';
  const currentLabel = el.getAttribute('data-status-label') || '';
  const currentStatus = el.getAttribute('data-status-outcome') || '';
  const toneChanged = currentTone !== tone;
  const statusChanged = currentStatus !== status;
  const contentChanged = currentLabel !== label || currentActivity !== activityKey;
  el.setAttribute('data-status-tone', tone);
  el.setAttribute('data-activity-key', activityKey);
  el.setAttribute('data-status-label', label);
  el.setAttribute('data-status-outcome', status);
  // The icon is a function of tone/outcome only. Rewriting `innerHTML` on a
  // label-only change would restart the spinner, so update the label in place.
  if (toneChanged || statusChanged) {
    el.innerHTML = renderSidebarChatStatusHtml(meta, options.escapeHtml);
    return true;
  }
  if (!contentChanged) return false;
  if (tone === 'active') {
    const labelEl = typeof el.querySelector === 'function'
      ? el.querySelector('.' + ACTIVITY_LABEL_CLASS)
      : null;
    if (labelEl) {
      const nextText = activityKey ? label : '';
      if (labelEl.textContent !== nextText) labelEl.textContent = nextText;
      return true;
    }
    // Chip from an older render: append the label node instead of rebuilding, so
    // the existing spinner node survives.
    if (typeof el.appendChild === 'function' && el.ownerDocument?.createElement) {
      const span = el.ownerDocument.createElement('span');
      span.className = ACTIVITY_LABEL_CLASS;
      span.textContent = activityKey ? label : '';
      el.appendChild(span);
      return true;
    }
    // Plain test double without DOM support: fall back to markup.
    el.innerHTML = renderSidebarChatStatusHtml(meta, options.escapeHtml);
    return true;
  }
  // Text-only tone (e.g. an attention label without an outcome icon).
  if (typeof el.querySelector === 'function' && el.querySelector('.mdi')) return false;
  if ('textContent' in el) {
    el.textContent = label;
    return true;
  }
  el.innerHTML = renderSidebarChatStatusHtml(meta, options.escapeHtml);
  return true;
}

