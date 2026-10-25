/**
 * Keep the rejected call visible before the guard notice and turn cancellation.
 * Otherwise the notice appears to refer to the previous successful command.
 */
export function buildCodexGuardEvents(item: Record<string, unknown>, message: string): Array<Record<string, unknown>> {
  return [
    { ...item, status: 'running', result: undefined },
    { ...item, status: 'error', result: message },
  ];
}
