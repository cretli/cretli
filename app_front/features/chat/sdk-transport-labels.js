import { normalizeSdkMode } from '../../../lib/sdk/sdk-mode.js';
import { t } from '../../i18n/index.js';

const HELLO_TRANSPORTS = new Set([
  'cursor-sdk',
  'openrouter',
  'opencode',
  'codebuddy',
  'deepseek',
  'codex',
  'qwen',
]);

/**
 * @param {unknown} transport
 * @returns {'sdk' | 'openrouter' | 'opencode' | 'codebuddy' | 'deepseek' | 'codex' | 'qwen'}
 */
export function normalizeHarnessTransport(transport) {
  const raw = typeof transport === 'string' ? transport.trim().toLowerCase() : '';
  if (raw === 'openrouter' || raw === 'opencode' || raw === 'codebuddy' || raw === 'deepseek' || raw === 'codex' || raw === 'qwen') return raw;
  return 'sdk';
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
  const normalized = normalizeHarnessTransport(transport);
  if (normalized === 'openrouter') return 'OpenRouter';
  if (normalized === 'opencode') return 'OpenCode';
  if (normalized === 'codebuddy') return 'CodeBuddy';
  if (normalized === 'deepseek') return 'DeepSeek';
  if (normalized === 'codex') return 'Codex';
  if (normalized === 'qwen') return 'Qwen';
  return 'SDK';
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
  if (transport === 'openrouter') {
    return `OpenRouter · ${modeLabel} · ${sessionLabel}`;
  }
  if (transport === 'opencode') {
    return `OpenCode · ${modeLabel} · ${sessionLabel}`;
  }
  if (transport === 'codebuddy') {
    return `CodeBuddy · ${modeLabel} · ${sessionLabel}`;
  }
  if (transport === 'deepseek') {
    return `DeepSeek · ${modeLabel} · ${sessionLabel}`;
  }
  if (transport === 'codex') {
    return `Codex · ${modeLabel} · ${sessionLabel}`;
  }
  if (transport === 'qwen') {
    return `Qwen · ${modeLabel} · ${sessionLabel}`;
  }
  return `@cursor/sdk · ${modeLabel} · ${sessionLabel}`;
}
