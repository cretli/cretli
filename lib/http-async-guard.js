/**
 * Express 4 does not catch a rejected promise returned by an `async` route handler: the request hangs
 * and, with `unhandledRejection` fatal, the process dies. The history adapter turned many previously
 * synchronous handlers asynchronous (stage 2b), and its typed refusals are expected outcomes, so route
 * registration goes through this guard: a rejection becomes the typed history response (or a 500) and is
 * never an unhandled rejection.
 *
 * The patch is applied in place, once per app/router (idempotent), and touches only `async` handlers
 * that are not error middleware (arity 4).
 */
import { describeHistoryError } from './persist/chat-history-http.js';

const GUARDED = Symbol.for('cretli.asyncRouteGuard');
const METHODS = Object.freeze(['get', 'post', 'put', 'patch', 'delete', 'all', 'use']);

/** @param {Function} handler @returns {Function} */
function wrapHandler(handler) {
  const wrapped = function guardedAsyncHandler(req, res, next) {
    let pending;
    try {
      pending = handler.call(this, req, res, next);
    } catch (error) {
      return next(error);
    }
    if (!pending || typeof pending.then !== 'function') return pending;
    return pending.catch((error) => {
      if (res.headersSent) {
        console.error('[http] async handler failed after the response started:', error?.stack || error?.message || error);
        return undefined;
      }
      const described = describeHistoryError(error);
      if (described) return res.status(described.status).json(described.body);
      return next(error);
    });
  };
  Object.defineProperty(wrapped, 'name', { value: handler.name || 'guardedAsyncHandler' });
  return wrapped;
}

/**
 * @template {Record<string, any>} T
 * @param {T} target an express app or router
 * @returns {T} the same object
 */
export function guardAsyncRoutes(target) {
  if (!target || target[GUARDED]) return target;
  for (const method of METHODS) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = function guardedRegistration(...args) {
      const mapped = args.map((arg) => (typeof arg === 'function' && arg.constructor?.name === 'AsyncFunction' && arg.length < 4 ? wrapHandler(arg) : arg));
      return original.apply(this, mapped);
    };
  }
  Object.defineProperty(target, GUARDED, { value: true });
  return target;
}
