/**
 * Opt-in periodic harness update checks (npm registry, read-only).
 */

import { sweepHarnessUpdateChecks } from './harness-updates.js';

/** One-minute cadence; the sweep no-ops when disabled or cache is fresh. */
export const HARNESS_UPDATE_CHECK_INTERVAL_MS = 60 * 1000;

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let bootTimer = null;
/** @type {Promise<unknown> | null} */
let inFlightSweep = null;

/**
 * @param {Parameters<typeof sweepHarnessUpdateChecks>[0]} [options]
 * @returns {Promise<object | null>}
 */
export function runHarnessUpdateCheckSweep(options = {}) {
  if (inFlightSweep) return inFlightSweep;
  const work = (async () => {
    try {
      return await sweepHarnessUpdateChecks(options);
    } catch {
      return null;
    } finally {
      inFlightSweep = null;
    }
  })();
  inFlightSweep = work;
  return work;
}

/**
 * @param {{ intervalMs?: number }} [options]
 */
export function startHarnessUpdateCheckWorker(options = {}) {
  stopHarnessUpdateCheckWorker();
  const intervalMs = Number(options.intervalMs) > 0
    ? Number(options.intervalMs)
    : HARNESS_UPDATE_CHECK_INTERVAL_MS;
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void runHarnessUpdateCheckSweep();
  }, 0);
  if (typeof bootTimer.unref === 'function') bootTimer.unref();
  timer = setInterval(() => {
    void runHarnessUpdateCheckSweep();
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopHarnessUpdateCheckWorker() {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
