/**
 * Recovery for Cursor registry model rejections.
 *
 * Cursor's model catalog can advertise a variant that its run-time registry
 * rejects with `Invalid parameters for registry model: "..."`. The rejection
 * can surface while creating/resuming an agent, while sending a prompt, or as
 * a streamed `status=ERROR` run event. Every path shares the same recovery:
 * quarantine all favorites for the rejected model id and switch the chat to
 * Auto, unless a strict `fast=true` variant was explicitly requested.
 */

import {
  normalizeCatalogModelValue,
  normalizeChatEnabledModels,
  resolveModelSelection,
  decodeModelValue,
} from '../model-catalog.js';
import { loadSettings, saveSettings } from '../persist/settings.js';
import { isSdkRunFailureStatus } from './sdk-run-outcome.js';

/** Reason stored on `room._lastModelFallback` for a registry rejection. */
export const SDK_INVALID_REGISTRY_MODEL_REASON = 'invalid_registry_model';
/** `lastErrorCode` for a run/send registry rejection. */
export const SDK_INVALID_REGISTRY_MODEL_CODE = 'invalid_registry_model';
/** `lastErrorCode` when the strict fast rule blocks the automatic fallback. */
export const SDK_STRICT_MODEL_UNSUPPORTED_CODE = 'strict_model_unsupported';
/** Model every registry rejection falls back to. */
export const SDK_REGISTRY_MODEL_FALLBACK_VALUE = 'auto';
/** One retry is enough: after the switch the room already runs Auto. */
export const SDK_REGISTRY_MODEL_RECOVERY_MAX_RETRIES = 1;

/**
 * @param {unknown} err
 * @returns {string}
 */
export function readSdkRegistryModelErrorText(err) {
  if (err && typeof err === 'object' && 'message' in err) {
    return String(/** @type {{ message?: unknown }} */ (err).message || '');
  }
  return String(err || '');
}

/**
 * Cursor rejects a variant whose parameters the registry does not know. The
 * message carries the model value in quotes.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isInvalidSdkRegistryModelError(err) {
  return /Invalid parameters for registry model:\s*["']/i.test(readSdkRegistryModelErrorText(err));
}

/**
 * Registry rejection reaches the run/send path as a failed run status plus the
 * registry message, either from `agent.send()` or a streamed status event.
 *
 * @param {unknown} status
 * @param {unknown} result
 * @returns {boolean}
 */
export function isSdkRunRegistryModelRejection(status, result) {
  if (!isSdkRunFailureStatus(status)) return false;
  return isInvalidSdkRegistryModelError(result);
}

/**
 * Remove favorites for the rejected registry model. A registry rejection is
 * model-level; keeping sibling presets would make the next pick fail again.
 *
 * @param {string} modelValue
 * @param {{
 *   loadSettings?: () => Record<string, unknown>,
 *   saveSettings?: (settings: Record<string, unknown>) => void,
 * }} [deps]
 * @returns {boolean} true when at least one favorite was removed
 */
export function quarantineRejectedSdkFavorite(modelValue, deps = {}) {
  const rejected = normalizeCatalogModelValue(modelValue);
  if (!rejected) return false;
  const readSettings = typeof deps.loadSettings === 'function' ? deps.loadSettings : loadSettings;
  const writeSettings = typeof deps.saveSettings === 'function' ? deps.saveSettings : saveSettings;
  const rejectedModelId = decodeModelValue(rejected).modelId.toLowerCase();
  const settings = readSettings() || {};
  const favorites = Array.isArray(settings.chatEnabledModels) ? settings.chatEnabledModels : [];
  const normalizedFavorites = normalizeChatEnabledModels(favorites);
  const next = normalizedFavorites.filter((value) => (
    decodeModelValue(value).modelId.toLowerCase() !== rejectedModelId
  ));
  if (next.length === normalizedFavorites.length) return false;
  if (next.length > 0) settings.chatEnabledModels = next;
  else delete settings.chatEnabledModels;
  writeSettings(settings);
  return true;
}

/**
 * @param {{
 *   attemptedModelId?: unknown,
 *   strictFast?: unknown,
 *   reason?: unknown,
 * }} [input]
 * @returns {{
 *   attemptedModelId: string,
 *   fallbackModelId: string,
 *   applied: boolean,
 *   blockedByStrict: boolean,
 *   reason: string,
 *   at: number,
 * }}
 */
