/**
 * Settings → Chat and agents → Files: video attachments, retention window and
 * a view of what data/uploads/ currently holds. The sweep itself runs on the
 * server; this module edits the `uploads` setting through `PATCH /api/settings`.
 */

import { t } from '../../i18n/index.js';
import { getSettings, patchSettings, getUploadsStats, cleanupUploads } from '../../core/api/index.js';

const LIMITS = Object.freeze({ videoMaxMb: 5000, retentionDays: 3650 });

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024 * 1024) return `${Math.max(0, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Wires the section once; no-op when the markup is absent. */
export function initUploadsSettings() {
  const videoCheckbox = /** @type {any} */ (document.getElementById('uploads-video-checkbox'));
  const videoMax = /** @type {any} */ (document.getElementById('uploads-video-max'));
  const retentionCheckbox = /** @type {any} */ (document.getElementById('uploads-retention-checkbox'));
  const retentionDays = /** @type {any} */ (document.getElementById('uploads-retention-days'));
  const statusEl = document.getElementById('uploads-status');
  const statsEl = document.getElementById('uploads-stats');
  const cleanupBtn = document.getElementById('uploads-cleanup-btn');
  const deleteAllBtn = document.getElementById('uploads-delete-all-btn');
  if (!videoCheckbox || !videoMax || !retentionCheckbox || !retentionDays) return;

  let saved = { videoEnabled: true, videoMaxMb: 500, retentionEnabled: true, retentionDays: 30 };

  /**
   * @param {string} [text]
   * @param {boolean} [isError]
   */
  function setStatus(text = '', isError = false) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', isError);
  }

  function syncDisabled() {
    videoMax.disabled = !videoCheckbox.checked;
    retentionDays.disabled = !retentionCheckbox.checked;
  }

  /** @param {Record<string, any> | null | undefined} cfg */
  function applyConfig(cfg) {
    if (cfg && typeof cfg === 'object') saved = { ...saved, ...cfg };
    videoCheckbox.checked = saved.videoEnabled !== false;
    retentionCheckbox.checked = saved.retentionEnabled !== false;
    videoMax.value = String(saved.videoMaxMb);
    retentionDays.value = String(saved.retentionDays);
    syncDisabled();
  }

  /**
   * @param {unknown} value
   * @param {number} max
   * @returns {number | null}
   */
  function whole(value, max) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= 1 && n <= max ? n : null;
  }

  async function save() {
    const mb = whole(videoMax.value, LIMITS.videoMaxMb);
    const days = whole(retentionDays.value, LIMITS.retentionDays);
    if (mb === null || days === null) {
      applyConfig(saved);
      setStatus(t('settings.uploadsInvalid'), true);
      return;
    }
    const next = {
      videoEnabled: videoCheckbox.checked,
      videoMaxMb: mb,
      retentionEnabled: retentionCheckbox.checked,
      retentionDays: days,
    };
    setStatus(t('settings.uploadsSaving'));
    try {
      const json = await patchSettings({ uploads: next });
      if (json && json.ok === false) throw new Error(json.error || 'save_failed');
      applyConfig(next);
      setStatus(t('settings.uploadsSaved'));
    } catch (err) {
      applyConfig(saved);
      setStatus(err?.message || t('settings.uploadsSaveFailed'), true);
    }
  }

  async function refreshStats() {
    if (!statsEl) return;
    try {
      const json = /** @type {Awaited<ReturnType<typeof getUploadsStats>> & { files?: number, videos?: number, bytes?: number }} */ (await getUploadsStats());
      if (!json || json.ok === false) return;
      statsEl.textContent = json.files
        ? t('settings.uploadsStats', { files: json.files, videos: json.videos, size: formatBytes(json.bytes) })
        : t('settings.uploadsStatsEmpty');
    } catch {
      statsEl.textContent = '';
    }
  }

  /** @param {boolean} all */
  async function runCleanup(all) {
    if (all && !window.confirm(t('settings.uploadsDeleteAllConfirm'))) return;
    try {
      const json = /** @type {Awaited<ReturnType<typeof cleanupUploads>> & { error?: string, deleted?: number, freedBytes?: number }} */ (await cleanupUploads({ all }));
      if (json && json.ok === false) throw new Error(json.error || 'cleanup_failed');
      setStatus(t('settings.uploadsCleaned', { count: json.deleted || 0, size: formatBytes(json.freedBytes) }));
    } catch (err) {
      setStatus(err?.message || t('settings.uploadsSaveFailed'), true);
    }
    void refreshStats();
  }

  videoCheckbox.addEventListener('change', () => { syncDisabled(); void save(); });
  retentionCheckbox.addEventListener('change', () => { syncDisabled(); void save(); });
  // A native `change` does not cross the cr-bar-input shadow root, so commit on blur and Enter.
  for (const [input, key] of [[videoMax, 'videoMaxMb'], [retentionDays, 'retentionDays']]) {
    const commit = () => {
      if (String(input.value) !== String(saved[key])) void save();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') commit();
    });
  }
  cleanupBtn?.addEventListener('click', () => { void runCleanup(false); });
  deleteAllBtn?.addEventListener('click', () => { void runCleanup(true); });
  document.querySelector('[data-settings-tab="chat-uploads"][role="tab"]')
    ?.addEventListener('click', () => { void refreshStats(); });

  getSettings()
    .then((json) => {
      applyConfig(json?.uploads);
      void refreshStats();
    })
    .catch(() => applyConfig(saved));
}
