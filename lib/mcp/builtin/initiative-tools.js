import { resolveCretliToolContext } from './tool-context.js';
import { mcpToolResult } from './result.js';
import { requireClientMethod } from './client-scope.js';

/** Runs one initiative op for the calling chat's workspace; the agent can read and propose, never decide direction. */
async function call(op, args, { client, session, signal }) {
  requireClientMethod(client, 'initiativeRequest');
  const ctx = resolveCretliToolContext(session);
  const scope = { workspaceId: ctx.workspaceId, workspaceFile: ctx.workspaceFile, workspaceFolder: ctx.workspaceFolder };
  return client.initiativeRequest({ op, scope, args }, { signal });
}

const ID = { id: { type: 'string', description: 'Initiative id.' } };
const PAGE = { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } };

const tool = (name, op, description, properties, required, readOnly) => ({
  name, readOnly,
  description,
  inputSchema: { type: 'object', properties, required },
  async handler(args, deps) {
    const result = await call(op, args, deps);
    return mcpToolResult(`${name}: ok`, result);
  },
});

export const INITIATIVE_MCP_TOOLS = [
  tool('initiative_list', 'list', 'List development-plan initiatives of this workspace (keyset paging, default 50, max 100).',
    { ...PAGE, status: { type: 'string' }, horizon: { type: 'string', enum: ['now', 'next', 'later'] }, includeArchived: { type: 'boolean' } }, [], true),
  tool('initiative_get', 'get', 'Read one initiative.', { ...ID }, ['id'], true),
  tool('initiative_history', 'history', 'Read the durable change journal of an initiative.', { ...ID, ...PAGE }, ['id'], true),
  tool('initiative_graph', 'graph', 'Bounded slice of the initiative graph with explicit truncation.', { ...PAGE }, [], true),
  tool('initiative_create', 'create', 'Propose a new initiative as draft/exploring. Retry with the same idempotency_key. A human accepts the direction.',
    { initiative: { type: 'object', description: 'title and desiredOutcome are required; status may be draft or exploring.' }, idempotencyKey: { type: 'string' } },
    ['initiative', 'idempotencyKey'], false),
  tool('initiative_update', 'update', 'Edit a draft/exploring initiative (compare-and-swap on expectedRevision). Strategic fields of an accepted initiative are human-only: propose via research instead.',
    { ...ID, patch: { type: 'object' }, expectedRevision: { type: 'integer' }, reason: { type: 'string' } }, ['id', 'patch', 'expectedRevision'], false),
  tool('initiative_relate', 'relate', 'Add a supports or alternative_to relation between two initiatives (requires/contributes_to are human-only).',
    { type: { type: 'string', enum: ['supports', 'alternative_to'] }, fromId: { type: 'string' }, toId: { type: 'string' } }, ['type', 'fromId', 'toId'], false),
  tool('initiative_link', 'link', 'Link an existing Todo, Decision, research or Git outcome to an initiative without changing it.',
    { ...ID, kind: { type: 'string', enum: ['todo', 'decision', 'research', 'git'] }, targetId: { type: 'string' } }, ['id', 'kind', 'targetId'], false),
  tool('initiative_cite', 'research', 'Add a research entry (observed / hypothesis / unknown) with sources and limitations; pass supersedesId to add a new version.',
    { ...ID, entry: { type: 'object' }, supersedesId: { type: 'string' } }, ['id', 'entry'], false),
];
