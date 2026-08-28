import { normalizeSdkMode } from '../../../lib/sdk/sdk-mode.js';
import { t } from '../../i18n/index.js';

/**
 * @param {unknown} transport
 * @returns {'sdk' | 'openrouter' | 'opencode'}
 */
export function normalizeHarnessTransport(transport) {
  const raw = typeof transport === 'string' ? transport.trim().toLowerCase() : '';
  if (raw === 'openrouter' || raw === 'opencode') return raw;
  return 'sdk';
}

/**
 * @param {unknown} transport
 * @returns {string}
 */
export function resolveHarnessDisplayLabel(transport) {
  const normalized = normalizeHarnessTransport(transport);
  if (normalized === 'openrouter') return 'OpenRouter';
  if (normalized === 'opencode') return 'OpenCode';
  return 'SDK';
}

/**
 * @param {unknown} transport
 * @param {unknown} mode
 * @returns {string}
 */
export function resolveHarnessModeLabel(transport, mode) {
  const normalizedTransport = normalizeHarnessTransport(transport);
  const normalizedMode = normalizeSdkMode(mode);
  if (normalizedTransport === 'openrouter') {
    return normalizedMode === 'plan' ? 'Ask' : 'Agent';
  }
  return normalizedMode === 'plan' ? 'Plan' : 'Agent';
}

/**
 * @param {{
 *   transport: unknown,
 *   mode: unknown,
 *   sessionRef: string,
 * }} input
 * @returns {string}
 */
export function buildHarnessLaunchLabel(input) {
  const transport = normalizeHarnessTransport(input.transport);
  const modeLabel = resolveHarnessModeLabel(transport, input.mode);
  const ref = String(input.sessionRef || '?').trim() || '?';
  const sessionLabel = t('chatUi.harnessSession', { ref });
  if (transport === 'openrouter') {
    return `OpenRouter · ${modeLabel} · ${sessionLabel}`;
  }
  if (transport === 'opencode') {
    return `OpenCode · ${modeLabel} · ${sessionLabel}`;
  }
  return `@cursor/sdk · ${modeLabel} · ${sessionLabel}`;
}
