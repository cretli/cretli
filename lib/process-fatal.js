/**
 * Fatal process-event handling shared by `uncaughtException` and
 * `unhandledRejection`.
 *
 * Dev keeps the process alive: the event is recorded, but no cleanup runs, so a
 * single rejected promise never kills live chats. Production treats the event
 * as terminal: the caller's `shutdown` hook runs (its first phase synchronously
 * signals OpenCode) instead of an immediate `process.exit`.
 *
 * Extracted from `server.js` so the dev/prod decision is testable without
 * booting an HTTP server.
 */

/**
 * @param {{
 *   isProd?: boolean,
 *   record?: (kind: string, error: unknown) => void,
 *   shutdown?: (kind: string) => void,
 * }} [options]
 * @returns {(input: { kind: string, error: unknown }) => { terminate: boolean, shutdownCalled: boolean }}
 */
export function createFatalProcessEventHandler(options = {}) {
  const isProd = options.isProd === true;
  const record = typeof options.record === 'function' ? options.record : () => {};
  const shutdown = typeof options.shutdown === 'function' ? options.shutdown : null;
  return function handleFatalProcessEvent(input) {
    const kind = String(input?.kind || 'fatal');
    try {
      record(kind, input?.error);
    } catch {
      // Diagnostics must never mask the fatal event.
    }
    if (!isProd) return { terminate: false, shutdownCalled: false };
    if (!shutdown) return { terminate: true, shutdownCalled: false };
    try {
      shutdown(kind);
      return { terminate: true, shutdownCalled: true };
    } catch {
      return { terminate: true, shutdownCalled: false };
    }
  };
}
