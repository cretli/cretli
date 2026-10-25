export const AUTO_TITLE_MAX_LEN = 80;

/**
 * Example title from the prompt — never use as a real title.
 * Must stay verbatim in sync with AUTO_TITLE_PROMPT in app_front/config.js.
 */
export const EXAMPLE_TITLE = 'Refactor module X';

/**
 * Only parse agent output after this phrase (end of the title prompt).
 * Must stay verbatim in sync with AUTO_TITLE_PROMPT in app_front/config.js.
 */
export const PROMPT_END_MARKER = 'No other text.';

/** Regex for {"title": "..."} — group 1 is the title value. */
export const TITLE_JSON_REGEX = /\{\s*"title"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
const ANSI_ESC = String.fromCharCode(27);
const ANSI_BELL = String.fromCharCode(7);
const ANSI_CSI_RE = new RegExp(`${ANSI_ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
const ANSI_OSC_RE = new RegExp(`${ANSI_ESC}\\][^${ANSI_BELL}]*${ANSI_BELL}`, 'g');
const ANSI_MISC_RE = new RegExp(`${ANSI_ESC}[PX^_][^${ANSI_ESC}]*(${ANSI_ESC}\\\\)?`, 'g');

/**
 * Strips ANSI escape sequences (SGR, CSI, OSC, DCS/PM/APC/SOS).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stripAnsi(value) {
  if (!value || typeof value !== 'string') return '';
  return value
    .replace(ANSI_CSI_RE, '')
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_MISC_RE, '');
}

/**
 * @param {unknown} title
 * @returns {boolean}
 */
export function isExampleTitle(title) {
  return typeof title === 'string' && title.trim().toLowerCase() === EXAMPLE_TITLE.toLowerCase();
}

/**
 * @param {string} clean
 * @returns {string}
 */
export function sliceResponseOnly(clean) {
  const endIdx = clean.lastIndexOf(PROMPT_END_MARKER);
  if (endIdx !== -1) {
    return clean.slice(endIdx + PROMPT_END_MARKER.length);
  }
  const exampleMarker = 'Example: {"title": "Refactor module X"}';
  const exampleIdx = clean.lastIndexOf(exampleMarker);
  if (exampleIdx !== -1) {
    return clean.slice(exampleIdx + exampleMarker.length);
  }
  return clean;
}

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function previewStr(value, max) {
  if (value == null) return String(value);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= (max || 120) ? text : `${text.slice(0, max || 120)}…`;
}

/**
 * @param {string} buffer
 * @param {(tag: string, payload?: object) => void} [debugAutoTitle]
 * @returns {string|null}
 */
export function tryExtractTitleFromBuffer(buffer, debugAutoTitle = () => {}) {
  if (!buffer || typeof buffer !== 'string') return null;
  const clean = stripAnsi(buffer);
  const afterPrompt = sliceResponseOnly(clean);
  debugAutoTitle('extract', {
    cleanLen: clean.length,
    afterPromptLen: afterPrompt.length,
    afterPromptPreview: previewStr(afterPrompt, 150),
  });
  let lastTitle = null;
  TITLE_JSON_REGEX.lastIndex = 0;
  let match;
  while ((match = TITLE_JSON_REGEX.exec(afterPrompt)) !== null) {
    const title = (match[1] || '').replace(/\\"/g, '"').trim();
    if (title && !isExampleTitle(title)) lastTitle = title;
  }
  if (lastTitle) {
    debugAutoTitle('extract regex ok', { title: lastTitle, msg: 'last match (agent response)' });
    return lastTitle.length > AUTO_TITLE_MAX_LEN ? lastTitle.slice(0, AUTO_TITLE_MAX_LEN) : lastTitle;
  }
  const lines = afterPrompt.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.title === 'string' && obj.title.trim()) {
        const title = obj.title.trim();
        if (isExampleTitle(title)) continue;
        debugAutoTitle('extract line JSON ok', { title });
        return title.length > AUTO_TITLE_MAX_LEN ? title.slice(0, AUTO_TITLE_MAX_LEN) : title;
      }
    } catch (_) {}
  }
  debugAutoTitle('extract no title');
  return null;
}

/**
 * @param {string} line
 * @returns {string|null}
 */
function parseStandaloneTitleLine(line) {
  const trimmed = typeof line === 'string' ? line.trim() : '';
  if (!trimmed || trimmed[0] !== '{' || trimmed[trimmed.length - 1] !== '}') return null;
  if (trimmed.length > 260) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const keys = Object.keys(obj);
    if (keys.length !== 1 || keys[0] !== 'title') return null;
    if (typeof obj.title !== 'string') return null;
    const title = obj.title.trim();
    if (!title || isExampleTitle(title)) return null;
    return title.length > AUTO_TITLE_MAX_LEN ? title.slice(0, AUTO_TITLE_MAX_LEN) : title;
  } catch {
    return null;
  }
}

/**
 * @param {string} buffer
 * @returns {string|null}
 */
export function tryExtractStandaloneTitleJson(buffer) {
  if (!buffer || typeof buffer !== 'string') return null;
  const trailing = splitTrailingTitleJson(buffer);
  if (trailing.title) return trailing.title;
  const lines = stripAnsi(buffer).split(/\r?\n/);
  let lastTitle = null;
  for (const line of lines) {
    const title = parseStandaloneTitleLine(line);
    if (title) lastTitle = title;
  }
  return lastTitle;
}

/**
 * Splits a trailing finish-summary `{"title":"..."}` (bare line or fenced json) from agent output.
 * @param {unknown} buffer
 * @returns {{ text: string, title: string|null }}
 */
export function splitTrailingTitleJson(buffer) {
  const raw = typeof buffer === 'string' ? buffer : '';
  if (!raw) return { text: '', title: null };
  const clean = stripAnsi(raw);
  const fencedRe = /(?:^|\n)```(?:json)?[ \t]*\r?\n(\{\s*"title"\s*:\s*"(?:[^"\\]|\\.)*"\s*\})[ \t]*\r?\n```[ \t]*\s*$/;
  const fenced = clean.match(fencedRe);
  if (fenced) {
    const title = parseStandaloneTitleLine(fenced[1]);
    if (title) return { text: clean.slice(0, fenced.index).replace(/\s+$/, ''), title };
  }
  const lines = clean.split(/\r?\n/);
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && !lines[lastIdx].trim()) lastIdx -= 1;
  if (lastIdx < 0) return { text: raw, title: null };
  const title = parseStandaloneTitleLine(lines[lastIdx]);
  if (!title) return { text: raw, title: null };
  return {
    text: lines.slice(0, lastIdx).join('\n').replace(/\s+$/, ''),
    title,
  };
}

/**
 * @param {string} buffer
 * @returns {{ summary: string, title: string }|null}
 */
export function tryExtractSummaryAndTitleFromBuffer(buffer) {
  if (!buffer || typeof buffer !== 'string') return null;
  const raw = stripAnsi(buffer);
  const candidates = [];
  const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) candidates.push(codeBlockMatch[1].trim());
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) candidates.push(trimmed);
  }
  const braceStart = raw.lastIndexOf('{');
  if (braceStart !== -1) {
    let depth = 0;
    let end = -1;
    for (let index = braceStart; index < raw.length; index += 1) {
      if (raw[index] === '{') depth += 1;
      else if (raw[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end !== -1) candidates.push(raw.slice(braceStart, end));
  }
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (!obj || typeof obj !== 'object') continue;
      const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
      const title = typeof obj.title === 'string' ? obj.title.trim() : '';
      if (summary || title) {
        return {
          summary,
          title: title.length > AUTO_TITLE_MAX_LEN ? title.slice(0, AUTO_TITLE_MAX_LEN) : title,
        };
      }
    } catch (_) {}
  }
  return null;
}
