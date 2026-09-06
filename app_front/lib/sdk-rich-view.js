/**
 * HTML view for the @cursor/sdk chat — collapsible tools, Markdown answers, file paths.
 */

import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import jsonLang from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import php from 'highlight.js/lib/languages/php';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';

import {
  extractAssistantPlainText,
  isHarnessErrorAssistantText,
  projectStreamAccumulator,
  resetSdkStreamState,
  takeStreamDelta,
  textsOverlap,
} from './sdk-chat-format.js';
import { writeTextToClipboard } from './clipboard.js';
import {
  splitSdkFormattedConversation,
} from '../../lib/sdk/sdk-chat-history.js';
import { isSdkRunFailureStatus } from '../../lib/sdk/sdk-run-outcome.js';
import { normalizeSdkUiMode } from '../../lib/sdk/sdk-ui-mode.js';
import { splitTrailingTitleJson } from '../features/chat/chatTitleParsing.js';
import { parseTimeoutProgressNotice } from '../../lib/notices.js';
import {
  buildStableSdkToolCallFallback,
  hasRunningSdkTools,
  isEmptyGenericSdkToolEvent,
  isOpenSdkToolStatus,
  isTerminalSdkRunStatus,
  isTerminalSdkToolStatus,
  resolveAbandonedToolStatus,
  resolveSdkToolCallId,
  setRunningSdkToolCallCount,
  shouldAcceptSdkToolStatus,
  updateRunningSdkToolState,
} from '../../lib/sdk/sdk-thinking-state.js';
import {
  findReusableSdkThinkingBlockIndex,
  restoreSdkThinkingAccumulator,
} from '../../lib/sdk/sdk-thinking-block-reuse.js';
import {
  listAllRunItems,
  listRunItems,
  registerRunItem,
} from '../../lib/sdk/sdk-run-block-registry.js';
import {
  findReusableSdkAssistantBlockIndex,
  restoreSdkAssistantAccumulator,
} from '../../lib/sdk/sdk-assistant-block-reuse.js';
import { cloneSerializableSdkEvent } from './sdk-chat-history-store.js';
import { appLogger } from '../logger.js';
import { extractPlanTextFromSdkEvent } from '../../lib/sdk/sdk-plan-text.js';
import { parseContextSeedPayload } from './context-seed-payload.js';
import { parseInheritedPrompt } from '../../lib/conversation-fork.js';
import { registerPageResumeCleanupHook } from './pageResumeCleanup.js';
import { getChatSpeaker } from '../features/voice/chatSpeaker.js';
import { t } from '../i18n/index.js';
import { resolveHarnessDisplayLabel } from '../features/chat/sdk-transport-labels.js';
import {
  formatToolSearchResult,
  isFailedToolSearchResult,
  isToolSearchName,
  parseToolSearchQuery,
  readToolSearchQuery,
} from '../../lib/agent-harness/tool-search-display.js';
import '../components/chat/cr-sdk-block.js';
import { escapeHtml } from '../features/chat/chatHtmlUtils.js';
import {
  delegationStatusLabel,
  parseDelegationHistoryPayload,
} from '../features/chat/chatDelegations.js';
import { parseRelatedChatPayload } from '../../lib/chat-relation-payload.js';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', jsonLang);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('php', php);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, lang) {
    const language = String(lang || '').trim().toLowerCase();
    const languageClass = language ? ` language-${escapeHtml(language)}` : '';
    if (language && hljs.getLanguage(language)) {
      try {
        return `<pre class="sdk-rich-pre"><code class="hljs${languageClass}">${hljs.highlight(code, {
          language,
          ignoreIllegals: true,
        }).value}</code></pre>`;
      } catch (_) {
        /* fallthrough */
      }
    }
    return `<pre class="sdk-rich-pre"><code class="${languageClass.trim()}">${escapeHtml(code)}</code></pre>`;
  },
});

const defaultFenceRenderer = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, index, options, env, self) => {
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
async function renderMermaidDiagrams(mdHost) {
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
function decorateCodeForCopy(mdHost) {
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

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg)(?:[?#].*)?$/i;
const SCREENSHOT_MARKER_RE = /\[Screenshot:\s*([^\]\n]+)\]/gi;
const IMAGE_URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+\.(?:png|jpe?g|webp|gif|bmp|svg)(?:[^\s<>"')]*)?/gi;
let sdkImageLightboxEl = null;
let sdkImageLightboxImgEl = null;
let sdkImageLightboxCaptionEl = null;
let sdkImageLightboxCloseBtnEl = null;
let sdkImageLightboxEscapeBound = false;

/**
 * @param {string} href
 * @returns {boolean}
 */
function isImageLikeHref(href) {
  const value = String(href || '').trim();
  if (!value) return false;
  if (/^data:image\//i.test(value)) return true;
  return IMAGE_EXT_RE.test(value);
}

/**
 * @param {string} rawPath
 * @returns {string}
 */
function screenshotPathToPreviewUrl(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  if (/^(https?:|data:image\/|blob:)/i.test(value)) return value;
  const normalized = value.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)uploads\/([a-f0-9-]{36}\.jpg)$/i);
  if (!match) return '';
  return `/api/uploads/${encodeURIComponent(match[1])}`;
}

/**
 * @param {string} text
 * @returns {Array<{ source: string, href: string }>}
 */
function collectInlineImageRefs(text) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const refs = [];
  const seen = new Set();

  SCREENSHOT_MARKER_RE.lastIndex = 0;
  let markerMatch;
  while ((markerMatch = SCREENSHOT_MARKER_RE.exec(raw)) !== null) {
    const source = String(markerMatch[1] || '').trim();
    if (!source) continue;
    const href = screenshotPathToPreviewUrl(source) || (isImageLikeHref(source) ? source : '');
    if (!href || seen.has(href)) continue;
    seen.add(href);
    refs.push({ source, href });
  }

  IMAGE_URL_RE.lastIndex = 0;
  let urlMatch;
  while ((urlMatch = IMAGE_URL_RE.exec(raw)) !== null) {
    const source = String(urlMatch[0] || '').trim();
    if (!source) continue;
    if (!isImageLikeHref(source) || seen.has(source)) continue;
    seen.add(source);
    refs.push({ source, href: source });
  }

  return refs;
}

/**
 * Strips technical screenshot markers from the displayed content.
 * Thumbnails are still rendered separately from those markers.
 *
 * @param {string} text
 * @returns {string}
 */
function stripScreenshotMarkers(text) {
  const raw = String(text || '');
  if (!raw) return '';
  SCREENSHOT_MARKER_RE.lastIndex = 0;
  return raw
    .replace(SCREENSHOT_MARKER_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {HTMLElement} container
 * @param {Array<{ source: string, href: string }>} refs
 */
function appendInlineImageThumbs(container, refs) {
  if (!(container instanceof HTMLElement)) return;
  if (!Array.isArray(refs) || refs.length === 0) return;
  const strip = document.createElement('div');
  strip.className = 'sdk-rich-inline-thumbs';
  refs.forEach((ref) => {
    if (!ref || typeof ref !== 'object') return;
    const href = String(ref.href || '').trim();
    if (!href) return;
    const source = String(ref.source || href);

    const thumbBtn = document.createElement('button');
    thumbBtn.type = 'button';
    thumbBtn.className = 'sdk-rich-inline-thumb';
    thumbBtn.title = source;
    thumbBtn.setAttribute('aria-label', t('sdkView.imagePreviewOf', { source }));
    thumbBtn.addEventListener('click', () => {
      openSdkImageLightbox(href, source);
    });

    const img = document.createElement('img');
    img.src = href;
    img.alt = source;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    thumbBtn.appendChild(img);
    strip.appendChild(thumbBtn);
  });
  if (strip.childElementCount === 0) return;
  container.appendChild(strip);
}

function closeSdkImageLightbox() {
  if (!(sdkImageLightboxEl instanceof HTMLElement)) return;
  sdkImageLightboxEl.hidden = true;
  document.body.classList.remove('sdk-image-lightbox-open');
  if (sdkImageLightboxImgEl instanceof HTMLImageElement) {
    sdkImageLightboxImgEl.removeAttribute('src');
    sdkImageLightboxImgEl.alt = '';
  }
  if (sdkImageLightboxCaptionEl instanceof HTMLElement) {
    sdkImageLightboxCaptionEl.textContent = '';
  }
}

/** Closes SDK image preview if it stayed open after PWA resume. */
export function dismissSdkImageLightboxIfOpen() {
  if (!(sdkImageLightboxEl instanceof HTMLElement)) return false;
  if (sdkImageLightboxEl.hidden !== false) return false;
  closeSdkImageLightbox();
  return true;
}

function ensureSdkImageLightbox() {
  if (sdkImageLightboxEl instanceof HTMLElement) return sdkImageLightboxEl;
  if (typeof document === 'undefined') return null;
  const host = document.createElement('div');
  host.className = 'sdk-image-lightbox';
  host.hidden = true;
  host.innerHTML =
    '<div class="sdk-image-lightbox-backdrop"></div>' +
    `<div class="sdk-image-lightbox-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('sdkView.imagePreview'))}">` +
    `<button type="button" class="sdk-image-lightbox-close" aria-label="${escapeHtml(t('sdkView.closePreview'))}">×</button>` +
    '<img class="sdk-image-lightbox-img" alt="" />' +
    '<div class="sdk-image-lightbox-caption"></div>' +
    '</div>';
  document.body.appendChild(host);
  sdkImageLightboxEl = host;
  sdkImageLightboxImgEl = host.querySelector('.sdk-image-lightbox-img');
  sdkImageLightboxCaptionEl = host.querySelector('.sdk-image-lightbox-caption');
  sdkImageLightboxCloseBtnEl = host.querySelector('.sdk-image-lightbox-close');

  host.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.classList.contains('sdk-image-lightbox-backdrop')) {
      closeSdkImageLightbox();
    }
  });
  sdkImageLightboxCloseBtnEl?.addEventListener('click', () => {
    closeSdkImageLightbox();
  });

  if (!sdkImageLightboxEscapeBound) {
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      closeSdkImageLightbox();
    });
    sdkImageLightboxEscapeBound = true;
  }
  return host;
}

function openSdkImageLightbox(href, caption) {
  const host = ensureSdkImageLightbox();
  if (!(host instanceof HTMLElement)) return;
  const imageSrc = String(href || '').trim();
  if (!imageSrc) return;
  if (sdkImageLightboxImgEl instanceof HTMLImageElement) {
    sdkImageLightboxImgEl.src = imageSrc;
    sdkImageLightboxImgEl.alt = caption || t('sdkView.imagePreview');
  }
  if (sdkImageLightboxCaptionEl instanceof HTMLElement) {
    sdkImageLightboxCaptionEl.textContent = caption || '';
  }
  host.hidden = false;
  document.body.classList.add('sdk-image-lightbox-open');
  sdkImageLightboxCloseBtnEl?.focus();
}

/**
 * Strips technical SDK telemetry lines from the plaintext history buffer,
 * so an old buffer does not mix tool statuses into the assistant answer.
 *
 * @param {string} text
 * @returns {string}
 */
function stripSdkTelemetryLines(text) {
  const raw = text == null ? '' : String(text);
  if (!raw) return '';
  const telemetryLinePattern =
    /^\[(status\s+[^\]]+|tool\s+[^\]]+|system|task|sdk\s+[^\]]+|SDK|OpenCode|OpenRouter|run finished:[^\]]*|SDK busy|SDK error|Mode:[^\]]*|request[^\]]*)\](?:\s.*)?$/i;
  return raw
    .split('\n')
    .filter((line) => !telemetryLinePattern.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function formatTimeoutProgressSeconds(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  const mm = Math.floor(safe / 60);
  const ss = safe % 60;
  if (mm <= 0) return `${ss}s`;
  return `${mm}m ${ss}s`;
}

/**
 * @param {unknown} args
 * @returns {string}
 */
function extractTodoSummary(args) {
  if (!args || typeof args !== 'object') return '';
  const o = /** @type {Record<string, unknown>} */ (args);
  const todos = Array.isArray(o.todos) ? o.todos : [];
  if (todos.length === 0) return '';
  const lines = todos.slice(0, 12).map((item) => {
    if (!item || typeof item !== 'object') return '';
    const t = /** @type {Record<string, unknown>} */ (item);
    const status = typeof t.status === 'string' ? t.status : '?';
    const content = typeof t.content === 'string' ? t.content : '';
    return `[${status}] ${content}`;
  });
  return lines.filter(Boolean).join('\n');
}

/**
 * @param {unknown} args
 * @returns {string[]}
 */
function pathsFromToolArgs(args) {
  if (!args || typeof args !== 'object') return [];
  const o = /** @type {Record<string, unknown>} */ (args);
  const keys = ['path', 'file_path', 'target_file', 'filePath', 'filename'];
  const out = [];
  for (const k of keys) {
    if (typeof o[k] === 'string') out.push(o[k]);
  }
  if (Array.isArray(o.paths)) {
    for (const p of o.paths) {
      if (typeof p === 'string') out.push(p);
    }
  }
  return [...new Set(out)];
}

/**
 * @param {unknown} val
 * @param {number} max
 * @returns {string}
 */
function stringifySnippet(val, max) {
  if (val == null) return '';
  try {
    const s = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(val);
  }
}

/**
 * @param {unknown} ev
 * @returns {string}
 */
function extractUserPlain(ev) {
  if (!ev || typeof ev !== 'object') return '';
  const e = /** @type {Record<string, unknown>} */ (ev);
  const msg = e.message && typeof e.message === 'object' ? /** @type {Record<string, unknown>} */ (e.message) : null;
  const content = msg && Array.isArray(msg.content) ? msg.content : [];
  let t = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = /** @type {Record<string, unknown>} */ (block);
    if (b.type === 'text' && typeof b.text === 'string') t += b.text;
  }
  return t;
}

/**
 * @param {string} rawKey
 * @returns {string}
 */
function normalizeToolName(rawKey) {
  const k = String(rawKey || '').trim();
  if (!k) return 'tool';
  const base = k.endsWith('ToolCall') ? k.slice(0, -8) : k;
  return base.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Converts a single Agent.messages.list row (agentConversationTurn) into a sequence of SDK events.
 *
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>[]}
 */
function sdkEventsFromAgentRow(row) {
  const out = [];
  if (!row || typeof row !== 'object') return out;
  const turn =
    row.message &&
    typeof row.message === 'object' &&
    row.message.agentConversationTurn &&
    typeof row.message.agentConversationTurn === 'object'
      ? row.message.agentConversationTurn
      : null;
  if (!turn) return out;

  const userText =
    turn.userMessage && typeof turn.userMessage === 'object' && typeof turn.userMessage.text === 'string'
      ? turn.userMessage.text
      : '';
  if (userText.trim()) {
    out.push({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: userText }],
      },
    });
  }

  const steps = Array.isArray(turn.steps) ? turn.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;

    const assistantText =
      step.assistantMessage &&
      typeof step.assistantMessage === 'object' &&
      typeof step.assistantMessage.text === 'string'
        ? step.assistantMessage.text
        : '';
    if (assistantText.trim()) {
      out.push({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: assistantText }],
        },
      });
    }

    const thinkingText =
      step.thinkingMessage &&
      typeof step.thinkingMessage === 'object' &&
      typeof step.thinkingMessage.text === 'string'
        ? step.thinkingMessage.text
        : '';
    if (thinkingText.trim()) {
      out.push({ type: 'thinking', text: thinkingText });
    }

    const statusText =
      step.statusMessage &&
      typeof step.statusMessage === 'object' &&
      typeof step.statusMessage.text === 'string'
        ? step.statusMessage.text
        : '';
    if (statusText.trim()) {
      out.push({ type: 'status', status: statusText, message: '' });
    }

    const toolCall = step.toolCall;
    if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) continue;
    for (const key of Object.keys(toolCall)) {
      const payload = toolCall[key];
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
      const result = payload.result;
      const status = result && typeof result === 'object' && result.error ? 'error' : 'completed';
      out.push({
        type: 'tool_call',
        name: normalizeToolName(key),
        status,
        args: payload.args && typeof payload.args === 'object' ? payload.args : {},
        result: result && typeof result === 'object' ? result : undefined,
        call_id: typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined,
      });
    }
  }

  return out;
}

/**
 * @param {object} chat
 * @param {HTMLElement} mountEl
   * @param {{ appendPlain: (s: string) => void, onHistoryRecord?: (rec: unknown) => void, loadOlderHistory?: () => Promise<{ records: unknown[], hasOlder: boolean } | null>, onAssistantText?: (text: string) => void, onAnswerEnd?: () => void, onForkFromPoint?: (point: { createdAt: string }) => void }} hooks
 * @returns {{ destroy: () => void, applyEvent: (ev: unknown) => void, onStreamReset: () => void, appendUserPrompt: (text: string, opts?: { silent?: boolean }) => void, appendBannerConnected: (opts?: { silent?: boolean }) => void, markUserPromptQueued: (text: string) => boolean, appendRunFinished: (status: string, opts?: { silent?: boolean }) => void, appendBusy: (message: string, opts?: { silent?: boolean }) => void, appendError: (message: string, opts?: { silent?: boolean }) => void, appendMetaNotice: (text: string, opts?: { silent?: boolean }) => void, appendRestoredPlainBuffer: (text: string, summaryLabel?: string) => void, applyAgentMessagesHistory: (rows: Array<{ type?: string, message?: unknown }>) => void, replayHistoryRecords: (records: unknown[]) => void, prependHistoryRecords: (records: unknown[]) => number, setOlderHistoryAvailable: (available: boolean) => void, scrollToBottom: () => void, getCopyText: () => string }}
 */
