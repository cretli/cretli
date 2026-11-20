import net from 'node:net';

const PROBE_CACHE_MS = 15_000;
const PROBE_TIMEOUT_MS = 1500;

/**
 * TCP connect probe of one configured address.
 *
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function probeTcp(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Cached reachability of the non-loopback addresses the server is configured
 * for. `get()` is synchronous (last completed sample) and refreshes in the
 * background, so /api/health never waits on a socket. Before the first sample
 * completes nothing is reported, to avoid a false alarm right after start.
 *
 * @param {{
 *   hosts: string[],
 *   port: number,
 *   probe?: (host: string, port: number) => Promise<boolean>,
 *   now?: () => number,
 *   cacheMs?: number,
 * }} deps
 */
export function createLanReachability(deps) {
  const probe = deps.probe || probeTcp;
  const now = deps.now || Date.now;
  const cacheMs = deps.cacheMs ?? PROBE_CACHE_MS;
  /** @type {string[]} */
  let unreachable = [];
  let sampledAt = 0;
  let inflight = null;

  function refresh() {
    if (!deps.hosts.length) return Promise.resolve();
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const results = await Promise.all(deps.hosts.map(async (host) => [host, await probe(host, deps.port).catch(() => false)]));
        unreachable = results.filter(([, ok]) => !ok).map(([host]) => String(host));
        sampledAt = now();
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /** @returns {{ hosts: string[], unreachable: string[] }} */
  function get() {
    if (deps.hosts.length && now() - sampledAt > cacheMs) void refresh();
    return { hosts: deps.hosts, unreachable };
  }

  return { get, refresh };
}