export function buildSdkRegistryModelFallbackRecord(input = {}) {
  const strictFast = input.strictFast === true;
  return {
    attemptedModelId: normalizeCatalogModelValue(input.attemptedModelId) || '',
    fallbackModelId: SDK_REGISTRY_MODEL_FALLBACK_VALUE,
    applied: !strictFast,
    blockedByStrict: strictFast,
    reason:
      String(input.reason || SDK_INVALID_REGISTRY_MODEL_REASON) ||
      SDK_INVALID_REGISTRY_MODEL_REASON,
    at: Date.now(),
  };
}

/**
 * Quarantine the rejected favorite and point the room (and its chat) at Auto.
 * Shared by the create/resume catch and the run/send rejection paths so a
 * rejected variant cannot be selected again on the next turn.
 *
 * Returns `null` when the room was already on Auto, because there is nothing
 * to fall back from.
 *
 * @param {{
 *   room?: any,
 *   requestedModelId?: unknown,
 *   strictFast?: unknown,
 *   reason?: unknown,
 *   quarantineFavorite?: (modelValue: string) => boolean,
 *   updateChatModel?: (modelValue: string) => void,
 * }} input
 * @returns {ReturnType<typeof buildSdkRegistryModelFallbackRecord> | null}
 */
export function applySdkRegistryModelFallback(input = {}) {
  const room = input.room;
  const requestedModelId =
    normalizeCatalogModelValue(
      input.requestedModelId ?? room?._lastRequestedModelId ?? room?.modelId
    ) || '';
  if (!requestedModelId || requestedModelId.toLowerCase() === SDK_REGISTRY_MODEL_FALLBACK_VALUE) {
    return null;
  }
  const quarantineFavorite =
    typeof input.quarantineFavorite === 'function'
      ? input.quarantineFavorite
      : quarantineRejectedSdkFavorite;
  quarantineFavorite(requestedModelId);
  const record = buildSdkRegistryModelFallbackRecord({
    attemptedModelId: requestedModelId,
    strictFast: input.strictFast,
    reason: input.reason,
  });
  if (room && typeof room === 'object') {
    room._lastModelFallback = record;
    room.modelId = SDK_REGISTRY_MODEL_FALLBACK_VALUE;
    room.modelSelection = resolveModelSelection(SDK_REGISTRY_MODEL_FALLBACK_VALUE);
    room._lastRequestedModelId = SDK_REGISTRY_MODEL_FALLBACK_VALUE;
    room._strictModelRequested = false;
  }
  if (typeof input.updateChatModel === 'function') {
    input.updateChatModel(SDK_REGISTRY_MODEL_FALLBACK_VALUE);
  }
  return record;
}

/**
 * @param {number} retryCount
 * @returns {boolean}
 */
export function shouldRetrySdkRegistryModelRecovery(retryCount) {
  return Number(retryCount) < SDK_REGISTRY_MODEL_RECOVERY_MAX_RETRIES;
}

/**
 * @param {number} retryAttempt
 * @param {number} [maxRetries]
 * @returns {string}
 */
export function buildSdkRegistryModelRecoveryRetryMessage(
  retryAttempt,
  maxRetries = SDK_REGISTRY_MODEL_RECOVERY_MAX_RETRIES
) {
  const attempt = Math.max(1, Number(retryAttempt) || 1);
  const max = Math.max(1, Number(maxRetries) || SDK_REGISTRY_MODEL_RECOVERY_MAX_RETRIES);
  return `Cursor rejected the selected model variant — removed it from favorites and retrying with Auto (${attempt}/${max})…`;
}

/**
 * @param {unknown} modelValue
 * @returns {string}
 */
export function buildSdkRegistryModelRejectedMessage(modelValue) {
  const modelId = normalizeCatalogModelValue(modelValue) || 'the selected model';
  return `Cursor rejected the registry parameters for "${modelId}". Its SDK favorites were removed; retry with Auto.`;
}

/**
 * Strict fast means do not silently run a different model, so the automatic
 * fallback stays off for this turn even though the favorite is quarantined.
 *
 * @param {unknown} modelValue
 * @returns {string}
 */
export function buildStrictRegistryModelRejectedMessage(modelValue) {
  const modelId = normalizeCatalogModelValue(modelValue) || 'the selected model';
  return `Strict SDK model "${modelId}" was rejected. Its SDK favorites were removed where configured; automatic fallback is disabled for this turn.`;
}
