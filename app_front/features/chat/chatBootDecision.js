/**
 * Boot decision when the initial auth-status probe fails.
 *
 * `ensureAuthenticatedThenBoot()` normally asks `GET /api/auth-status` whether a
 * session is required. When that request rejects, the SPA used to show the
 * "backend unavailable" overlay and never call `bootApp()`. That also blocked the
 * whole local hydration path (`loadChatsFromServer` -> `hydrateChatListFromLocalBootCache`),
 * so a real offline cold start of `?chat=<id>` rendered an empty shell even though the
 * chat rows and history were already in IndexedDB/localStorage.
 *
 * This helper keeps the online auth gate intact while allowing an offline boot when
 * there is a non-empty local snapshot to hydrate from:
 *
 * - offline (`navigator.onLine === false`) + local snapshot -> boot the SPA;
 * - anything else (online but the backend is down, connectivity unknown, or offline
 *   with nothing cached) -> keep the overlay and retry.
 */

/**
 * @param {{ online?: boolean | null, hasLocalBootCache?: boolean }} [input]
 * @returns {'boot' | 'overlay'}
 */
export function resolveBootOnAuthStatusFailure(input = {}) {
  const online = input.online;
  const hasLocalBootCache = input.hasLocalBootCache === true;
  // Only a confidently offline client with something cached may bypass the auth gate.
  // `undefined`/`null` connectivity is treated as online on purpose: we never boot
  // blind when the server might simply be failing.
  if (online === false && hasLocalBootCache) return 'boot';
  return 'overlay';
}
