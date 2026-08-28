/**
 * Files panel: directory tree of the selected workspace with a file preview.
 */
import * as api from './core/api/index.js';
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
import { createMarkdownRenderer, renderMarkdownHtml } from './lib/render-markdown.js';
import { escapeHtml } from './features/chat/chatHtmlUtils.js';
import { initDropdown } from './lib/dropdown.js';
import { initModal } from './lib/modal.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from './lib/storageKeyAlias.js';
import { t } from './i18n/index.js';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('json', jsonLang);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', cssLang);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('python', python);
hljs.registerLanguage('php', php);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);

const treeEl = document.getElementById('files-tree');
const rootLabelEl = document.getElementById('files-root-label');
const rootDropdownEl = document.getElementById('files-root-dropdown');
const previewWrap = document.getElementById('files-preview-wrap');
const previewPathEl = document.getElementById('files-preview-path');
const previewContentEl = document.getElementById('files-preview-content');
const previewCloseBtn = document.getElementById('files-preview-close');
const previewMdToggleWrap = document.getElementById('files-preview-markdown-toggle-wrap');
const previewMdToggle = document.getElementById('files-preview-markdown-toggle');
const previewDiffToggleWrap = document.getElementById('files-preview-diff-toggle-wrap');
const previewDiffToggle = document.getElementById('files-preview-diff-toggle');
const filesSettingsBtn = document.getElementById('files-settings-btn');
const filesSettingsModalEl = document.getElementById('files-settings-modal');
const filesShowHiddenCheckbox = document.getElementById('files-show-hidden-checkbox');
const filesSettingsCancelBtn = document.getElementById('files-settings-cancel');
const filesSettingsSaveBtn = document.getElementById('files-settings-save');

const LS_PREVIEW_H = 'cretli-files-preview-height';
const PREVIEW_H_MIN = 88;
const PREVIEW_H_DEFAULT = 220;
const TREE_MIN_PX = 64;
const LS_SHOW_HIDDEN_FILES = 'cretli-files-show-hidden';
const LS_PREVIEW_FONT_SCALE = 'cretli-files-preview-font-scale';
const PREVIEW_FONT_SCALE_MIN = 0.6;
const PREVIEW_FONT_SCALE_MAX = 3;
const PREVIEW_FONT_SCALE_DEFAULT = 1;
const LANGUAGE_BY_EXT = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsx: 'javascript',
  json: 'json',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  py: 'python',
  php: 'php',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
};
const md = createMarkdownRenderer({
  highlight(code, lang) {
    const language = String(lang || '').trim().toLowerCase();
    const languageClass = language ? ` language-${escapeHtml(language)}` : '';
    if (language && hljs.getLanguage(language)) {
      try {
        const highlighted = hljs.highlight(code, {
          language,
          ignoreIllegals: true,
        }).value;
        return `<pre><code class="hljs${languageClass}">${highlighted}</code></pre>`;
      } catch (_) {
        /* fallthrough */
      }
    }
    return `<pre><code class="${languageClass.trim()}">${escapeHtml(code)}</code></pre>`;
  },
});
let currentPreviewPath = '';
let currentPreviewContent = '';
let currentDiffContent = null; // null = not loaded yet; string = diff text
let currentDiffLoading = false;
let rootDropdownBound = false;
let rootDropdownApi = null;
let filesSettingsModalApi = null;

/** Cache: path -> { entries, loaded } */
const cache = new Map();

/**
 * Git status: path (relative to cwd, posix) -> code ('M'|'A'|'D'|'R'|'U'|'C').
 * dirtyDirs: set of directory paths that contain changed descendants.
 */
let gitStatusByPath = new Map();
let gitDirtyDirs = new Set();
let gitStatusLoaded = false;

const GIT_STATUS_EVENT = 'cretli-git-changed';

function classifyGitStatus(code) {
  if (!code || code.length < 2) return '';
  if (code === '??') return 'U';
  if (code === '!!') return '';
  const x = code[0];
  const y = code[1];
  if (x === 'A' || y === 'A') return 'A';
  if (x === 'D' || y === 'D') return 'D';
  if (x === 'R' || y === 'R') return 'R';
  if (x === 'C' || y === 'C') return 'C';
  if (x === 'M' || y === 'M') return 'M';
  return '';
}

