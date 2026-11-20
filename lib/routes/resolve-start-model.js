/**
 * Resolve the model stored on a new chat. Cursor SDK keeps its configured
 * fallback, while other harnesses select their own default when no model (or
 * the SDK-only `auto` sentinel) was requested.
 *
 * @param {string} transport
 * @param {unknown} requested
 * @param {unknown} fallback
 * @returns {string}
 */
export function resolveTodoStartModel(transport, requested, fallback) {
  const model = String(requested || '').trim();
  if (transport === 'sdk') return model || String(fallback || '').trim();
  return !model || model.toLowerCase() === 'auto' ? '' : model;
}
