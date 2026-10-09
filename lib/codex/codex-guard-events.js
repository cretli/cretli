/**
 * Keep the rejected call visible before the guard notice and turn cancellation.
 * Otherwise the notice appears to refer to the previous successful command.
 * @param {Record<string, unknown>} item
 * @param {string} message
 * @returns {Array<Record<string, unknown>>}
 */
export function buildCodexGuardEvents(item, message) {
  return [
    { ...item, status: 'running', result: undefined },
    { ...item, status: 'error', result: message },
  ];
}