function parseGitStatusShort(lines) {
  const byPath = new Map();
  const dirtyDirs = new Set();
  for (const raw of lines) {
    if (!raw || raw.startsWith('## ')) continue;
    const code = raw.slice(0, 2);
    let rest = raw.slice(3);
    // Rename/copy: "old -> new" — take both paths
    const arrowIdx = rest.indexOf(' -> ');
    const paths = arrowIdx >= 0 ? [rest.slice(0, arrowIdx), rest.slice(arrowIdx + 4)] : [rest];
    const cls = classifyGitStatus(code);
    if (!cls) continue;
    for (let p of paths) {
      if (!p) continue;
      // porcelain v1 quotes paths that contain special characters
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/\\(.)/g, '$1');
      p = p.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!p) continue;
      byPath.set(p, cls);
      const segments = p.split('/');
      for (let i = 1; i < segments.length; i++) {
        dirtyDirs.add(segments.slice(0, i).join('/'));
      }
    }
  }
  return { byPath, dirtyDirs };
}

function fetchGitStatus() {
  return api.getGitInfo().then((data) => {
    if (!data?.ok || !data.isRepo || !Array.isArray(data.statusShort)) {
      gitStatusByPath = new Map();
      gitDirtyDirs = new Set();
      gitStatusLoaded = true;
      applyGitStatusToTree(treeEl);
      return;
    }
    const { byPath, dirtyDirs } = parseGitStatusShort(data.statusShort);
    gitStatusByPath = byPath;
    gitDirtyDirs = dirtyDirs;
    gitStatusLoaded = true;
    applyGitStatusToTree(treeEl);
  }).catch(() => {
    gitStatusByPath = new Map();
    gitDirtyDirs = new Set();
    gitStatusLoaded = true;
    applyGitStatusToTree(treeEl);
  });
}

const GIT_CLASS_BY_STATUS = {
  M: 'is-modified',
  A: 'is-added',
  D: 'is-deleted',
  R: 'is-renamed',
  C: 'is-renamed',
  U: 'is-untracked',
};

function applyGitStatusToItem(item) {
  if (!item) return;
  const p = item.dataset.path || '';
  if (!p) return;
  const isDir = item.dataset.isDir === '1';
  const cls = isDir ? (gitDirtyDirs.has(p) ? 'has-changes' : '') : (GIT_CLASS_BY_STATUS[gitStatusByPath.get(p) || ''] || '');
  for (const c of ['is-modified', 'is-added', 'is-deleted', 'is-renamed', 'is-untracked', 'has-changes']) {
    item.classList.remove(c);
  }
  if (cls) item.classList.add(cls);
}

function applyGitStatusToTree(root) {
  if (!root) return;
  const items = root.querySelectorAll('.files-tree-item--dir, .files-tree-item--file');
  for (const item of items) applyGitStatusToItem(item);
}

function getSavedPreviewHeight() {
  try {
    const n = parseInt(readStorageValueWithAlias(localStorage, LS_PREVIEW_H, ''), 10);
    if (Number.isFinite(n) && n >= PREVIEW_H_MIN) return n;
  } catch (_) {}
  return PREVIEW_H_DEFAULT;
}

function getSavedPreviewFontScale() {
  try {
    const n = parseFloat(readStorageValueWithAlias(localStorage, LS_PREVIEW_FONT_SCALE, ''));
    if (Number.isFinite(n) && n >= PREVIEW_FONT_SCALE_MIN && n <= PREVIEW_FONT_SCALE_MAX) return n;
  } catch (_) {}
  return PREVIEW_FONT_SCALE_DEFAULT;
}

function clampPreviewFontScale(v) {
  if (!Number.isFinite(v)) return PREVIEW_FONT_SCALE_DEFAULT;
  return Math.min(PREVIEW_FONT_SCALE_MAX, Math.max(PREVIEW_FONT_SCALE_MIN, v));
}

