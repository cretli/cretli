/**
 * Workspace quick menu and the sidebar filter toggle.
 *
 * The branch chip in the sidebar workspace bar (`#header-workspace-branch`)
 * opens the workspace popover; the bar's filter button toggles "active
 * workspace only". The popover is a `role=dialog`: the workspace list stays in
 * its `ul[role=listbox]`, while the branch section (listbox of its own) lives
 * OUTSIDE that listbox. Branch switching is server-authoritative: the dirty-tree
 * confirmation here is only UX, and a busy workspace is refused by the server
 * guard (`workspace_busy`).
 */

import { initDropdown } from '../../lib/dropdown.js';
import * as api from '../../core/api/index.js';
import { t } from '../../i18n/index.js';
import { refreshGitContextBadge } from '../../gitContextBadge.js';
import {
  getWorkspaceBranchBadgeInfo,
  refreshWorkspaceBranchBadge,
} from './workspaceBranchBadge.js';
import {
  readSidebarOnlyActiveWorkspaceFlag,
  writeSidebarOnlyActiveWorkspaceFlag,
} from '../../features/sidebar/sidebarOnlyActiveFilter.js';

/** Same allow-list the server applies to git action arguments. */
function argSafeBranchName(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed.startsWith('-')) return '';
  if (!/^[0-9A-Za-z._/-]+$/.test(trimmed)) return '';
  return trimmed;
}

