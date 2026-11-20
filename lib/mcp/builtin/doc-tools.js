import { resolveCretliToolContext } from './tool-context.js';
import { mcpToolResult } from './result.js';
import { requireClientMethod } from './client-scope.js';

const tool = (name, op, description, properties, required = []) => ({
  name, readOnly: !op.startsWith('propose_'), description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  async handler(args, { client, session, signal }) {
    requireClientMethod(client, 'docRequest');
    const ctx = resolveCretliToolContext(session);
    const scope = { workspaceId: ctx.workspaceId, workspaceFile: ctx.workspaceFile, workspaceFolder: ctx.workspaceFolder };
    return mcpToolResult(`${name}: ok`, await client.docRequest({ op, scope, args, chatId: ctx.chatId }, { signal }));
  },
});
const PATH = { path: { type: 'string', description: 'Root-relative Markdown path.' } };
export const DOC_PROPOSAL_MCP_TOOLS = [
  tool('doc_propose_write', 'propose_write', 'Propose creating or replacing a note; only human approval writes it.',
    { ...PATH, text: { type: 'string' } }, ['path', 'text']),
  tool('doc_propose_append', 'propose_append', 'Propose appending exact text to a note; only human approval writes it.',
    { ...PATH, text: { type: 'string' } }, ['path', 'text']),
  tool('doc_propose_link', 'propose_link', 'Propose a managed note link; only human approval creates it.',
    { ...PATH, target: { type: 'string', description: 'todo|initiative|decision:uuid' } }, ['path', 'target']),
];
export const DOC_MCP_TOOLS = [
  tool('doc_list', 'list', 'List Markdown notes in the session workspace.', {}),
  tool('doc_read', 'read', 'Read a note, its managed links, mentions and backlinks.', PATH, ['path']),
  tool('doc_search', 'search', 'Search note text and titles in the session workspace.',
    { q: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['q']),
  tool('doc_backlinks', 'backlinks', 'Read backlinks by note path or reverse links by target (todo|initiative|decision:uuid).',
    { ...PATH, target: { type: 'string' } }),
];
