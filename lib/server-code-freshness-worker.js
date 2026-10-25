/**
 * Periodic worker around the server-code freshness detector: capture the startup
 * manifest, re-hash the backend sources on an unref'd timer, publish one
 * notification per episode and keep an in-process snapshot for the API and the
 * Workspace Watcher.
 *
 * The snapshot never contains file paths, only the state and how many files
 * changed. `/api/health` is pre-auth and may carry the bare flag; the count
 * lives in the authorized diagnostics endpoint.
 */

import {
  CODE_FRESHNESS_EPISODE_PREFIX,
  describeCodeFreshness,
  diffCodeManifest,
  formatCodeFreshnessMessage,
  scanServerCodeManifest,
} from './server-code-freshness.js';
import { publishNotification, readNotificationStoreSync } from './notifications/notification-store.ts';

/**
 * One minute. A full pass re-reads the backend sources (a few thousand files,
 * asynchronously), so the flag appears within a period of an edit without
 * measurable load, and no timer can keep the process alive on its own.
 */
export const SERVER_CODE_FRESHNESS_INTERVAL_MS = 60 * 1000;

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let bootTimer = null;

/**
 * Last evaluated view of the backend, plus the inputs the next pass needs.
 * `baseline` is the manifest captured at (or right after) start; `episode` is the
 * currently open change set, kept so a replay of the same change set does not
 * restart the "stale since" clock; `notifiedEpisodeKey` is the last episode this
 * process published, so one episode publishes once instead of every period.
 */
let state = createIdleState();

/**
 * @returns {{
 *   status: 'pending' | 'ok',
 *   detector: { state: 'fresh' | 'stale' | 'unknown', changedCount: number | null, episodeKey: string, episodeState: string, staleSinceAt: string | null },
 *   baseline: Record<string, string> | null,
 *   episode: { key: string, openedAt: number } | null,
 *   notifiedEpisodeKey: string,
 *   scannedAt: string | null,
 *   passes: number,
 * }}
 */
function createIdleState() {
  return {
    status: 'pending',
    detector: { state: 'unknown', changedCount: null, episodeKey: '', episodeState: 'unknown', staleSinceAt: null },
    baseline: null,
    episode: null,
    notifiedEpisodeKey: '',
    scannedAt: null,
    passes: 0,
  };
}

/**
 * Fingerprint-derived acknowledgement: dismissing this producer's notification in
 * the centre is the operator saying "I know". The flag itself stays up — a
 * dismissal does not make the running code current again.
 *
 * @param {{ dataDir?: string, storePath?: string, readStore?: (options: object) => { items?: unknown[] } }} options
 * @returns {string[]}
 */
function readAcknowledgedEpisodeKeys(options = {}) {
  const readStore = typeof options.readStore === 'function' ? options.readStore : readNotificationStoreSync;
  let doc = null;
  try {
    doc = readStore({ storePath: options.storePath });
  } catch {
    return [];
  }
  const items = Array.isArray(doc?.items) ? doc.items : [];
  const keys = [];
  for (const item of items) {
    // A dismissed row is the ack; an active or merely read one is not.
    if (!item || !item.dismissedAt) continue;
    const fingerprint = String(item.fingerprint || '').trim();
    if (!fingerprint.startsWith(`${CODE_FRESHNESS_EPISODE_PREFIX}:`)) continue;
    keys.push(fingerprint);
  }
  return keys;
}

/**
 * One freshness pass that can never throw.
 *
 * Without a baseline (the boot scan failed or has not run yet) the pass adopts
 * what it reads as the baseline: there is nothing to compare against, and a later
 * period is strictly better than never measuring. The state stays `unknown` until
 * a pass completes with a baseline plus a complete re-read.
 *
 * @param {{
 *   rootDir?: string,
 *   instanceToken?: string,
 *   dataDir?: string,
 *   storePath?: string,
 *   fsAdapter?: import('./server-code-freshness.js').CodeFsAdapter,
 *   now?: () => number,
 *   publish?: (input: object) => Promise<{ created?: boolean }>,
 *   readStore?: (options: object) => { items?: unknown[] },
 *   broadcast?: boolean,
 * }} options
 * @returns {Promise<typeof state.detector & { status: string, passes: number }>}
 */
