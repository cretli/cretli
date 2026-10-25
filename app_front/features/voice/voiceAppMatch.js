/**
 * Pure helpers for the panel / settings / status voice tools: spoken-alias
 * resolution (diacritic- and case-insensitive, Polish included) and the result
 * cap shared by the read-only tools (spec §4: lists <= 8 items, strings <= ~120
 * chars, total <= ~1.2 KB).
 */

export const VOICE_RESULT_MAX_ITEMS = 8;
export const VOICE_RESULT_MAX_STRING = 120;
export const VOICE_RESULT_MAX_BYTES = 1200;

export const VOICE_PANEL_IDS = Object.freeze([
  'chat', 'todo', 'files', 'git', 'github', 'browser',
  'tasks', 'terminal', 'logs', 'tests', 'instances', 'agents',
]);

/** @type {Record<string, string[]>} */
const PANEL_ALIASES = {
  chat: ['chat', 'czat', 'czaty', 'rozmowa', 'rozmowy'],
  todo: ['todo', 'to do', 'do zrobienia', 'lista todo', 'zadania todo'],
  files: ['files', 'file', 'pliki', 'plik', 'plikow', 'plikach', 'katalog', 'edytor'],
  git: ['git', 'gita', 'zmiany', 'repozytorium'],
  github: ['github', 'git hub', 'gitub'],
  browser: ['browser', 'przegladarka', 'przegladarke', 'przegladarki'],
  tasks: ['tasks', 'task', 'zadania', 'zadanie', 'taski', 'taski robocze'],
  terminal: ['terminal', 'terminala', 'konsola', 'konsole', 'powloka'],
  logs: ['logs', 'log', 'logi', 'dziennik', 'dziennika'],
  tests: ['tests', 'test', 'testy', 'testow', 'status parser'],
  instances: ['instances', 'instance', 'instancje', 'instancji'],
  agents: ['agents', 'agenci', 'agentow', 'agenty'],
};

/**
 * @param {unknown} value
 * @returns {string} lower-case text without diacritics (Polish ł included)
 */
export function foldSpoken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/\s+/g, ' ');
}

/**
 * @param {string} folded
 * @param {string[]} aliases
 * @returns {boolean}
 */
function hasWord(folded, aliases) {
  return aliases.some((alias) => new RegExp(`(^|[^a-z])${alias}([^a-z]|$)`).test(folded));
}

/**
 * @param {unknown} value spoken or enum panel name
 * @returns {string} panel id, or '' when unknown
 */
export function resolveVoicePanel(value) {
  const foldedInput = foldSpoken(value);
  // Singular "agent" alone is too broad (it also means the coding agent).
  // It names the panel only when the user also says "panel".
  const wantsPanelContext = /\bpanel(u|e)?\b/.test(foldedInput);
  const folded = foldedInput.replace(/\bpanel(u|e)?\b/g, '').replace(/\s+/g, ' ').trim();
  if (!folded) return '';
  if (VOICE_PANEL_IDS.includes(folded)) return folded;
  if (folded === 'agent') return wantsPanelContext ? 'agents' : '';
  for (const id of VOICE_PANEL_IDS) {
    if (PANEL_ALIASES[id].includes(folded)) return id;
  }
  for (const id of VOICE_PANEL_IDS) {
    if (hasWord(folded, PANEL_ALIASES[id].filter((alias) => !alias.includes(' ')))) return id;
  }
  return '';
}

/**
 * @param {unknown} value
 * @returns {'dark'|'light'|'system'|''}
 */
export function resolveVoiceTheme(value) {
  const folded = foldSpoken(value);
  if (!folded) return '';
  if (hasWord(folded, ['dark', 'ciemny', 'ciemna', 'ciemne', 'ciemnego', 'noc', 'nocny'])) return 'dark';
  if (hasWord(folded, ['light', 'jasny', 'jasna', 'jasne', 'jasnego', 'dzien', 'dzienny'])) return 'light';
  if (hasWord(folded, ['system', 'systemowy', 'systemowa', 'auto', 'automatyczny', 'automatyczna'])) return 'system';
  return '';
}

/**
 * @param {unknown} value
 * @returns {'en'|'pl'|''}
 */
export function resolveVoiceLanguage(value) {
  const folded = foldSpoken(value);
  if (!folded) return '';
  if (hasWord(folded, ['en', 'english', 'angielski', 'angielska', 'angielskim', 'angielskiego'])) return 'en';
  if (hasWord(folded, ['pl', 'polish', 'polski', 'polska', 'polskim', 'polskiego', 'po polsku'])) return 'pl';
  return '';
}

/**
 * @param {unknown} value
 * @returns {'mute'|'unmute'|''}
 */
export function resolveVoiceMicAction(value) {
  const folded = foldSpoken(value);
  if (!folded) return '';
  const muteNoun = hasWord(folded, ['wyciszenie', 'wyciszenia', 'mute', 'muted']);
  const enable = hasWord(folded, ['wlacz', 'wlaczaj', 'enable', 'odblokuj', 'on']);
  const disable = hasWord(folded, ['wylacz', 'disable', 'off']);
  // "odcisz"/"unmute" always mean unmute, even next to the mute noun.
  if (hasWord(folded, ['odcisz', 'unmute'])) return 'unmute';
  // "włącz/wyłącz wyciszenie" is a verb + noun pair: the noun wins.
  if (muteNoun) return disable && !enable ? 'unmute' : 'mute';
  if (hasWord(folded, ['wycisz', 'zamilknij'])) return 'mute';
  if (enable) return 'unmute';
  if (disable) return 'mute';
  return '';
}

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string} single-line text clipped to `max` chars
 */
export function clipVoiceText(value, max = VOICE_RESULT_MAX_STRING) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Caps a read-only tool result: array fields to 8 items, strings to 120 chars,
 * and the serialized size to ~1.2 KB (dropping trailing list items first).
 *
 * @param {Record<string, any>} result
 * @param {number} [maxBytes]
 * @returns {Record<string, any>} result with `truncated: true` when anything was cut
 */
export function capVoiceResult(result, maxBytes = VOICE_RESULT_MAX_BYTES) {
  let truncated = false;
  const capped = {};
  for (const [key, value] of Object.entries(result || {})) {
    if (typeof value === 'string') {
      const clipped = clipVoiceText(value);
      if (clipped !== value.replace(/\s+/g, ' ').trim()) truncated = true;
      capped[key] = clipped;
    } else if (Array.isArray(value)) {
      if (value.length > VOICE_RESULT_MAX_ITEMS) truncated = true;
      capped[key] = value.slice(0, VOICE_RESULT_MAX_ITEMS).map((item) => (
        typeof item === 'string' ? clipVoiceText(item) : item
      ));
    } else {
      capped[key] = value;
    }
  }
  const arrayKeys = Object.keys(capped).filter((key) => Array.isArray(capped[key]));
  while (JSON.stringify(capped).length > maxBytes) {
    const key = arrayKeys.find((name) => capped[name].length > 0);
    if (!key) break;
    capped[key].pop();
    truncated = true;
  }
  if (truncated) capped.truncated = true;
  return capped;
}
