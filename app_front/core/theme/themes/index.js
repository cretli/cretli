/** Theme definitions contain only color deltas from the appearance base. */
/** @typedef {{ id: string, label: string, appearance: string, tokens: Record<string, string>, themeColor: string, terminal?: Record<string, string>, syntax?: Record<string, string> }} ThemeDefinition */

/** @type {Map<string, ThemeDefinition>} */
export const themes = new Map([
  ['cretli-dark', { id: 'cretli-dark', label: 'Cretli Dark', appearance: 'dark', tokens: {}, themeColor: '#1e1e1e' }],
  ['cretli-light', { id: 'cretli-light', label: 'Cretli Light', appearance: 'light', tokens: {}, themeColor: '#f3f3f3' }],
]);

export function isColor(value) {
  if (typeof value !== 'string') return false;
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return true;
  const match = value.match(/^(rgb|hsl)a?\(([^()]*)\)$/i);
  if (!match) return false;
  const parts = match[2].trim().split(/\s*[,/]\s*|\s+/);
  if (parts.length < 3 || parts.length > 4) return false;
  if (!parts.every((part) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(part))) return false;
  return match[1].toLowerCase() !== 'hsl' || (parts[1].endsWith('%') && parts[2].endsWith('%'));
}

/** Syntax palette keys a theme may override; each maps to the `--cr-code-<key>` token used by .hljs-*. */
const SYNTAX_KEYS = ['bg', 'text', 'keyword', 'string', 'number', 'title', 'comment', 'variable', 'attribute', 'built-in', 'meta', 'tag', 'deletion', 'addition'];

export function themeCss(definition) {
  const syntax = Object.entries(definition.syntax || {})
    .filter(([key]) => SYNTAX_KEYS.includes(key))
    .map(([key, value]) => [`--cr-code-${key}`, value]);
  const entries = [...syntax, ...Object.entries(definition.tokens || {})].filter(([key, value]) => /^--cr-[a-z0-9-]+$/.test(key) && isColor(value));
  // Beat appearance selectors even when this style precedes the base stylesheet.
  return entries.length ? `:root:root:root{${entries.map(([key, value]) => `${key}:${value}`).join(';')}}` : '';
}

export function registerTheme(definition) {
  if (!definition || !/^[a-z][a-z0-9-]*$/.test(definition.id) || !['dark', 'light'].includes(definition.appearance)) throw new TypeError('Invalid theme definition');
  const base = themes.get(`cretli-${definition.appearance}`);
  const safe = {
    ...definition,
    terminal: definition.terminal && typeof definition.terminal === 'object' ? { ...definition.terminal } : undefined,
    syntax: definition.syntax && typeof definition.syntax === 'object' ? { ...definition.syntax } : undefined,
    tokens: Object.fromEntries(Object.entries(definition.tokens || {}).filter(([key, value]) => /^--cr-[a-z0-9-]+$/.test(key) && isColor(value))),
    themeColor: isColor(definition.themeColor) ? definition.themeColor : base.themeColor,
  };
  themes.set(safe.id, safe);
  return safe;
}
