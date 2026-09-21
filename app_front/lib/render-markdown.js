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

/**
 * @param {{ highlight?: (code: string, lang: string) => string }} [options]
 * @returns {{ render: (source: string) => string }}
 */
export function createMarkdownRenderer(options = {}) {
  const highlight = typeof options.highlight === 'function' ? options.highlight : undefined;
  return {
    render(source) {
      if (!instance) void loadMarkdownItCtor().then((Ctor) => {
        instance = new Ctor({
          html: false,
          linkify: true,
          breaks: true,
          highlight,
        });
      });
      if (instance) return instance.render(String(source || ''));
      return `<pre><code>${escapePlain(source)}</code></pre>`;
    },
  };
}

const defaultRenderer = createMarkdownRenderer();

/**
 * @param {unknown} source
 * @param {{ render: (source: string) => string }} [renderer]
 * @returns {string}
 */
export function renderMarkdownHtml(source, renderer = defaultRenderer) {
  return renderer.render(String(source || ''));
}