function applyPreviewFontScale(scale) {
  if (!previewContentEl) return;
  previewContentEl.style.setProperty('--files-preview-font-scale', String(scale));
}

let previewFontScale = PREVIEW_FONT_SCALE_DEFAULT;
let pinchActive = false;
let pinchStartDist = 0;
let pinchStartScale = PREVIEW_FONT_SCALE_DEFAULT;
let pinchBound = false;

function touchDistance(touches) {
  const a = touches[0];
  const b = touches[1];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function initPreviewPinch() {
  if (!previewContentEl || pinchBound) return;
  pinchBound = true;

  previewContentEl.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 2) return;
      pinchActive = true;
      pinchStartDist = touchDistance(e.touches) || 1;
      pinchStartScale = previewFontScale;
    },
    { passive: true }
  );

  previewContentEl.addEventListener(
    'touchmove',
    (e) => {
      if (!pinchActive || e.touches.length !== 2) return;
      const dist = touchDistance(e.touches) || 1;
      const ratio = dist / pinchStartDist;
      const next = clampPreviewFontScale(pinchStartScale * ratio);
      if (Math.abs(next - previewFontScale) >= 0.01) {
        previewFontScale = next;
        applyPreviewFontScale(next);
      }
      e.preventDefault();
    },
    { passive: false }
  );

  const endPinch = () => {
    if (!pinchActive) return;
    pinchActive = false;
    try {
      writeStorageValueWithAlias(localStorage, LS_PREVIEW_FONT_SCALE, String(previewFontScale));
    } catch (_) {}
  };
  previewContentEl.addEventListener('touchend', endPinch, { passive: true });
  previewContentEl.addEventListener('touchcancel', endPinch, { passive: true });
}

function getShowHiddenFilesEnabled() {
  try {
    return readStorageValueWithAlias(localStorage, LS_SHOW_HIDDEN_FILES, '') === '1';
  } catch (_) {
    return false;
  }
}

function setShowHiddenFilesEnabled(enabled) {
  try {
    writeStorageValueWithAlias(localStorage, LS_SHOW_HIDDEN_FILES, enabled ? '1' : '0');
  } catch (_) {}
}

function setPreviewHeightPx(px) {
  if (!previewWrap) return;
  const layout = previewWrap.closest('.files-layout');
  if (!layout) return;
  const toolbarH = layout.querySelector('.files-toolbar')?.offsetHeight ?? 36;
  const layoutH = layout.getBoundingClientRect().height || 320;
  const maxPreview = Math.max(layoutH - toolbarH - TREE_MIN_PX - 8, PREVIEW_H_MIN + 80);
  const h = Math.round(Math.min(Math.max(px, PREVIEW_H_MIN), maxPreview));
  previewWrap.style.setProperty('--files-preview-height', `${h}px`);
  previewWrap.style.height = `${h}px`;
  try {
    writeStorageValueWithAlias(localStorage, LS_PREVIEW_H, String(h));
  } catch (_) {}
}

let previewResizeBound = false;

/**
 * The preview bar can only be bound once the panel is open (or once the DOM ids exist).
 * Pointer events + setPointerCapture + capturing window listeners keep the drag working
 * while scrolling and on touch devices.
 */
