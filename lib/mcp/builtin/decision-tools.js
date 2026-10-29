import { resolveCretliToolContext } from './tool-context.js';
import { mcpToolResult } from './result.js';
import { requireClientMethod } from './client-scope.js';
import { DECISION_WAIT_MAX_MS } from '../../decisions/decision-request.js';
import { DECISION_OPTION_PROPERTIES } from './watcher-tools.js';

export const DECISION_MCP_TOOLS = [{
  name: 'decision_request', readOnly: false,
  description: 'Create a decision card with 2–4 options, recommended option id and one-sentence why. Only the human can resolve it. Retry with the same idempotency_key, or decision_id to read/wait. Each wait is capped at 24 seconds. Inna odpowiedź… is always available.',
  inputSchema: { type: 'object', properties: {
    ...DECISION_OPTION_PROPERTIES,
    title: { type: 'string' }, summary: { type: 'string' }, kind: { type: 'string' },
    idempotency_key: { type: 'string' }, decision_id: { type: 'string' },
    onTimeout: { type: 'string', enum: ['nothing', 'reject', 'recommended'] },
    wait_ms: { type: 'integer', minimum: 0, maximum: DECISION_WAIT_MAX_MS },
  } },
  async handler(args, { client, session, signal }) {
    requireClientMethod(client, 'decisionRequest');
    const ctx = resolveCretliToolContext(session);
    const result = await client.decisionRequest({ ...args, workspaceFolder: ctx.workspaceFolder,
      chatId: ctx.chatId, idempotencyKey: args.idempotency_key, decisionId: args.decision_id,
      waitMs: Math.min(DECISION_WAIT_MAX_MS, Math.max(0, Number(args.wait_ms) || 0)),
    }, { signal });
    return mcpToolResult(`decision_request: ${result.decision?.status || 'pending'}`, result);
  },
}];
