/**
 * Shared plan-mode guard — detects file/shell mutations.
 * Read, grep, task, and subagent stay allowed so the model can explore.
 */

export const PLAN_MODE_MUTATING_TOOL_NAMES = new Set([
  'edit',
  'write',
  'delete',
  'shell',
  'mcp',
]);

/**
 * @param {unknown} toolName
 * @returns {boolean}
 */
export function isPlanModeMutatingToolName(toolName) {
  const name = String(toolName || '').trim().toLowerCase();
  if (!name) return false;
  if (PLAN_MODE_MUTATING_TOOL_NAMES.has(name)) return true;
  if (name.startsWith('shell.')) return true;
  if (name.startsWith('mcp.')) return true;
  if (name.includes('write') || name.includes('delete') || name.includes('edit')) return true;
  return false;
}

/**
 * @param {unknown} event
 * @returns {string}
 */
export function getSdkToolCallName(event) {
  if (!event || typeof event !== 'object') return '';
  const ev = /** @type {Record<string, unknown>} */ (event);
  const raw = typeof ev.name === 'string' ? ev.name : '';
  return raw.trim().toLowerCase();
}

/**
 * @param {unknown} event SDK-shaped event (normalized stream).
 * @returns {boolean}
 */
export function isPlanModeMutatingSdkEvent(event) {
  if (!event || typeof event !== 'object') return false;
  const ev = /** @type {Record<string, unknown>} */ (event);
  if (ev.type !== 'tool_call') return false;
  const status = typeof ev.status === 'string' ? ev.status.trim().toLowerCase() : '';
  if (status && status !== 'running' && status !== 'started' && status !== 'pending') return false;
  return isPlanModeMutatingToolName(getSdkToolCallName(ev));
}

export const PLAN_GUARD_USER_MESSAGE =
  'Plan mode blocked execution. Switch to Agent mode to apply changes.';
