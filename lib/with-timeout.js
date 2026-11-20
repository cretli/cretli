/**
 * Race a promise against a timer. On expiry the returned promise rejects with an
 * Error carrying `code`; the underlying work is NOT cancelled (the caller owns
 * that). The timer is always cleared, so it never keeps the process alive.
 *
 * @template T
 * @param {Promise<T> | T} promise
 * @param {number} ms
 * @param {string} code
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, code) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = /** @type {Error & { code?: string }} */ (new Error(code));
      error.code = code;
      reject(error);
    }, ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
