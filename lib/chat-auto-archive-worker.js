/**
 * Periodic worker for automatic chat archiving. Started and stopped with the
 * delegation runtime boot so only the owner process sweeps the shared store.
 *
 * Archiving is best-effort: a failing sweep must never take down the worker.
 */

import { sweepIdleChats } from './chat-auto-archive.js';

/**
 * One-minute cadence so a "minutes" idle window actually fires close to its
 * deadline. When the feature is off the tick only reads the small config file
 * (`sweepIdleChats` returns before loading chats).
 */
export const CHAT_AUTO_ARCHIVE_INTERVAL_MS = 60 * 1000;

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let bootTimer = null;

/**
 * One sweep that can never throw.
 *
 * @param {Parameters<typeof sweepIdleChats>[0]} [options]
 * @returns {ReturnType<typeof sweepIdleChats> | null}
 */
export function runChatAutoArchiveSweep(options = {}) {
  try {
    return sweepIdleChats(options);
  } catch {
    // A corrupt chat store is handled by the store itself; auto-archive is
    // optional and must stay silent instead of crashing the runtime worker.
    return null;
  }
}

/**
 * @param {{ intervalMs?: number }} [options]
 */
export function startChatAutoArchiveWorker(options = {}) {
  stopChatAutoArchiveWorker();
  const intervalMs = Number(options.intervalMs) > 0
    ? Number(options.intervalMs)
    : CHAT_AUTO_ARCHIVE_INTERVAL_MS;
  // One sweep shortly after boot so a restart does not delay an overdue
  // archive by a whole interval.
  bootTimer = setTimeout(() => {
    bootTimer = null;
    runChatAutoArchiveSweep();
  }, 0);
  if (typeof bootTimer.unref === 'function') bootTimer.unref();
  timer = setInterval(() => {
    runChatAutoArchiveSweep();
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopChatAutoArchiveWorker() {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
