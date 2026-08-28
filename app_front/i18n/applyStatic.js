/**
 * Applies translations to static HTML (index.html) via attributes:
 *   data-i18n="key"               -> textContent
 *   data-i18n-title="key"         -> title
 *   data-i18n-aria="key"          -> aria-label
 *   data-i18n-placeholder="key"   -> placeholder
 * Re-applies on language change (cr-lang-changed event).
 */

import { t, getCurrentLang } from './index.js';

const ATTRS = [
  { attr: 'data-i18n', set: (el, v) => { el.textContent = v; } },
  { attr: 'data-i18n-title', set: (el, v) => { el.setAttribute('title', v); } },
  { attr: 'data-i18n-aria', set: (el, v) => { el.setAttribute('aria-label', v); } },
  { attr: 'data-i18n-placeholder', set: (el, v) => { el.setAttribute('placeholder', v); } },
];

export function applyStaticTranslations(root = document) {
  for (const { attr, set } of ATTRS) {
    const nodes = root.querySelectorAll(`[${attr}]`);
    for (const el of nodes) {
      const key = el.getAttribute(attr);
      if (!key) continue;
      set(el, t(key));
    }
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('lang', getCurrentLang());
  }
}

let wired = false;
/** Subscribes to language changes and re-applies static text. */
export function wireStaticTranslations() {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  window.addEventListener('cr-lang-changed', () => applyStaticTranslations());
}
