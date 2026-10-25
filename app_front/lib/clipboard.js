import {
  isWidgetHostClipboardAvailable,
  requestWidgetHostCopyText,
} from '../embed/widgetHostClipboard.js';

/**
 * @param {string} text
 * @returns {boolean}
 */
function tryExecCommandCopy(text) {
  if (typeof document === 'undefined') return false;
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Copies text to the clipboard. Inside the embedded widget the write is
 * delegated to the host page.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function writeTextToClipboard(text) {
  const value = String(text ?? '');
  if (!value) return false;

  if (isWidgetHostClipboardAvailable()) {
    try {
      await requestWidgetHostCopyText(value);
      return true;
    } catch {
      // fall back to the local methods below
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // fall back to execCommand
    }
  }

  return tryExecCommandCopy(value);
}
