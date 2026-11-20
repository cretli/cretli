import { normalizeSdkMode } from '../../../lib/sdk/sdk-mode.ts';
import { t } from '../../i18n/index.js';
import { listHarnessUiIds, normalizeHarnessUiId, resolveHarnessUiMeta } from '../../core/harness/harnessUiRegistry.js';

// `cursor-sdk` is the legacy hello alias of the Cursor transport; the plain `sdk` id was never listed.
const HELLO_TRANSPORTS = new Set(['cursor-sdk', ...listHarnessUiIds().filter((id) => id !== 'sdk')]);

/**
 * @param {unknown} transport
 * @returns {string} A known transport id; unknown values fall back to `sdk`.
 */
export function normalizeHarnessTransport(transport) {
  return normalizeHarnessUiId(transport, 'sdk');
}

/**
 * @param {unknown} transport
 * @returns {boolean}
 */
export function isHarnessHelloTransport(transport) {
  const raw = typeof transport === 'string' ? transport.trim().toLowerCase() : '';
  return HELLO_TRANSPORTS.has(raw);
}

/**
 * @param {unknown} transport
 * @returns {string}
 */
export function resolveHarnessDisplayLabel(transport) {
  return resolveHarnessUiMeta(normalizeHarnessTransport(transport)).label;
}

/**
 * @param {unknown} transport
 * @param {unknown} mode
 * @returns {string}
 */
export function resolveHarnessModeLabel(transport, mode) {
  const normalizedMode = normalizeSdkMode(mode);
  if (normalizedMode === 'plan') return 'Plan';
  if (normalizedMode === 'ask') return 'Ask';
  return 'Agent';
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
  const { launchLabel } = resolveHarnessUiMeta(transport);
  return `${launchLabel} · ${modeLabel} · ${sessionLabel}`;
}
