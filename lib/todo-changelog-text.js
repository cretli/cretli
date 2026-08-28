/**
 * Sanitize todo plan/changelog text: drop finish-summary JSON and keep a short excerpt.
 */

const TITLE_JSON_RE = /\{\s*"title"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/g;
const TITLE_JSON_FRAGMENT_RE = /\{?\s*"?title"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}?/g;
const FENCED_TITLE_JSON_RE =
  /(?:^|\n)```(?:json)?[ \t]*\r?\n\{\s*"title"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}[ \t]*\r?\n```[ \t]*/g;

export const TODO_CHANGELOG_EXCERPT_LEN = 180;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function stripTitleJsonTrailer(value) {
  const text = String(value || '');
  if (!text) return '';
  return text
    .replace(FENCED_TITLE_JSON_RE, '\n')
    .replace(TITLE_JSON_RE, '')
    .replace(TITLE_JSON_FRAGMENT_RE, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {unknown} value
 * @param {number} [maxLen]
 * @returns {string}
 */
export function buildChangelogExcerpt(value, maxLen = TODO_CHANGELOG_EXCERPT_LEN) {
  const clean = stripTitleJsonTrailer(value);
  if (!clean) return '';
  const heading = clean.match(/^#{1,6}\s+(.+)$/m);
  const source = heading ? `${heading[1].trim()}\n${clean}` : clean;
  const excerpt = stripTitleJsonTrailer(source).replace(/\s+/g, ' ').trim();
  if (excerpt.length <= maxLen) return excerpt;
  return `${excerpt.slice(0, maxLen - 1)}…`;
}
