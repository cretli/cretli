/**
 * Cretli — lightweight frontend i18n system.
 *
 * English ships with the bundle; other dictionaries are fetched on demand, so
 * `initI18n` and `setLang` are asynchronous — await them before rendering text.
 * The choice is persisted in localStorage (key `cretli-lang`, with legacy alias
 * support) and a `cr-lang-changed` event is emitted on window, which Lit/JS
 * components use to re-render or re-apply static text.
 *
 * Usage:
 *   import { t, getCurrentLang, setLang, initI18n } from '../i18n/index.js';
 *   await initI18n();
 *   t('chat.send')                       // -> "Send" / "Wyślij"
 *   t('errors.network', { detail: 'x' }) // -> {detail} interpolation
 */

import { en } from './en.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../lib/storageKeyAlias.js';

const STORAGE_KEY = 'cretli-lang';
export const AVAILABLE_LANGS = ['en', 'pl'];
export const DEFAULT_LANG = 'en';

const dictionaries = { en };

const dictionaryLoaders = {
  pl: () => import(/* webpackChunkName: "i18n-pl" */ './pl.js').then((mod) => mod.pl),
};

let currentLang = DEFAULT_LANG;

/** Detects the language: localStorage > navigator (if pl) > default. */
function detectLang() {
  try {
    const saved = (readStorageValueWithAlias(localStorage, STORAGE_KEY, '') || '').trim().toLowerCase();
    if (AVAILABLE_LANGS.includes(saved)) return saved;
  } catch {}
  if (typeof navigator !== 'undefined') {
    const nav = (navigator.language || '').toLowerCase();
    if (nav.startsWith('pl')) return 'pl';
  }
  return DEFAULT_LANG;
}

/**
 * Loads a dictionary that is not bundled with the app.
 * @param {string} lang
 * @returns {Promise<boolean>} false when the chunk could not be fetched
 */
async function ensureDictionaryLoaded(lang) {
  if (dictionaries[lang]) return true;
  const loader = dictionaryLoaders[lang];
  if (!loader) return false;
  try {
    dictionaries[lang] = await loader();
    return true;
  } catch (err) {
    console.warn(`[i18n] could not load the "${lang}" dictionary:`, err?.message || err);
    return false;
  }
}

/**
 * Initializes the language (once at startup) and sets <html lang>.
 * @returns {Promise<void>}
 */
export async function initI18n() {
  const detected = detectLang();
  currentLang = (await ensureDictionaryLoaded(detected)) ? detected : DEFAULT_LANG;
  applyHtmlLang();
}

export function getCurrentLang() {
  return currentLang;
}

/**
 * Switches the language, fetching its dictionary first so the UI never renders
 * a half-translated frame.
 * @param {string} lang
 * @returns {Promise<void>}
 */
export async function setLang(lang) {
  const next = AVAILABLE_LANGS.includes(lang) ? lang : DEFAULT_LANG;
  if (next === currentLang) return;
  if (!(await ensureDictionaryLoaded(next))) return;
  currentLang = next;
  try {
    writeStorageValueWithAlias(localStorage, STORAGE_KEY, next);
  } catch {}
  applyHtmlLang();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('cr-lang-changed', { detail: { lang: next } }));
  }
}

function applyHtmlLang() {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('lang', currentLang);
  }
}

/**
 * Translates a key into the current language with optional {variable} interpolation.
 * Missing key -> EN fallback -> the key itself.
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 * @returns {string}
 */
export function t(key, vars = null) {
  const dict = dictionaries[currentLang] || dictionaries[DEFAULT_LANG];
  let str = lookup(dict, key);
  if (str === undefined) str = lookup(dictionaries[DEFAULT_LANG], key);
  if (str === undefined) return key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.split(`{${k}}`).join(String(v));
    }
  }
  return str;
}

function lookup(dict, key) {
  if (!dict) return undefined;
  const parts = key.split('.');
  let cur = dict;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}
