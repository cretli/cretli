/** Lit templates for the file preview: numbered code, unified diff, markdown. */
import { html } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { t } from '../../../i18n/index.js';
import { renderMarkdownHtml } from '../../../lib/render-markdown.js';
import { highlightToLines, markdownRenderer } from '../services/highlight.js';

const NBSP = ' ';

/** Plain message (loading / error) shown in the preview pane. */
export function previewMessageView(text) {
  return html`${text}`;
}

export function codeView(content, filePath) {
  const lines = highlightToLines(content, filePath);
  return html`<code class="hljs files-preview-code-with-lines">${lines.map((line, idx) => html`<span class="files-preview-line"><span class="files-preview-line-no">${idx + 1}</span><span class="files-preview-line-code">${line.length ? unsafeHTML(line) : NBSP}</span></span>`)}</code>`;
}

export function markdownView(content) {
  return html`<div class="files-preview-markdown">${unsafeHTML(renderMarkdownHtml(content || '', markdownRenderer))}</div>`;
}

const HEADER_PREFIXES = ['diff ', 'index ', 'new file', 'deleted file', 'old mode', 'new mode', '+++', '---'];

function lineNo(value) {
  return value
    ? html`<span class="files-diff-line-no">${value}</span>`
    : html`<span class="files-diff-line-no files-diff-line-no--empty"></span>`;
}

/** Unified diff as coloured lines with old/new line numbers. */
export function diffView(diff) {
  if (!diff || !diff.trim()) {
    return html`<div class="files-preview-empty">${t('files.noDiffChanges')}</div>`;
  }
  let oldNo = 0;
  let newNo = 0;
  const rows = String(diff).split('\n').map((line) => {
    let cls = 'files-diff-line';
    let oldNum = '';
    let newNum = '';
    let body = line;

    if (line.startsWith('@@')) {
      cls += ' files-diff-line-hunk';
      const m = line.match(/@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (m) {
        oldNo = parseInt(m[1], 10) || 0;
        newNo = parseInt(m[2], 10) || 0;
      }
    } else if (HEADER_PREFIXES.some((p) => line.startsWith(p))) {
      cls += ' files-diff-line-header';
    } else if (line.startsWith('+')) {
      cls += ' files-diff-line-add';
      newNum = String(++newNo);
      body = line.slice(1);
    } else if (line.startsWith('-')) {
      cls += ' files-diff-line-del';
      oldNum = String(++oldNo);
      body = line.slice(1);
    } else {
      cls += ' files-diff-line-ctx';
      oldNum = String(++oldNo);
      newNum = String(++newNo);
      // context lines start with a space — drop it so the body renders as plain code
      body = line.slice(1);
    }
    return html`<span class=${cls}>${lineNo(oldNum)}${lineNo(newNum)}<span class="files-diff-line-code">${body.length ? body : NBSP}</span></span>`;
  });
  return html`<code class="files-diff-code">${rows}</code>`;
}

