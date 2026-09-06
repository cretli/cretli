/**
 * MCP tool results: short text plus structuredContent.
 */

/**
 * @param {string} text
 * @param {object} [structured]
 * @param {boolean} [isError]
 */
export function mcpToolResult(text, structured = undefined, isError = false) {
  const result = {
    content: [{ type: 'text', text: String(text || '') }],
    isError: isError === true,
  };
  if (structured !== undefined) result.structuredContent = structured;
  return result;
}

/**
 * @param {string} text
 * @param {boolean} [isError]
 */
export function mcpTextResult(text, isError = false) {
  return mcpToolResult(text, undefined, isError);
}

/**
 * @param {import('./errors.js').CretliMcpToolError} err
 */
export function mcpErrorResult(err) {
  const code = String(err?.code || 'VALIDATION_ERROR');
  const message = String(err?.message || 'MCP tool failed');
  return mcpToolResult(`${code}: ${message}`, { ok: false, code, error: message }, true);
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateText(value, max) {
  const text = String(value || '');
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, Math.max(0, max)), truncated: true };
}
