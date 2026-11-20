import { recoverToolResult } from '../../tool-result-compression/index.js';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

export const TOOL_RESULT_MCP_TOOLS = Object.freeze([{
  name: 'result_full',
  readOnly: true,
  description: 'Recover a compressed tool result by its reference id. Use offset and length to page through the exact original.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      offset: { type: 'integer', minimum: 0 },
      length: { type: 'integer', minimum: 1, maximum: 4000 },
    },
    required: ['id'],
  },
  handler(args) {
    const id = String(args?.id || '');
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'Invalid result id');
    }
    const original = recoverToolResult(id);
    if (original === undefined) {
      throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Tool result no longer available');
    }
    const offset = Number(args?.offset ?? 0);
    const length = Number(args?.length ?? 4000);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 4000) {
      throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'Invalid offset or length');
    }
    const text = original.slice(offset, offset + length);
    const nextOffset = offset + text.length < original.length ? offset + text.length : null;
    return mcpToolResult(text, { id, offset, length: text.length, total_length: original.length, next_offset: nextOffset });
  },
}]);
