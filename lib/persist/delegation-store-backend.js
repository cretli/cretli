/**
 * Which durable backend owns delegation records for this process.
 */

let backend = 'json';

/**
 * @returns {'json' | 'sqlite'}
 */
export function getDelegationStoreBackend() {
  const env = String(process.env.CRETLI_DELEGATION_STORE || '').trim().toLowerCase();
  if (env === 'sqlite' || env === 'json') return env;
  return backend;
}

/**
 * @param {'json' | 'sqlite'} value
 */
export function setDelegationStoreBackend(value) {
  backend = value === 'sqlite' ? 'sqlite' : 'json';
}