function ensurePreviewResizeDrag() {
  if (!previewWrap || previewResizeBound) return;
  const toolbar =
    document.getElementById('files-preview-toolbar') ||
    previewWrap.querySelector('.files-preview-drag-handle') ||
    previewWrap.querySelector('.files-preview-toolbar');
  if (!toolbar) return;

  let dragging = false;
  let startY = 0;
  let startH = 0;

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', endDrag, true);
    window.removeEventListener('pointercancel', endDrag, true);
    document.body.classList.remove('files-preview-resizing');
  }

  function onMove(e) {
    if (!dragging) return;
    e.preventDefault();
    const dy = startY - e.clientY;
    setPreviewHeightPx(startH + dy);
  }

  toolbar.addEventListener(
    'pointerdown',
    (e) => {
      if (e.target.closest && e.target.closest('button, input, label, .files-preview-markdown-toggle-wrap')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging = true;
      startY = e.clientY;
      startH = previewWrap.getBoundingClientRect().height;
      try {
        toolbar.setPointerCapture(e.pointerId);
      } catch (_) {
        /* older browsers */
      }
      window.addEventListener('pointermove', onMove, { capture: true, passive: false });
      window.addEventListener('pointerup', endDrag, true);
      window.addEventListener('pointercancel', endDrag, true);
      document.body.classList.add('files-preview-resizing');
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );

  previewResizeBound = true;
}

function renderEmpty() {
  if (!treeEl) return;
  treeEl.innerHTML = '';
  treeEl.appendChild(
    Object.assign(document.createElement('div'), {
      className: 'files-tree-empty',
      textContent: t('files.noWorkspace'),
    })
  );
}

function normalizePathValue(value) {
  if (!value || typeof value !== 'string') return '';
  return value.replaceAll('\\', '/').replace(/\/+$/, '').trim();
}

function closeRootDropdown() {
  if (!rootDropdownApi) return;
  rootDropdownApi.close();
}

function renderRootDropdown(workspace, selectedFolder) {
  if (!rootDropdownEl) return;
  const options = [];
  const pushed = new Set();

  if (workspace.workspaceDir) {
    options.push({
      value: workspace.workspaceDir,
      label: `Workspace: ${workspace.workspaceDir}`,
    });
    pushed.add(workspace.workspaceDir);
  }

  for (const folder of workspace.folders || []) {
    const value = String(folder.resolvedPath || '').trim();
    if (!value || pushed.has(value)) continue;
    options.push({
      value,
      label: `${folder.name || value} — ${value}`,
    });
    pushed.add(value);
  }

  rootDropdownEl.innerHTML = '';
  for (const option of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'files-root-dropdown-item';
    if (selectedFolder === option.value) btn.classList.add('is-selected');
    btn.textContent = option.label;
    btn.title = option.value;
    btn.addEventListener('click', () => {
      api.patchSettings({ workspaceFolder: option.value }).then((res) => {
        if (!res?.ok) return;
        closeRootDropdown();
        buildRootTree();
        window.dispatchEvent(new CustomEvent('cretli-workspace-updated'));
      }).catch(() => {});
    });
    rootDropdownEl.appendChild(btn);
  }

  rootDropdownEl.hidden = false;
  rootDropdownApi?.open();
}

function initRootDropdown() {
  if (!rootLabelEl || !rootDropdownEl || rootDropdownBound) return;
  rootDropdownApi = initDropdown({
    triggerEl: rootLabelEl,
    floatingEl: rootDropdownEl,
    placement: 'bottom-end',
    matchTriggerWidth: true,
    offsetPx: 6,
    viewportPadding: 8,
    minWidthPx: 220,
    maxHeightPx: 360,
  });

  rootLabelEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (rootDropdownApi?.isOpen()) return closeRootDropdown();
    Promise.all([api.getWorkspace(), api.getSettings()]).then(([workspace, settings]) => {
      if (!workspace?.ok) return;
      const selectedFolder =
        settings?.ok && typeof settings.workspaceFolder === 'string' && settings.workspaceFolder.trim()
          ? settings.workspaceFolder.trim()
          : workspace.workspaceDir;
      renderRootDropdown(workspace, selectedFolder);
    }).catch(() => {});
  });

  rootDropdownBound = true;
}

function initFilesSettingsModal() {
  if (!filesSettingsModalEl) return;
  filesSettingsModalApi = initModal(filesSettingsModalEl, {
    backdropSelector: '.chat-settings-backdrop',
  });

  if (filesSettingsBtn) {
    filesSettingsBtn.addEventListener('click', () => {
      if (filesShowHiddenCheckbox) {
        filesShowHiddenCheckbox.checked = getShowHiddenFilesEnabled();
      }
      filesSettingsModalApi?.open();
    });
  }

  if (filesSettingsCancelBtn) {
    filesSettingsCancelBtn.addEventListener('click', () => {
      filesSettingsModalApi?.close();
    });
  }

  if (filesSettingsSaveBtn) {
    filesSettingsSaveBtn.addEventListener('click', () => {
      const enabled = !!filesShowHiddenCheckbox?.checked;
      setShowHiddenFilesEnabled(enabled);
      filesSettingsModalApi?.close();
      buildRootTree();
    });
  }
}

