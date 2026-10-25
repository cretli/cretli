/**
 * Files panel: directory tree of the selected workspace with a file preview.
 */
import {
  registerViewMemoryRestoreHandler,
  schedulePanelViewMemoryCapture,
} from '../../app/appShell/viewMemoryBridge.js';
import { dom, filesScrollContainer } from './state/filesDom.js';
import { filesState } from './state/filesState.js';
import { GIT_STATUS_EVENT, fetchGitStatus } from './services/gitStatus.js';
import { initPreviewPinch, ensurePreviewResizeDrag } from './services/previewInteractions.js';
import {
  clearFilesTree,
  configureFilesTree,
  expandPathIfPresent,
  loadDir,
  renderEmptyTree,
  renderFilesTree,
} from './components/filesTree.js';
import {
  bindPreviewControls,
  configureFilesPreview,
  openFile,
  refreshPreviewAfterGitChange,
} from './components/filesPreview.js';
import {
  closeRootDropdown,
  initFilesSettingsModal,
  initRootDropdown,
  refreshRootLabel,
} from './components/rootPicker.js';

function buildViewMemorySlice() {
  return {
    expandedPaths: [...filesState.expanded],
    scrollTop: filesScrollContainer()?.scrollTop || 0,
    previewPath: filesState.previewPath || '',
  };
}

function scheduleViewMemoryCapture() {
  schedulePanelViewMemoryCapture('files', buildViewMemorySlice);
}

function applyViewMemorySlice(slice) {
  if (!slice || typeof slice !== 'object') return;
  if (Array.isArray(slice.expandedPaths)) {
    const paths = slice.expandedPaths.map(String).filter(Boolean).sort((a, b) => a.split('/').length - b.split('/').length);
    for (const path of paths) expandPathIfPresent(path);
  }
  const scrollEl = filesScrollContainer();
  if (scrollEl && Number.isFinite(Number(slice.scrollTop))) scrollEl.scrollTop = Number(slice.scrollTop);
  const previewPath = String(slice.previewPath || '').trim();
  if (previewPath) openFile(previewPath);
  filesState.pendingViewMemory = null;
}

function tryApplyPendingViewMemory() {
  if (!filesState.pendingViewMemory || !dom.tree?.childElementCount) return;
  applyViewMemorySlice(filesState.pendingViewMemory);
}

function buildRootTree() {
  if (!dom.tree) return;
  closeRootDropdown();
  clearFilesTree();
  refreshRootLabel(renderEmptyTree);
  loadDir('');
  fetchGitStatus().then(renderFilesTree);
  tryApplyPendingViewMemory();
  scheduleViewMemoryCapture();
}

export function initFilesPanel() {
  if (!dom.tree) return;
  configureFilesTree({ onOpen: openFile, onChange: scheduleViewMemoryCapture });
  configureFilesPreview({ onChange: scheduleViewMemoryCapture });
  initRootDropdown(buildRootTree);
  initFilesSettingsModal(buildRootTree);
  buildRootTree();
  ensurePreviewResizeDrag();
  initPreviewPinch();

  window.addEventListener(GIT_STATUS_EVENT, () => {
    fetchGitStatus().then(() => {
      renderFilesTree();
      refreshPreviewAfterGitChange();
    });
  });

  bindPreviewControls();
  registerViewMemoryRestoreHandler('files', (slice) => {
    filesState.pendingViewMemory = slice;
    tryApplyPendingViewMemory();
  });
  filesScrollContainer()?.addEventListener('scroll', () => scheduleViewMemoryCapture(), { passive: true });
}

export function refreshFilesPanel() {
  buildRootTree();
}

/**
 * Open a workspace-relative file from a route adapter (`/files?path=`).
 *
 * @param {string} relativePath
 */
export function openFilesRoutePath(relativePath) {
  const path = typeof relativePath === 'string' ? relativePath.trim() : '';
  if (!path) return;
  openFile(path);
}
