/**
 * The takeover confirmation covers the listener and its ancestors, so the dialog lists them and the
 * server compares the posted PID set with its own recomputation (see `takeover` in lib/apps/service.js).
 * Kept free of UI imports so it can be unit-tested in node.
 */

/**
 * Every PID the user confirms: for each foreign-owned port the listener plus its ancestors, deduplicated.
 *
 * @param {Array<{ listener?: { pid?: number, ancestors?: Array<{ pid: number }> } | null }>} conflicts
 * @returns {number[]}
 */
export function takeoverPids(conflicts) {
  const pids = new Set();
  for (const p of conflicts) {
    for (const a of p.listener?.ancestors || []) pids.add(a.pid);
    if (p.listener?.pid) pids.add(p.listener.pid);
  }
  return [...pids];
}

/**
 * Ancestors shown in the dialog, deduplicated across ports, outermost first (the order they are ended in).
 *
 * @param {Array<{ listener?: { ancestors?: Array<{ pid: number, command?: string }> } | null }>} conflicts
 * @returns {Array<{ pid: number, command?: string }>}
 */
export function takeoverAncestors(conflicts) {
  const seen = new Map();
  for (const p of conflicts) {
    for (const a of [...(p.listener?.ancestors || [])].reverse()) if (!seen.has(a.pid)) seen.set(a.pid, a);
  }
  return [...seen.values()];
}
