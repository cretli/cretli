/**
 * Settings → Harness: external benchmark source configuration.
 *
 * Keys stay server-side. Official API fetching requires an explicit operator action.
 */

import {
  getHarnessBenchmarkSources,
  putHarnessBenchmarkImport,
  updateHarnessBenchmarkSource,
} from '../../core/api/index.js';
import { t } from '../../i18n/index.js';
import {
  buildHarnessBenchmarkSourcesViewModel,
  buildLocalFixtureImportBody,
  renderHarnessBenchmarkSourcesHtml,
} from './harnessBenchmarkSourcesModel.js';

let wired = false;
let isSaving = false;
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
    const action = target.closest('[data-benchmark-action]')?.getAttribute('data-benchmark-action');
    if (action) { void configureSource(action); return; }
    const sourceId = target.getAttribute('data-benchmark-import');
    if (!sourceId) return;
    void importFixture(sourceId);
  });
}

/** Save operator configuration without returning or displaying the stored key. */
async function configureSource(action) {
  if (isSaving) return;
  const read = (id) => document.getElementById(`benchmark-${id}`);
  const source = currentPayload?.sources?.find((row) => row.id === 'artificial-analysis');
  if (!source || !currentPayload?.etag) return;
  let body = { sourceId: source.id };
  if (action === 'toggle') body.enabled = !source.enabled;
  if (action === 'fetch') body.force = read('force')?.checked === true;
  const keyInput = read('api-key');
  const key = String(keyInput?.value || '').trim();
  if (action === 'saveKey' && !key) return;
  isSaving = true;
  const controls = document.querySelectorAll('#harness-benchmark-sources-section cr-bar-button');
  const disabledStates = Array.from(controls, (control) => control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  setStatus(t('harnessBenchmarkSources.working'));
  try {
    const result = action === 'saveKey' || action === 'clearKey'
      ? await updateHarnessBenchmarkSource('key', action === 'saveKey' ? { apiKey: key } : { clear: true }, currentPayload.etag)
      : await updateHarnessBenchmarkSource(action === 'toggle' ? 'source' : action === 'test' ? 'test' : 'fetch', body, currentPayload.etag);
    if (result?.ok === false) {
      if (result.conflict) await refreshHarnessBenchmarkSourcesPanel();
      setStatus(result.error || t('harnessBenchmarkSources.importFailed'), 'error');
      return;
    }
    if (action === 'test') {
      setStatus(t('harnessBenchmarkSources.testSuccess', { count: result.entryCount }), 'success');
      return;
    }
    if (keyInput) keyInput.value = '';
    await refreshHarnessBenchmarkSourcesPanel();
    const verifiedSaved = currentPayload?.apiKeys?.['artificial-analysis']?.saved;
    if (action === 'saveKey' && !verifiedSaved) { setStatus(t('harnessBenchmarkSources.keySaveFailed'), 'error'); return; }
    setStatus(t(action === 'saveKey' ? 'harnessBenchmarkSources.keySaved' : 'harnessBenchmarkSources.saved'), 'success');
  } catch (error) {
    setStatus(error?.message || t('harnessBenchmarkSources.importFailed'), 'error');
  } finally {
    isSaving = false;
    controls.forEach((control, index) => { control.disabled = disabledStates[index]; });
  }
}
