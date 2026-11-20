/**
 * Settings → Harness: model prices and statistics per (model, role, level).
 *
 * GET only (`/api/delegations/stats`); display-only, it never changes
 * model_pick ranking and triggers no outbound fetch.
 */

import { getDelegationStats } from '../../core/api/index.js';
import { t } from '../../i18n/index.js';
import {
  buildHarnessModelStatsViewModel,
  renderHarnessModelStatsHtml,
} from './harnessModelStatsModel.js';

let wired = false;
let loadSeq = 0;

/**
 * @returns {{ workspaceFolder: string, workspaceFile: string }}
 */
function activeWorkspaceScope() {
  const trigger = document.getElementById('header-workspace-trigger');
  return {
    workspaceFolder: String(trigger?.dataset?.workspaceFolder || '').trim(),
    workspaceFile: String(trigger?.dataset?.workspaceFile || '').trim(),
  };
}

/**
 * @param {string} message
 * @param {'error'|''} [tone]
 */
function setStatus(message, tone = '') {
  const el = document.getElementById('harness-model-stats-status');
  if (!el) return;
  el.textContent = message || '';
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

/**
 * @returns {Promise<void>}
 */
export async function refreshHarnessModelStatsPanel() {
  const seq = ++loadSeq;
  setStatus(t('harnessModelStats.loading'));
  try {
    const payload = await getDelegationStats(activeWorkspaceScope());
    if (seq !== loadSeq) return;
    if (!payload?.ok) {
      setStatus(payload?.error || t('harnessModelStats.loadFailed'), 'error');
      return;
    }
    const out = document.getElementById('harness-model-stats-output');
    if (out) out.innerHTML = renderHarnessModelStatsHtml(buildHarnessModelStatsViewModel(payload), t);
    setStatus('');
  } catch {
    if (seq !== loadSeq) return;
    setStatus(t('harnessModelStats.loadFailed'), 'error');
  }
}

/**
 * Wire panel controls once.
 */
export function initHarnessModelStats() {
  if (wired) return;
  wired = true;
  document.getElementById('harness-model-stats-refresh')?.addEventListener('click', () => {
    void refreshHarnessModelStatsPanel();
  });
}
