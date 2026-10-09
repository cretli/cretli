import * as api from './core/api/index.js';
import { t } from './i18n/index.js';
import {
  buildGitScopeKey,
  getGitScope,
  getGitScopeRevision,
  setGitScope,
  subscribeGitScope,
} from './features/git/gitScope.js';
import {
  buildGitDetailRows,
  deriveGitContextBadge,
  resolveGitBranch,
} from './features/git/gitContextView.js';

const ACTION_NEEDS_ARG = new Set(['switch', 'switch-new', 'merge', 'rebase']);

/** Monotonic request id: a newer refresh drops every older in-flight answer. */
let refreshRequestId = 0;

function setText(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value || '—';
}

function setBadge(text, type) {
  const badge = document.getElementById('git-status-badge');
  if (!badge) return;
  badge.textContent = text || '—';
  badge.classList.remove('git-status-badge--ok', 'git-status-badge--warn', 'git-status-badge--error');
  if (type) badge.classList.add(`git-status-badge--${type}`);
}

function formatBranchLabel(info) {
  if (!info) return '—';
  if (!info.branch) return '—';
  if (!info.upstream) return info.branch;
  const aheadBehind = info.aheadBehind ? ` (${info.aheadBehind})` : '';
  return `${info.branch} → ${info.upstream}${aheadBehind}`;
}

/**
 * Compact context chip in the toolbar: which chat/task the panel is showing.
 *
 * @param {object | null} info
 */
function renderContextChip(info) {
  const chip = document.getElementById('git-context-chip');
  if (!chip) return;
  if (!info || (!info.chatId && !info.todoId && !info.isWorktree)) {
    chip.hidden = true;
    chip.textContent = '';
    chip.className = 'git-context-chip';
    return;
  }
  const badge = deriveGitContextBadge(info, t);
  chip.hidden = false;
  chip.textContent = badge.branch ? `${badge.label} · ${badge.branch}` : badge.label;
  chip.title = badge.title;
  chip.dataset.kind = badge.kind;
  chip.className = `git-context-chip git-context-chip--${badge.tone}`;
}

/**
 * Context-specific detail rows (project, base commit, changes, task, integration).
 *
 * @param {object | null} info
 */
function renderDetailRows(info) {
  const host = document.getElementById('git-info-details');
  if (!host) return;
  host.replaceChildren();
  const rows = buildGitDetailRows(info, t);
  for (const row of rows) {
    const wrap = document.createElement('div');
    wrap.className = 'git-info-row';
    wrap.dataset.detail = row.key;
    const label = document.createElement('span');
    label.className = 'git-info-label';
    label.textContent = row.label;
    const value = document.createElement('span');
    value.className = 'git-info-value';
    value.textContent = row.value;
    if (row.tone) value.dataset.tone = row.tone;
    wrap.append(label, value);
    host.append(wrap);
  }
}

function renderOutput(text) {
  const out = document.getElementById('git-output');
  if (!out) return;
  out.textContent = text || '';
  out.scrollTop = out.scrollHeight;
}

function renderInfo(info) {
  renderContextChip(info);
  renderDetailRows(info);
  if (!info) {
    setBadge(t('git.noData'), 'error');
    setText('git-info-cwd', '—');
    setText('git-info-repo', '—');
    setText('git-info-branch', '—');
    setText('git-info-upstream', '—');
    setText('git-info-head', '—');
    return;
  }
  setText('git-info-cwd', info.cwd || '—');
  if (!info.isRepo) {
    setBadge(t('git.noRepo'), 'warn');
    setText('git-info-repo', '—');
    setText('git-info-branch', '—');
    setText('git-info-upstream', '—');
    setText('git-info-head', '—');
    return;
  }
  setBadge(t('git.repoActive'), 'ok');
  setText('git-info-repo', info.topLevel || '—');
  setText('git-info-branch', resolveGitBranch(info) ? formatBranchLabel(info) : '—');
  setText('git-info-upstream', info.upstream || '—');
  setText('git-info-head', info.head || '—');
}

/**
 * Fetch Git info for the active scope and repaint the panel. The captured
 * request id and scope key make a late answer for a previous chat/workspace a
 * no-op instead of overwriting the newer context.
 *
 * @returns {Promise<object | null>}
 */
