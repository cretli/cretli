/**
 * Lazy markdown-it / highlight.js / mermaid engines and code-block decoration.
 */

import { writeTextToClipboard } from '../../../../lib/clipboard.js';
import { probeSync } from '../../../../lib/perfProbe.js';
import { t } from '../../../../i18n/index.js';
import { escapeHtml } from '../../chatHtmlUtils.js';
import { decorateMarkdownTables, repairLooseTableRows } from '../../../../lib/render-markdown.js';

/** @type {import('highlight.js').HLJSApi | null} */
let hljsEngine = null;
/** @type {Promise<import('highlight.js').HLJSApi> | null} */
let hljsLoadPromise = null;
const hljsReadyListeners = new Set();

function loadHljsEngine() {
  if (hljsEngine) return Promise.resolve(hljsEngine);
  if (!hljsLoadPromise) {
    hljsLoadPromise = import(/* webpackChunkName: "sdk-hljs" */ '../../../../lib/sdk-hljs.js').then((mod) => {
      hljsEngine = mod.hljs;
      for (const listener of hljsReadyListeners) {
        try {
          listener();
        } catch (_) {
          /* ignore */
        }
      }
      hljsReadyListeners.clear();
      return hljsEngine;
    });
  }
  return hljsLoadPromise;
}

/**
 * @param {() => void} listener
 */
export function whenHljsReady(listener) {
  if (typeof listener !== 'function') return;
  if (hljsEngine) {
    listener();
    return;
  }
  hljsReadyListeners.add(listener);
}

/** @type {import('markdown-it') | null} */
export let mdEngine = null;
/** @type {Promise<import('markdown-it')> | null} */
let mdLoadPromise = null;
export const mdReadyListeners = new Set();

function bindMarkdownFence(instance) {
  const defaultFenceRenderer = instance.renderer.rules.fence;
  instance.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const language = String(token.info || '').trim().split(/\s+/)[0].toLowerCase();
    if (language !== 'mermaid') {
      return defaultFenceRenderer(tokens, index, options, env, self);
    }
    return (
      '<div class="sdk-rich-mermaid" data-mermaid-state="pending">' +
      `<pre class="sdk-rich-pre"><code class="language-mermaid">${escapeHtml(token.content)}</code></pre>` +
      '</div>'
    );
  };
  return instance;
}

function createMarkdownIt(MarkdownIt) {
  return decorateMarkdownTables(bindMarkdownFence(
    new MarkdownIt({
      html: false,
      linkify: true,
      breaks: true,
      highlight(code, lang) {
        const language = String(lang || '').trim().toLowerCase();
        const languageClass = language ? ` language-${escapeHtml(language)}` : '';
        if (language && hljsEngine?.getLanguage(language)) {
          try {
            return `<pre class="sdk-rich-pre"><code class="hljs${languageClass}">${hljsEngine.highlight(code, {
              language,
              ignoreIllegals: true,
            }).value}</code></pre>`;
          } catch (_) {
            /* fallthrough */
          }
        }
        if (language && !hljsEngine) void loadHljsEngine();
        return `<pre class="sdk-rich-pre"><code class="${languageClass.trim()}">${escapeHtml(code)}</code></pre>`;
      },
    }),
  ));
}

function loadMarkdownIt() {
  if (mdEngine) return Promise.resolve(mdEngine);
  if (!mdLoadPromise) {
    mdLoadPromise = import(/* webpackChunkName: "sdk-markdown" */ 'markdown-it').then((mod) => {
      mdEngine = createMarkdownIt(mod.default);
      for (const listener of mdReadyListeners) {
        try {
          listener();
        } catch (_) {
          /* ignore */
        }
      }
      mdReadyListeners.clear();
      return mdEngine;
    });
  }
  return mdLoadPromise;
}

/**
 * @param {string} source
 * @returns {string}
 */
export function renderMarkdownSource(source) {
  const text = repairLooseTableRows(source);
  if (mdEngine) return probeSync('chat.history.markdown', () => mdEngine.render(text));
  void loadMarkdownIt();
  return `<pre class="sdk-rich-pre"><code>${escapeHtml(text)}</code></pre>`;
}

let mermaidModulePromise = null;
let mermaidDiagramId = 0;

async function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then((module) => module.default);
  }
  return mermaidModulePromise;
}

/**
 * @param {HTMLElement} mdHost
 */
