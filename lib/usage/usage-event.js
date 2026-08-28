/**
 * Canonical usage event for the instance-wide cost ledger.
 * Uses Web Crypto so the same module can be imported from the browser.
 */

function createUsageId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const USAGE_PROVIDERS = Object.freeze([
  'openai',
  'google',
  'azure',
  'openrouter',
  'cursor',
  'other',
]);

export const USAGE_FEATURES = Object.freeze([
  'voice-live',
  'voice-tts',
  'voice-stt',
  'chat',
  'other',
]);

/**
 * @returns {{
 *   textInput: number,
 *   textOutput: number,
 *   audioInput: number,
 *   audioOutput: number,
 *   cachedInput: number,
 *   reasoning: number,
 * }}
 */
export function emptyUsageTokens() {
  return {
    textInput: 0,
    textOutput: 0,
    audioInput: 0,
    audioOutput: 0,
    cachedInput: 0,
    reasoning: 0,
  };
}

/**
 * @param {object} [partial]
 * @returns {object}
 */
export function createUsageEvent(partial = {}) {
  const tokens = { ...emptyUsageTokens(), ...(partial.tokens || {}) };
  for (const key of Object.keys(tokens)) {
    const value = Number(tokens[key]);
    tokens[key] = Number.isFinite(value) && value > 0 ? value : 0;
  }
  const provider = USAGE_PROVIDERS.includes(partial.provider) ? partial.provider : 'other';
  const feature = USAGE_FEATURES.includes(partial.feature) ? partial.feature : 'other';
  return {
    id: String(partial.id || createUsageId()),
    at: String(partial.at || new Date().toISOString()),
    provider,
    feature,
    model: String(partial.model || '').trim(),
    workspaceFile: partial.workspaceFile ? String(partial.workspaceFile) : undefined,
    chatId: partial.chatId ? String(partial.chatId) : undefined,
    tokens,
    characters: Number.isFinite(Number(partial.characters)) ? Math.max(0, Number(partial.characters)) : 0,
    audioSeconds: Number.isFinite(Number(partial.audioSeconds)) ? Math.max(0, Number(partial.audioSeconds)) : 0,
    usd: null,
    estimated: partial.estimated === true,
    source: partial.source === 'client' ? 'client' : 'server',
  };
}