export function refreshGitInfo() {
  const requestId = ++refreshRequestId;
  const scope = getGitScope();
  const scopeKey = buildGitScopeKey(scope);
  const revision = getGitScopeRevision();
  const isCurrent = () =>
    requestId === refreshRequestId
    && revision === getGitScopeRevision()
    && scopeKey === buildGitScopeKey(getGitScope());
  return api.getGitInfo(scope).then((data) => {
    if (!isCurrent()) return null;
    if (!data?.ok) {
      renderInfo(null);
      renderOutput(data?.error ? t('git.errorDetail', { detail: data.error }) : t('git.fetchError'));
      return null;
    }
    renderInfo(data);
    if (Array.isArray(data.statusShort) && data.statusShort.length) {
      renderOutput(data.statusShort.join('\n'));
    } else {
      renderOutput('');
    }
    window.dispatchEvent(new CustomEvent('cretli-git-changed', { detail: data }));
    return data;
  }).catch(() => {
    if (!isCurrent()) return null;
    renderInfo(null);
    renderOutput(t('git.fetchError'));
    return null;
  });
}

/**
 * Point the panel (and the compact indicator) at a chat or task and refresh.
 * A null scope resets to the legacy global cwd.
 *
 * @param {object | null} scope
 * @returns {number} the new scope revision
 */
export function setGitPanelScope(scope) {
  const revision = setGitScope(scope || null);
  if (document.getElementById('git-panel')?.classList.contains('active')) {
    void refreshGitInfo();
  }
  return revision;
}

/**
 * @returns {{ chatId: string, todoId: string, workspaceFolder: string }}
 */
export function getGitPanelScope() {
  return getGitScope();
}

function runAction(action, arg) {
  if (!action) return;
  if (ACTION_NEEDS_ARG.has(action) && !arg) {
    renderOutput(t('git.missingValue'));
    return;
  }
  renderOutput(t('git.running'));
  const scope = getGitScope();
  const scopeKey = buildGitScopeKey(scope);
  const requestId = ++refreshRequestId;
  api.postGitAction({ action, arg }, scope).then((data) => {
    if (requestId !== refreshRequestId || scopeKey !== buildGitScopeKey(getGitScope())) return;
    if (!data?.ok) {
      renderOutput(data?.error ? t('git.errorDetail', { detail: data.error }) : t('git.runFailed'));
      return;
    }
    const header = data.command ? `$ ${data.command}\n` : '';
    renderOutput(header + (data.output || ''));
    refreshGitInfo();
  }).catch(() => {
    if (requestId !== refreshRequestId || scopeKey !== buildGitScopeKey(getGitScope())) return;
    renderOutput(t('git.runFailed'));
  });
}

function initQuickButtons() {
  document.querySelectorAll('.git-action-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      runAction(action, '');
    });
  });
}

function getGitActionSelectOptions() {
  return [
    { value: '', label: t('git.chooseAction') },
    { value: 'switch', label: 'git switch <name>' },
    { value: 'switch-new', label: 'git switch -c <name>' },
    { value: 'merge', label: 'git merge <name>' },
    { value: 'rebase', label: 'git rebase <name>' },
  ];
}

function initActionForm() {
  const select = document.getElementById('git-action-select');
  const input = document.getElementById('git-action-arg');
  const runBtn = document.getElementById('git-action-run');
  if (!select || !input || !runBtn) return;
  if ('options' in select) {
    select.options = getGitActionSelectOptions();
  }

  function updatePlaceholder() {
    const needsArg = ACTION_NEEDS_ARG.has(select.value);
    input.placeholder = needsArg ? t('git.actionPlaceholder') : '—';
    input.disabled = !needsArg;
    if (!needsArg) input.value = '';
  }

  select.addEventListener('change', updatePlaceholder);
  window.addEventListener('cr-lang-changed', () => {
    if ('options' in select) {
      const current = select.value;
      select.options = getGitActionSelectOptions();
      select.value = current;
    }
    updatePlaceholder();
  });
  updatePlaceholder();

  runBtn.addEventListener('click', () => {
    runAction(select.value, (input.value || '').trim());
  });
}

export function initGitPanel() {
  const refreshBtn = document.getElementById('git-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => refreshGitInfo());
  }
  initQuickButtons();
  initActionForm();
  // A scope switch while the panel is open must repaint immediately.
  subscribeGitScope(() => {
    if (document.getElementById('git-panel')?.classList.contains('active')) {
      void refreshGitInfo();
    }
  });
}