export function initWorkspaceBranchMenu(deps = {}) {
  const chip = document.getElementById('header-workspace-branch');
  const popover = document.getElementById('header-workspace-popover');
  if (!chip || !popover) return null;
  const getWorkspaceFolder = typeof deps.getActiveWorkspaceFolder === 'function'
    ? deps.getActiveWorkspaceFolder
    : () => '';
  const onGitMutated = typeof deps.onGitMutated === 'function' ? deps.onGitMutated : null;
  const onFilterChanged = typeof deps.onFilterChanged === 'function' ? deps.onFilterChanged : null;

  const dropdown = initDropdown({
    triggerEl: chip,
    floatingEl: popover,
    compact: true,
    placement: 'bottom-start',
    offsetPx: 6,
    viewportPadding: 8,
    minWidthPx: 260,
    maxHeightPx: 420,
  });

  let messageTimer = 0;

  function sectionEl() {
    return popover.querySelector('#header-branch-section');
  }

  function showMessage(text, tone) {
    const section = sectionEl();
    if (!section) return;
    let message = section.querySelector('.header-branch-message');
    if (!text) {
      message?.remove();
      return;
    }
    if (!message) {
      message = document.createElement('p');
      message.className = 'header-branch-message';
      section.appendChild(message);
    }
    message.dataset.tone = tone === 'success' ? 'success' : 'error';
    message.textContent = text;
    window.clearTimeout(messageTimer);
    messageTimer = window.setTimeout(() => message?.remove(), 6000);
  }

  function currentWorkspaceFolder() {
    return String(getWorkspaceFolder() || '').trim();
  }

  /** Git info for the dirty-tree UX guard; reuses the badge's last fetch. */
  async function readWorkspaceGitInfo() {
    let info = getWorkspaceBranchBadgeInfo();
    if (info && Array.isArray(info.statusShort)) return info;
    const folder = currentWorkspaceFolder();
    if (!folder) return null;
    try {
      info = await api.getGitInfo({ workspaceFolder: folder });
    } catch (_) {
      return null;
    }
    return info && Array.isArray(info.statusShort) ? info : null;
  }

  function confirmDirtyTree() {
    return new Promise((resolve) => {
      let confirmed = false;
      const dialog = document.createElement('cr-dialog');
      dialog.heading = t('workspace.dirtyTreeHeading');
      const body = document.createElement('p');
      body.textContent = t('workspace.dirtyTreeConfirm');
      dialog.appendChild(body);
      const actions = document.createElement('div');
      actions.setAttribute('slot', 'actions');
      const cancelBtn = document.createElement('cr-bar-button');
      cancelBtn.textContent = t('common.cancel');
      cancelBtn.addEventListener('click', () => dialog.hide());
      const switchBtn = document.createElement('cr-bar-button');
      switchBtn.variant = 'primary';
      switchBtn.textContent = t('workspace.switchBranch');
      switchBtn.addEventListener('click', () => {
        confirmed = true;
        dialog.hide();
      });
      actions.append(cancelBtn, switchBtn);
      dialog.appendChild(actions);
      dialog.addEventListener('cr-dialog-close', () => {
        dialog.remove();
        resolve(confirmed);
      }, { once: true });
      document.body.appendChild(dialog);
      dialog.show();
    });
  }

  async function runSwitchAction(action, arg) {
    const folder = currentWorkspaceFolder();
    if (!folder) return;
    const info = await readWorkspaceGitInfo();
    const dirty = Array.isArray(info?.statusShort) && info.statusShort.length > 0;
    if (dirty && !(await confirmDirtyTree())) return;
    showMessage('');
    let result = null;
    try {
      result = await api.postGitAction({ action, arg }, { workspaceFolder: folder });
    } catch (_) {
      result = null;
    }
    if (!result?.ok) {
      showMessage(result?.error || t('workspace.branchSwitchFailed'), 'error');
      return;
    }
    showMessage(t('workspace.branchSwitched', { branch: arg }), 'success');
    // Refresh every consumer of the (pre-existing) git change flow: the
    // workspace chip, the execution badge and the git panel — whose refresh
    // dispatches `cretli-git-changed` for the files panel.
    void refreshWorkspaceBranchBadge({ force: true });
    void refreshGitContextBadge({ force: true });
    if (onGitMutated) onGitMutated();
    void renderBranchSection();
  }

  function renderBranchList(branches, currentBranch) {
    const list = popover.querySelector('#header-branch-list');
    if (!list) return;
    list.innerHTML = '';
    const current = String(currentBranch || '').trim();
    const rows = Array.isArray(branches) && branches.length ? branches : [];
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'header-branch-empty';
      empty.textContent = t('workspace.branchListEmpty');
      list.appendChild(empty);
      return;
    }
    for (const branch of rows) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'header-branch-item';
      item.setAttribute('role', 'option');
      item.setAttribute('tabindex', '-1');
      const isCurrent = branch.current || (current && branch.name === current);
      if (isCurrent) {
        item.classList.add('is-current');
        item.setAttribute('aria-selected', 'true');
      }
      if (!branch.argSafe) {
        item.setAttribute('aria-disabled', 'true');
        item.title = t('workspace.branchUnsafe');
      } else {
        item.addEventListener('click', () => {
          if (isCurrent) return;
          void runSwitchAction('switch', branch.name);
        });
      }
      const marker = document.createElement('span');
      marker.className = 'header-branch-item-marker';
      marker.textContent = isCurrent ? '•' : '';
      marker.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'header-branch-item-name';
      name.textContent = branch.name;
      item.append(marker, name);
      list.appendChild(item);
    }
  }

  async function renderBranchSection() {
    const section = sectionEl();
    if (!section || section.hidden) return;
    const folder = currentWorkspaceFolder();
    if (!folder) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    let result = null;
    try {
      result = await api.getGitBranches({ workspaceFolder: folder });
    } catch (_) {
      result = null;
    }
    if (!result?.ok) {
      showMessage(result?.error || t('workspace.branchListFailed'), 'error');
      return;
    }
    const currentEl = popover.querySelector('#header-branch-current');
    const info = await readWorkspaceGitInfo();
    const currentName = (result.branches || []).find((branch) => branch.current)?.name
      || String(info?.branch === 'HEAD' ? info.head || '' : info?.branch || '');
    if (currentEl) {
      currentEl.textContent = currentName || '—';
      currentEl.title = currentName;
    }
    renderBranchList(result.branches || [], currentName);
  }

  function wireNewBranchControls() {
    const input = popover.querySelector('#header-branch-new-input');
    const button = popover.querySelector('#header-branch-new-btn');
    if (!input || !button || input.dataset.bound === '1') return;
    input.dataset.bound = '1';
    const submit = () => {
      const name = argSafeBranchName(input.value);
      if (!name) {
        showMessage(t('workspace.branchInvalidName'), 'error');
        return;
      }
      input.value = '';
      void runSwitchAction('switch-new', name);
    };
    button.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
  }

  const filterBtn = document.getElementById('sidebar-only-active-btn');

  function paintFilterToggle() {
    if (!filterBtn) return;
    const on = readSidebarOnlyActiveWorkspaceFlag();
    filterBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    filterBtn.classList.toggle('is-active', on);
  }

  if (filterBtn) {
    paintFilterToggle();
    filterBtn.addEventListener('click', () => {
      writeSidebarOnlyActiveWorkspaceFlag(!readSidebarOnlyActiveWorkspaceFlag());
      paintFilterToggle();
      if (onFilterChanged) onFilterChanged();
    });
  }

  chip.addEventListener('click', () => {
    if (dropdown.isOpen()) {
      dropdown.close();
      return;
    }
    const contentReady = typeof deps.refreshMenuContent === 'function'
      ? deps.refreshMenuContent()
      : Promise.resolve(true);
    void Promise.all([contentReady, Promise.resolve()]).then(([ok]) => {
      if (!ok) return;
      wireNewBranchControls();
      dropdown.open();
      void renderBranchSection();
    });
  });

  chip.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    chip.click();
  });

  return {
    open: () => chip.click(),
    close: () => dropdown.close(),
    isOpen: () => dropdown.isOpen(),
  };
}
