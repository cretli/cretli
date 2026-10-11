/**
 * Settings → Harness: external benchmark sources panel (display-only).
 *
 * Loads registry state via GET only. Import uses same-origin API; no outbound
 * benchmark fetch and no inference.
 */

import {
  getHarnessBenchmarkSources,
  putHarnessBenchmarkImport,
} from '../../api.js';
import { t } from '../../i18n/index.js';
import {
  buildHarnessBenchmarkSourcesViewModel,
  buildLocalFixtureImportBody,
  renderHarnessBenchmarkSourcesHtml,
} from './harnessBenchmarkSourcesModel.js';

let wired = false;
let loadSeq = 0;
/** @type {object|null} */
let currentPayload = null;

/**
 * @returns {HTMLElement|null}
 */
function outputEl() {
  return document.getElementById('harness-benchmark-sources-output');
}

/**
 * @returns {HTMLElement|null}
 */
function statusEl() {
  return document.getElementById('harness-benchmark-sources-status');
}

/**
 * @param {string} message
 * @param {'error'|'success'|''} [tone]
 */
function setStatus(message, tone = '') {
  const el = statusEl();
  if (!el) return;
  el.textContent = message || '';
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

/**
 * @returns {Promise<void>}
 */
export async function refreshHarnessBenchmarkSourcesPanel() {
  const seq = ++loadSeq;
  setStatus(t('harnessBenchmarkSources.loading'));
  try {
    const payload = await getHarnessBenchmarkSources();
    if (seq !== loadSeq) return;
    if (!payload?.ok) {
      setStatus(payload?.error || t('harnessBenchmarkSources.loadFailed'), 'error');
      return;
    }
    currentPayload = payload;
    const model = buildHarnessBenchmarkSourcesViewModel(payload, t);
    const out = outputEl();
    if (out) out.innerHTML = renderHarnessBenchmarkSourcesHtml(model, t);
    setStatus('');
  } catch {
    if (seq !== loadSeq) return;
    setStatus(t('harnessBenchmarkSources.loadFailed'), 'error');
  }
}

/**
 * @param {string} sourceId
 * @returns {Promise<void>}
 */
async function importFixture(sourceId) {
  if (!currentPayload?.etag) {
    await refreshHarnessBenchmarkSourcesPanel();
  }
  const etag = String(currentPayload?.etag || '');
  if (!etag) {
    setStatus(t('harnessBenchmarkSources.importFailed'), 'error');
    return;
  }
  setStatus(t('harnessBenchmarkSources.importing'));
  try {
    const body = buildLocalFixtureImportBody();
    if (sourceId) body.sourceId = sourceId;
    const result = await putHarnessBenchmarkImport(body, etag);
    if (result?.conflict) {
      setStatus(t('harnessBenchmarkSources.conflict'), 'error');
      await refreshHarnessBenchmarkSourcesPanel();
      return;
    }
    if (!result?.ok) {
      setStatus(result?.error || t('harnessBenchmarkSources.importFailed'), 'error');
      return;
    }
    setStatus(t('harnessBenchmarkSources.importDone'), 'success');
    await refreshHarnessBenchmarkSourcesPanel();
  } catch {
    setStatus(t('harnessBenchmarkSources.importFailed'), 'error');
  }
}

/**
 * Wire panel controls once.
 */
export function initHarnessBenchmarkSources() {
  if (wired) return;
  wired = true;
  const section = document.getElementById('harness-benchmark-sources-section');
  if (!section) return;
  document.getElementById('harness-benchmark-sources-refresh')?.addEventListener('click', () => {
    void refreshHarnessBenchmarkSourcesPanel();
  });
  section.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const sourceId = target.getAttribute('data-benchmark-import');
    if (!sourceId) return;
    void importFixture(sourceId);
  });
}
