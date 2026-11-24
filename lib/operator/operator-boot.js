/**
 * Start/stop of the internal operator scheduler for the delegation runtime boot.
 * Best-effort: a failure is logged and never degrades the delegation runtime.
 * Nothing starts unless `operatorInternal.enabled` is true (default false).
 */

import { createOperatorScheduler } from './operator-scheduler.js';
import { readOperatorSettings } from './operator-settings.js';

/** @type {ReturnType<typeof createOperatorScheduler> | null} */
let schedulerInstance = null;

export function getOperatorScheduler() { return schedulerInstance; }

/**
 * @param {{ log?: (event: string, data?: Record<string, unknown>) => void, settings?: Record<string, any>, schedulerOptions?: Record<string, any> }} [options]
 * @returns {boolean} true when a scheduler was started
 */
export function startOperatorSchedulerSafely(options = {}) {
  try {
    if (schedulerInstance) return true;
    if (!readOperatorSettings({ settings: options.settings }).enabled) return false;
    schedulerInstance = createOperatorScheduler({ ...options.schedulerOptions, settings: () => readOperatorSettings({ settings: options.settings }) });
    schedulerInstance.start();
    options.log?.('operator-scheduler-started', { instanceId: schedulerInstance.instanceId });
    return true;
  } catch (error) {
    schedulerInstance = null;
    options.log?.('operator-scheduler-start-failed', { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** @returns {Promise<void>} */
export async function stopOperatorSchedulerSafely() {
  const current = schedulerInstance;
  schedulerInstance = null;
  try { await current?.stop(); } catch { /* shutdown is best-effort */ }
}