function makeTreeItem(entry, depth, parentPath) {
  const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  const item = document.createElement('div');
  item.setAttribute('role', 'treeitem');
  item.setAttribute('aria-expanded', 'false');
  item.dataset.path = path;
  item.dataset.isDir = entry.isDir ? '1' : '0';
  item.classList.add(entry.isDir ? 'files-tree-item--dir' : 'files-tree-item--file');

  const row = document.createElement('div');
  row.className = 'files-tree-row';
  row.style.paddingLeft = `${depth * 0.75 + 0.4}rem`;

  const arrow = document.createElement('span');
  arrow.className = 'files-tree-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  if (entry.isDir) {
    arrow.innerHTML = '<span class="mdi mdi-chevron-right" aria-hidden="true"></span>';
  } else {
    arrow.innerHTML = '';
  }

  const icon = document.createElement('span');
  icon.className = 'files-tree-icon';
  icon.innerHTML = entry.isDir
    ? '<span class="mdi mdi-folder-outline" aria-hidden="true"></span>'
    : '<span class="mdi mdi-file-document-outline" aria-hidden="true"></span>';

  const name = document.createElement('span');
  name.className = 'files-tree-name';
  name.textContent = entry.name;
  const meta = document.createElement('span');
  meta.className = 'files-tree-meta';
  meta.textContent = formatEntryMeta(entry);

  row.appendChild(arrow);
  row.appendChild(icon);
  row.appendChild(name);
  row.appendChild(meta);
  item.appendChild(row);

  if (entry.isDir) {
    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    group.className = 'files-tree-group';
    group.hidden = true;
    item.appendChild(group);
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFolder(item, path);
    });
  } else {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      openFile(path);
    });
  }

  return item;
}

function formatBytes(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return '';
  if (num < 1024) return `${num} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = num / 1024;
  let unitIdx = 0;
  while (v >= 1024 && unitIdx < units.length - 1) {
    v /= 1024;
    unitIdx += 1;
  }
  const rounded = v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded} ${units[unitIdx]}`;
}

function formatEntryMeta(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (entry.isDir) {
    const count = Number(entry.dirEntries);
    if (Number.isFinite(count) && count >= 0) return `${count}`;
    return '';
  }
  return formatBytes(entry.sizeBytes);
}

function toggleFolder(item, path) {
  const expanded = item.getAttribute('aria-expanded') === 'true';
  const group = item.querySelector(':scope > [role="group"]');
  const arrow = item.querySelector('.files-tree-row .files-tree-arrow');

  if (expanded) {
    item.setAttribute('aria-expanded', 'false');
    if (group) group.hidden = true;
    if (arrow) arrow.innerHTML = '<span class="mdi mdi-chevron-right" aria-hidden="true"></span>';
    return;
  }

  item.setAttribute('aria-expanded', 'true');
  if (arrow) arrow.innerHTML = '<span class="mdi mdi-chevron-down" aria-hidden="true"></span>';

  const childDepth = path.split('/').filter(Boolean).length;
  const needsLoad =
    !group ||
    (group.children.length === 0 &&
      !group.querySelector('.files-tree-loading') &&
      !group.querySelector('.files-tree-error'));

  if (group && needsLoad) {
    loadDirInto(path, group, childDepth);
  }
  if (group) group.hidden = false;
}

