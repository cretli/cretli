/** Directory tree controller: loads directories, tracks expansion, renders with Lit. */
import { render, nothing } from 'lit';
import * as api from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import { dom } from '../state/filesDom.js';
import { filesState } from '../state/filesState.js';
import { getShowHiddenFilesEnabled } from '../services/filesPrefs.js';
import { dirChildrenView, emptyTreeView } from '../views/treeView.js';

/** @type {{ onOpen: (path: string) => void, onChange: () => void }} */
let hooks = { onOpen: () => {}, onChange: () => {} };

export function configureFilesTree(next) {
  hooks = next;
}

export function renderFilesTree() {
  if (!dom.tree) return;
  render(dirChildrenView('', 0, { onToggle: toggleFolder, onOpen: (p) => hooks.onOpen(p) }), dom.tree);
}

export function renderEmptyTree() {
  if (dom.tree) render(emptyTreeView(), dom.tree);
}

export function clearFilesTree() {
  filesState.dirs.clear();
  filesState.expanded.clear();
  filesState.generation += 1;
  if (dom.tree) render(nothing, dom.tree);
}

/** Loads a directory once; cached directories resolve synchronously. */
export function loadDir(relPath) {
  const existing = filesState.dirs.get(relPath);
  if (existing && existing.status !== 'error') return;
  const generation = filesState.generation;
  filesState.dirs.set(relPath, { status: 'loading', entries: [], error: '' });
  renderFilesTree();
  const fail = (message) => {
    if (generation !== filesState.generation) return;
    filesState.dirs.set(relPath, { status: 'error', entries: [], error: message || t('files.error') });
    renderFilesTree();
  };
  api.getFilesEntries(relPath, getShowHiddenFilesEnabled()).then((data) => {
    if (generation !== filesState.generation) return;
    if (!data.ok) return fail(data.error);
    filesState.dirs.set(relPath, { status: 'ok', entries: data.entries || [], error: '' });
    renderFilesTree();
  }).catch((err) => fail(err?.message));
}

export function toggleFolder(path) {
  if (filesState.expanded.has(path)) {
    filesState.expanded.delete(path);
    renderFilesTree();
  } else {
    filesState.expanded.add(path);
    // Errors are not retried automatically, matching the previous behaviour.
    if (!filesState.dirs.has(path)) loadDir(path);
    else renderFilesTree();
  }
  hooks.onChange();
}

/** Expands a folder restored from view memory when its parent listing is already loaded. */
export function expandPathIfPresent(path) {
  const normalized = String(path || '').trim();
  if (!normalized || filesState.expanded.has(normalized)) return;
  const idx = normalized.lastIndexOf('/');
  const parent = idx >= 0 ? normalized.slice(0, idx) : '';
  const name = normalized.slice(idx + 1);
  const node = filesState.dirs.get(parent);
  const entry = node?.status === 'ok' ? node.entries.find((e) => e.name === name && e.isDir) : null;
  if (entry) toggleFolder(normalized);
}
