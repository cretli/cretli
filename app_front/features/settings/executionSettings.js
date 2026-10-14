/**
 * Settings → Execution: per-workspace default execution folder and worktree
 * layout. Shared by the Workspace Watcher cycle and the manual "run todo"
 * start; stored server-side in a store independent of the watcher.
 */

import '../../components/ui/cr-bar-button.js';
import '../../components/ui/cr-bar-select.js';
import { t, getCurrentLang } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { getWatcherWorkspaceFolder, scopeWatcherRequestToWorkspace } from '../watcher/watcherWorkspaceScope.js';

const ROOT_ID = 'settings-execution-root';
const DIRTY_POLICIES = ['block', 'head', 'snapshot'];
/** Absolute path on POSIX (`/...`) or Windows (`C:\...` / `C:/...`). */
const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/)/;

/** @type {{ proposal: object | null }} */
const state = { proposal: null };

/**
 * @param {unknown} value
 * @returns {string}
 */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 */
async function api(path, options = {}) {
  const scoped = scopeWatcherRequestToWorkspace(path, options, getWatcherWorkspaceFolder());
  const headers = { Accept: 'application/json', 'Accept-Language': getCurrentLang() };
  if (scoped.options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await cretliApiFetch(scoped.path, {
    method: scoped.options.method || 'GET',
    headers,
    credentials: 'include',
    body: scoped.options.body !== undefined ? JSON.stringify(scoped.options.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/**
 * One argv argument per non-empty line; never a shell string.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function prepareLines(value) {
  if (Array.isArray(value)) return value.map((part) => String(part ?? '').trim()).filter(Boolean);
  return String(value ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * @param {HTMLElement} root
 * @param {object} data API response (`effective`, `proposal`, `saved`)
 */
function render(root, data) {
  const eff = data.effective || {};
  const wt = eff.worktree || {};
  const isWorktree = eff.executionMode === 'worktree';
  state.proposal = data.proposal || null;
  const field = (id, key, label, placeholder) => `<label class="cr-field"><span class="cr-field-label">${esc(t(label))}</span><input id="${id}" type="text" placeholder="${esc(placeholder)}" value="${esc(wt[key] || '')}"></label>`;
  root.innerHTML = `
    <div class="cr-page-body">
      <p class="cr-hint">${esc(t('settings.executionHint'))}</p>
      <div class="cr-field">
        <span class="cr-field-label">${esc(t('settings.executionMode'))}</span>
        <label class="cr-check"><input type="radio" name="execution-mode" value="project"${isWorktree ? '' : ' checked'}> ${esc(t('settings.executionModeProject'))}</label>
        <label class="cr-check"><input type="radio" name="execution-mode" value="worktree"${isWorktree ? ' checked' : ''}> ${esc(t('settings.executionModeWorktree'))}</label>
      </div>
      ${field('execution-root', 'root', 'settings.executionWorktreeRoot', '/var/lib/cretli/worktrees')}
      ${field('execution-namespace', 'namespace', 'settings.executionWorktreeNamespace', 'my-app')}
      ${field('execution-branch-prefix', 'branchPrefix', 'settings.executionWorktreeBranchPrefix', 'my-app/todo/')}
      ${field('execution-directory-prefix', 'directoryPrefix', 'settings.executionWorktreeDirectoryPrefix', 't-')}
      <div class="cr-field">
        <span class="cr-field-label">${esc(t('settings.executionDirtyPolicy'))}</span>
        <cr-bar-select id="execution-dirty-policy" value="${DIRTY_POLICIES.includes(wt.dirtyPolicy) ? wt.dirtyPolicy : 'block'}"></cr-bar-select>
        <p class="cr-hint">${esc(t('settings.executionDirtyPolicyHint'))}</p>
      </div>
      <label class="cr-field"><span class="cr-field-label">${esc(t('settings.executionPrepare'))}</span><textarea id="execution-prepare" rows="3" placeholder="npm&#10;ci">${esc(prepareLines(wt.prepareCommand).join('\n'))}</textarea></label>
      <p class="cr-hint">${esc(t('settings.executionPrepareHint'))}</p>
      ${data.proposal?.available ? `<p class="cr-hint">${esc(t('settings.executionProposalHint'))} <code>${esc(data.proposal.repoRoot || '')}</code></p>` : ''}
      <p class="cr-status" id="execution-status" data-tone=""></p>
    </div>
    <div class="cr-page-footer cr-row">
      <cr-bar-button id="execution-save" variant="primary">${esc(t('settings.executionSave'))}</cr-bar-button>
      <cr-bar-button id="execution-reset">${esc(t('settings.executionReset'))}</cr-bar-button>
    </div>`;
  const select = root.querySelector('#execution-dirty-policy');
  if (select) select.options = DIRTY_POLICIES.map((value) => ({ value, label: t(`settings.executionDirtyPolicy_${value}`) }));
}

/**
 * @param {HTMLElement} root
 * @param {string} text
 * @param {'error' | 'success' | ''} tone
 */
function setStatus(root, text, tone = '') {
  const el = root.querySelector('#execution-status');
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

/**
 * @param {HTMLElement} root
 * @returns {{ body: object, error: string }}
 */
function readForm(root) {
  const val = (id) => String(root.querySelector(id)?.value || '').trim();
  const executionMode = root.querySelector('input[name="execution-mode"]:checked')?.value === 'worktree' ? 'worktree' : 'project';
  const worktree = {
    root: val('#execution-root'),
    namespace: val('#execution-namespace'),
    branchPrefix: val('#execution-branch-prefix'),
    directoryPrefix: val('#execution-directory-prefix'),
    dirtyPolicy: val('#execution-dirty-policy') || 'block',
    prepareCommand: prepareLines(root.querySelector('#execution-prepare')?.value || ''),
  };
  let error = '';
  const started = executionMode === 'worktree' || [worktree.root, worktree.namespace, worktree.branchPrefix, worktree.directoryPrefix].some(Boolean);
  if (started) {
    if (worktree.root && !ABSOLUTE_PATH_RE.test(worktree.root)) error = t('settings.executionValidationRoot');
    else if (/[\\/]/.test(worktree.namespace) || worktree.namespace === '.' || worktree.namespace === '..') error = t('settings.executionValidationNamespace');
    else if (executionMode === 'worktree' && state.proposal?.available !== true
      && (!worktree.root || !worktree.namespace || !worktree.branchPrefix || !worktree.directoryPrefix)) {
      error = t('settings.executionValidationLayout');
    }
  }
  return { body: { executionMode, worktree }, error };
}

/** Fetch and paint the panel. */
export async function refreshExecutionSettingsPanel() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  const { status, json } = await api('/api/execution-settings');
  if (status !== 200 || !json?.ok) {
    root.textContent = json?.error || t('settings.executionLoadFailed');
    return;
  }
  render(root, json);
}

/** Wire the panel once (delegated listeners survive re-render). */
export function initExecutionSettingsPanel() {
  const root = document.getElementById(ROOT_ID);
  if (!root || root.dataset.bound === 'true') return;
  root.dataset.bound = 'true';
  root.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target.closest('cr-bar-button') : null;
    if (!target) return;
    if (target.id === 'execution-reset') {
      const proposal = state.proposal || {};
      const wt = proposal.worktree || {};
      render(root, { effective: { executionMode: proposal.executionMode || 'project', worktree: wt }, proposal });
      return;
    }
    if (target.id !== 'execution-save') return;
    const { body, error } = readForm(root);
    if (error) return setStatus(root, error, 'error');
    const { status, json } = await api('/api/execution-settings', { method: 'PATCH', body });
    if (status !== 200 || !json?.ok) return setStatus(root, json?.error || t('settings.executionSaveFailed'), 'error');
    render(root, json);
    setStatus(root, t('settings.executionSaved'), 'success');
  });
}