function loadDirInto(relPath, containerEl, depth) {
  const includeHidden = getShowHiddenFilesEnabled();
  const key = `${relPath || '.'}|hidden:${includeHidden ? '1' : '0'}`;
  if (cache.has(key) && cache.get(key).loaded) {
    const { entries } = cache.get(key);
    containerEl.innerHTML = '';
    appendEntries(containerEl, entries, depth, relPath ? relPath : '');
    return;
  }
  containerEl.innerHTML = `<span class="files-tree-loading">${t('files.loading')}</span>`;
  api.getFilesEntries(relPath, includeHidden).then((data) => {
    if (!data.ok) {
      containerEl.innerHTML = `<span class="files-tree-error">${data.error || t('files.error')}</span>`;
      return;
    }
    cache.set(key, { entries: data.entries, loaded: true });
    containerEl.innerHTML = '';
    appendEntries(containerEl, data.entries, depth, relPath || '');
    containerEl.hidden = false;
  }).catch((err) => {
    containerEl.innerHTML = `<span class="files-tree-error">${err.message || t('files.error')}</span>`;
  });
}

function appendEntries(containerEl, entries, depth, parentPath) {
  const normParent = parentPath.replace(/\/$/, '') || '';
  for (const entry of entries) {
    const child = makeTreeItem(entry, depth, normParent || undefined);
    containerEl.appendChild(child);
  }
  if (gitStatusLoaded) applyGitStatusToTree(containerEl);
}

function getLanguageFromPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith('.d.ts')) return 'typescript';
  const parts = normalized.split('.');
  if (parts.length < 2) return '';
  const ext = parts.pop();
  return LANGUAGE_BY_EXT[ext] || '';
}

function isMarkdownFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const normalized = filePath.toLowerCase();
  return normalized.endsWith('.md') || normalized.endsWith('.markdown');
}

function renderCodeWithLineNumbers(renderedHtml) {
  const lines = splitHighlightedIntoLines(String(renderedHtml));
  const body = lines.map((line, idx) => {
    const lineNo = idx + 1;
    const lineHtml = line.length ? line : '&nbsp;';
    return (
      `<span class="files-preview-line">` +
      `<span class="files-preview-line-no">${lineNo}</span>` +
      `<span class="files-preview-line-code">${lineHtml}</span>` +
      `</span>`
    );
  }).join('');
  return `<code class="hljs files-preview-code-with-lines">${body}</code>`;
}

/**
 * Splits highlight.js HTML into lines with balanced tags.
 * highlight.js emits multi-line <span> elements (e.g. for block comments slash-star ... star-slash),
 * so a plain split('\n') would cut a span in half and break the layout.
 * Every line therefore closes the open spans at its end and reopens them at the start of the next one.
 */
function splitHighlightedIntoLines(html) {
  const lines = [];
  let current = '';
  const stack = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const ch = html[i];
    if (ch === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) {
        current += html.slice(i);
        break;
      }
      const tag = html.slice(i, end + 1);
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
      let closing = '';
      for (let k = stack.length; k > 0; k--) closing += '</span>';
      lines.push(current + closing);
      current = stack.join('');
      i++;
      continue;
    }
    // copy plain text up to the next '<' or newline
    let nextTag = html.indexOf('<', i);
    if (nextTag === -1) nextTag = n;
    let nextNl = html.indexOf('\n', i);
    if (nextNl === -1) nextNl = n;
    const nextPos = Math.min(nextTag, nextNl);
    current += html.slice(i, nextPos);
    i = nextPos;
  }
  // last line, closing any spans still open
  let closing = '';
  for (let k = stack.length; k > 0; k--) closing += '</span>';
  if (current.length || stack.length || lines.length === 0) {
    lines.push(current + closing);
  }
  return lines;
}

function renderPreviewContent(content, filePath) {
  if (!previewContentEl) return;
  const lang = getLanguageFromPath(filePath);
  if (!lang) {
    previewContentEl.innerHTML = renderCodeWithLineNumbers(escapeHtml(content));
    return;
  }
  try {
    const highlighted = hljs.highlight(content, {
      language: lang,
      ignoreIllegals: true,
    }).value;
    previewContentEl.innerHTML = renderCodeWithLineNumbers(highlighted);
  } catch (_) {
    previewContentEl.innerHTML = renderCodeWithLineNumbers(escapeHtml(content));
  }
}

