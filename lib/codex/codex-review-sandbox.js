/**
 * Codex review delegations run in the Codex read-only sandbox, which is the
 * hard write block that certifies Codex reviews. Operators can switch it off
 * with CRETLI_DELEGATION_CODEX_REVIEW_SANDBOX=0 (for example when bwrap is not
 * usable on a host); Codex reviews are then uncertified again and need
 * CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1.
 */

import { readEnvAlias } from '../env-alias.js';

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isCodexReviewSandboxEnabled(env = process.env) {
  const raw = readEnvAlias({
    current: 'CRETLI_DELEGATION_CODEX_REVIEW_SANDBOX',
    defaultValue: '1',
    env,
  });
  return String(raw).trim() !== '0';
}