export async function runServerCodeFreshnessPass(options = {}) {
  const rootDir = String(options.rootDir || '').trim();
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  if (!rootDir) {
    state = { ...state, detector: { ...state.detector, state: 'unknown' } };
    return snapshotDetectorView();
  }
  const scanned = await scanServerCodeManifest({ rootDir, fsAdapter: options.fsAdapter });
  state.passes += 1;
  state.scannedAt = new Date(now).toISOString();
  state.status = 'ok';
  if (scanned.status !== 'ok' && !state.baseline) {
    // Nothing to compare against yet: stay unknown, do not alarm.
    state.detector = {
      state: 'unknown',
      changedCount: null,
      episodeKey: '',
      episodeState: 'unknown',
      staleSinceAt: null,
    };
    return snapshotDetectorView();
  }
  if (!state.baseline) {
    state.baseline = scanned.manifest;
  }
  if (scanned.status !== 'ok') {
    // A baseline exists, so the last good measurement must not be overwritten
    // with an alarm derived from an incomplete read.
    state.detector = {
      state: 'unknown',
      changedCount: null,
      episodeKey: '',
      episodeState: 'unknown',
      staleSinceAt: null,
    };
    return snapshotDetectorView();
  }
  const diff = diffCodeManifest({ baseline: state.baseline, current: scanned.manifest });
  const evaluation = describeCodeFreshness({
    scanStatus: 'ok',
    diff,
    instanceToken: String(options.instanceToken || ''),
    previousEpisode: state.episode,
    acknowledgedEpisodeKeys: readAcknowledgedEpisodeKeys(options),
    now,
  });
  state.detector = {
    state: evaluation.state,
    changedCount: evaluation.changedCount,
    episodeKey: evaluation.episodeKey,
    episodeState: evaluation.episodeState,
    staleSinceAt: evaluation.staleSinceAt,
  };
  state.episode = evaluation.episodeKey
    ? { key: evaluation.episodeKey, openedAt: evaluation.openedAt }
    : null;
  // One publication per episode: the in-process gate keeps a minute-long pass
  // from hitting the store every period, and the store's fingerprint dedupe
  // (which also covers a dismissed row) makes the guarantee durable.
  if (evaluation.episodeKey && evaluation.episodeState === 'open'
    && evaluation.episodeKey !== state.notifiedEpisodeKey) {
    const message = formatCodeFreshnessMessage(evaluation.changedCount);
    const publish = typeof options.publish === 'function' ? options.publish : publishNotification;
    state.notifiedEpisodeKey = evaluation.episodeKey;
    try {
      await publish({
        category: 'system',
        severity: 'warning',
        title: message.title,
        body: message.body,
        actionUrl: '/?panel=todos',
        fingerprint: evaluation.episodeKey,
      }, { storePath: options.storePath, broadcast: options.broadcast });
    } catch {
      // A notification failure must never break the timer. Forget the stamp so
      // the next pass retries the same episode key.
      state.notifiedEpisodeKey = '';
    }
  }
  return snapshotDetectorView();
}

/**
 * @returns {typeof state.detector & { status: string, passes: number }}
 */
function snapshotDetectorView() {
  return { ...state.detector, status: state.status, passes: state.passes };
}

/**
 * Detail view for the authorized API: state plus the number of changed files.
 * `changedCount` is `null` when the detector has no measurement — never a zero
 * that would read as "nothing changed".
 *
 * @returns {{ state: 'fresh' | 'stale' | 'unknown', changedCount: number | null, staleSinceAt: string | null, episodeState: string }}
 */
export function getServerCodeFreshnessDetail() {
  return {
    state: state.detector.state,
    changedCount: state.detector.changedCount,
    staleSinceAt: state.detector.staleSinceAt,
    episodeState: state.detector.episodeState,
  };
}

/**
 * Bare flag for the pre-auth health endpoint. `unknown` must not read as an
 * alarm, so only an actual `stale` measurement is true.
 *
 * @returns {boolean}
 */
export function isServerCodeStale() {
  return state.detector.state === 'stale';
}

/**
 * @param {Parameters<typeof runServerCodeFreshnessPass>[0] & { intervalMs?: number }} [options]
 */
export function startServerCodeFreshnessWorker(options = {}) {
  stopServerCodeFreshnessWorker();
  const intervalMs = Number(options.intervalMs) > 0
    ? Number(options.intervalMs)
    : SERVER_CODE_FRESHNESS_INTERVAL_MS;
  // Baseline immediately: the manifest must describe the code this process
  // actually loaded, not whatever is on disk a minute later.
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void runServerCodeFreshnessPass(options)
      .catch((err) => console.warn('[cretli] server-code freshness pass failed:', err?.message || err));
  }, 0);
  if (typeof bootTimer.unref === 'function') bootTimer.unref();
  timer = setInterval(() => {
    void runServerCodeFreshnessPass(options)
      .catch((err) => console.warn('[cretli] server-code freshness pass failed:', err?.message || err));
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopServerCodeFreshnessWorker() {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** Test helper: forget the baseline and any open episode. */
export function __resetServerCodeFreshnessForTest() {
  stopServerCodeFreshnessWorker();
  state = createIdleState();
}