function updateMarkdownToggleVisibility(filePath) {
  if (!previewMdToggleWrap || !previewMdToggle) return;
  if (!isMarkdownFilePath(filePath)) {
    previewMdToggleWrap.hidden = true;
    previewMdToggle.checked = false;
    return;
  }
  previewMdToggleWrap.hidden = false;
}

/** The Diff toggle is shown only for files with git changes. */
function fileHasGitChanges(filePath) {
  if (!filePath) return false;
  return gitStatusByPath.has(filePath);
}

function updateDiffToggleVisibility(filePath) {
  if (!previewDiffToggleWrap || !previewDiffToggle) return;
  if (!fileHasGitChanges(filePath)) {
    previewDiffToggleWrap.hidden = true;
    previewDiffToggle.checked = false;
    return;
  }
  previewDiffToggleWrap.hidden = false;
}

function escapeDiffLine(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Renders a unified diff as coloured lines with old/new line numbers. */
function renderDiffContent(diff) {
  if (!diff || !diff.trim()) {
    return `<div class="files-preview-empty">${t('files.noDiffChanges')}</div>`;
  }
  const lines = String(diff).split('\n');
  let oldNo = 0;
  let newNo = 0;
  const rows = [];
  for (const line of lines) {
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
    } else if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('+++') ||
      line.startsWith('---')
    ) {
      cls += ' files-diff-line-header';
    } else if (line.startsWith('+')) {
      cls += ' files-diff-line-add';
      newNo += 1;
      newNum = String(newNo);
    } else if (line.startsWith('-')) {
      cls += ' files-diff-line-del';
      oldNo += 1;
      oldNum = String(oldNo);
    } else {
      cls += ' files-diff-line-ctx';
      oldNo += 1;
      newNo += 1;
      oldNum = String(oldNo);
      newNum = String(newNo);
      // context lines start with a space — drop it so the body renders as plain code
      body = line.slice(1);
    }

    // on add/del lines drop the leading +/- from the body, so the numbering matches the real line
    if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      body = line.slice(1);
    }

    const oldHtml = oldNum
      ? `<span class="files-diff-line-no">${oldNum}</span>`
      : '<span class="files-diff-line-no files-diff-line-no--empty"></span>';
    const newHtml = newNum
      ? `<span class="files-diff-line-no">${newNum}</span>`
      : '<span class="files-diff-line-no files-diff-line-no--empty"></span>';
    const escaped = escapeDiffLine(body);
    const codeHtml = escaped.length ? escaped : '&nbsp;';

    rows.push(
      `<span class="${cls}">` +
      oldHtml +
      newHtml +
      `<span class="files-diff-line-code">${codeHtml}</span>` +
      `</span>`
    );
  }
  return `<code class="files-diff-code">${rows.join('')}</code>`;
}

function ensureDiffLoaded() {
  if (currentDiffContent !== null || currentDiffLoading) return Promise.resolve();
  if (!currentPreviewPath || !fileHasGitChanges(currentPreviewPath)) {
    currentDiffContent = '';
    return Promise.resolve();
  }
  currentDiffLoading = true;
  return api.getGitFileDiff(currentPreviewPath).then((data) => {
    currentDiffLoading = false;
    currentDiffContent = data?.ok
      ? data.diff || ''
      : (data?.error ? t('files.errorDetail', { detail: data.error }) : t('files.diffFetchError'));
  }).catch((err) => {
    currentDiffLoading = false;
    currentDiffContent = err?.message ? t('files.errorDetail', { detail: err.message }) : t('files.diffFetchError');
  });
}

function renderCurrentPreview() {
  if (!previewContentEl) return;
  if (!currentPreviewPath) return;

  if (previewDiffToggle?.checked) {
    const renderNow = () => {
      previewContentEl.innerHTML = renderDiffContent(currentDiffContent || '');
    };
    if (currentDiffContent === null) {
      previewContentEl.textContent = t('files.loadingDiff');
      ensureDiffLoaded().then(renderNow);
      return;
    }
    renderNow();
    return;
  }

  if (previewMdToggle?.checked && isMarkdownFilePath(currentPreviewPath)) {
    previewContentEl.innerHTML = `<div class="files-preview-markdown">${renderMarkdownHtml(currentPreviewContent || '', md)}</div>`;
    return;
  }

  renderPreviewContent(currentPreviewContent, currentPreviewPath);
}

