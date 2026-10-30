/** Best-effort publication; a failed card write never changes a source gate. */
const listeners = new Map();
export function registerDecisionGateChangeListener(key, listener) {
  listeners.set(key, listener);
  return () => listeners.delete(key);
}
export function notifyDecisionGateChange(workspaceFolder, dataDir) {
  if (!workspaceFolder) return;
  for (const listener of listeners.values()) {
    try { listener(workspaceFolder, dataDir); } catch { /* Source writes stay authoritative. */ }
  }
}
