/**
 * Shared Markdown renderer for Files preview and Todo plan cards.
 */

/** @type {typeof import('markdown-it') | null} */
let MarkdownItCtor = null;
/** @type {Promise<typeof import('markdown-it')> | null} */
let markdownItLoadPromise = null;

/**
 * @param {unknown} source
 * @returns {string}
 */
function escapePlain(source) {
  return String(source || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * @returns {Promise<typeof import('markdown-it')>}
 */
function loadMarkdownItCtor() {
  if (MarkdownItCtor) return Promise.resolve(MarkdownItCtor);
  if (!markdownItLoadPromise) {
    markdownItLoadPromise = import(/* webpackChunkName: "sdk-markdown" */ 'markdown-it').then((mod) => {
      MarkdownItCtor = mod.default;
      return MarkdownItCtor;
    });
  }
  return markdownItLoadPromise;
}

const VERSION_WITH_DATE = /\d+\.\d[\w.-]*(?:[^|()\n]{0,80}?)?\([^)]+\)/g;

/**
 * @param {string} line
 * @returns {number}
 */
function readSeparatorColumnCount(line) {
  const trimmed = String(line || '').trim();
  if (!/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)) return 0;
  return trimmed.split('|').map((part) => part.trim()).filter(Boolean).length;
}

/**
 * @param {string} line
 * @returns {string[]}
 */
function splitRowCells(line) {
  const cells = String(line || '').split('|');
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((cell) => cell.trim());
}

/**
 * Split one glued cell into `pieces` when it holds version (date) chunks
 * that the model forgot to separate with pipes.
 *
 * @param {string} text
 * @param {number} pieces
 * @returns {string[] | null}
 */
function expandGluedCell(text, pieces) {
  if (pieces < 2) return null;
  const matches = [...String(text || '').matchAll(VERSION_WITH_DATE)];
  if (matches.length === 0) return null;
  if (pieces === matches.length + 2) {
    const name = text.slice(0, matches[0].index).trim();
    const versions = matches.map((match) => match[0].trim());
    const tailStart = matches[matches.length - 1].index + matches[matches.length - 1][0].length;
    const tail = text.slice(tailStart).trim();
    if (name && tail) return [name, ...versions, tail];
  }
  if (pieces !== 2) return null;
  const match = matches[0];
  const before = text.slice(0, match.index + match[0].length).trim();
  const after = text.slice(match.index + match[0].length).trim();
  if (!before || !after) return null;
  return [before, after];
}

/**
 * @param {string} line
 * @param {number} columnCount
 * @returns {string}
 */
function repairTableRow(line, columnCount) {
  const cells = splitRowCells(line);
  if (cells.length === 0 || cells.length >= columnCount) return line;
  const pieces = columnCount - cells.length + 1;
  for (let index = 0; index < cells.length; index += 1) {
    const expanded = expandGluedCell(cells[index], pieces);
    if (!expanded || expanded.length !== pieces) continue;
    const next = cells.slice(0, index).concat(expanded, cells.slice(index + 1));
    if (next.length !== columnCount) continue;
    return `| ${next.join(' | ')} |`;
  }
  return line;
}

/**
 * Put back pipes the model dropped inside a GFM table, so a short row still
 * lands in the header columns instead of one glued cell.
 *
 * @param {unknown} source
 * @returns {string}
 */
export function repairLooseTableRows(source) {
  const lines = String(source || '').split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const columnCount = readSeparatorColumnCount(lines[i + 1]);
    if (!columnCount || !line.includes('|')) continue;
    i += 2;
    for (; i < lines.length; i += 1) {
      if (/^\s*```/.test(lines[i])) {
        inFence = !inFence;
        break;
      }
      if (!lines[i].trim() || !lines[i].includes('|')) {
        i -= 1;
        break;
      }
      lines[i] = repairTableRow(lines[i], columnCount);
    }
  }
  return lines.join('\n');
}

/**
 * Wrap GFM tables and copy header text onto body cells (`data-label`) so a
 * narrow chat column can stack each row without losing the column name.
 *
 * @param {import('markdown-it').default} md
 * @returns {import('markdown-it').default}
 */
export function decorateMarkdownTables(md) {
  if (!md || md.__cretliTableDecorated) return md;
  md.__cretliTableDecorated = true;
  md.core.ruler.push('cretli_table_labels', (state) => {
    const tokens = state.tokens;
    let headers = [];
    let inHead = false;
    let column = 0;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.type === 'thead_open') {
        inHead = true;
        headers = [];
        continue;
      }
      if (token.type === 'thead_close') {
        inHead = false;
        continue;
      }
      if (inHead && token.type === 'inline') {
        headers.push(String(token.content || '').trim());
        continue;
      }
      if (token.type === 'tr_open') {
        column = 0;
        continue;
      }
      if (token.type !== 'td_open') continue;
      const label = headers[column] || '';
      column += 1;
      if (!label) continue;
      token.attrSet('data-label', label);
    }
  });
  md.renderer.rules.table_open = (tokens, idx, options, env, self) => (
    `<div class="sdk-rich-table-scroll">${self.renderToken(tokens, idx, options)}`
  );
  md.renderer.rules.table_close = (tokens, idx, options, env, self) => (
    `${self.renderToken(tokens, idx, options)}</div>`
  );
  return md;
}

/**
 * @param {{ highlight?: (code: string, lang: string) => string }} [options]
 * @returns {{ render: (source: string) => string, ready: () => Promise<object> }}
 */
export function createMarkdownRenderer(options = {}) {
  const highlight = typeof options.highlight === 'function' ? options.highlight : undefined;
  /** @type {InstanceType<typeof import('markdown-it').default> | null} */
  let instance = null;
  /** @returns {Promise<object>} */
  function ensureInstance() {
    return loadMarkdownItCtor().then((Ctor) => {
      if (!instance) {
        instance = decorateMarkdownTables(new Ctor({
          html: false,
          linkify: true,
          breaks: true,
          highlight,
        }));
      }
      return instance;
    });
  }
  return {
    render(source) {
      if (!instance) {
        void ensureInstance();
      }
      if (instance) return instance.render(repairLooseTableRows(source));
      return `<pre><code>${escapePlain(source)}</code></pre>`;
    },
    /** Resolves once markdown-it is loaded and this renderer has an instance. */
    ready() {
      return instance ? Promise.resolve(instance) : ensureInstance();
    },
  };
}

const defaultRenderer = createMarkdownRenderer();

/**
 * Loads markdown-it ahead of the first Markdown render (for example when the
 * editor opens) so a preview can re-render from the escaped fallback to real
 * Markdown once the chunk arrives.
 *
 * @returns {Promise<object>}
 */
export function preloadMarkdown() {
  return defaultRenderer.ready();
}

/**
 * @param {unknown} source
 * @param {{ render: (source: string) => string }} [renderer]
 * @returns {string}
 */
export function renderMarkdownHtml(source, renderer = defaultRenderer) {
  return renderer.render(String(source || ''));
}