function openFile(path) {
  if (!previewWrap || !previewPathEl || !previewContentEl) return;
  ensurePreviewResizeDrag();
  previewPathEl.textContent = path;
  previewContentEl.textContent = t('files.loading');
  previewWrap.hidden = false;
  requestAnimationFrame(() => {
    setPreviewHeightPx(getSavedPreviewHeight());
  });

  currentDiffContent = null;
  currentDiffLoading = false;

  api.getFileContent(path).then((data) => {
    if (!data.ok) {
      previewContentEl.textContent = data.error || t('files.readError');
      return;
    }
    currentPreviewPath = path;
    currentPreviewContent = data.content;
    updateMarkdownToggleVisibility(path);
    updateDiffToggleVisibility(path);
    renderCurrentPreview();
  }).catch((err) => {
    previewContentEl.textContent = err.message || t('files.error');
  });
}

function closePreview() {
  if (previewWrap) previewWrap.hidden = true;
}

function buildRootTree() {
  if (!treeEl) return;
  closeRootDropdown();
  treeEl.innerHTML = '';
  cache.clear();
  rootLabelEl.textContent = t('files.loading');

  Promise.all([api.getWorkspace(), api.getSettings()])
    .then(([w, settings]) => {
      if (!w?.ok) {
        rootLabelEl.textContent = '—';
        renderEmpty();
        return;
      }
      const workspaceDir = w.workspaceDir || w.cwd || '—';
      const selectedFolder =
        settings?.ok && typeof settings.workspaceFolder === 'string'
          ? settings.workspaceFolder.trim()
          : '';
      const workspaceNorm = normalizePathValue(workspaceDir);
      const selectedNorm = normalizePathValue(selectedFolder);
      if (selectedNorm && selectedNorm !== workspaceNorm) {
        const label = `${workspaceDir} • ${selectedNorm}`;
        rootLabelEl.textContent = label;
        rootLabelEl.title = label;
        return;
      }
      rootLabelEl.textContent = workspaceDir;
      rootLabelEl.title = workspaceDir;
    })
    .catch(() => {
      rootLabelEl.textContent = '—';
    });

  loadDirInto('', treeEl, 0);
  fetchGitStatus();
}

export function initFilesPanel() {
  if (!treeEl) return;
  initRootDropdown();
  initFilesSettingsModal();
  buildRootTree();
  ensurePreviewResizeDrag();
  previewFontScale = getSavedPreviewFontScale();
  applyPreviewFontScale(previewFontScale);
  initPreviewPinch();

  window.addEventListener(GIT_STATUS_EVENT, () => {
    fetchGitStatus().then(() => {
      // git status changed: refresh the diff toggle and invalidate the cached diff
      if (currentPreviewPath) {
        currentDiffContent = null;
        updateDiffToggleVisibility(currentPreviewPath);
        // diff was on but the file no longer has changes — fall back to the plain preview
        if (previewDiffToggle?.checked && !fileHasGitChanges(currentPreviewPath)) {
          previewDiffToggle.checked = false;
        }
        renderCurrentPreview();
      }
    });
  });

  if (previewCloseBtn) {
    previewCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closePreview();
    });
  }
  if (previewMdToggle) {
    previewMdToggle.addEventListener('change', (e) => {
      e.stopPropagation();
      // mutually exclusive: markdown turns diff off
      if (previewMdToggle.checked && previewDiffToggle) {
        previewDiffToggle.checked = false;
      }
      renderCurrentPreview();
    });
  }
  if (previewDiffToggle) {
    previewDiffToggle.addEventListener('change', (e) => {
      e.stopPropagation();
      // diff turns markdown off
      if (previewDiffToggle.checked && previewMdToggle) {
        previewMdToggle.checked = false;
      }
      renderCurrentPreview();
    });
  }
}

export function refreshFilesPanel() {
  buildRootTree();
}
