// Socket lifecycle helpers, testable without chrome.* APIs.

/** Aborts every in-flight command (and with it its HTTP request). */
export function abortAll(running) {
  for (const controller of running.values()) controller.abort();
  running.clear();
}

/** Rejects a pending browser promise immediately when its command is cancelled. */
export function awaitAbortable(promise, signal, isConnected = () => true) {
  if (signal?.aborted || !isConnected()) return Promise.reject(new DOMException('Cancelled.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Cancelled.', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((value) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted || !isConnected()) reject(new DOMException('Cancelled.', 'AbortError'));
      else resolve(value);
    }, (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

/**
 * Any socket close or error (server kill switch, unpair, network drop) aborts
 * in-flight work, not only the local disconnect().
 */
export function bindSocketLifecycle(ws, { running, onClosed }) {
  ws.onerror = () => abortAll(running);
  ws.onclose = (event) => {
    abortAll(running);
    onClosed(event);
  };
}
