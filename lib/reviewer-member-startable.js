/**
 * Configuration check for a learned reviewer pair member: can it still be
 * started at all? Used by `resolveReviewerPolicy` to evict a learned member
 * whose model left the enabled Settings favorites or whose harness is disabled
 * or has no delegation adapter.
 *
 * Synchronous and probe-free. Only configuration counts: the credential
 * `ready` probe, quota/limit lockouts and provider errors are transient and
 * never make a member unstartable. When the information is not reliable
 * (unknown harness, no favorites configured, a read error) the member is kept.
 * Favorites are compared by canonical base model, so another effort or a
 * Claude alias of an enabled favorite still counts as present.
 */

import { hasRoleFavoriteOverride, listHarnessModels, readHarnessEnabledModelIds, readSyncHarnessDelegatableRow } from './harness-catalog.js';
import { parseKnownAgentTransport } from './agent-transport.js';
import { sameCanonicalBaseModel } from './model-identity.js';
import { loadSettings } from './persist/settings.js';

/**
 * @param {{ harness?: unknown, model?: unknown }} member
 * @returns {boolean} false only when the member is known not to be startable
 */
export function isReviewerMemberStartable(member) {
  const harness = parseKnownAgentTransport(String(member?.harness ?? '').trim());
  const model = String(member?.model ?? '').trim();
  if (!harness || !model) return true;
  try {
    const row = readSyncHarnessDelegatableRow(harness);
    if (!row) return true;
    if (row.enabled === false || row.can_delegate === false) return false;
    const favorites = readHarnessEnabledModelIds(harness, 'review');
    if (favorites.length === 0) return !hasRoleFavoriteOverride(loadSettings(), harness, 'review');
    if (favorites.some((id) => sameCanonicalBaseModel(harness, id, model))) return true;
    // Catalog rows also cover a variant the start gate resolves to (a Claude
    // alias of a numbered favorite, for example).
    const listed = listHarnessModels({ harness, enabledOnly: true, role: 'review' });
    const items = Array.isArray(listed?.items) ? listed.items : [];
    return items.some((item) => sameCanonicalBaseModel(harness, item?.id, model));
  } catch {
    return true;
  }
}
