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
        instance = new Ctor({
          html: false,
          linkify: true,
          breaks: true,
          highlight,
        });
      }
      return instance;
    });
  }
  return {
    render(source) {
      if (!instance) {
        void ensureInstance();
      }
      if (instance) return instance.render(String(source || ''));
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
