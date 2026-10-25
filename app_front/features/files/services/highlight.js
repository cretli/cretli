/** Syntax highlighting, markdown rendering and highlighted-HTML line splitting. */
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import jsonLang from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import cssLang from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import bash from 'highlight.js/lib/languages/bash';
import python from 'highlight.js/lib/languages/python';
import php from 'highlight.js/lib/languages/php';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import { createMarkdownRenderer } from '../../../lib/render-markdown.js';
import { escapeHtml } from '../../chat/chatHtmlUtils.js';

const LANGUAGES = {
  javascript, jsx: javascript, typescript, tsx: typescript, json: jsonLang,
  xml, html: xml, css: cssLang, scss, bash, shell: bash, sh: bash,
  python, php, markdown, md: markdown, yaml, yml: yaml,
};
for (const [name, def] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, def);

const LANGUAGE_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript',
  jsx: 'javascript', json: 'json', html: 'xml', htm: 'xml', xml: 'xml', css: 'css', scss: 'scss',
  sh: 'bash', bash: 'bash', zsh: 'bash', py: 'python', php: 'php', md: 'markdown',
  yml: 'yaml', yaml: 'yaml',
};

export const markdownRenderer = createMarkdownRenderer({
  highlight(code, lang) {
    const language = String(lang || '').trim().toLowerCase();
    const languageClass = language ? ` language-${escapeHtml(language)}` : '';
    if (language && hljs.getLanguage(language)) {
      try {
        const highlighted = hljs.highlight(code, { language, ignoreIllegals: true }).value;
        return `<pre><code class="hljs${languageClass}">${highlighted}</code></pre>`;
      } catch (_) {
        /* fallthrough */
      }
    }
    return `<pre><code class="${languageClass.trim()}">${escapeHtml(code)}</code></pre>`;
  },
});

export function getLanguageFromPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith('.d.ts')) return 'typescript';
  const parts = normalized.split('.');
  if (parts.length < 2) return '';
  return LANGUAGE_BY_EXT[parts.pop()] || '';
}

export function isMarkdownFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const normalized = filePath.toLowerCase();
  return normalized.endsWith('.md') || normalized.endsWith('.markdown');
}

/**
 * Highlights file content into lines of balanced HTML (escaped when the
 * language is unknown or highlighting fails).
 *
 * @returns {string[]}
 */
export function highlightToLines(content, filePath) {
  const lang = getLanguageFromPath(filePath);
  if (!lang) return splitHighlightedIntoLines(escapeHtml(content));
  try {
    const highlighted = hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
    return splitHighlightedIntoLines(highlighted);
  } catch (_) {
    return splitHighlightedIntoLines(escapeHtml(content));
  }
}

/**
 * Splits highlight.js HTML into lines with balanced tags.
 * highlight.js emits multi-line <span> elements (e.g. for block comments slash-star ... star-slash),
 * so a plain split('\n') would cut a span in half and break the layout.
 * Every line therefore closes the open spans at its end and reopens them at the start of the next one.
 */
export function splitHighlightedIntoLines(html) {
  const source = String(html);
  const lines = [];
  let current = '';
  const stack = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '<') {
      const end = source.indexOf('>', i);
      if (end === -1) {
        current += source.slice(i);
        break;
      }
      const tag = source.slice(i, end + 1);
      current += tag;
      if (tag.startsWith('</')) {
        if (stack.length) stack.pop();
      } else if (!tag.endsWith('/>')) {
        stack.push(tag);
      }
      i = end + 1;
      continue;
    }
    if (ch === '\n') {
      lines.push(current + '</span>'.repeat(stack.length));
      current = stack.join('');
      i++;
      continue;
    }
    // copy plain text up to the next '<' or newline
    let nextTag = source.indexOf('<', i);
    if (nextTag === -1) nextTag = n;
    let nextNl = source.indexOf('\n', i);
    if (nextNl === -1) nextNl = n;
    const nextPos = Math.min(nextTag, nextNl);
    current += source.slice(i, nextPos);
    i = nextPos;
  }
  // last line, closing any spans still open
  if (current.length || stack.length || lines.length === 0) {
    lines.push(current + '</span>'.repeat(stack.length));
  }
  return lines;
}