export function createSdkRichView(chat, mountEl, hooks) {
  if (!mountEl || typeof hooks?.appendPlain !== 'function') {
    throw new Error('createSdkRichView: mountEl and hooks.appendPlain are required');
  }

  mountEl.classList.add('sdk-rich-chat-mount');
  mountEl.innerHTML = '';
  // Sentinel lives outside the stream — replayHistoryRecords wipes the stream on every replay.
  const historyTopEl = document.createElement('div');
  historyTopEl.className = 'sdk-rich-history-top';
  historyTopEl.hidden = true;
  mountEl.appendChild(historyTopEl);
  const realStream = document.createElement('div');
  realStream.className = 'sdk-rich-stream';
  mountEl.appendChild(realStream);
  /** Render target — temporarily swapped to an offscreen node while paging older history in. */
  let stream = realStream;

  /** @type {HTMLElement | null} */
  let assistantMdEl = null;
  /** @type {HTMLDetailsElement | null} */
  let thinkingDetails = null;
  /** @type {HTMLElement | null} */
  let thinkingPre = null;
  /** @type {Map<string, { fullBlock: HTMLElement, tile: HTMLButtonElement, tray: object, event: Record<string, unknown> }>} */
  const toolByCallId = new Map();
  const planByCallId = new Map();
  /** @type {Map<string, HTMLElement>} */
  const openCodeQuestionByRequestId = new Map();
  /** @type {Map<string, HTMLElement>} */
  const openCodePermissionByRequestId = new Map();
  const compactTrayHosts = new Set();
  const fullToolBlocks = new Set();
  const compactStatusLines = new Set();
  const latestThinkingByRun = new Map();
  const latestTrayByRun = new Map();
  /** @type {Map<string, Set<unknown>>} Every Thinking/Activity block a run has rendered. */
  const thinkingBlocksByRun = new Map();
  /** @type {Map<string, Set<unknown>>} Every Activity tray a run has rendered. */
  const traysByRun = new Map();
  const runStatusByRun = new Map();
  const runningToolCallsByRun = new Map();
  let runScope = 1;
  let uiMode = normalizeSdkUiMode(chat.sdkUiMode);
  /** After WS hello/reconnect, keep using the live Thinking block (same run, new local-run key). */
  let resumeThinkingAfterStreamReset = false;
  /** After WS hello/reconnect, keep using the live Answer block instead of spawning a duplicate. */
  let resumeAssistantAfterStreamReset = false;

  /** @type {'assistant'|'thinking'|'idle'} */
  let activeKind = 'idle';
  let activeThinkingRunKey = '';

  /** When true (replay from Agent.messages.list) — do not append to the plaintext buffer in chat.js. */
  let suppressHooksPlain = false;

  /** When true — do not write to the local structured history (replay / applyAgentMessagesHistory). */
  let suppressHistoryPersist = false;

  /** When true (history replay) — render Markdown synchronously, without the shared rAF. */
  let mdRenderImmediate = false;

  /** Record timestamp of the SDK event currently being rendered. */
  let renderedRecordCreatedAt = '';
  let renderedRecordHistorySeq = 0;

  let mdRaf = 0;
  /** @type {{
   *   block: HTMLElement,
   *   summaryEl: HTMLElement,
   *   progressFillEl: HTMLElement,
   *   progressEl: HTMLElement,
   *   updatesEl: HTMLElement,
   *   totalSeconds: number,
   *   updates: number,
   *   isStarted?: boolean,
   *   anchorAt?: number,
   *   anchorIdleSeconds?: number,
   *   anchorRemainingSeconds?: number,
   *   liveTick?: boolean
   * } | null} */
  let timeoutProgressSeries = null;
  let timeoutProgressTickTimer = 0;

  const SCROLL_STICK_THRESHOLD_PX = 64;
  /** When false — the user scrolled up; do not autoscroll while streaming. */
  let stickToBottom = true;
  let suppressScrollStickUpdate = false;
  /** When true (rendering an older history page) — nothing may pull the viewport to the bottom. */
  let suppressAutoScroll = false;

  function isNearBottom() {
    const maxScroll = mountEl.scrollHeight - mountEl.clientHeight;
    if (maxScroll <= 0) return true;
    return mountEl.scrollTop >= maxScroll - SCROLL_STICK_THRESHOLD_PX;
  }

  /**
   * Autoscrolls a scrollable element (e.g. the thinking <pre>) to newly appended text,
   * but only while the user sits at the bottom — a manual scroll up must not be overridden.
   * @param {HTMLElement} el
   * @returns {boolean} whether the element should be pinned to the bottom after the update
   */
  function isScrollableNearBottom(el) {
    if (!el) return false;
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll <= 0) return true;
    return el.scrollTop >= maxScroll - SCROLL_STICK_THRESHOLD_PX;
  }

  /** @param {HTMLElement} el */
  function stickScrollToBottom(el) {
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function updateStickFromScroll() {
    if (suppressScrollStickUpdate) return;
    stickToBottom = isNearBottom();
  }

  /**
   * @param {{ force?: boolean } | boolean} [opts]
   */
  function scrollToBottom(opts) {
    if (suppressAutoScroll) return;
    const force = opts === true || (opts && typeof opts === 'object' && opts.force === true);
    if (!force && !stickToBottom) return;
    if (force) stickToBottom = true;
    requestAnimationFrame(() => {
      try {
        suppressScrollStickUpdate = true;
        mountEl.scrollTop = mountEl.scrollHeight;
      } catch (_) {
        /* ignore */
      } finally {
        requestAnimationFrame(() => {
          suppressScrollStickUpdate = false;
        });
      }
    });
  }

  mountEl.addEventListener('scroll', updateStickFromScroll, { passive: true });

  mountEl.addEventListener('cr-sdk-block-speak', (event) => {
    const detail = event?.detail || {};
    if (typeof detail.text !== 'string' || !detail.text) return;
    getChatSpeaker().toggleSpeakMarkdown(detail.text, detail.token || '');
  });

  mountEl.addEventListener('cr-sdk-block-fork', (event) => {
    const block = event?.target;
    const createdAt =
      block instanceof HTMLElement && typeof /** @type {any} */ (block).createdAt === 'string'
        ? /** @type {any} */ (block).createdAt.trim()
        : '';
    if (!createdAt) return;
    if (typeof hooks.onForkFromPoint === 'function') hooks.onForkFromPoint({ createdAt });
  });

  mountEl.addEventListener('cr-sdk-block-pass', (event) => {
    const point = readBlockMessagePoint(event?.target);
    if (!point.text) return;
    if (typeof hooks.onPassMessageToChild === 'function') hooks.onPassMessageToChild(point);
  });

  mountEl.addEventListener('cr-sdk-block-reply', (event) => {
    const point = readBlockMessagePoint(event?.target);
    if (!point.text) return;
    if (typeof hooks.onReplyMessageToParent === 'function') hooks.onReplyMessageToParent(point);
  });

  /**
   * @param {Record<string, unknown>} ev
   */
  function persistThisSdkEvent(ev) {
    if (suppressHistoryPersist) return;
    if (typeof hooks.onHistoryRecord !== 'function') return;
    const cloned = cloneSerializableSdkEvent(ev);
    if (!cloned) return;
    hooks.onHistoryRecord({
      kind: 'sdk',
      event: cloned,
      createdAt: renderedRecordCreatedAt || new Date().toISOString(),
    });
  }

  /**
   * Persists a streaming event (assistant/thinking) with the full accumulator text instead of
   * the raw, possibly partial, WS event. This guarantees that after "last one wins" coalescing
   * the history holds the complete text, so replay through takeStreamDelta stays deterministic
   * (full.startsWith(prev)) — fixes fragmented thinking/assistant output.
   *
   * @param {Record<string, unknown>} ev
   * @param {'assistant' | 'thinking'} kind
   * @param {string} acc full accumulator text
   */
  function persistSdkStreamSnapshot(ev, kind, acc) {
    if (suppressHistoryPersist) return;
    if (typeof hooks.onHistoryRecord !== 'function') return;
    const cloned = cloneSerializableSdkEvent(ev);
    if (!cloned) return;
    if (kind === 'thinking') {
      cloned.text = acc;
    } else if (kind === 'assistant') {
      const msg = cloned.message && typeof cloned.message === 'object' ? cloned.message : {};
      cloned.message = { ...msg, content: [{ type: 'text', text: acc }] };
    }
    hooks.onHistoryRecord({
      kind: 'sdk',
      event: cloned,
      createdAt: renderedRecordCreatedAt || new Date().toISOString(),
    });
  }

  /**
   * @param {HTMLElement} mdHost
   * @param {string} raw
   */
  function flushMarkdown(mdHost, raw) {
    const r = raw == null ? '' : String(raw);
    const textForDisplay = stripScreenshotMarkers(r);
    mdHost.dataset.rawMd = r;
    mdHost.innerHTML = md.render(textForDisplay);
    decorateCodeForCopy(mdHost);
    void renderMermaidDiagrams(mdHost);
    const mdLinkRefs = Array.from(mdHost.querySelectorAll('a[href]'))
      .map((el) => String(el.getAttribute('href') || '').trim())
      .filter((href) => isImageLikeHref(href))
      .map((href) => ({
        source: href,
        href: screenshotPathToPreviewUrl(href) || href,
      }));
    const markerRefs = collectInlineImageRefs(r);
    const thumbRefs = [];
    const seenThumbHref = new Set();
    for (const ref of [...markerRefs, ...mdLinkRefs]) {
      if (!ref || typeof ref !== 'object') continue;
      const href = String(ref.href || '').trim();
      if (!href || seenThumbHref.has(href)) continue;
      seenThumbHref.add(href);
      thumbRefs.push(ref);
    }
    appendInlineImageThumbs(mdHost, thumbRefs);
    scrollToBottom();
  }

  /**
   * @param {HTMLElement} mdHost
   * @param {string} raw
   */
  function scheduleMd(mdHost, raw) {
    mdHost.dataset.rawMd = raw;
    if (mdRaf) return;
    mdRaf = requestAnimationFrame(() => {
      mdRaf = 0;
      flushMarkdown(mdHost, mdHost.dataset.rawMd || '');
    });
  }

  function clearSegmentPointers() {
    setThinkingRunning(false);
    assistantMdEl = null;
    thinkingDetails = null;
    thinkingPre = null;
    activeKind = 'idle';
    activeThinkingRunKey = '';
  }

  /**
   * @returns {Array<{ runKey: string, isConnected: boolean, isActivityOnly: boolean, hasThinkingPre: boolean, block: HTMLElement }>}
   */
  function listThinkingBlockEntries() {
    const entries = [];
    for (const [runKey, block] of latestThinkingByRun.entries()) {
      if (!block) continue;
      entries.push({
        runKey,
        block,
        isConnected: block.isConnected === true,
        isActivityOnly: block.classList.contains('sdk-compact-activity-block'),
        hasThinkingPre: !!block.querySelector('.sdk-rich-thinking-pre'),
      });
    }
    return entries;
  }

  /**
   * @param {string} runKey
   * @returns {HTMLElement | null}
   */
  function resolveThinkingBlockForRun(runKey) {
    const entries = listThinkingBlockEntries();
    const index = findReusableSdkThinkingBlockIndex(
      entries,
      runKey,
      resumeThinkingAfterStreamReset
    );
    if (index < 0) return null;
    return entries[index].block;
  }

  /**
   * @returns {Array<{ variant: string, isConnected: boolean, hasAssistantMd: boolean, block: HTMLElement }>}
   */
  function listAssistantBlockEntries() {
    const entries = [];
    for (const node of stream.querySelectorAll(':scope > cr-sdk-block')) {
      if (!(node instanceof HTMLElement)) continue;
      const variant = typeof node.variant === 'string' ? node.variant : '';
      entries.push({
        variant,
        block: node,
        isConnected: node.isConnected === true,
        hasAssistantMd: !!node.querySelector('.sdk-rich-assistant-md'),
      });
    }
    return entries;
  }

  /**
   * @returns {HTMLElement | null}
   */
  function resolveAssistantBlockAfterReset() {
    const entries = listAssistantBlockEntries();
    const index = findReusableSdkAssistantBlockIndex(entries, resumeAssistantAfterStreamReset);
    if (index < 0) return null;
    return entries[index].block.querySelector('.sdk-rich-assistant-md');
  }

  /**
   * @param {HTMLElement} mdEl
   */
  function adoptAssistantBlock(mdEl) {
    assistantMdEl = mdEl;
    const restored = restoreSdkAssistantAccumulator(
      typeof chat._sdkAssistantAcc === 'string' ? chat._sdkAssistantAcc : '',
      mdEl.dataset.rawMd || ''
    );
    if (restored) chat._sdkAssistantAcc = restored;
  }

  /**
   * @param {unknown} block
   * @param {string} runKey
   * @returns {void}
   */
  function rememberThinkingBlock(runKey, block) {
    if (!block) return;
    latestThinkingByRun.set(runKey, block);
    registerRunItem(thinkingBlocksByRun, runKey, block);
  }

  /**
   * @param {HTMLElement} block
   * @param {string} runKey
   */
  function adoptThinkingBlock(block, runKey) {
    thinkingDetails = block;
    thinkingPre = block.querySelector('.sdk-rich-thinking-pre');
    rememberThinkingBlock(runKey, block);
    activeThinkingRunKey = runKey;
    if ('running' in block) {
      block.running = !suppressHistoryPersist;
      block.open = true;
    }
    const restored = restoreSdkThinkingAccumulator(
      typeof chat._sdkThinkingAcc === 'string' ? chat._sdkThinkingAcc : '',
      thinkingPre ? thinkingPre.textContent || '' : ''
    );
    if (restored) chat._sdkThinkingAcc = restored;
  }

  function stopTimeoutProgressTicker() {
    if (!timeoutProgressTickTimer) return;
    clearInterval(timeoutProgressTickTimer);
    timeoutProgressTickTimer = 0;
  }

  function startTimeoutProgressTicker() {
    if (timeoutProgressTickTimer) return;
    if (!timeoutProgressSeries?.liveTick) return;
    timeoutProgressTickTimer = setInterval(() => {
      renderTimeoutProgressSeriesLive();
    }, 1000);
  }

  /**
   * @param {number} idleSeconds
   * @param {number} remainingSeconds
   * @param {boolean} isStarted
   */
  function renderTimeoutProgressSeriesDisplay(idleSeconds, remainingSeconds, isStarted) {
    if (!timeoutProgressSeries) return;

    if (isStarted) {
      timeoutProgressSeries.progressFillEl.style.width = '0%';
      timeoutProgressSeries.progressEl.setAttribute('aria-valuenow', '0');
      timeoutProgressSeries.summaryEl.textContent = t('sdkView.promptSentWaiting');
      timeoutProgressSeries.block.name =
        idleSeconds > 0
          ? t('sdkView.waitingFirstReplyWithTime', {
            time: formatTimeoutProgressSeconds(idleSeconds),
          })
          : t('sdkView.waitingFirstReply');
      return;
    }

    const totalSeconds = Math.max(timeoutProgressSeries.totalSeconds, 1);
    const elapsedSeconds = Math.max(0, totalSeconds - remainingSeconds);
    const percent = Math.max(
      0,
      Math.min(100, Math.round((elapsedSeconds / totalSeconds) * 100))
    );
    timeoutProgressSeries.progressFillEl.style.width = `${percent}%`;
    timeoutProgressSeries.progressEl.setAttribute('aria-valuenow', String(percent));
    timeoutProgressSeries.summaryEl.textContent = t('sdkView.timeoutProgressSummary', {
      idle: formatTimeoutProgressSeconds(idleSeconds),
      remaining: formatTimeoutProgressSeconds(remainingSeconds),
      percent,
    });
    timeoutProgressSeries.block.name = t('sdkView.waitingBlockName', {
      idle: formatTimeoutProgressSeconds(idleSeconds),
      remaining: formatTimeoutProgressSeconds(remainingSeconds),
    });
  }

  function renderTimeoutProgressSeriesLive() {
    if (!timeoutProgressSeries?.liveTick) return;
    const series = timeoutProgressSeries;
    const anchorAt = Number(series.anchorAt) || Date.now();
    const deltaSec = Math.max(0, Math.floor((Date.now() - anchorAt) / 1000));
    const idleSeconds = Math.max(0, Number(series.anchorIdleSeconds) || 0) + deltaSec;
    const remainingSeconds = Math.max(0, (Number(series.anchorRemainingSeconds) || 0) - deltaSec);
    renderTimeoutProgressSeriesDisplay(idleSeconds, remainingSeconds, series.isStarted === true);
  }

  function finalizeTimeoutProgressSeries() {
    stopTimeoutProgressTicker();
    if (!timeoutProgressSeries) return;
    timeoutProgressSeries.block.running = false;
    timeoutProgressSeries.block.label = '';
    timeoutProgressSeries.liveTick = false;
    timeoutProgressSeries = null;
  }

  function stopTimeoutProgressSeries() {
    finalizeTimeoutProgressSeries();
  }

  function discardTimeoutProgressSeries() {
    stopTimeoutProgressTicker();
    if (timeoutProgressSeries?.block) {
      timeoutProgressSeries.block.remove();
    }
    timeoutProgressSeries = null;
  }

  /**
   * @param {HTMLElement} el
   * @param {{ skipTimeoutFinalize?: boolean }} [opts]
   */
  function appendStreamChild(el, opts = {}) {
    if (!(el instanceof HTMLElement)) return;
    if (!opts.skipTimeoutFinalize) {
      finalizeTimeoutProgressSeries();
    }
    stream.appendChild(el);
  }

  /**
   * @param {{ idleSeconds: number, remainingSeconds: number, totalSeconds?: number, isStarted?: boolean }} parsed
   */
  function appendTimeoutProgressSeries(parsed) {
    if (!parsed) return;
    const isStarted = parsed.isStarted === true;
    const idleSeconds = Math.max(0, Number(parsed.idleSeconds) || 0);
    const remainingSeconds = Math.max(0, Number(parsed.remainingSeconds) || 0);

    if (!timeoutProgressSeries) {
      const block = createSdkBlock({
        variant: 'warn',
        label: '',
        name: t('sdkView.waitingForAgentReply'),
        open: false,
        skipTimeoutFinalize: true,
      });
      block.classList.add('sdk-timeout-progress-series');
      block.running = true;

      const body = document.createElement('div');
      body.className = 'sdk-timeout-progress';
      const summaryEl = document.createElement('div');
      summaryEl.className = 'sdk-timeout-progress__summary';
      const progressEl = document.createElement('div');
      progressEl.className = 'sdk-timeout-progress__bar';
      progressEl.setAttribute('role', 'progressbar');
      progressEl.setAttribute('aria-valuemin', '0');
      progressEl.setAttribute('aria-valuemax', '100');
      const progressFillEl = document.createElement('div');
      progressFillEl.className = 'sdk-timeout-progress__bar-fill';
      progressEl.appendChild(progressFillEl);
      const updatesEl = document.createElement('div');
      updatesEl.className = 'sdk-timeout-progress__updates';
      body.append(summaryEl, progressEl, updatesEl);
      block.appendChild(body);

      timeoutProgressSeries = {
        block,
        summaryEl,
        progressFillEl,
        progressEl,
        updatesEl,
        totalSeconds: 0,
        updates: 0,
      };
    }

    const explicitTotal = Math.max(0, Number(parsed.totalSeconds) || 0);
    const inferredTotal = idleSeconds + remainingSeconds;
    const totalSeconds = Math.max(
      timeoutProgressSeries.totalSeconds,
      explicitTotal,
      inferredTotal
    );
    timeoutProgressSeries.totalSeconds = Math.max(totalSeconds, 1);
    if (!isStarted) {
      timeoutProgressSeries.updates += 1;
    }
    timeoutProgressSeries.block.running = true;
    timeoutProgressSeries.block.label = '';
    timeoutProgressSeries.block.createdAt = new Date().toISOString();
    timeoutProgressSeries.isStarted = isStarted;
    timeoutProgressSeries.anchorAt = Date.now();
    timeoutProgressSeries.anchorIdleSeconds = idleSeconds;
    timeoutProgressSeries.anchorRemainingSeconds = remainingSeconds;
    timeoutProgressSeries.liveTick = !suppressHistoryPersist;

    renderTimeoutProgressSeriesDisplay(idleSeconds, remainingSeconds, isStarted);
    if (timeoutProgressSeries.liveTick) {
      startTimeoutProgressTicker();
    } else {
      stopTimeoutProgressTicker();
    }

    if (!isStarted) {
      const updateLine = document.createElement('div');
      updateLine.className = 'sdk-timeout-progress__update';
      updateLine.textContent =
        `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}` +
        ` • ${t('sdkView.timeoutProgressUpdate', {
          idle: formatTimeoutProgressSeconds(idleSeconds),
          remaining: formatTimeoutProgressSeconds(remainingSeconds),
        })}`;
      timeoutProgressSeries.updatesEl.prepend(updateLine);
      while (timeoutProgressSeries.updatesEl.childElementCount > 40) {
        timeoutProgressSeries.updatesEl.lastElementChild?.remove();
      }
    }
    scrollToBottom();
  }

  /**
   * @param {string} text
   * @param {{ silent?: boolean }} [opts]
   */
  function handleMetaNotice(text, opts = {}) {
    const silent = opts.silent === true;
    const noticeText = text == null ? '' : String(text);
    // Replayed records carry the progress values; parsing the text is only a
    // fallback for history written before they were stored.
    const timeoutProgress = opts.progress || parseTimeoutProgressNotice(noticeText);
    if (timeoutProgress) {
      if (!silent) hooks.appendPlain(`\n${noticeText}\n`);
      appendTimeoutProgressSeries(timeoutProgress);
      if (!silent && typeof hooks.onHistoryRecord === 'function' && !suppressHistoryPersist) {
        hooks.onHistoryRecord({
          kind: 'meta',
          variant: 'notice',
          payload: noticeText,
          progress: timeoutProgress,
          createdAt: new Date().toISOString(),
        });
      }
      return;
    }
    stopTimeoutProgressSeries();
    if (!silent) hooks.appendPlain(`\n${noticeText}\n`);
    const createdAt = lineMeta('sdk-rich-line--notice', escapeHtml(noticeText));
    if (!silent && typeof hooks.onHistoryRecord === 'function' && !suppressHistoryPersist) {
      hooks.onHistoryRecord({
        kind: 'meta',
        variant: 'notice',
        payload: noticeText,
        createdAt,
      });
    }
  }

  /**
   * @param {boolean} value
   */
  function setThinkingRunning(value) {
    if (thinkingDetails && typeof thinkingDetails === 'object' && 'running' in thinkingDetails) {
      thinkingDetails.running = value;
    }
  }

  /**
   * @param {string} runKey
   */
  function syncThinkingBlockRunning(runKey) {
    const key = String(runKey || '').trim();
    if (!key) return;
    const latest = latestThinkingByRun.get(key);
    // Blocks the run already left behind are done — their spinner is always stale.
    for (const stale of listRunItems(thinkingBlocksByRun, key)) {
      if (stale === latest) continue;
      if (!stale || typeof stale !== 'object' || !('running' in stale)) continue;
      stale.running = false;
    }
    if (!latest || typeof latest !== 'object' || !('running' in latest)) return;

    if (activeKind === 'thinking' && activeThinkingRunKey === key && !suppressHistoryPersist) {
      latest.running = true;
      return;
    }

    const running = hasRunningSdkTools(runningToolCallsByRun, key);
    latest.running = running;
    if (running) latest.open = true;
  }

  /**
   * @param {Record<string, unknown>} ev
   * @returns {string}
   */
  function getEventRunKey(ev) {
    const runId = typeof ev.run_id === 'string' ? ev.run_id.trim() : '';
    return runId || `local-run-${runScope}`;
  }

  /**
   * @param {string} name
   * @returns {string}
   */
  function getToolIconClass(name) {
    const normalized = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (/read|file|glob|list/.test(normalized)) return 'mdi-file-eye-outline';
    if (/search|grep|find/.test(normalized)) return 'mdi-magnify';
    if (/edit|write|patch|delete/.test(normalized)) return 'mdi-file-edit-outline';
    if (/shell|terminal|command|bash/.test(normalized)) return 'mdi-console';
    if (/usage|token/.test(normalized)) return 'mdi-chart-donut';
    if (/todo/.test(normalized)) return 'mdi-format-list-checks';
    if (/task|subagent|agent/.test(normalized)) return 'mdi-robot-outline';
    if (/mcp/.test(normalized)) return 'mdi-power-plug-outline';
    return 'mdi-wrench-outline';
  }

  /**
   * @param {string} name
   * @param {string[]} paths
   * @param {unknown} [args]
   * @returns {string}
   */
  function getToolTileLabel(name, paths, args) {
    const searchQuery = parseToolSearchQuery(readToolSearchQuery(args));
    if (searchQuery) return searchQuery;
    const firstPath = Array.isArray(paths) ? String(paths[0] || '') : '';
    if (!firstPath) return name || 'tool';
    const normalized = firstPath.replace(/\\/g, '/').replace(/\/$/, '');
    return normalized.split('/').pop() || name || 'tool';
  }

  /**
   * @param {Record<string, unknown>} ev
   * @returns {HTMLElement}
   */
  function createToolBody(ev) {
    const name = typeof ev.name === 'string' ? ev.name : '';
    const nameLower = name.toLowerCase();
    const argsStr = stringifySnippet(ev.args, 2400);
    const resultStr = stringifySnippet(ev.result, 4800);
    const todoSummary = nameLower === 'updatetodos' ? extractTodoSummary(ev.args) : '';
    const searchQuery = parseToolSearchQuery(readToolSearchQuery(ev.args));
    const body = document.createElement('div');
    const searchSummary = searchQuery
      ? `<p class="sdk-rich-tool-summary">${escapeHtml(t('sdkView.toolSearchLookingFor', { query: searchQuery }))}</p>`
      : '';
    body.innerHTML = `
  ${todoSummary ? `<pre class="sdk-rich-todos">${escapeHtml(todoSummary)}</pre>` : ''}
  ${searchSummary}
  ${argsStr ? `<details class="sdk-rich-nested"><summary>${escapeHtml(t('sdkView.arguments'))}</summary><pre class="sdk-rich-json">${escapeHtml(argsStr)}</pre></details>` : ''}
  ${resultStr ? `<details class="sdk-rich-nested"${searchQuery ? ' open' : ''}><summary>${escapeHtml(t('sdkView.result'))}</summary><pre class="sdk-rich-json">${escapeHtml(resultStr)}</pre></details>` : ''}`;
    return body;
  }

  /**
   * @param {string} status
   * @returns {'ok' | 'err' | 'warn' | 'run'}
   */
  function resolveToolBlockVariant(status) {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'completed') return 'ok';
    if (normalized === 'error') return 'err';
    if (normalized === 'cancelled') return 'warn';
    return 'run';
  }

  /**
   * Close tool tiles that never received a terminal SDK status after the run ended.
   *
   * @param {string} [runKey]
   * @param {string} [runStatus]
   */
  function finalizeOpenToolCalls(runKey = '', runStatus = '') {
    const abandonedStatus = resolveAbandonedToolStatus(runStatus);
    const filterKey = String(runKey || '').trim();
    for (const record of toolByCallId.values()) {
      if (!record) continue;
      if (filterKey && record.runKey !== filterKey) continue;
      const prevStatus = typeof record.event?.status === 'string' ? record.event.status : '';
      if (!isOpenSdkToolStatus(prevStatus)) continue;
      if (!shouldAcceptSdkToolStatus(prevStatus, abandonedStatus)) continue;
      const ev = { ...(record.event || {}), status: abandonedStatus };
      const paths = pathsFromToolArgs(ev.args);
      record.event = ev;
      record.fullBlock.variant = resolveToolBlockVariant(abandonedStatus);
      record.fullBlock.label = abandonedStatus;
      record.fullBlock.open = false;
      if (record.fullBlock && typeof record.fullBlock === 'object' && 'running' in record.fullBlock) {
        record.fullBlock.running = false;
      }
      updateCompactToolTile(record, ev, paths);
      updateRunningSdkToolState(
        runningToolCallsByRun,
        record.runKey || filterKey,
        prevStatus,
        abandonedStatus
      );
    }
    if (filterKey) {
      setRunningSdkToolCallCount(runningToolCallsByRun, filterKey, 0);
      syncThinkingBlockRunning(filterKey);
      return;
    }
    runningToolCallsByRun.clear();
    for (const key of latestThinkingByRun.keys()) {
      syncThinkingBlockRunning(key);
    }
  }

  /**
   * @param {string} runKey
   * @param {string} status
   */
  function applyStatusToLatestOpenTool(runKey, status) {
    const key = String(runKey || '').trim();
    let match = null;
    for (const record of toolByCallId.values()) {
      if (!record) continue;
      if (key && record.runKey !== key) continue;
      const prevStatus = typeof record.event?.status === 'string' ? record.event.status : '';
      if (!isOpenSdkToolStatus(prevStatus)) continue;
      match = record;
    }
    if (!match) return;
    const prevStatus = typeof match.event?.status === 'string' ? match.event.status : '';
    if (!shouldAcceptSdkToolStatus(prevStatus, status)) return;
    const ev = { ...(match.event || {}), status };
    const paths = pathsFromToolArgs(ev.args);
    match.event = ev;
    match.fullBlock.variant = resolveToolBlockVariant(status);
    match.fullBlock.label = status;
    match.fullBlock.name = typeof ev.name === 'string' ? ev.name : match.fullBlock.name;
    match.fullBlock.open = false;
    match.fullBlock.replaceChildren(createToolBody(ev));
    updateCompactToolTile(match, ev, paths);
    updateRunningSdkToolState(runningToolCallsByRun, match.runKey || key, prevStatus, status);
    syncThinkingBlockRunning(match.runKey || key);
  }

  /**
   * @param {object} tray
   * @param {string} status
   */
  function setTrayStatus(tray, status) {
    if (!tray?.statusEl) return;
    const normalized = String(status || '').trim().toUpperCase();
    tray.statusEl.textContent = normalized;
    tray.statusEl.hidden = !normalized;
    tray.statusEl.dataset.status = normalized.toLowerCase();
  }

  /**
   * @param {string} runKey
   * @param {HTMLElement | null} thinkingBlock
   * @returns {object}
   */
  function ensureCompactTray(runKey, thinkingBlock = null) {
    const existing = thinkingBlock?._sdkCompactTray;
    if (existing) return existing;

    if (!thinkingBlock) {
      const latestTray = latestTrayByRun.get(runKey);
      if (latestTray) return latestTray;
    }

    let container = thinkingBlock;
    let compactRoot = null;
    if (!container) {
      container = createSdkBlock({ variant: 'thinking', label: t('sdkView.activity'), open: true });
      container.classList.add('sdk-compact-activity-block');
      compactRoot = container;
    }

    const trayEl = document.createElement('div');
    trayEl.className = 'sdk-tool-tray';
    const header = document.createElement('div');
    header.className = 'sdk-tool-tray__header';
    const title = document.createElement('span');
    title.className = 'sdk-tool-tray__title';
    title.textContent = t('sdkView.activity');
    const statusEl = document.createElement('span');
    statusEl.className = 'sdk-tool-tray__status';
    statusEl.hidden = true;
    header.append(title, statusEl);

    const tilesEl = document.createElement('div');
    tilesEl.className = 'sdk-tool-tray__tiles';
    const detailEl = document.createElement('div');
    detailEl.className = 'sdk-tool-tray__detail';
    detailEl.hidden = true;
    trayEl.append(header, tilesEl, detailEl);
    container.appendChild(trayEl);

    const tray = {
      runKey,
      container,
      compactRoot: compactRoot || trayEl,
      trayEl,
      tilesEl,
      detailEl,
      statusEl,
      activeCallId: '',
    };
    container._sdkCompactTray = tray;
    compactTrayHosts.add(tray);
    latestTrayByRun.set(runKey, tray);
    registerRunItem(traysByRun, runKey, tray);
    if (compactRoot) registerRunItem(thinkingBlocksByRun, runKey, compactRoot);
    setTrayStatus(tray, runStatusByRun.get(runKey) || '');
    tray.compactRoot.hidden = uiMode !== 'compact';
    return tray;
  }

  /**
   * @param {object} record
   */
  function openCompactToolDetail(record) {
    const tray = record.tray;
    if (tray.activeCallId === record.callId && !tray.detailEl.hidden) {
      tray.activeCallId = '';
      tray.detailEl.hidden = true;
      record.tile.setAttribute('aria-expanded', 'false');
      return;
    }
    tray.tilesEl.querySelectorAll('.sdk-tool-tile[aria-expanded="true"]').forEach((tile) => {
      tile.setAttribute('aria-expanded', 'false');
    });
    tray.activeCallId = record.callId;
    record.tile.setAttribute('aria-expanded', 'true');
    tray.detailEl.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'sdk-tool-tray__detail-heading';
    heading.textContent = record.title;
    tray.detailEl.append(heading, createToolBody(record.event));
    tray.detailEl.hidden = false;
    scrollToBottom();
  }

  /**
   * @param {object} record
   * @param {Record<string, unknown>} ev
   * @param {string[]} paths
   */
  function updateCompactToolTile(record, ev, paths) {
    const name = typeof ev.name === 'string' ? ev.name : '?';
    const status = typeof ev.status === 'string' ? ev.status.toLowerCase() : '';
    const label = getToolTileLabel(name, paths, ev.args);
    record.event = ev;
    const searchQuery = parseToolSearchQuery(readToolSearchQuery(ev.args));
    record.title = searchQuery
      ? `${name}: ${searchQuery}`
      : (paths.length > 0 ? `${name}: ${paths.join(', ')}` : name);
    record.tile.dataset.status = status || 'unknown';
    record.tile.title = record.title;
    record.tile.setAttribute('aria-label', `${name}: ${status || 'unknown'}`);
    record.iconEl.className = `mdi ${getToolIconClass(name)} sdk-tool-tile__icon`;
    record.labelEl.textContent = label;
    record.statusEl.className =
      status === 'running'
        ? 'mdi mdi-loading mdi-spin sdk-tool-tile__status-icon'
        : status === 'error'
          ? 'mdi mdi-alert-circle-outline sdk-tool-tile__status-icon'
          : status === 'cancelled'
            ? 'mdi mdi-close-circle-outline sdk-tool-tile__status-icon'
            : 'mdi mdi-check sdk-tool-tile__status-icon';
    if (record.tray.activeCallId === record.callId && !record.tray.detailEl.hidden) {
      const heading = document.createElement('div');
      heading.className = 'sdk-tool-tray__detail-heading';
      heading.textContent = record.title;
      record.tray.detailEl.replaceChildren(heading, createToolBody(record.event));
    }
  }

  /**
   * @param {string} callId
   * @param {HTMLElement} fullBlock
   * @param {Record<string, unknown>} ev
   * @param {string[]} paths
   * @param {string} runKey
   * @returns {object}
   */
  function createCompactToolRecord(callId, fullBlock, ev, paths, runKey) {
    const name = typeof ev.name === 'string' ? ev.name : '?';
    const thinkingBlock = resolveThinkingBlockForRun(runKey);
    if (thinkingBlock) rememberThinkingBlock(runKey, thinkingBlock);
    const tray = ensureCompactTray(runKey, thinkingBlock);
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'sdk-tool-tile';
    tile.dataset.callId = callId;
    tile.setAttribute('aria-expanded', 'false');
    const iconEl = document.createElement('span');
    iconEl.setAttribute('aria-hidden', 'true');
    const labelEl = document.createElement('span');
    labelEl.className = 'sdk-tool-tile__label';
    const statusEl = document.createElement('span');
    statusEl.setAttribute('aria-hidden', 'true');
    tile.append(iconEl, labelEl, statusEl);
    tray.tilesEl.appendChild(tile);

    const record = {
      callId,
      runKey,
      fullBlock,
      tile,
      tray,
      iconEl,
      labelEl,
      statusEl,
      event: ev,
      title: name,
    };
    tile.addEventListener('click', () => openCompactToolDetail(record));
    updateCompactToolTile(record, ev, paths);
    return record;
  }

  function applyUiModeVisibility() {
    const compact = uiMode === 'compact';
    fullToolBlocks.forEach((block) => {
      block.hidden = compact;
    });
    compactTrayHosts.forEach((tray) => {
      tray.compactRoot.hidden = !compact;
    });
    compactStatusLines.forEach((line) => {
      line.hidden = compact;
    });
  }

  function resetRenderedActivity() {
    toolByCallId.clear();
    planByCallId.clear();
    compactTrayHosts.clear();
    fullToolBlocks.clear();
    compactStatusLines.clear();
    latestThinkingByRun.clear();
    latestTrayByRun.clear();
    thinkingBlocksByRun.clear();
    traysByRun.clear();
    runStatusByRun.clear();
    runningToolCallsByRun.clear();
    runScope += 1;
    resumeThinkingAfterStreamReset = false;
    resumeAssistantAfterStreamReset = false;
  }

  /**
   * @param {unknown} status
   * @returns {string}
   */
  function resolveRunFinishedLineClass(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (!normalized || normalized === 'finished' || normalized === 'completed') {
      return 'sdk-rich-line--ok';
    }
    if (isSdkRunFailureStatus(normalized)) return 'sdk-rich-line--err';
    return 'sdk-rich-line--warn';
  }

  /**
   * @param {string} htmlClass
   * @param {string} htmlInner
   * @param {string} [createdAt]
   * @param {boolean} [compactHidden]
   * @returns {string}
   */
  function lineMeta(
    htmlClass,
    htmlInner,
    createdAt = '',
    compactHidden = false,
    skipTimeoutFinalize = false
  ) {
    const rawCreatedAt =
      typeof createdAt === 'string' && createdAt.trim()
        ? createdAt
        : renderedRecordCreatedAt || new Date().toISOString();
    const date = new Date(rawCreatedAt);
    const validDate = Number.isFinite(date.getTime()) ? date : new Date();
    const normalizedCreatedAt = validDate.toISOString();

    const div = document.createElement('div');
    div.className = `sdk-rich-line ${htmlClass}`;

    const content = document.createElement('span');
    content.className = 'sdk-rich-line__content';
    content.innerHTML = htmlInner;
    div.appendChild(content);

    const time = document.createElement('time');
    time.className = 'sdk-rich-line__timestamp';
    time.dateTime = normalizedCreatedAt;
    time.title = normalizedCreatedAt;
    time.textContent = validDate.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    div.appendChild(time);

    if (compactHidden) {
      compactStatusLines.add(div);
      div.hidden = uiMode === 'compact';
    }
    appendStreamChild(div, { skipTimeoutFinalize });
    scrollToBottom();
    return normalizedCreatedAt;
  }

  const queuedUserBlocks = [];

  /**
   * Renumbers the labels of all pending queue blocks.
   */
  function relabelQueuedBlocks() {
    queuedUserBlocks.forEach((item, idx) => {
      if (!item.block) return;
      item.block.label = t('sdkView.youQueuedNumbered', { n: idx + 1 });
    });
  }

  function normalizeUserPromptText(text) {
    return text == null ? '' : String(text).trim();
  }

  function findUserBlockByText(text) {
    const raw = normalizeUserPromptText(text);
    if (!raw) return null;
    return Array.from(stream.children).find(
      (item) => item?.localName === 'cr-sdk-block' && normalizeUserPromptText(item.copyText) === raw,
    ) || null;
  }

  function hasQueuedOrSentUserText(text) {
    const raw = normalizeUserPromptText(text);
    if (!raw) return false;
    if (queuedUserBlocks.some((item) => normalizeUserPromptText(item.text) === raw)) return true;
    return !!findUserBlockByText(raw);
  }

  function attachQueuedBlockActions(block, text) {
    block.classList.add('sdk-rich-block--queued');
    block.queued = true;
    // Not sent yet — the history cut point would be ambiguous, so no fork action
    // until the queued record is promoted to a sent localUser record.
    block.forkable = false;
    block.addEventListener('cr-sdk-block-force-send', () => {
      if (typeof hooks.onForceSendQueueItem === 'function') hooks.onForceSendQueueItem(text);
    });
    block.addEventListener('cr-sdk-block-remove', () => {
      if (typeof hooks.onRemoveQueueItem === 'function') hooks.onRemoveQueueItem(text);
    });
    applyDelegationArrows(block);
  }

  /**
   * Creates a consistent collapsible SDK block (<cr-sdk-block>) and appends it to the stream.
   *
   * @param {{ variant?: string, label?: string, name?: string, paths?: string[], open?: boolean, createdAt?: string }} opts
   * @returns {HTMLElement} the <cr-sdk-block> element (light DOM host for the content)
   */
  function readBlockMessagePoint(block) {
    if (!(block instanceof HTMLElement)) {
      return { historySeq: 0, createdAt: '', text: '' };
    }
    const seq = Number(/** @type {any} */ (block).historySeq);
    const createdAt =
      typeof /** @type {any} */ (block).createdAt === 'string'
        ? /** @type {any} */ (block).createdAt.trim()
        : '';
    const text =
      typeof /** @type {any} */ (block).getBlockCopyText === 'function'
        ? String(/** @type {any} */ (block).getBlockCopyText() || '').trim()
        : String(/** @type {any} */ (block).copyText || '').trim();
    return {
      historySeq: Number.isSafeInteger(seq) && seq > 0 ? seq : 0,
      createdAt,
      text,
    };
  }

  function applyDelegationArrows(block) {
    if (!(block instanceof HTMLElement)) return;
    const hasParent = typeof chat?.delegationParentChatId === 'string'
      && chat.delegationParentChatId.trim() !== '';
    const variant = String(block.variant || '');
    const eligibleVariant = variant === 'user' || variant === 'assistant';
    const blocked = block.running === true || block.queued === true || !eligibleVariant;
    const seq = Number(block.historySeq);
    const saved = Number.isSafeInteger(seq) && seq > 0;
    if (blocked) {
      block.passable = false;
      block.replyable = false;
      block.passDisabled = false;
      block.passHint = '';
      return;
    }
    if (!saved) {
      block.passable = false;
      block.replyable = false;
      block.passDisabled = true;
      block.passHint = t('sdkBlock.passNeedsSavedHistory');
      return;
    }
    block.passDisabled = false;
    block.passHint = '';
    block.passable = true;
    block.replyable = hasParent;
  }

  function createSdkBlock(opts = {}) {
    const block = document.createElement('cr-sdk-block');
    block.variant = opts.variant || 'muted';
    block.label = opts.label || '';
    block.name = opts.name || '';
    block.paths = Array.isArray(opts.paths) ? opts.paths : [];
    block.open = opts.open === true;
    block.createdAt =
      typeof opts.createdAt === 'string' && opts.createdAt
        ? opts.createdAt
        : renderedRecordCreatedAt || new Date().toISOString();
    const seq = Number(opts.historySeq);
    block.historySeq = Number.isSafeInteger(seq) && seq > 0
      ? seq
      : (renderedRecordHistorySeq || 0);
    appendStreamChild(block, { skipTimeoutFinalize: opts.skipTimeoutFinalize === true });
    return block;
  }

  /**
   * Assistant answer block rendered as a regular cr-sdk-block.
   *
   * @returns {HTMLElement} host for the Markdown content
   */
  function createAssistantBlock() {
    const block = createSdkBlock({ variant: 'assistant', label: t('sdkView.answer'), open: true });
    block.speakable = true;
    block.forkable = true;
    applyDelegationArrows(block);
    const mdEl = document.createElement('div');
    mdEl.className = 'sdk-md sdk-rich-md sdk-rich-assistant-md';
    block.appendChild(mdEl);
    return mdEl;
  }

  /**
   * User message rendered as a regular cr-sdk-block.
   *
   * @param {string} textRaw
   * @param {string} [createdAt]
   * @returns {HTMLElement} the <cr-sdk-block> element
   */
  function createUserBlock(textRaw, createdAt = '') {
    const text = String(textRaw || '').trim();
    if (!text) return null;
    const block = createSdkBlock({ variant: 'user', label: t('sdkView.you'), open: true, createdAt });
    block.forkable = true;
    applyDelegationArrows(block);
    const textForDisplay = stripScreenshotMarkers(text);
    block.copyText = text;
    const body = document.createElement('div');
    body.className = 'sdk-rich-user-body';
    body.innerHTML = escapeHtml(textForDisplay).replace(/\r?\n/g, '<br/>');
    appendInlineImageThumbs(body, collectInlineImageRefs(text));
    block.appendChild(body);
    return block;
  }

  /**
   * Collapsed block for compressed conversation context seeded after reset.
   *
   * @param {string} summaryRaw
   * @param {string} [createdAt]
   * @returns {HTMLElement}
   */
  function createContextSeedBlock(summaryRaw, createdAt = '') {
    const summary = String(summaryRaw || '').trim();
    const block = createSdkBlock({
      variant: 'muted',
      label: t('sdkView.contextCompressed'),
      open: false,
      createdAt,
    });
    block.classList.add('sdk-rich-block--context-seed');
    block.copyText = summary;
    const body = document.createElement('div');
    body.className = 'sdk-rich-context-seed-body';
    body.innerHTML = escapeHtml(summary).replace(/\r?\n/g, '<br/>');
    block.appendChild(body);
    return block;
  }

  function inheritedPromptDisplayLabel(kind) {
    if (kind === 'analyze') return t('chat.monitorAgentDisplayPrompt');
    if (kind === 'handoff') return t('chat.harnessHandoffDisplayText');
    return t('chat.forkContinueDisplayText');
  }

  /**
   * Text shown in the user bubble (unwraps compressed context and fork/handoff wrappers).
   *
   * @param {unknown} textRaw
   * @returns {string}
   */
  function resolveVisibleUserPromptText(textRaw) {
    const parsed = parseContextSeedPayload(textRaw);
    if (parsed.hasSeed) return parsed.userText.trim();
    const inherited = parseInheritedPrompt(textRaw);
    if (!inherited.wrapped) return String(textRaw || '').trim();
    if (inherited.kind === 'analyze') return inheritedPromptDisplayLabel('analyze');
    if (inherited.followUp) return inherited.followUp;
    return inheritedPromptDisplayLabel(inherited.kind);
  }

  /**
   * Render a user turn, splitting compressed context from the visible user message.
   *
   * @param {string} textRaw
   * @param {string} [createdAt]
   * @returns {string} user text used for dedupe / queue matching
   */
  function renderUserTurn(textRaw, createdAt = '') {
    const parsed = parseContextSeedPayload(textRaw);
    if (parsed.hasSeed) {
      if (parsed.summary.trim()) createContextSeedBlock(parsed.summary.trim(), createdAt);
      const userText = parsed.userText.trim();
      if (userText) createUserBlock(userText, createdAt);
      return userText;
    }
    const inherited = parseInheritedPrompt(textRaw);
    if (inherited.wrapped) {
      const label = inheritedPromptDisplayLabel(inherited.kind);
      if (!findUserBlockByText(label)) createUserBlock(label, createdAt);
      if (
        inherited.kind !== 'analyze' &&
        inherited.followUp &&
        !findUserBlockByText(inherited.followUp)
      ) {
        createUserBlock(inherited.followUp, createdAt);
      }
      const echo = inherited.kind === 'analyze' ? label : inherited.followUp || label;
      chat._sdkLastLocalUserEcho = echo;
      return echo;
    }
    const text = String(textRaw || '').trim();
    if (!text) return '';
    if (findUserBlockByText(text)) {
      chat._sdkLastLocalUserEcho = text;
      return text;
    }
    createUserBlock(text, createdAt);
    return text;
  }

  /**
   * Renders one conversation turn (history/API or a restored plaintext buffer).
   *
   * @param {boolean} isUser
   * @param {string} textRaw
   */
  function emitHistoryTurn(isUser, textRaw) {
    const text = String(textRaw || '').trim();
    if (!text) return;

    resetSdkStreamState(chat);
    clearSegmentPointers();

    if (isUser) {
      renderUserTurn(text);
      scrollToBottom();
      return;
    }

    const mdEl = createAssistantBlock();
    flushMarkdown(mdEl, text);
  }

  /**
   * @param {Record<string, unknown>} ev
   */
  function renderOpenCodeQuestion(ev) {
    stopTimeoutProgressSeries();
    const requestId = typeof ev.requestId === 'string' ? ev.requestId.trim() : '';
    const questions = Array.isArray(ev.questions) ? ev.questions : [];
    if (!requestId || questions.length === 0) return;
    const block = createSdkBlock({
      variant: 'question',
      label: t('sdkView.openCodeQuestion'),
      name: 'question',
      open: true,
    });
    block.dataset.requestId = requestId;
    block.classList.add('sdk-rich-opencode-question');
    const body = document.createElement('div');
    body.className = 'sdk-rich-opencode-question-body';
    /** @type {Array<Array<string>>} */
    const answers = questions.map(() => []);
    questions.forEach((rawQuestion, questionIndex) => {
      if (!rawQuestion || typeof rawQuestion !== 'object') return;
      const item = /** @type {Record<string, unknown>} */ (rawQuestion);
      const section = document.createElement('section');
      section.className = 'sdk-rich-opencode-question-item';
      const header = document.createElement('h4');
      header.className = 'sdk-rich-opencode-question-header';
      header.textContent = typeof item.header === 'string' && item.header.trim()
        ? item.header.trim()
        : t('sdkView.questionNumbered', { n: questionIndex + 1 });
      section.appendChild(header);
      const prompt = document.createElement('p');
      prompt.className = 'sdk-rich-opencode-question-text';
      prompt.textContent = typeof item.question === 'string' ? item.question : '';
      section.appendChild(prompt);
      const optionsWrap = document.createElement('div');
      optionsWrap.className = 'sdk-rich-opencode-question-options';
      const options = Array.isArray(item.options) ? item.options : [];
      const multiple = item.multiple === true;
      options.forEach((rawOption) => {
        if (!rawOption || typeof rawOption !== 'object') return;
        const option = /** @type {Record<string, unknown>} */ (rawOption);
        const label = typeof option.label === 'string' ? option.label.trim() : '';
        if (!label) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sdk-rich-opencode-question-option';
        button.textContent = label;
        const description = typeof option.description === 'string' ? option.description.trim() : '';
        if (description) button.title = description;
        button.addEventListener('click', () => {
          if (multiple) {
            const idx = answers[questionIndex].indexOf(label);
            if (idx >= 0) {
              answers[questionIndex].splice(idx, 1);
              button.classList.remove('is-selected');
            } else {
              answers[questionIndex].push(label);
              button.classList.add('is-selected');
            }
            return;
          }
          answers[questionIndex] = [label];
          optionsWrap.querySelectorAll('.sdk-rich-opencode-question-option').forEach((el) => {
            el.classList.toggle('is-selected', el === button);
          });
        });
        optionsWrap.appendChild(button);
      });
      section.appendChild(optionsWrap);
      if (item.custom === true) {
        const customInput = document.createElement('input');
        customInput.type = 'text';
        customInput.className = 'sdk-rich-opencode-question-custom';
        customInput.placeholder = t('sdkView.customAnswerPlaceholder');
        customInput.addEventListener('input', () => {
          const value = customInput.value.trim();
          if (!value) return;
          if (multiple) {
            const withoutCustom = answers[questionIndex].filter((entry) => options.some((raw) => {
              if (!raw || typeof raw !== 'object') return false;
              return String(/** @type {Record<string, unknown>} */ (raw).label || '').trim() === entry;
            }));
            answers[questionIndex] = [...withoutCustom, value];
            return;
          }
          answers[questionIndex] = [value];
          optionsWrap.querySelectorAll('.sdk-rich-opencode-question-option').forEach((el) => {
            el.classList.remove('is-selected');
          });
        });
        section.appendChild(customInput);
      }
      body.appendChild(section);
    });
    const actions = document.createElement('div');
    actions.className = 'sdk-rich-opencode-question-actions';
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'sdk-rich-opencode-question-submit';
    submitBtn.textContent = t('sdkView.submitAnswer');
    submitBtn.addEventListener('click', () => {
      if (typeof hooks.onOpenCodeQuestionReply !== 'function') return;
      const normalized = answers.map((entry) => entry.filter(Boolean));
      if (normalized.some((entry) => entry.length === 0)) return;
      hooks.onOpenCodeQuestionReply({ requestId, answers: normalized });
      block.classList.add('sdk-rich-opencode-question--answered');
      submitBtn.disabled = true;
      rejectBtn.disabled = true;
    });
    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'sdk-rich-opencode-question-reject';
    rejectBtn.textContent = t('sdkView.rejectAnswer');
    rejectBtn.addEventListener('click', () => {
      if (typeof hooks.onOpenCodeQuestionReply !== 'function') return;
      hooks.onOpenCodeQuestionReply({ requestId, reject: true });
      block.classList.add('sdk-rich-opencode-question--rejected');
      submitBtn.disabled = true;
      rejectBtn.disabled = true;
    });
    actions.appendChild(submitBtn);
    actions.appendChild(rejectBtn);
    body.appendChild(actions);
    block.appendChild(body);
    openCodeQuestionByRequestId.set(requestId, block);
    scrollToBottom();
    persistThisSdkEvent(ev);
  }

  /**
   * @param {Record<string, unknown>} ev
   */
  function renderOpenCodePermission(ev) {
    stopTimeoutProgressSeries();
    const requestId = typeof ev.requestId === 'string' ? ev.requestId.trim() : '';
    const action = typeof ev.action === 'string' ? ev.action.trim() : 'Permission required';
    if (!requestId) return;
    const block = createSdkBlock({
      variant: 'question',
      label: t('sdkView.openCodePermission'),
      name: action === 'Permission required' ? '' : action,
      open: true,
    });
    block.dataset.requestId = requestId;
    block.classList.add('sdk-rich-opencode-permission');
    const body = document.createElement('div');
    body.className = 'sdk-rich-opencode-permission-body';
    const title = document.createElement('p');
    title.className = 'sdk-rich-opencode-permission-text';
    title.textContent = action;
    body.appendChild(title);
    const resources = Array.isArray(ev.resources) ? ev.resources : [];
    if (resources.length > 0) {
      const list = document.createElement('ul');
      list.className = 'sdk-rich-opencode-permission-resources';
      resources.forEach((entry) => {
        if (typeof entry !== 'string' || !entry.trim()) return;
        const li = document.createElement('li');
        li.textContent = entry.trim();
        list.appendChild(li);
      });
      body.appendChild(list);
    }
    const actions = document.createElement('div');
    actions.className = 'sdk-rich-opencode-permission-actions';
    const replyButtons = [
      { reply: 'once', label: 'Once', className: 'sdk-rich-opencode-permission-once' },
      { reply: 'always', label: 'Always', className: 'sdk-rich-opencode-permission-always' },
      { reply: 'reject', label: 'Reject', className: 'sdk-rich-opencode-permission-reject' },
    ];
    replyButtons.forEach(({ reply, label, className }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.textContent = label;
      button.addEventListener('click', () => {
        if (typeof hooks.onOpenCodePermissionReply !== 'function') return;
        hooks.onOpenCodePermissionReply({ requestId, reply });
        block.classList.add('sdk-rich-opencode-permission--answered');
        actions.querySelectorAll('button').forEach((el) => {
          el.disabled = true;
        });
      });
      actions.appendChild(button);
    });
    body.appendChild(actions);
    block.appendChild(body);
    openCodePermissionByRequestId.set(requestId, block);
    scrollToBottom();
    persistThisSdkEvent(ev);
  }

  /**
   * @param {unknown} event
   */
  function applySdkEventCore(event) {
    if (!event || typeof event !== 'object') return;
    const ev = /** @type {Record<string, unknown>} */ (event);
    const eventType = typeof ev.type === 'string' ? ev.type.toLowerCase() : '';

    if (eventType === 'user') {
      stopTimeoutProgressSeries();
      runScope += 1;
      resumeThinkingAfterStreamReset = false;
      resumeAssistantAfterStreamReset = false;
      resetSdkStreamState(chat);
      clearSegmentPointers();
      const plain = extractUserPlain(ev);
      const inherited = parseInheritedPrompt(plain);
      const userEchoKey = resolveVisibleUserPromptText(plain);
      if (userEchoKey === chat._sdkLastLocalUserEcho && !inherited.wrapped) {
        scrollToBottom();
        return;
      }
      if (findUserBlockByText(userEchoKey) && !inherited.followUp) {
        chat._sdkLastLocalUserEcho = userEchoKey;
        scrollToBottom();
        return;
      }
      if (!suppressHooksPlain) hooks.appendPlain(`\n[user] ${userEchoKey}\n`);
      renderUserTurn(plain);
      scrollToBottom();
      persistThisSdkEvent(ev);
      return;
    }

    if (eventType === 'assistant') {
      if (isHarnessErrorAssistantText(extractAssistantPlainText(ev))) return;
      stopTimeoutProgressSeries();
      if (activeKind === 'thinking') {
        delete chat._sdkThinkingAcc;
        const thinkingRunKey = activeThinkingRunKey || getEventRunKey(ev);
        const shouldKeepThinkingOpen = hasRunningSdkTools(runningToolCallsByRun, thinkingRunKey);
        if (shouldKeepThinkingOpen) {
          syncThinkingBlockRunning(thinkingRunKey);
          if (thinkingDetails) thinkingDetails.open = true;
        } else {
          setThinkingRunning(false);
          if (thinkingDetails) thinkingDetails.open = false;
        }
        thinkingDetails = null;
        thinkingPre = null;
        activeThinkingRunKey = '';
      }
      // A new answer block must start from a clean accumulator.
      if (!assistantMdEl) {
        const reused = resolveAssistantBlockAfterReset();
        if (reused) {
          adoptAssistantBlock(reused);
        } else {
          delete chat._sdkAssistantAcc;
        }
      }
      activeKind = 'assistant';
      const full = extractAssistantPlainText(ev);
      const assistantPrev = typeof chat._sdkAssistantAcc === 'string' ? chat._sdkAssistantAcc : '';
      const thinkingAcc = typeof chat._sdkThinkingAcc === 'string' ? chat._sdkThinkingAcc : '';
      const projectedAssistant = projectStreamAccumulator(assistantPrev, full);
      if (thinkingAcc && textsOverlap(thinkingAcc, projectedAssistant)) {
        return;
      }
      const delta = takeStreamDelta(chat, '_sdkAssistantAcc', full);
      if (delta && !suppressHooksPlain) hooks.appendPlain(delta);

      if (!assistantMdEl) {
        assistantMdEl = createAssistantBlock();
      }
      const acc = typeof chat._sdkAssistantAcc === 'string' ? chat._sdkAssistantAcc : '';
      const split = splitTrailingTitleJson(acc);
      const display = split.title ? split.text : acc;
      if (split.title && !display.trim()) {
        assistantMdEl.closest('cr-sdk-block')?.remove();
        assistantMdEl = null;
      } else if (mdRenderImmediate) {
        flushMarkdown(assistantMdEl, display);
      } else {
        scheduleMd(assistantMdEl, display);
      }
      if (split.title && typeof hooks.onFinishTitle === 'function') {
        hooks.onFinishTitle(split.title);
      }
      persistSdkStreamSnapshot(ev, 'assistant', acc);
      // Replayed history must stay silent — only live answers are read aloud.
      if (!suppressHistoryPersist && typeof hooks.onAssistantText === 'function') {
        hooks.onAssistantText(display);
      }
      return;
    }

    if (eventType === 'thinking') {
      stopTimeoutProgressSeries();
      if (activeKind === 'assistant') {
        delete chat._sdkAssistantAcc;
        assistantMdEl = null;
      }
      activeKind = 'thinking';
      const runKey = getEventRunKey(ev);
      if (!thinkingDetails) {
        const reused = resolveThinkingBlockForRun(runKey);
        if (reused) {
          adoptThinkingBlock(reused, runKey);
        } else {
          delete chat._sdkThinkingAcc;
          thinkingDetails = createSdkBlock({ variant: 'thinking', label: t('sdkView.thinking'), open: true });
          thinkingPre = document.createElement('pre');
          thinkingPre.className = 'sdk-rich-thinking-pre';
          thinkingDetails.appendChild(thinkingPre);
          thinkingDetails.running = !suppressHistoryPersist;
        }
      }
      activeThinkingRunKey = runKey;
      const full = typeof ev.text === 'string' ? ev.text : '';
      const truncated = full.length > 12000 ? `${full.slice(0, 12000)}…` : full;
      const assistantAcc = typeof chat._sdkAssistantAcc === 'string' ? chat._sdkAssistantAcc : '';
      const thinkingPrev = typeof chat._sdkThinkingAcc === 'string' ? chat._sdkThinkingAcc : '';
      const projectedThinking = projectStreamAccumulator(thinkingPrev, truncated);
      if (assistantAcc && textsOverlap(assistantAcc, projectedThinking)) {
        return;
      }
      const delta = takeStreamDelta(chat, '_sdkThinkingAcc', truncated);
      if (delta && !suppressHooksPlain) hooks.appendPlain(delta);

      rememberThinkingBlock(runKey, thinkingDetails);
      if (thinkingPre) {
        const stickThinking = isScrollableNearBottom(thinkingPre);
        thinkingPre.textContent = typeof chat._sdkThinkingAcc === 'string' ? chat._sdkThinkingAcc : '';
        if (stickThinking) stickScrollToBottom(thinkingPre);
      }
      scrollToBottom();
      persistSdkStreamSnapshot(ev, 'thinking', typeof chat._sdkThinkingAcc === 'string' ? chat._sdkThinkingAcc : '');
      return;
    }

    if (eventType === 'tool_call') {
      stopTimeoutProgressSeries();
      if (isEmptyGenericSdkToolEvent(ev)) {
        const ghostRunKey = getEventRunKey(ev);
        const ghostStatus = typeof ev.status === 'string' ? ev.status : '';
        if (isTerminalSdkToolStatus(ghostStatus)) {
          applyStatusToLatestOpenTool(ghostRunKey, ghostStatus);
        }
        return;
      }
      delete chat._sdkAssistantAcc;
      assistantMdEl = null;
      activeKind = 'idle';

      const incomingName = typeof ev.name === 'string' ? ev.name.trim() : '';
      const incomingStatus = typeof ev.status === 'string' ? ev.status : '';
      const runKey = getEventRunKey(ev);
      const callId = resolveSdkToolCallId(ev, buildStableSdkToolCallFallback(ev, runKey));
      let record = toolByCallId.get(callId);
      const prevName = record?.event && typeof record.event.name === 'string'
        ? record.event.name.trim()
        : '';
      const genericIncoming = !incomingName || incomingName === '?' || incomingName.toLowerCase() === 'tool';
      const name = genericIncoming && prevName ? prevName : (incomingName || prevName || '?');
      const nameLower = name.toLowerCase();
      const compactName = nameLower.replace(/[^a-z0-9]/g, '');
      if (compactName === 'createplan') {
        const planText = extractPlanTextFromSdkEvent(ev);
        let block = planByCallId.get(callId);
        if (!block) {
          block = createSdkBlock();
          block.dataset.callId = callId;
          planByCallId.set(callId, block);
        }
        block.variant = 'plan';
        block.label = incomingStatus || 'plan';
        block.name = t('sdkView.implementationPlan');
        block.open = true;

        let mdEl = block.querySelector('.sdk-rich-plan-md');
        if (!mdEl) {
          mdEl = document.createElement('div');
          mdEl.className = 'sdk-md sdk-rich-md sdk-rich-plan-md';
          block.replaceChildren(mdEl);
        }
        flushMarkdown(mdEl, planText || stringifySnippet(ev.result, 8000) || stringifySnippet(ev.args, 4000));
        scrollToBottom();
        persistThisSdkEvent(ev);
        return;
      }

      const prevStatus =
        record && record.event && typeof record.event.status === 'string' ? record.event.status : '';
      let status = shouldAcceptSdkToolStatus(prevStatus, incomingStatus)
        ? incomingStatus
        : prevStatus;
      const prevArgs = record?.event?.args && typeof record.event.args === 'object'
        ? /** @type {Record<string, unknown>} */ (record.event.args)
        : null;
      const incomingArgs = ev.args && typeof ev.args === 'object' && !Array.isArray(ev.args)
        ? /** @type {Record<string, unknown>} */ (ev.args)
        : null;
      const args = incomingArgs && Object.keys(incomingArgs).length > 0 ? incomingArgs : prevArgs;
      let result = ev.result !== undefined ? ev.result : record?.event?.result;
      if (isToolSearchName(name) && args) {
        result = formatToolSearchResult(args, result);
      }
      if (
        isToolSearchName(name)
        && isFailedToolSearchResult(result)
        && shouldAcceptSdkToolStatus(status, 'error')
      ) {
        status = 'error';
      }
      const evForUi = {
        ...(status === incomingStatus ? ev : { ...ev, status }),
        name,
        args,
        result,
        status,
      };
      const filePaths = pathsFromToolArgs(args);
      const searchQuery = parseToolSearchQuery(readToolSearchQuery(args));
      const paths = filePaths.length > 0 ? filePaths : (searchQuery ? [searchQuery] : []);
      if (!record) {
        const fullBlock = createSdkBlock({ variant: 'run', label: status || '?', name });
        fullBlock.dataset.callId = callId;
        fullBlock.classList.add('sdk-full-tool-block');
        fullToolBlocks.add(fullBlock);
        record = createCompactToolRecord(callId, fullBlock, evForUi, paths, runKey);
        toolByCallId.set(callId, record);
      }

      record.fullBlock.variant = resolveToolBlockVariant(status);
      record.fullBlock.label = status || '?';
      record.fullBlock.name = name;
      record.fullBlock.paths = paths;
      record.fullBlock.open = status === 'running' || (isToolSearchName(name) && status === 'error');
      record.fullBlock.replaceChildren(createToolBody(evForUi));
      record.fullBlock.hidden = uiMode === 'compact';
      updateCompactToolTile(record, evForUi, paths);
      updateRunningSdkToolState(runningToolCallsByRun, runKey, prevStatus, status);
      syncThinkingBlockRunning(runKey);

      scrollToBottom();
      persistThisSdkEvent(evForUi);
      return;
    }

    if (eventType === 'status') {
      const st = typeof ev.status === 'string' ? ev.status : '';
      // A run announcing itself as running is not the agent's first output. Ending the waiting
      // block here stops its spinner seconds before anything actually arrives — and the status
      // line is hidden in compact mode, so the indicator would die with no visible cause.
      const keepWaiting = !isTerminalSdkRunStatus(st);
      if (!keepWaiting) stopTimeoutProgressSeries();
      const msg = typeof ev.message === 'string' ? ev.message : '';
      const runKey = getEventRunKey(ev);
      runStatusByRun.set(runKey, st);
      const tray = latestTrayByRun.get(runKey);
      if (tray) setTrayStatus(tray, st);
      if (isTerminalSdkRunStatus(st)) {
        finalizeOpenToolCalls(runKey, st);
      }
      lineMeta(
        'sdk-rich-line--status',
        `<span class="sdk-rich-badge sdk-rich-badge--status">${escapeHtml(st)}</span> ${escapeHtml(msg)}`,
        '',
        true,
        keepWaiting
      );
      persistThisSdkEvent(ev);
      return;
    }

    if (eventType === 'system') {
      stopTimeoutProgressSeries();
      lineMeta('sdk-rich-line--muted', '<span class="sdk-rich-badge">system</span>', '', true);
      persistThisSdkEvent(ev);
      return;
    }

    if (eventType === 'task') {
      stopTimeoutProgressSeries();
      const tx = typeof ev.text === 'string' ? ev.text : '';
      lineMeta(
        'sdk-rich-line--task',
        `<span class="sdk-rich-badge">task</span> ${escapeHtml(tx)}`,
        '',
        true
      );
      persistThisSdkEvent(ev);
      return;
    }

    if (eventType === 'request') {
      stopTimeoutProgressSeries();
      lineMeta(
        'sdk-rich-line--warn',
        `<span class="sdk-rich-badge sdk-rich-badge--warn">Request</span> ${escapeHtml(t('sdkView.userActionRequired'))}`
      );
      persistThisSdkEvent(ev);
      return;
    }

    if (eventType === 'opencode_question') {
      renderOpenCodeQuestion(ev);
      return;
    }

    if (eventType === 'opencode_permission') {
      renderOpenCodePermission(ev);
      return;
    }

    delete chat._sdkAssistantAcc;
    stopTimeoutProgressSeries();
    assistantMdEl = null;
    activeKind = 'idle';
    const rawLabel = eventType ? String(eventType) : 'sdk';
    const rawJson = stringifySnippet(ev, 6000);
    const block = createSdkBlock({ variant: 'muted', label: rawLabel, name: t('sdkView.sdkEvent') });
    if (rawJson) {
      const body = document.createElement('div');
      body.innerHTML = `<details class="sdk-rich-nested"><summary>${escapeHtml(t('sdkView.arguments'))}</summary><pre class="sdk-rich-json">${escapeHtml(rawJson)}</pre></details>`;
      block.appendChild(body);
    }
    if (eventType === 'usage') {
      const runKey = getEventRunKey(ev);
      const callId = `usage-${runKey}`;
      const compactEvent = {
        ...ev,
        type: 'tool_call',
        name: 'usage',
        status: 'completed',
        args: ev.usage ?? ev,
      };
      block.classList.add('sdk-full-tool-block');
      fullToolBlocks.add(block);
      block.hidden = uiMode === 'compact';
      const record = createCompactToolRecord(callId, block, compactEvent, [], runKey);
      toolByCallId.set(callId, record);
    }
    scrollToBottom();
    persistThisSdkEvent(ev);
  }

  function applySdkEvent(event, createdAt = '', historySeq = 0) {
    const previousCreatedAt = renderedRecordCreatedAt;
    const previousSeq = renderedRecordHistorySeq;
    renderedRecordCreatedAt =
      typeof createdAt === 'string' && createdAt.trim() ? createdAt : new Date().toISOString();
    renderedRecordHistorySeq = Number(historySeq) > 0 ? Number(historySeq) : 0;
    try {
      applySdkEventCore(event);
    } finally {
      renderedRecordCreatedAt = previousCreatedAt;
      renderedRecordHistorySeq = previousSeq;
    }
  }

  let lastHistoryErrorText = '';

  function applyHistoryRecord(record) {
    if (!record || typeof record !== 'object') return;
    const rec = /** @type {Record<string, unknown>} */ (record);
    const createdAt = typeof rec.createdAt === 'string' ? rec.createdAt : '';
    const historySeq = Number(rec.historySeq) > 0 ? Number(rec.historySeq) : 0;
    const previousSeq = renderedRecordHistorySeq;
    renderedRecordHistorySeq = historySeq;
    try {
    if (rec.kind === 'sdk' && rec.event != null && typeof rec.event === 'object') {
      applySdkEvent(rec.event, createdAt, historySeq);
      return;
    }
    if (rec.kind === 'localUser' && typeof rec.text === 'string') {
      const parsed = parseContextSeedPayload(rec.text);
      const inherited = parseInheritedPrompt(rec.text);
      const raw = normalizeUserPromptText(
        parsed.hasSeed ? parsed.userText : resolveVisibleUserPromptText(rec.text)
      );
      if (!raw) return;
      const idx = queuedUserBlocks.findIndex((item) => normalizeUserPromptText(item.text) === raw);
      if (idx >= 0) {
        const item = queuedUserBlocks.splice(idx, 1)[0];
        if (item?.block) {
          item.block.label = t('sdkView.you');
          item.block.classList.remove('sdk-rich-block--queued');
          item.block.queued = false;
          // The sent record carries the authoritative cut point for "fork from here".
          if (createdAt) item.block.createdAt = createdAt;
          if (historySeq) item.block.historySeq = historySeq;
          item.block.forkable = true;
          applyDelegationArrows(item.block);
          relabelQueuedBlocks();
          scrollToBottom();
          return;
        }
      }
      const existing = findUserBlockByText(raw);
      if (existing && !existing.queued && !inherited.followUp) {
        scrollToBottom();
        return;
      }
      renderUserTurn(rec.text, createdAt);
      scrollToBottom();
      return;
    }
    if (rec.kind !== 'meta') return;

    const variant = rec.variant;
    const payload = typeof rec.payload === 'string' ? rec.payload : '';
    if (variant === 'banner') {
      lineMeta(
        'sdk-rich-line--ok',
        `<span class="sdk-rich-badge sdk-rich-badge--ok">SDK</span> ${escapeHtml(t('sdkView.connected'))}`,
        createdAt
      );
    } else if (variant === 'runFinished') {
      setThinkingRunning(false);
      for (const block of listAllRunItems(thinkingBlocksByRun)) {
        if (block && typeof block === 'object' && 'running' in block) block.running = false;
      }
      for (const block of latestThinkingByRun.values()) {
        if (block && typeof block === 'object' && 'running' in block) block.running = false;
      }
      const latestRunKey = Array.from(latestTrayByRun.keys()).pop() || '';
      finalizeOpenToolCalls(latestRunKey, payload);
      const runTrays = listRunItems(traysByRun, latestRunKey);
      const trays = runTrays.length > 0
        ? runTrays
        : [latestTrayByRun.get(latestRunKey) || Array.from(latestTrayByRun.values()).pop()];
      for (const tray of trays) {
        if (tray) setTrayStatus(tray, payload || 'finished');
      }
      lineMeta(
        resolveRunFinishedLineClass(payload),
        `<strong>${escapeHtml(t('sdkView.runFinished'))}</strong> · ${escapeHtml(payload)}`,
        createdAt,
        true
      );
    } else if (variant === 'busy') {
      const busyText = payload == null ? '' : String(payload).trim();
      const busyBadge = `<span class="sdk-rich-badge sdk-rich-badge--warn">${escapeHtml(t('sdkView.busy'))}</span>`;
      const busyLine = busyText ? `${busyBadge} ${escapeHtml(busyText)}` : busyBadge;
      lineMeta('sdk-rich-line--warn', busyLine, createdAt);
    } else if (variant === 'queued') {
      const raw = normalizeUserPromptText(payload);
      if (!raw) return;
      if (queuedUserBlocks.some((item) => normalizeUserPromptText(item.text) === raw)) return;
      if (findUserBlockByText(raw)) return;
      createUserBlock(raw, createdAt);
      const lastBlock = stream.lastElementChild;
      if (lastBlock) {
        lastBlock.label = t('sdkView.youQueued');
        attachQueuedBlockActions(lastBlock, raw);
        queuedUserBlocks.push({ text: raw, block: lastBlock });
      }
    } else if (variant === 'queueRemoved') {
      const raw = normalizeUserPromptText(payload);
      const idx = queuedUserBlocks.findIndex((item) => normalizeUserPromptText(item.text) === raw);
      if (idx >= 0) {
        const item = queuedUserBlocks.splice(idx, 1)[0];
        item?.block?.remove();
        relabelQueuedBlocks();
      }
    } else if (variant === 'mode') {
      const modeLabel =
        payload === 'plan' ? 'Plan' : payload === 'ask' ? 'Ask' : payload === 'agent' ? 'Agent' : payload;
      if (modeLabel) {
        lineMeta(
          'sdk-rich-line--notice',
          `<span class="sdk-rich-badge sdk-rich-badge--status">${escapeHtml(t('sdkView.modeBadge'))}</span> ${escapeHtml(modeLabel)}`,
          createdAt
        );
      }
    } else if (variant === 'error') {
      lastHistoryErrorText = payload.trim();
      lineMeta(
        'sdk-rich-line--err',
        `<span class="sdk-rich-badge sdk-rich-badge--err">${escapeHtml(t('sdkView.error'))}</span> ${escapeHtml(payload)}`,
        createdAt
      );
    } else if (variant === 'notice') {
      const noticeText = payload.trim();
      if (noticeText && noticeText === lastHistoryErrorText) return;
      const progress =
        rec.progress && typeof rec.progress === 'object' ? rec.progress : null;
      handleMetaNotice(payload, { silent: true, progress });
    } else if (variant === 'contextSeed') {
      if (!payload.trim()) return;
      createContextSeedBlock(payload.trim(), createdAt);
    } else if (variant === 'delegation') {
      renderDelegationCard(payload, createdAt);
    } else if (variant === 'mailbox') {
      renderMailboxCard(payload, createdAt);
    } else if (variant === 'relatedChat') {
      renderRelatedChatCard(payload, createdAt);
    }
    } finally {
      renderedRecordHistorySeq = previousSeq;
    }
  }

  /**
   * @param {unknown} payload
   * @param {string} createdAt
   */
  function renderDelegationCard(payload, createdAt) {
    const data = parseDelegationHistoryPayload(payload);
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) return;
    const safeId = id.replace(/"/g, '');
    const status = String(data.status || '');
    const childChatId = String(data.childChatId || '');
    const executor = data.executor && typeof data.executor === 'object' ? data.executor : {};
    const executorLabel = [executor.transport, executor.model].filter(Boolean).join(' · ');
    const report = String(data.report || '').trim();
    const error = String(data.error || '').trim();
    const canCancel = status === 'queued' || status === 'starting' || status === 'running'
      || status === 'waiting_for_input' || status === 'cancelling';
    let card = stream.querySelector(`[data-delegation-id="${safeId}"]`);
    if (!(card instanceof HTMLElement)) {
      lineMeta('sdk-rich-line--ok sdk-rich-delegation', '', createdAt);
      card = stream.lastElementChild;
      if (card instanceof HTMLElement) card.dataset.delegationId = safeId;
    }
    if (!(card instanceof HTMLElement)) return;
    const content = card.querySelector('.sdk-rich-line__content');
    if (!(content instanceof HTMLElement)) return;
    const unverified = data.unverified !== false && status === 'completed' && !String(data.acknowledgedAt || '').trim()
      ? `<span class="sdk-rich-badge sdk-rich-badge--warn">${escapeHtml(t('chat.delegationUnverified'))}</span>`
      : '';
    const waiting = status === 'waiting_for_input'
      ? `<p>${escapeHtml(t('chat.delegationNeedsInput'))}</p>`
      : '';
    content.innerHTML = [
      `<strong>${escapeHtml(t('chat.delegationCardTitle'))}</strong>`,
      `<div>${escapeHtml(delegationStatusLabel(status))} ${unverified}</div>`,
      executorLabel ? `<div>${escapeHtml(executorLabel)}</div>` : '',
      waiting,
      error ? `<pre class="sdk-rich-delegation-report">${escapeHtml(error)}</pre>` : '',
      report ? `<pre class="sdk-rich-delegation-report">${escapeHtml(report)}</pre>` : '',
      `<div class="sdk-rich-delegation-actions"></div>`,
    ].filter(Boolean).join('');
    const actions = content.querySelector('.sdk-rich-delegation-actions');
    if (actions instanceof HTMLElement) {
      if (childChatId) {
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'sdk-rich-delegation-btn';
        openBtn.textContent = t('chat.delegationOpenChild');
        openBtn.addEventListener('click', () => {
          hooks.onOpenDelegationChat?.(childChatId);
        });
        actions.appendChild(openBtn);
      }
      if (canCancel && status !== 'cancelling') {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'sdk-rich-delegation-btn';
        cancelBtn.textContent = t('chat.delegationCancel');
        cancelBtn.addEventListener('click', () => {
          hooks.onCancelDelegation?.(id);
        });
        actions.appendChild(cancelBtn);
      }
      const acknowledged = Boolean(String(data.acknowledgedAt || '').trim());
      const canReview = !acknowledged && (
        status === 'completed' || status === 'failed' || status === 'interrupted'
      );
      if (canReview) {
        const ackBtn = document.createElement('button');
        ackBtn.type = 'button';
        ackBtn.className = 'sdk-rich-delegation-btn';
        ackBtn.textContent = t('chat.delegationAcknowledge');
        ackBtn.addEventListener('click', () => {
          hooks.onAcknowledgeDelegation?.(id);
        });
        actions.appendChild(ackBtn);
      }
    }
    scrollToBottom();
  }

  /**
   * @param {unknown} payload
   * @param {string} createdAt
   */
  function renderMailboxCard(payload, createdAt) {
    const data = parseDelegationHistoryPayload(payload);
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) return;
    const safeId = id.replace(/"/g, '');
    const kind = String(data.kind || 'reply');
    const status = String(data.status || '');
    const fromChatId = String(data.fromChatId || '');
    const body = String(data.body || '').trim();
    const queued = status === 'queued' || status === 'dispatching'
      ? `<span class="sdk-rich-badge sdk-rich-badge--warn">${escapeHtml(t('chat.mailboxQueued'))}</span>`
      : status === 'delivered'
        ? `<span class="sdk-rich-badge">${escapeHtml(t('chat.mailboxDelivered'))}</span>`
        : status === 'uncertain'
          ? `<span class="sdk-rich-badge sdk-rich-badge--warn">${escapeHtml(t('chat.mailboxUncertain'))}</span>`
          : '';
    let card = stream.querySelector(`[data-mailbox-id="${safeId}"]`);
    if (!(card instanceof HTMLElement)) {
      lineMeta('sdk-rich-line--ok sdk-rich-mailbox', '', createdAt);
      card = stream.lastElementChild;
      if (card instanceof HTMLElement) card.dataset.mailboxId = safeId;
    }
    if (!(card instanceof HTMLElement)) return;
    const content = card.querySelector('.sdk-rich-line__content');
    if (!(content instanceof HTMLElement)) return;
    const title = kind === 'task'
      ? t('chat.mailboxTaskFromParent')
      : t('chat.mailboxReplyFromChild');
    content.innerHTML = [
      `<strong>${escapeHtml(title)}</strong> ${queued}`,
      fromChatId ? `<div>${escapeHtml(t('chat.mailboxFromChat'))}: ${escapeHtml(fromChatId.slice(0, 8))}</div>` : '',
      body ? `<pre class="sdk-rich-delegation-report">${escapeHtml(body)}</pre>` : '',
      `<div class="sdk-rich-delegation-actions"></div>`,
    ].filter(Boolean).join('');
    const actions = content.querySelector('.sdk-rich-delegation-actions');
    if (actions instanceof HTMLElement && fromChatId) {
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'sdk-rich-delegation-btn';
      openBtn.textContent = kind === 'task' ? t('chat.delegationOpenParent') : t('chat.delegationOpenChild');
      openBtn.addEventListener('click', () => {
        hooks.onOpenDelegationChat?.(fromChatId);
      });
      actions.appendChild(openBtn);
    }
    scrollToBottom();
  }

  /**
   * @param {string} chatId
   * @returns {string}
   */
  function relatedChatDomId(chatId) {
    return String(chatId || '').replace(/"/g, '');
  }

  /**
   * @param {unknown} payload
   * @param {string} createdAt
   * @param {{ prepend?: boolean }} [opts]
   */
  function renderRelatedChatCard(payload, createdAt, opts = {}) {
    const data = parseRelatedChatPayload(payload);
    const chatId = data?.chatId || '';
    if (!chatId) return;
    const safeId = relatedChatDomId(chatId);
    let card = stream.querySelector(`[data-related-chat-id="${safeId}"]`);
    if (!(card instanceof HTMLElement)) {
      lineMeta('sdk-rich-line--notice sdk-rich-related-chat', '', createdAt);
      card = stream.lastElementChild;
      if (card instanceof HTMLElement) card.dataset.relatedChatId = safeId;
      if (opts.prepend === true && card instanceof HTMLElement && stream.firstChild !== card) {
        stream.insertBefore(card, stream.firstChild);
      }
    }
    if (!(card instanceof HTMLElement)) return;
    const content = card.querySelector('.sdk-rich-line__content');
    if (!(content instanceof HTMLElement)) return;
    const title = data.title || chatId.slice(0, 8);
    const label = data.role === 'parent'
      ? t('chat.relatedChatParent', { title })
      : t('chat.relatedChatChild', { title });
    content.replaceChildren();
    const textEl = document.createElement('strong');
    textEl.textContent = label;
    const actions = document.createElement('div');
    actions.className = 'sdk-rich-delegation-actions';
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'sdk-rich-delegation-btn';
    openBtn.textContent = t('chat.relatedChatOpen');
    openBtn.addEventListener('click', () => {
      hooks.onOpenDelegationChat?.(chatId);
    });
    actions.appendChild(openBtn);
    content.append(textEl, actions);
    scrollToBottom();
  }

  /**
   * Backfill missing parent/child links from chat metadata for older chats.
   *
   * @param {{
   *   parent?: { chatId: string, title?: string, reason?: string } | null,
   *   children?: Array<{ chatId: string, title?: string, reason?: string }>,
   * }} input
   */
  function ensureRelatedChatLinks(input = {}) {
    const parent = input.parent;
    if (parent?.chatId) {
      const existing = stream.querySelector(`[data-related-chat-id="${relatedChatDomId(parent.chatId)}"]`);
      if (!(existing instanceof HTMLElement)) {
        renderRelatedChatCard({
          role: 'parent',
          chatId: parent.chatId,
          title: parent.title || '',
          reason: parent.reason || '',
        }, '', { prepend: true });
      }
    }
    for (const child of Array.isArray(input.children) ? input.children : []) {
      if (!child?.chatId) continue;
      const existing = stream.querySelector(`[data-related-chat-id="${relatedChatDomId(child.chatId)}"]`);
      if (existing instanceof HTMLElement) continue;
      renderRelatedChatCard({
        role: 'child',
        chatId: child.chatId,
        title: child.title || '',
        reason: child.reason || '',
      }, '');
    }
  }

  /** @type {HTMLElement | null} */
  let contextAdvisoryEl = null;

  /**
   * Remove the inline context pressure advisory from the chat stream.
   */
  function removeContextAdvisory() {
    if (!contextAdvisoryEl) return;
    contextAdvisoryEl.remove();
    contextAdvisoryEl = null;
  }

  /**
   * Show or update the context pressure advisory as a normal chat stream block.
   *
   * @param {Record<string, unknown>} opts
   */
  function updateContextAdvisory(opts = {}) {
    const visible = opts.visible === true;
    if (!visible) {
      removeContextAdvisory();
      return;
    }
    const levelRaw = typeof opts.level === 'string' ? opts.level : 'warn';
    const level = levelRaw === 'critical' || levelRaw === 'danger' ? levelRaw : 'warn';
    const message = opts.message == null ? '' : String(opts.message);
    const actionLabel = opts.actionLabel == null ? '' : String(opts.actionLabel);
    const dismissLabel = opts.dismissLabel == null ? '' : String(opts.dismissLabel);
    if (!contextAdvisoryEl) {
      contextAdvisoryEl = document.createElement('div');
      contextAdvisoryEl.className = 'sdk-rich-context-advisory';
      stream.appendChild(contextAdvisoryEl);
    }
    contextAdvisoryEl.classList.remove('is-warn', 'is-danger', 'is-critical');
    contextAdvisoryEl.classList.add(`is-${level}`);
    contextAdvisoryEl.replaceChildren();
    const textEl = document.createElement('div');
    textEl.className = 'sdk-rich-context-advisory-text';
    textEl.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'sdk-rich-context-advisory-actions';
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'sdk-rich-context-advisory-action';
    actionBtn.textContent = actionLabel;
    actionBtn.addEventListener('click', () => {
      if (typeof opts.onSummarize === 'function') opts.onSummarize();
    });
    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'sdk-rich-context-advisory-dismiss';
    dismissBtn.textContent = dismissLabel;
    dismissBtn.addEventListener('click', () => {
      removeContextAdvisory();
      if (typeof opts.onDismiss === 'function') opts.onDismiss();
    });
    actions.appendChild(actionBtn);
    actions.appendChild(dismissBtn);
    contextAdvisoryEl.appendChild(textEl);
    contextAdvisoryEl.appendChild(actions);
    stream.appendChild(contextAdvisoryEl);
    scrollToBottom({ force: true });
  }

  /**
   * Runs `fn` with a blank renderer state, then restores the live one.
   *
   * applyHistoryRecord is stateful: it keeps segment pointers and per-run maps that describe the
   * currently rendered tail. Older records are a self-contained prefix, so they must render from
   * scratch without clobbering that state.
   *
   * @param {() => void} fn
   */
  function withIsolatedRenderState(fn) {
    const scalars = {
      assistantMdEl,
      thinkingDetails,
      thinkingPre,
      activeKind,
      activeThinkingRunKey,
      runScope,
      timeoutProgressSeries,
      timeoutProgressTickTimer,
      renderedRecordCreatedAt,
      renderedRecordHistorySeq,
    };
    // Run-scoped state only. compactTrayHosts / fullToolBlocks / compactStatusLines are left
    // alone on purpose: they register DOM nodes that get toggled when the UI mode changes, and
    // the nodes rendered here end up in the real stream — dropping them would freeze the
    // prepended history in whatever mode was active when it loaded.
    /** @type {Array<Map<unknown, unknown> | Set<unknown>>} */
    const collections = [
      toolByCallId,
      planByCallId,
      openCodeQuestionByRequestId,
      openCodePermissionByRequestId,
      latestThinkingByRun,
      latestTrayByRun,
      thinkingBlocksByRun,
      traysByRun,
      runStatusByRun,
      runningToolCallsByRun,
    ];
    const snapshots = collections.map((c) => (c instanceof Map ? new Map(c) : new Set(c)));
    const queuedSnapshot = queuedUserBlocks.slice();

    collections.forEach((c) => c.clear());
    queuedUserBlocks.length = 0;
    assistantMdEl = null;
    thinkingDetails = null;
    thinkingPre = null;
    activeKind = 'idle';
    activeThinkingRunKey = '';
    runScope += 1;
    timeoutProgressSeries = null;
    timeoutProgressTickTimer = 0;

    try {
      fn();
    } finally {
      // A ticker started while rendering the prefix would outlive its (offscreen) block.
      if (timeoutProgressTickTimer) clearInterval(timeoutProgressTickTimer);
      collections.forEach((c, index) => {
        c.clear();
        const snapshot = snapshots[index];
        if (c instanceof Map && snapshot instanceof Map) {
          snapshot.forEach((value, key) => /** @type {Map<unknown, unknown>} */ (c).set(key, value));
        } else if (c instanceof Set && snapshot instanceof Set) {
          snapshot.forEach((value) => /** @type {Set<unknown>} */ (c).add(value));
        }
      });
      queuedUserBlocks.length = 0;
      queuedUserBlocks.push(...queuedSnapshot);
      assistantMdEl = scalars.assistantMdEl;
      thinkingDetails = scalars.thinkingDetails;
      thinkingPre = scalars.thinkingPre;
      activeKind = scalars.activeKind;
      activeThinkingRunKey = scalars.activeThinkingRunKey;
      runScope = scalars.runScope;
      timeoutProgressSeries = scalars.timeoutProgressSeries;
      timeoutProgressTickTimer = scalars.timeoutProgressTickTimer;
      renderedRecordCreatedAt = scalars.renderedRecordCreatedAt;
      renderedRecordHistorySeq = scalars.renderedRecordHistorySeq;
    }
  }

  /**
   * True for records that open a user turn — a safe cut point between history pages,
   * so a tool call and its result never land on opposite sides of the boundary.
   *
   * @param {unknown} record
   * @returns {boolean}
   */
  function isUserTurnBoundary(record) {
    if (!record || typeof record !== 'object') return false;
    const rec = /** @type {Record<string, unknown>} */ (record);
    if (rec.kind === 'localUser') return true;
    if (rec.kind !== 'sdk') return false;
    const event = /** @type {Record<string, unknown> | null} */ (rec.event);
    return !!event && String(event.type || '').toLowerCase() === 'user';
  }

  /**
   * Renders older records above the current stream, keeping the viewport visually anchored.
   *
   * @param {unknown[]} records
   * @returns {number} number of records rendered
   */
  function prependHistoryRecordsImpl(records) {
    if (!Array.isArray(records) || records.length === 0) return 0;
    const offscreen = document.createElement('div');
    offscreen.className = 'sdk-rich-stream';

    const previousStream = stream;
    const previousSuppressPlain = suppressHooksPlain;
    const previousSuppressPersist = suppressHistoryPersist;
    const previousMdImmediate = mdRenderImmediate;
    stream = offscreen;
    suppressHooksPlain = true;
    suppressHistoryPersist = true;
    mdRenderImmediate = true;
    suppressAutoScroll = true;
    try {
      withIsolatedRenderState(() => {
        for (const record of records) applyHistoryRecord(record);
      });
    } finally {
      stream = previousStream;
      suppressHooksPlain = previousSuppressPlain;
      suppressHistoryPersist = previousSuppressPersist;
      mdRenderImmediate = previousMdImmediate;
      suppressAutoScroll = false;
    }

    if (offscreen.childElementCount === 0) return 0;
    const heightBefore = mountEl.scrollHeight;
    const scrollBefore = mountEl.scrollTop;
    suppressScrollStickUpdate = true;
    try {
      realStream.prepend(...Array.from(offscreen.childNodes));
      mountEl.scrollTop = scrollBefore + (mountEl.scrollHeight - heightBefore);
    } finally {
      requestAnimationFrame(() => {
        suppressScrollStickUpdate = false;
      });
    }
    return records.length;
  }

  async function replayHistoryRecordsChunkedImpl(records, startIndex = 0) {
    if (!Array.isArray(records) || records.length <= startIndex) return;
    suppressHooksPlain = true;
    suppressHistoryPersist = true;
    mdRenderImmediate = true;
    try {
      for (let index = startIndex; index < records.length; index += 1) {
        applyHistoryRecord(records[index]);
        if ((index - startIndex + 1) % 8 === 0) {
          await new Promise((resolve) => {
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
            else setTimeout(resolve, 0);
          });
        }
      }
    } finally {
      suppressHooksPlain = false;
      suppressHistoryPersist = false;
      mdRenderImmediate = false;
      scrollToBottom({ force: true });
    }
  }

  let hasOlderHistory = false;
  let isLoadingOlderHistory = false;
  /** @type {IntersectionObserver | null} */
  let historyTopObserver = null;
  /** Records trimmed off the oldest edge of a page so it starts on a user turn. */
  let bufferedOlderRecords = [];
  /**
   * Bumped on every (dis)arming. A page fetched under an older token belongs to a paging
   * session that no longer exists — applying it would resurrect a dead sentinel state
   * (notably `error` over `hidden`), leaving a retry button that can never load anything.
   */
  let historyArmToken = 0;

  /**
   * `idle` keeps the sentinel rendered but empty — it must have a box for IntersectionObserver
   * to ever report it; `hidden` is only for chats with nothing older to load.
   *
   * @param {'hidden'|'idle'|'loading'|'error'|'start'} state
   */
  function renderHistoryTopState(state) {
    historyTopEl.replaceChildren();
    historyTopEl.dataset.state = state;
    historyTopEl.hidden = state === 'hidden';
    if (state === 'hidden' || state === 'idle') return;
    if (state === 'error') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'sdk-rich-history-top-retry';
      retry.textContent = t('sdkView.loadOlderFailed');
      retry.addEventListener('click', () => void retryOlderHistoryPage());
      historyTopEl.appendChild(retry);
      return;
    }
    if (state === 'loading') {
      const spinner = document.createElement('span');
      spinner.className = 'sdk-rich-history-top-spinner';
      historyTopEl.appendChild(spinner);
    }
    const label = document.createElement('span');
    label.className = 'sdk-rich-history-top-label';
    label.textContent = state === 'loading' ? t('sdkView.loadingOlder') : t('sdkView.historyStart');
    historyTopEl.appendChild(label);
  }

  function disconnectHistoryTopObserver() {
    if (!historyTopObserver) return;
    historyTopObserver.disconnect();
    historyTopObserver = null;
  }

  function ensureHistoryTopObserver() {
    if (historyTopObserver) return;
    if (typeof IntersectionObserver !== 'function') return;
    historyTopObserver = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        void loadOlderHistoryPage();
      },
      { root: mountEl, rootMargin: '200px 0px 0px 0px' },
    );
    historyTopObserver.observe(historyTopEl);
  }

  /**
   * Re-observes the sentinel to force a fresh intersection report. Without it a sentinel that
   * stays visible after a page (short conversation, tall viewport) would never fire again,
   * because the observer only reports transitions.
   */
  function refreshHistoryTopObserver() {
    if (!historyTopObserver) return;
    historyTopObserver.unobserve(historyTopEl);
    historyTopObserver.observe(historyTopEl);
  }

  /**
   * Splits a page so the rendered part starts on a user turn; the older remainder waits
   * for the next page instead of showing a run without its opening prompt.
   *
   * @param {unknown[]} records
   * @returns {{ buffered: unknown[], renderable: unknown[] }}
   */
  function splitPageAtUserTurn(records) {
    const boundary = records.findIndex((record) => isUserTurnBoundary(record));
    if (boundary <= 0) return { buffered: [], renderable: records };
    return { buffered: records.slice(0, boundary), renderable: records.slice(boundary) };
  }

  function finishOlderHistory() {
    disconnectHistoryTopObserver();
    renderHistoryTopState('start');
  }

  /**
   * The error state is only ever rendered while a page was owed, so a cleared `hasOlderHistory`
   * means the paging state was lost (e.g. the view got disarmed mid-flight), not that history
   * ended. Re-arm before retrying; a genuinely exhausted log answers with an empty page and the
   * sentinel settles on `start`.
   */
  function retryOlderHistoryPage() {
    if (isLoadingOlderHistory) return undefined;
    const canFetch = typeof hooks.loadOlderHistory === 'function';
    if (!hasOlderHistory && bufferedOlderRecords.length === 0 && canFetch) hasOlderHistory = true;
    return loadOlderHistoryPage();
  }

  async function loadOlderHistoryPage() {
    if (isLoadingOlderHistory) return;
    if (!hasOlderHistory && bufferedOlderRecords.length === 0) return;
    const armToken = historyArmToken;
    // Nothing can supply older pages — that is an exhausted history, not a failure.
    if (hasOlderHistory && typeof hooks.loadOlderHistory !== 'function') {
      hasOlderHistory = false;
      if (bufferedOlderRecords.length === 0) {
        finishOlderHistory();
        return;
      }
    }
    isLoadingOlderHistory = true;
    renderHistoryTopState('loading');
    const restoreBuffer = bufferedOlderRecords;
    const restoreHasOlder = hasOlderHistory;
    try {
      let fetched = [];
      if (hasOlderHistory) {
        const page = await hooks.loadOlderHistory();
        if (armToken !== historyArmToken) return;
        if (!page) {
          renderHistoryTopState('error');
          return;
        }
        fetched = Array.isArray(page.records) ? page.records : [];
        hasOlderHistory = page.hasOlder === true;
      }

      const batch = fetched.concat(bufferedOlderRecords);
      bufferedOlderRecords = [];
      if (hasOlderHistory) {
        const split = splitPageAtUserTurn(batch);
        bufferedOlderRecords = split.buffered;
        prependHistoryRecordsImpl(split.renderable);
      } else {
        prependHistoryRecordsImpl(batch);
      }

      if (hasOlderHistory || bufferedOlderRecords.length > 0) {
        renderHistoryTopState('idle');
        isLoadingOlderHistory = false;
        refreshHistoryTopObserver();
        return;
      }
      finishOlderHistory();
    } catch (err) {
      appLogger.log('sdk-rich-history', 'older history page failed', {
        error: String(err?.message || err),
        stack: String(err?.stack || '').slice(0, 900),
      });
      if (armToken !== historyArmToken) return;
      // Put the page back so a retry re-renders it instead of skipping over it.
      bufferedOlderRecords = restoreBuffer;
      hasOlderHistory = restoreHasOlder;
      renderHistoryTopState('error');
    } finally {
      isLoadingOlderHistory = false;
    }
  }

  return {
    destroy() {
      mountEl.removeEventListener('scroll', updateStickFromScroll);
      disconnectHistoryTopObserver();
      if (mdRaf) cancelAnimationFrame(mdRaf);
      mdRaf = 0;
      stopTimeoutProgressSeries();
      resetRenderedActivity();
      mountEl.innerHTML = '';
      mountEl.classList.remove('sdk-rich-chat-mount');
    },

    /**
     * Arms (or disarms) auto-loading of older history. Called once hydration settled, so the
     * sentinel cannot fire against a still-empty stream.
     *
     * @param {boolean} available
     */
    setOlderHistoryAvailable(available) {
      historyArmToken += 1;
      hasOlderHistory = available === true;
      if (!hasOlderHistory && bufferedOlderRecords.length === 0) {
        disconnectHistoryTopObserver();
        renderHistoryTopState('hidden');
        return;
      }
      renderHistoryTopState('idle');
      ensureHistoryTopObserver();
    },

    /**
     * @param {unknown[]} records
     * @returns {number}
     */
    prependHistoryRecords(records) {
      return prependHistoryRecordsImpl(records);
    },

    onStreamReset() {
      runScope += 1;
      resumeThinkingAfterStreamReset = findReusableSdkThinkingBlockIndex(
        listThinkingBlockEntries(),
        '',
        true
      ) >= 0;
      resumeAssistantAfterStreamReset = findReusableSdkAssistantBlockIndex(
        listAssistantBlockEntries(),
        true
      ) >= 0;
      clearSegmentPointers();
      stopTimeoutProgressSeries();
    },

    setUiMode(mode) {
      uiMode = normalizeSdkUiMode(mode);
      chat.sdkUiMode = uiMode;
      applyUiModeVisibility();
      scrollToBottom();
    },

    scrollToBottom: () => scrollToBottom({ force: true }),

    hasRenderedHistory() {
      return stream.childElementCount > 0;
    },

    getCopyText() {
      return (stream.innerText || '').trimEnd();
    },

    get queuedCount() {
      return queuedUserBlocks.length;
    },

    hasQueuedOrSentUserText(text) {
      return hasQueuedOrSentUserText(text);
    },

    resolveOpenCodeQuestion(requestId) {
      const id = String(requestId || '').trim();
      if (!id) return;
      const block = openCodeQuestionByRequestId.get(id);
      if (!block) return;
      block.classList.add('sdk-rich-opencode-question--resolved');
      openCodeQuestionByRequestId.delete(id);
    },

    resolveOpenCodePermission(requestId) {
      const id = String(requestId || '').trim();
      if (!id) return;
      const block = openCodePermissionByRequestId.get(id);
      if (!block) return;
      block.classList.add('sdk-rich-opencode-permission--resolved');
      openCodePermissionByRequestId.delete(id);
    },

    appendBannerConnected(opts = {}) {
      stopTimeoutProgressSeries();
      const silent = opts.silent === true;
      const transport = typeof opts.transport === 'string' ? opts.transport : 'sdk';
      const label = resolveHarnessDisplayLabel(transport);
      if (!silent) hooks.appendPlain(`\n[${label}] ${t('sdkView.connectedPlain')}\n`);
      lineMeta(
        'sdk-rich-line--ok',
        `<span class="sdk-rich-badge sdk-rich-badge--ok">${escapeHtml(label)}</span> ${escapeHtml(t('sdkView.connected'))}`
      );
      // The banner is not persisted on purpose — otherwise every WS reconnect would pile up another "connected" line in history.
    },

    appendUserPrompt(text, opts = {}) {
      stopTimeoutProgressSeries();
      const silent = opts.silent === true;
      const raw = text == null ? '' : String(text);
      const echoKey = renderUserTurn(raw) || String(raw).trim();
      if (!echoKey) return;
      if (!silent) hooks.appendPlain(`\n> ${echoKey}\n`);
      scrollToBottom({ force: true });
      if (!silent && typeof hooks.onHistoryRecord === 'function' && !suppressHistoryPersist) {
        const createdAt = new Date().toISOString();
        hooks.onHistoryRecord({ kind: 'localUser', text: echoKey, createdAt });
      }
    },

    appendQueuedPrompt(text, position, opts = {}) {
      const silent = opts.silent === true;
      const raw = normalizeUserPromptText(text);
      if (!raw) return;
      if (queuedUserBlocks.some((item) => normalizeUserPromptText(item.text) === raw)) return;
      const existing = findUserBlockByText(raw);
      if (existing) {
        if (!existing.queued) return;
        this.markUserPromptQueued(raw);
        return;
      }
      const pos = Math.max(1, Number(position) || queuedUserBlocks.length + 1);
      if (!silent) hooks.appendPlain(`\n> ${t('sdkView.queuedPlainTag', { n: pos })} ${raw}\n`);
      const block = createUserBlock(raw);
      block.label = t('sdkView.youQueuedNumbered', { n: pos });
      attachQueuedBlockActions(block, raw);
      queuedUserBlocks.push({ text: raw, block });
      scrollToBottom({ force: true });
    },

    markUserPromptQueued(text) {
      const raw = normalizeUserPromptText(text);
      if (!raw) return false;
      if (queuedUserBlocks.some((item) => normalizeUserPromptText(item.text) === raw)) return true;
      const block = Array.from(stream.children)
        .reverse()
        .find(
          (item) =>
            item?.localName === 'cr-sdk-block' &&
            normalizeUserPromptText(item.copyText) === raw &&
            item.queued !== true,
        );
      if (!block) return false;
      attachQueuedBlockActions(block, raw);
      queuedUserBlocks.push({ text: raw, block });
      relabelQueuedBlocks();
      scrollToBottom({ force: true });
      return true;
    },

    promoteQueuedPrompt(text, opts = {}) {
      const raw = normalizeUserPromptText(text);
      if (!raw) return;
      const idx = queuedUserBlocks.findIndex((item) => normalizeUserPromptText(item.text) === raw);
      if (idx >= 0) {
        const item = queuedUserBlocks.splice(idx, 1)[0];
        item.block.label = t('sdkView.you');
        item.block.classList.remove('sdk-rich-block--queued');
        item.block.queued = false;
        chat._sdkLastLocalUserEcho = raw;
        relabelQueuedBlocks();
        scrollToBottom({ force: true });
        return;
      }
      const existing = findUserBlockByText(raw);
      if (existing) {
        chat._sdkLastLocalUserEcho = raw;
        return;
      }
      this.appendUserPrompt(raw, opts);
    },

    removeQueuedPrompt(text) {
      const raw = normalizeUserPromptText(text);
      const idx = queuedUserBlocks.findIndex((item) => normalizeUserPromptText(item.text) === raw);
      if (idx < 0) return;
      const item = queuedUserBlocks.splice(idx, 1)[0];
      item.block?.remove();
      relabelQueuedBlocks();
    },

    appendRunFinished(status, opts = {}) {
      stopTimeoutProgressSeries();
      const silent = opts.silent === true;
      const st = status == null ? '' : String(status);
      if (!silent) hooks.appendPlain(`\n[run finished: ${st}]\n`);
      setThinkingRunning(false);
      for (const block of latestThinkingByRun.values()) {
        if (block && typeof block === 'object' && 'running' in block) block.running = false;
      }
      const latestRunKey = Array.from(latestTrayByRun.keys()).pop() || '';
      finalizeOpenToolCalls(latestRunKey, st);
      runningToolCallsByRun.clear();
      const latestTray = latestTrayByRun.get(latestRunKey) || Array.from(latestTrayByRun.values()).pop();
      if (latestTray) setTrayStatus(latestTray, st || 'finished');
      const createdAt = lineMeta(
        resolveRunFinishedLineClass(st),
        `<strong>${escapeHtml(t('sdkView.runFinished'))}</strong> · ${escapeHtml(st)}`,
        '',
        true
      );
      if (!silent && typeof hooks.onHistoryRecord === 'function' && !suppressHistoryPersist) {
        hooks.onHistoryRecord({
          kind: 'meta',
          variant: 'runFinished',
          payload: st,
          createdAt,
        });
      }
      if (!silent && !suppressHistoryPersist && typeof hooks.onAnswerEnd === 'function') {
        hooks.onAnswerEnd();
      }
    },

    appendBusy(message, opts = {}) {
      stopTimeoutProgressSeries();
      const silent = opts.silent === true;
      const m = message == null ? '' : String(message).trim();
      const busyBadge = `<span class="sdk-rich-badge sdk-rich-badge--warn">${escapeHtml(t('sdkView.busy'))}</span>`;
      const busyLine = m ? `${busyBadge} ${escapeHtml(m)}` : busyBadge;
      if (!silent) hooks.appendPlain(`\n[SDK busy]${m ? ` ${m}` : ''}\n`);
      const createdAt = lineMeta('sdk-rich-line--warn', busyLine);
      if (!silent && typeof hooks.onHistoryRecord === 'function' && !suppressHistoryPersist) {
        hooks.onHistoryRecord({
          kind: 'meta',
          variant: 'busy',
          payload: m,
          createdAt,
        });
      }
    },

    appendError(message, opts = {}) {
      discardTimeoutProgressSeries();
      const silent = opts.silent === true;
      const m = message == null ? '' : String(message);
      if (!silent) hooks.appendPlain(`\n[SDK error] ${m}\n`);
      const createdAt = lineMeta(
        'sdk-rich-line--err',
        `<span class="sdk-rich-badge sdk-rich-badge--err">${escapeHtml(t('sdkView.error'))}</span> ${escapeHtml(m)}`
      );
      if (!silent && typeof hooks.onHistoryRecord === 'function' && !suppressHistoryPersist) {
        hooks.onHistoryRecord({
          kind: 'meta',
          variant: 'error',
          payload: m,
          createdAt,
        });
      }
    },

    appendMetaNotice(text, opts = {}) {
      handleMetaNotice(text, opts);
    },

    appendContextSeedBlock(summary, opts = {}) {
      const silent = opts.silent === true;
      const raw = summary == null ? '' : String(summary).trim();
      if (!raw) return;
      if (!silent) hooks.appendPlain(`\n[context seed]\n${raw}\n`);
      const block = createContextSeedBlock(raw);
      scrollToBottom({ force: true });
      if (!silent && typeof hooks.onHistoryRecord === 'function' && !suppressHistoryPersist) {
        hooks.onHistoryRecord({
          kind: 'meta',
          variant: 'contextSeed',
          payload: raw,
          createdAt: block.createdAt,
        });
      }
    },

    updateContextAdvisory(opts = {}) {
      updateContextAdvisory(opts);
    },

    appendSdkRunProgress(progress, opts = {}) {
      if (!progress || typeof progress !== 'object') return;
      const silent = opts.silent === true;
      const phase = typeof progress.phase === 'string' ? progress.phase : '';
      const idleForMs = Number.isFinite(progress.idleForMs) ? Number(progress.idleForMs) : 0;
      const remainingMs = Number.isFinite(progress.remainingMs) ? Number(progress.remainingMs) : null;
      const timeoutMs = Number.isFinite(progress.timeoutMs) ? Number(progress.timeoutMs) : null;
      const transport = typeof progress.transport === 'string' ? progress.transport : 'sdk';
      const label =
        transport === 'openrouter' ? 'OpenRouter' : transport === 'opencode' ? 'OpenCode' : 'SDK';

      if (phase === 'started') {
        const notice = `[${label}] ${t('sdkView.runProgressStarted')}`;
        const progressState = { idleSeconds: 0, remainingSeconds: 0, isStarted: true };
        if (!silent) hooks.appendPlain(`\n${notice}\n`);
        appendTimeoutProgressSeries(progressState);
        if (!silent && typeof hooks.onHistoryRecord === 'function' && !suppressHistoryPersist) {
          hooks.onHistoryRecord({
            kind: 'meta',
            variant: 'notice',
            payload: notice,
            progress: progressState,
            createdAt: new Date().toISOString(),
          });
        }
        return;
      }

      if (phase !== 'awaiting_first_event'
        && phase !== 'awaiting_next_event'
        && phase !== 'awaiting_past_budget'
        && phase !== 'connecting'
        && phase !== 'setup'
        && phase !== 'preparing'
        && phase !== 'sending'
        && phase !== 'setup_past_budget') {
        return;
      }

      const idleSeconds = Math.max(0, Math.round(idleForMs / 1000));
      const remainingSeconds = remainingMs != null ? Math.max(0, Math.round(remainingMs / 1000)) : 0;
      const totalSeconds = timeoutMs != null ? Math.max(1, Math.round(timeoutMs / 1000)) : 0;
      let notice = '';
      if (phase === 'connecting' || phase === 'setup') {
        notice = `[${label}] ${t('sdkView.runProgressPreparingAgent', { seconds: idleSeconds })}`;
      } else if (phase === 'preparing') {
        notice = `[${label}] ${t('sdkView.runProgressPreparingPrompt', { seconds: idleSeconds })}`;
      } else if (phase === 'sending') {
        notice = `[${label}] ${t('sdkView.runProgressSendingPrompt', { seconds: idleSeconds })}`;
      } else if (phase === 'setup_past_budget' || phase === 'awaiting_past_budget') {
        notice = `[${label}] ${t('sdkView.runProgressPastBudget', { seconds: idleSeconds })}`;
      } else if (phase === 'awaiting_first_event') {
        notice = `[${label}] ${t('sdkView.runProgressAwaitingFirst', { seconds: idleSeconds })}`;
      } else {
        notice = `[${label}] ${t('sdkView.runProgressNoEvents', { seconds: idleSeconds })}`;
      }
      if (remainingSeconds > 0) {
        notice += ` ${t('sdkView.runProgressWarnThreshold', { seconds: remainingSeconds })}`;
      }
      if (!silent) hooks.appendPlain(`\n${notice}\n`);
      const progressState = { idleSeconds, remainingSeconds, totalSeconds };
      appendTimeoutProgressSeries(progressState);
      if (!silent && typeof hooks.onHistoryRecord === 'function' && !suppressHistoryPersist) {
        hooks.onHistoryRecord({
          kind: 'meta',
          variant: 'notice',
          payload: notice,
          progress: progressState,
          createdAt: new Date().toISOString(),
        });
      }
    },

    /** Live mode change pushed by the server (history is persisted on the backend side). */
    appendModeChange(mode, opts = {}) {
      stopTimeoutProgressSeries();
      const silent = opts.silent === true;
      const normalized = mode === 'plan' ? 'plan' : mode === 'agent' ? 'agent' : mode === 'ask' ? 'ask' : '';
      if (!normalized) return;
      const modeLabel = normalized === 'plan' ? 'Plan' : normalized === 'ask' ? 'Ask' : 'Agent';
      if (!silent) hooks.appendPlain(`\n[Mode: ${modeLabel}]\n`);
      lineMeta(
        'sdk-rich-line--notice',
        `<span class="sdk-rich-badge sdk-rich-badge--status">${escapeHtml(t('sdkView.modeBadge'))}</span> ${escapeHtml(modeLabel)}`
      );
    },

    /**
     * Restored plaintext buffer (localStorage or an API response without a messages list): rendered
     * with the same blocks as a live chat, without a separate collapsible "saved history" frame.
     *
     * @param {string} text
     * @param {string} [_summaryLabel] kept for call-site compatibility; ignored by the UI.
     */
    appendRestoredPlainBuffer(text, _summaryLabel) {
      const t = stripSdkTelemetryLines(text);
      if (!t.trim()) return;

      const segments = splitSdkFormattedConversation(t);
      if (segments.length > 0) {
        for (const seg of segments) {
          emitHistoryTurn(seg.role === 'user', seg.text);
        }
        return;
      }

      emitHistoryTurn(false, t);
    },

    /**
     * Rebuilds history from Agent.messages.list — the same events as over WS (tools, thinking, status).
     * Does not call hooks.appendPlain; the plaintext buffer is set separately in chat.js.
     *
     * @param {Array<Record<string, unknown>>} rows
     */
    applyAgentMessagesHistory(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return;

      resetSdkStreamState(chat);
      clearSegmentPointers();
      resetRenderedActivity();
      queuedUserBlocks.length = 0;
      stream.replaceChildren();

      suppressHooksPlain = true;
      suppressHistoryPersist = true;
      mdRenderImmediate = true;
      try {
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue;
          /** @type {Record<string, unknown>} */
          const ev = /** @type {Record<string, unknown>} */ (row);
          const expanded = sdkEventsFromAgentRow(ev);
          if (expanded.length > 0) {
            for (const item of expanded) {
              applySdkEvent(item);
            }
            continue;
          }
          const tt = typeof ev.type === 'string' ? ev.type.toLowerCase() : '';
          if (
            tt === 'system' ||
            tt === 'user' ||
            tt === 'assistant' ||
            tt === 'thinking' ||
            tt === 'tool_call' ||
            tt === 'status' ||
            tt === 'task' ||
            tt === 'request' ||
            tt === 'opencode_question' ||
            tt === 'opencode_permission'
          ) {
            applySdkEvent(ev);
          }
        }
      } finally {
        suppressHooksPlain = false;
        suppressHistoryPersist = false;
        mdRenderImmediate = false;
        scrollToBottom({ force: true });
      }
    },

    /**
     * Replays from the local JSON store (IndexedDB / legacy localStorage — same shape as written).
     *
     * @param {unknown[]} records
     * @param {{ instant?: boolean }} [opts]
     */
    replayHistoryRecords(records, opts = {}) {
      if (!Array.isArray(records) || records.length === 0) return;
      resetSdkStreamState(chat);
      clearSegmentPointers();
      resetRenderedActivity();
      queuedUserBlocks.length = 0;
      lastHistoryErrorText = '';
      // A replay redefines the window, so any page fetched by scrolling up is gone with it.
      bufferedOlderRecords = [];
      stream.replaceChildren();
      suppressHooksPlain = true;
      suppressHistoryPersist = true;
      mdRenderImmediate = true;
      const instant = opts.instant === true;
      try {
        if (instant) {
          for (let index = 0; index < records.length; index += 1) {
            applyHistoryRecord(records[index]);
          }
        } else {
          const maxImmediate = Math.min(records.length, 40);
          for (let index = 0; index < maxImmediate; index += 1) {
            applyHistoryRecord(records[index]);
          }
        }
      } finally {
        suppressHooksPlain = false;
        suppressHistoryPersist = false;
        mdRenderImmediate = false;
        scrollToBottom({ force: true });
      }
      if (instant || records.length <= 40) return;
      void replayHistoryRecordsChunkedImpl(records, 40);
    },

    async appendHistoryRecords(records, opts = {}) {
      if (!Array.isArray(records) || records.length === 0) return;
      suppressHooksPlain = true;
      suppressHistoryPersist = true;
      mdRenderImmediate = true;
      const instant = opts.instant === true;
      try {
        for (let index = 0; index < records.length; index += 1) {
          applyHistoryRecord(records[index]);
          if (
            !instant &&
            index > 0 &&
            (index + 1) % 10 === 0
          ) {
            await new Promise((resolve) => {
              if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
              else setTimeout(resolve, 0);
            });
          }
        }
      } finally {
        suppressHooksPlain = false;
        suppressHistoryPersist = false;
        mdRenderImmediate = false;
        scrollToBottom({ force: true });
      }
    },

    applyEvent(event) {
      applySdkEvent(event);
    },

    ensureRelatedChatLinks,
  };
}

registerPageResumeCleanupHook(() => (dismissSdkImageLightboxIfOpen() ? 'sdk-lightbox' : undefined));
