/**
 * Pure formatting/parsing helpers used by chatTransport.js. They hold no chat or
 * socket state, so they live outside the transport closure.
 */

/**
 * @param {number} ms
 * @returns {string} Whole seconds, at least `1s` for a positive duration.
 */
export function formatDurationSeconds(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds}s`;
}

/**
 * Model id from a harness launch command line (`--model <id>`, quoted or bare).
 * @param {unknown} commandLine
 * @returns {string}
 */
export function extractModelIdFromLaunchCommandLine(commandLine) {
  const line = String(commandLine || '').trim();
  if (!line) return '';
  const match = line.match(/(?:^|\s)--model\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  if (!match) return '';
  return (match[1] || match[2] || match[3] || '').trim();
}
