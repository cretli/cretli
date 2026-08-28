import * as api from './core/api/index.js';
import { t } from './i18n/index.js';

const ACTION_NEEDS_ARG = new Set(['switch', 'switch-new', 'merge', 'rebase']);

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

function renderInfo(info) {
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
  setText('git-info-branch', formatBranchLabel(info));
  setText('git-info-upstream', info.upstream || '—');
  setText('git-info-head', info.head || '—');
}

function renderOutput(text) {
  const out = document.getElementById('git-output');
  if (!out) return;
  out.textContent = text || '';
  out.scrollTop = out.scrollHeight;
}

export function refreshGitInfo() {
  return api.getGitInfo().then((data) => {
    if (!data?.ok) {
      renderInfo(null);
      renderOutput(data?.error ? t('git.errorDetail', { detail: data.error }) : t('git.fetchError'));
      return;
    }
    renderInfo(data);
    if (Array.isArray(data.statusShort) && data.statusShort.length) {
      renderOutput(data.statusShort.join('\n'));
    } else {
      renderOutput('');
    }
    window.dispatchEvent(new CustomEvent('cretli-git-changed', { detail: data }));
  }).catch(() => {
    renderInfo(null);
    renderOutput(t('git.fetchError'));
  });
}

function runAction(action, arg) {
  if (!action) return;
  if (ACTION_NEEDS_ARG.has(action) && !arg) {
    renderOutput(t('git.missingValue'));
    return;
  }
  renderOutput(t('git.running'));
  api.postGitAction({ action, arg }).then((data) => {
    if (!data?.ok) {
      renderOutput(data?.error ? t('git.errorDetail', { detail: data.error }) : t('git.runFailed'));
      return;
    }
    const header = data.command ? `$ ${data.command}\n` : '';
    renderOutput(header + (data.output || ''));
    refreshGitInfo();
  }).catch(() => {
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

function initActionForm() {
  const select = document.getElementById('git-action-select');
  const input = document.getElementById('git-action-arg');
  const runBtn = document.getElementById('git-action-run');
  if (!select || !input || !runBtn) return;

  function updatePlaceholder() {
    const needsArg = ACTION_NEEDS_ARG.has(select.value);
    input.placeholder = needsArg ? t('git.actionPlaceholder') : '—';
    input.disabled = !needsArg;
    if (!needsArg) input.value = '';
  }

  select.addEventListener('change', updatePlaceholder);
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
}
