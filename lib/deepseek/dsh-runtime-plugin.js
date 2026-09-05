/**
 * Cordis overlay for Cretli's DeepSeek Harness SDK profile.
 * Hides read_image on text-only models and replaces public-only web_fetch
 * with a LAN-friendly resolver (still pinned, still no link-local).
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  DEFAULT_USER_AGENT,
  HttpFetchProvider,
} from '@deepseek-ai/dsh-web-fetch-http';
import { WebError } from '@deepseek-ai/dsh-web';
import { isAllowedDshFetchIp } from './dsh-fetch-policy.js';

export const name = 'cretli-dsh-runtime';
export const inject = ['web', 'agents'];

const FETCH_LIMITS = Object.freeze({
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 30_000,
  maxRedirects: 5,
  userAgent: DEFAULT_USER_AGENT,
});

/**
 * @param {unknown} modelId
 * @returns {boolean}
 */
function modelAcceptsImages(modelId) {
  return String(modelId || '').toLowerCase().includes('vision');
}

/**
 * @param {string} hostname
 * @returns {string}
 */
function stripIpv6Brackets(hostname) {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
  return hostname;
}

/**
 * @param {Promise<unknown>} promise
 * @param {AbortSignal} signal
 * @returns {Promise<any>}
 */
function raceWithSignal(promise, signal) {
  const abortError = () => new Error('web fetch aborted during hostname resolution', { cause: signal.reason });
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

/**
 * @param {string} hostname
 * @param {AbortSignal} signal
 * @returns {Promise<Array<{ address: string, family: 4 | 6 }>>}
 */
export async function resolveDshFetchAddresses(hostname, signal) {
  const unbracketed = stripIpv6Brackets(hostname);
  const literalFamily = isIP(unbracketed);
  const resolved = literalFamily === 0
    ? await raceWithSignal(lookup(unbracketed, { all: true, order: 'verbatim' }), signal)
    : [{ address: unbracketed, family: literalFamily }];
  if (!Array.isArray(resolved) || resolved.length === 0) {
    throw new WebError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR');
  }
  /** @type {Array<{ address: string, family: 4 | 6 }>} */
  const addresses = [];
  for (const entry of resolved) {
    if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family) {
      throw new WebError(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR');
    }
    if (!isAllowedDshFetchIp(entry.address)) {
      throw new WebError(`URL hostname "${hostname}" resolves to a blocked address`, 'WEB_BLOCKED_URL');
    }
    addresses.push({ address: entry.address, family: entry.family });
  }
  return addresses;
}

/**
 * @param {any} ctx
 */
export function apply(ctx) {
  ctx.web.registerFetchProvider(new HttpFetchProvider(FETCH_LIMITS, resolveDshFetchAddresses));
  ctx.on('agent/created', ({ agent }) => {
    if (!agent?.ctx?.tools || typeof agent.ctx.tools.restrict !== 'function') return;
    if (modelAcceptsImages(agent.options?.model)) return;
    try {
      agent.ctx.tools.restrict({ deny: ['read_image'] });
    } catch {
      // read_image is absent when attachments are not mounted
    }
  });
}
