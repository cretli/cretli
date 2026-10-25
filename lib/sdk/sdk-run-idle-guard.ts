export const SDK_RUN_IDLE_TIMEOUT_DEFAULT_MS = 300000;
export const SDK_RUN_SETUP_PROGRESS_INTERVAL_MS = 15000;
type SdkRunStreamIterator = { next: () => unknown };
const pendingNextByIterator = new WeakMap<object, Promise<unknown>>();

export function resolveConfiguredSdkRunIdleTimeoutMs(rawSeconds: unknown): number {
  const parsedSeconds = Number.parseInt(String(rawSeconds ?? ''), 10);
  if (!Number.isFinite(parsedSeconds) || parsedSeconds <= 0) {
    return SDK_RUN_IDLE_TIMEOUT_DEFAULT_MS;
  }
  return parsedSeconds * 1000;
}

export function resolveSdkRunIdleTimeoutMs(rawValue: unknown, fallback: number = SDK_RUN_IDLE_TIMEOUT_DEFAULT_MS): number {
  const normalizedFallback = Number.isFinite(fallback) && fallback > 0 ? Number(fallback) : SDK_RUN_IDLE_TIMEOUT_DEFAULT_MS;
  const parsed = Number.parseInt(String(rawValue ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return normalizedFallback;
  }
  return parsed;
}

/**
 * Awaits a promise; the only way to interrupt it is the abort signal (e.g. cancelling a run).
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal | null | undefined} [signal]
 * @returns {Promise<T>}
 */
export async function withAbortOnly<T>(promise: Promise<T>, signal: AbortSignal | null | undefined = null): Promise<T> {
  if (!signal || typeof signal.addEventListener !== 'function') {
    return promise;
  }
  if (signal.aborted) {
    throw new Error('Cancelled by the user');
  }
  let abortHandler: (() => void) | null = null;
  return new Promise<T>((resolve, reject) => {
    abortHandler = () => reject(new Error('Cancelled by the user'));
    signal.addEventListener('abort', abortHandler, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', abortHandler as () => void);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', abortHandler as () => void);
        reject(err);
      }
    );
  });
}

export async function readSdkRunStreamStep(
  iterator: SdkRunStreamIterator,
  idleTimeoutMs: number
): Promise<{ timedOut: boolean; step: unknown }> {
  if (!iterator || typeof iterator.next !== 'function') {
    throw new TypeError('Iterator with next() is required.');
  }
  const timeoutMs = Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0 ? Number(idleTimeoutMs) : 0;
  if (timeoutMs === 0) {
    const step = await iterator.next();
    return { timedOut: false, step };
  }
  let pendingNext = pendingNextByIterator.get(iterator);
  if (!pendingNext) {
    pendingNext = Promise.resolve(iterator.next()).finally(() => {
      pendingNextByIterator.delete(iterator);
    });
    pendingNextByIterator.set(iterator, pendingNext);
  }
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const nextPromise = pendingNext.then((step: unknown) => ({ timedOut: false, step }));
  const timeoutPromise = new Promise<{ timedOut: boolean; step: unknown }>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({ timedOut: true, step: null });
    }, timeoutMs);
  });
  const result = await Promise.race([nextPromise, timeoutPromise]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
  return result;
}
