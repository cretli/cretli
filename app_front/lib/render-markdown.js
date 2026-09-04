/**
 * Shared Markdown renderer for Files preview and Todo plan cards.
 */

import MarkdownIt from 'markdown-it';

/**
 * @param {{ highlight?: (code: string, lang: string) => string }} [options]
 * @returns {import('markdown-it')}
 */
export function createMarkdownRenderer(options = {}) {
  const highlight = typeof options.highlight === 'function' ? options.highlight : undefined;
  return new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
    highlight,
  });
}

const defaultRenderer = createMarkdownRenderer();

/**
 * @param {unknown} source
 * @param {import('markdown-it')} [renderer]
 * @returns {string}
 */
export function renderMarkdownHtml(source, renderer = defaultRenderer) {
  return renderer.render(String(source || ''));
}
