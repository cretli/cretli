/** File preview controller: loads content/diff and renders it with Lit. */
import { render } from 'lit';
import * as api from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import { dom } from '../state/filesDom.js';
import { filesState } from '../state/filesState.js';
import { fileHasGitChanges } from '../services/gitStatus.js';
import { getSavedPreviewHeight } from '../services/filesPrefs.js';
import { isMarkdownFilePath } from '../services/highlight.js';
import { ensurePreviewResizeDrag, setPreviewHeightPx } from '../services/previewInteractions.js';
import { codeView, diffView, markdownView, previewMessageView } from '../views/previewView.js';

let onChange = () => {};

export function configureFilesPreview(hooks) {
  onChange = hooks.onChange;
}

function showMessage(text) {
  if (dom.previewContent) render(previewMessageView(text), dom.previewContent);
}

function updateToggleVisibility(wrap, toggle, visible) {
  if (!wrap || !toggle) return;
  wrap.hidden = !visible;
  if (!visible) toggle.checked = false;
}

export function updateDiffToggleVisibility(filePath) {
  updateToggleVisibility(dom.diffToggleWrap, dom.diffToggle, fileHasGitChanges(filePath));
}

function ensureDiffLoaded() {
  if (filesState.diffContent !== null || filesState.diffLoading) return Promise.resolve();
  if (!filesState.previewPath || !fileHasGitChanges(filesState.previewPath)) {
    filesState.diffContent = '';
    return Promise.resolve();
  }
  filesState.diffLoading = true;
  return api.getGitFileDiff(filesState.previewPath).then((data) => {
    filesState.diffLoading = false;
    filesState.diffContent = data?.ok
      ? data.diff || ''
      : (data?.error ? t('files.errorDetail', { detail: data.error }) : t('files.diffFetchError'));
  }).catch((err) => {
    filesState.diffLoading = false;
    filesState.diffContent = err?.message ? t('files.errorDetail', { detail: err.message }) : t('files.diffFetchError');
  });
}

export function renderCurrentPreview() {
  const host = dom.previewContent;
  if (!host || !filesState.previewPath) return;

  if (dom.diffToggle?.checked) {
    const renderNow = () => render(diffView(filesState.diffContent || ''), host);
    if (filesState.diffContent === null) {
      showMessage(t('files.loadingDiff'));
      ensureDiffLoaded().then(renderNow);
      return;
    }
    renderNow();
    return;
  }
  if (dom.mdToggle?.checked && isMarkdownFilePath(filesState.previewPath)) {
    render(markdownView(filesState.previewContent), host);
    return;
  }
  render(codeView(filesState.previewContent, filesState.previewPath), host);
}

export function openFile(path) {
  if (!dom.previewWrap || !dom.previewPath || !dom.previewContent) return;
  ensurePreviewResizeDrag();
  dom.previewPath.textContent = path;
  showMessage(t('files.loading'));
  dom.previewWrap.hidden = false;
  requestAnimationFrame(() => setPreviewHeightPx(getSavedPreviewHeight()));

  filesState.diffContent = null;
  filesState.diffLoading = false;

  api.getFileContent(path).then((data) => {
    if (!data.ok) {
      showMessage(data.error || t('files.readError'));
      return;
    }
    filesState.previewPath = path;
    filesState.previewContent = data.content;
    updateToggleVisibility(dom.mdToggleWrap, dom.mdToggle, isMarkdownFilePath(path));
    updateDiffToggleVisibility(path);
    renderCurrentPreview();
    onChange();
  }).catch((err) => {
    showMessage(err.message || t('files.error'));
  });
}

export function closePreview() {
  if (dom.previewWrap) dom.previewWrap.hidden = true;
}

/** Re-checks the diff toggle after a git status change and drops the cached diff. */
export function refreshPreviewAfterGitChange() {
  if (!filesState.previewPath) return;
  filesState.diffContent = null;
  updateDiffToggleVisibility(filesState.previewPath);
  // diff was on but the file no longer has changes — fall back to the plain preview
  if (dom.diffToggle?.checked && !fileHasGitChanges(filesState.previewPath)) dom.diffToggle.checked = false;
  renderCurrentPreview();
}

export function bindPreviewControls() {
  dom.previewClose?.addEventListener('click', (e) => {
    e.stopPropagation();
    closePreview();
  });
  // markdown and diff are mutually exclusive
  dom.mdToggle?.addEventListener('change', (e) => {
    e.stopPropagation();
    if (dom.mdToggle?.checked && dom.diffToggle) dom.diffToggle.checked = false;
    renderCurrentPreview();
  });
  dom.diffToggle?.addEventListener('change', (e) => {
    e.stopPropagation();
    if (dom.diffToggle?.checked && dom.mdToggle) dom.mdToggle.checked = false;
    renderCurrentPreview();
  });
}
