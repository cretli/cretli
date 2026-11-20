/**
 * Test helper: flattens a lit TemplateResult (html or svg) to a markup string.
 * Dynamic values are HTML-escaped like lit text bindings would; nested
 * templates, arrays, `nothing` and empty values collapse as lit renders them.
 * It exists so DOM-free unit tests can assert on template output without a
 * browser; real rendering is covered by the Playwright mount test.
 */
import { nothing } from 'lit';

/** @param {unknown} text */
function escape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function templateToString(value) {
  if (value == null || value === false || value === nothing || value === '') return '';
  if (Array.isArray(value)) return value.map(templateToString).join('');
  if (typeof value === 'object' && value !== null && 'strings' in value && '_$litType$' in value) {
    const { strings, values } = /** @type {{ strings: string[], values: unknown[] }} */ (value);
    let out = '';
    strings.forEach((chunk, index) => {
      out += chunk;
      if (index < values.length) {
        const text = templateToString(values[index]);
        // An unquoted attribute binding (`attr=${v}`) renders quoted, like the DOM serializer would.
        out += /=\s*$/.test(chunk) ? `"${text}"` : text;
      }
    });
    return out;
  }
  return escape(value);
}