export async function renderMermaidDiagrams(mdHost) {
  const diagrams = Array.from(
    mdHost.querySelectorAll('.sdk-rich-mermaid[data-mermaid-state="pending"]')
  );
  if (diagrams.length === 0) return;

  const renderVersion = String(Number(mdHost.dataset.mermaidRenderVersion || 0) + 1);
  mdHost.dataset.mermaidRenderVersion = renderVersion;

  try {
    const mermaid = await loadMermaid();
    const darkTheme = document.documentElement.dataset.theme !== 'light';
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: darkTheme ? 'dark' : 'default',
    });

    for (const diagram of diagrams) {
      if (mdHost.dataset.mermaidRenderVersion !== renderVersion || !diagram.isConnected) return;
      const source = diagram.textContent?.trim() || '';
      if (!source) continue;

      try {
        const id = `sdk-mermaid-${++mermaidDiagramId}`;
        const { svg, bindFunctions } = await mermaid.render(id, source);
        if (mdHost.dataset.mermaidRenderVersion !== renderVersion || !diagram.isConnected) return;
        diagram.innerHTML = svg;
        diagram.dataset.mermaidState = 'rendered';
        bindFunctions?.(diagram);
      } catch (error) {
        diagram.dataset.mermaidState = 'invalid';
        diagram.title = error instanceof Error ? error.message : t('sdkView.mermaidInvalid');
      }
    }
  } catch (error) {
    for (const diagram of diagrams) {
      if (!diagram.isConnected) continue;
      diagram.dataset.mermaidState = 'unavailable';
      diagram.title = error instanceof Error ? error.message : t('sdkView.mermaidLoadFailed');
    }
  }
}

/**
 * @param {string} s
 * @returns {string}
 */
/**
 * @param {HTMLElement} mdHost
 */
function ensureCodeCopyBinding(mdHost) {
  if (!(mdHost instanceof HTMLElement)) return;
  if (mdHost.dataset.copyBindingReady === '1') return;
  mdHost.dataset.copyBindingReady = '1';
  mdHost.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('.sdk-rich-copy-btn');
    if (!(button instanceof HTMLButtonElement)) return;
    event.preventDefault();
    event.stopPropagation();

    const blockHost = button.closest('.sdk-rich-code-block');
    const inlineHost = button.closest('.sdk-rich-inline-code');
    const source = blockHost
      ? blockHost.querySelector('pre code')
      : inlineHost
        ? inlineHost.querySelector('code')
        : null;
    const text = source?.textContent ? String(source.textContent) : '';
    if (!text.trim()) return;

    void writeTextToClipboard(text).then((ok) => {
      if (!ok) return;
      button.classList.add('is-copied');
      button.setAttribute('aria-label', t('sdkView.codeCopied'));
      button.setAttribute('title', t('sdkView.copied'));
      if (button._copyResetTimer) window.clearTimeout(button._copyResetTimer);
      button._copyResetTimer = window.setTimeout(() => {
        button.classList.remove('is-copied');
        button.setAttribute('aria-label', t('sdkView.copyCode'));
        button.setAttribute('title', t('sdkView.copyCode'));
        button._copyResetTimer = 0;
      }, 1500);
    });
  });
}

/**
 * @param {HTMLElement} mdHost
 */
export function decorateCodeForCopy(mdHost) {
  if (!(mdHost instanceof HTMLElement)) return;
  ensureCodeCopyBinding(mdHost);

  const codeBlocks = Array.from(mdHost.querySelectorAll('pre')).filter(
    (pre) => pre instanceof HTMLElement && !pre.parentElement?.classList.contains('sdk-rich-code-block')
  );
  codeBlocks.forEach((pre) => {
    if (!(pre instanceof HTMLElement) || !pre.parentElement) return;
    const wrap = document.createElement('div');
    wrap.className = 'sdk-rich-code-block';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sdk-rich-copy-btn sdk-rich-copy-btn--block';
    button.setAttribute('aria-label', t('sdkView.copyCode'));
    button.title = t('sdkView.copyCode');
    button.innerHTML =
      '<span class="mdi mdi-content-copy" aria-hidden="true"></span>' +
      '<span class="mdi mdi-check" aria-hidden="true"></span>';
    pre.parentElement.insertBefore(wrap, pre);
    wrap.append(pre, button);
  });
}
