/** Lit templates for the directory tree. */
import { html, nothing } from 'lit';
import { t } from '../../../i18n/index.js';
import { filesState } from '../state/filesState.js';
import { gitClassFor } from '../services/gitStatus.js';

export function formatBytes(value) {
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

export function formatEntryMeta(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (entry.isDir) {
    const count = Number(entry.dirEntries);
    return Number.isFinite(count) && count >= 0 ? `${count}` : '';
  }
  return formatBytes(entry.sizeBytes);
}

export function emptyTreeView() {
  return html`<div class="files-tree-empty">${t('files.noWorkspace')}</div>`;
}

/**
 * Children of one directory (loading / error / empty / entries).
 *
 * @param {string} parentPath '' for the workspace root
 * @param {number} depth
 * @param {{ onToggle: (path: string) => void, onOpen: (path: string) => void }} handlers
 */
export function dirChildrenView(parentPath, depth, handlers) {
  const node = filesState.dirs.get(parentPath);
  if (!node || node.status === 'loading') {
    return html`<span class="files-tree-loading">${t('files.loading')}</span>`;
  }
  if (node.status === 'error') return html`<span class="files-tree-error">${node.error}</span>`;
  if (node.entries.length === 0) return html`<div class="files-tree-empty">${t('files.empty')}</div>`;
  return node.entries.map((entry) => entryView(entry, depth, parentPath, handlers));
}

function entryView(entry, depth, parentPath, handlers) {
  const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  const isDir = !!entry.isDir;
  const expanded = isDir && filesState.expanded.has(path);
  const gitClass = gitClassFor(path, isDir);
  const cls = `${isDir ? 'files-tree-item--dir' : 'files-tree-item--file'}${gitClass ? ` ${gitClass}` : ''}`;
  const onClick = (e) => {
    e.stopPropagation();
    if (isDir) handlers.onToggle(path);
    else handlers.onOpen(path);
  };
  const showGroup = isDir && (expanded || filesState.dirs.has(path));
  return html`<div role="treeitem" aria-expanded=${expanded ? 'true' : 'false'} class=${cls} data-path=${path} data-is-dir=${isDir ? '1' : '0'}>
    <div class="files-tree-row" style="padding-left:${depth * 0.75 + 0.4}rem" @click=${onClick}>
      <span class="files-tree-arrow" aria-hidden="true">${isDir ? html`<span class="mdi ${expanded ? 'mdi-chevron-down' : 'mdi-chevron-right'}" aria-hidden="true"></span>` : nothing}</span>
      <span class="files-tree-icon"><span class="mdi ${isDir ? 'mdi-folder-outline' : 'mdi-file-document-outline'}" aria-hidden="true"></span></span>
      <span class="files-tree-name">${entry.name}</span>
      <span class="files-tree-meta">${formatEntryMeta(entry)}</span>
    </div>
    ${isDir ? html`<div role="group" class="files-tree-group" ?hidden=${!expanded}>${showGroup ? dirChildrenView(path, path.split('/').filter(Boolean).length, handlers) : nothing}</div>` : nothing}
  </div>`;
}
