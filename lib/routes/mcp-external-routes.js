/**
 * Cretli's built-in MCP tools for external clients (Claude Code, Cursor, …):
 * a stateless Streamable HTTP MCP endpoint at `/mcp` and the session-only
 * Settings API that manages the client tokens (lib/mcp/mcp-external-clients.js).
 *
 * Guards on `/mcp`, in order: the Settings switch (`externalMcpEnabled`,
 * default off), no browser `Origin` header (DNS-rebinding protection),
 * loopback peers unless `externalMcpAllowLan`, then a valid client token, then
 * a per-client rate limit (HTTP 429, tool not run). Every tool call is audited
 * in two phases (lib/mcp/mcp-external-audit.js): a `started` record must be written
 * before the tool runs, otherwise the call is refused (fail-closed).
 * Only the `builtin-cretli` server is exposed — never the user's other MCP
 * servers and their secrets — in the client's workspace and mode.
 */

import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { isLoopbackAddress } from '../local-login.js';
import { loadSettings } from '../persist/settings.js';
import { loadMcpDocument } from '../persist/mcp-persist.js';
import { BUILTIN_CRETILI_SERVER_ID } from '../mcp/mcp-config.js';
import { callContextTool, listContextTools, resolveContextServers } from '../mcp/mcp-service.js';
import {
  createExternalMcpClient,
  EXTERNAL_MCP_MODES,
  ExternalMcpClientError,
  listExternalMcpClients,
  revokeExternalMcpClient,
  rotateExternalMcpClientToken,
  updateExternalMcpClientMode,
  verifyExternalMcpToken,
} from '../mcp/mcp-external-clients.js';
import { ExternalMcpInstallError, installExternalMcpConfig } from '../mcp/mcp-external-install.js';
import { appendExternalMcpAudit,appendExternalMcpAuditStarted, consumeExternalMcpRateLimit } from '../mcp/mcp-external-audit.js';
import {
  callExternalOperatorTool,
  EXTERNAL_OPERATOR_TOOLS,
  isExternalOperatorTool,
} from '../mcp/mcp-external-operator-tools.js';
import { externalMcpInstructions } from '../mcp/mcp-external-guide.js';
import { assertOperatorLease, recordOperatorEvent } from '../persist/operator-journal-persist.js';

export const EXTERNAL_MCP_PATH = '/mcp';
const SERVER_INFO = { name: 'cretli', version: '0.1.0' };

export function bindOperatorSessionId(clientId, requestedSessionId) {
  const localId = String(requestedSessionId || '').trim().slice(0, 128) || 'default';
  return `mcp:${createHash('sha256').update(String(clientId)).update('\0').update(localId).digest('base64url')}`;
}

const SCOUT_PROFILE_MUTATIONS = new Set(['create', 'update', 'duplicate', 'archive', 'run', 'from_template', 'restore']);
const SCOUT_FINDING_MUTATIONS = new Set(['accept', 'reject', 'submit']);

/** Return the operator audit category for a mutating scout action, or null for reads. */
export function classifyScoutMutation(toolName, action) {
  if (toolName === 'scout_profiles' && SCOUT_PROFILE_MUTATIONS.has(String(action || ''))) return 'scout_profile';
  if (toolName === 'scout_findings' && SCOUT_FINDING_MUTATIONS.has(String(action || ''))) return 'scout_findings';
  return null;
}

/**
 * Settings API is for the logged-in user only: widget and per-chat MCP
 * integration tokens must not create or list external clients.
 *
 * @param {import('express').Request & { widgetAccess?: unknown, mcpIntegration?: unknown }} req
 * @param {import('express').Response} res
 */
function rejectLimitedClients(req, res) {
  if (!req.widgetAccess && !req.mcpIntegration) return false;
  res.status(403).json({ ok: false, error: 'External MCP clients are managed from a logged-in session only' });
  return true;
}

/**
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} message
 */
function sendMcpHttpError(res, status, message) {
  if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="cretli-mcp"');
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
}

/**
 * Runtime context for one client: like a chat's MCP context, minus the chat.
 *
 * @param {import('../mcp/mcp-external-clients.js').ExternalMcpClientInfo} client
 */
function externalClientContext(client) {
  const revision = loadMcpDocument().revision;
  // Operator tools are answered here, outside the catalog; the catalog itself runs as `agent`.
  const mode = client.mode === 'operator' ? 'agent' : client.mode;
  return {
    sessionId: `external:${client.id}`,
    chatId: '',
    workspaceId: '',
    workspaceFile: '',
    workspaceFolder: client.workspaceFolder,
    harness: '',
    mode,
    getMode: () => mode,
    revision,
    configurationRevision: revision,
    attemptId: '',
    runId: '',
    delegationId: '',
    // Only operator tokens may drive browser_* without a chat (system-owner session).
    operatorBrowser: client.mode === 'operator',
  };
}

/**
 * Names of the `tools/call` requests in a JSON-RPC body (single or batch).
 *
 * @param {unknown} body
 * @returns {string[]}
 */
function toolCallNames(body) {
  const messages = Array.isArray(body) ? body : [body];
  return messages
    .filter((message) => message && typeof message === 'object' && message.method === 'tools/call')
    .map((message) => String(message.params?.name || ''));
}

/**
 * @param {{ ok?: boolean, output?: string, error?: string, raw?: any }} result
 */
function toCallToolResult(result) {
  if (result?.raw && Array.isArray(result.raw.content)) return result.raw;
  const text = String(result?.output || result?.error || '');
  return { content: [{ type: 'text', text }], isError: result?.ok === false };
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleExternalMcpRequest(req, res) {
  const settings = loadSettings();
  if (settings.externalMcpEnabled !== true) {
    return sendMcpHttpError(res, 403, 'External MCP access is disabled (Settings → MCP)');
  }
  if (req.headers.origin) {
    return sendMcpHttpError(res, 403, 'Browser requests are not accepted on the MCP endpoint');
  }
  if (!isLoopbackAddress(req.socket?.remoteAddress) && settings.externalMcpAllowLan !== true) {
    return sendMcpHttpError(res, 403, 'External MCP access is limited to localhost (Settings → MCP)');
  }
  const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  let client;
  try {
    client = verifyExternalMcpToken(authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '');
  } catch (err) {
    const status = err instanceof ExternalMcpClientError ? err.status : 401;
    return sendMcpHttpError(res, status, err instanceof Error ? err.message : 'Invalid MCP client token');
  }
  client = { ...client, sessionId: bindOperatorSessionId(client.id, req.headers['x-cretli-operator-session']) };

  const calledTools = toolCallNames(req.body);
  if (calledTools.length > 0 && !consumeExternalMcpRateLimit(client.id, calledTools.length)) {
    for (const tool of calledTools) appendExternalMcpAudit({ clientId: client.id, tool, outcome: 'rejected' });
    res.setHeader('Retry-After', '60');
    return sendMcpHttpError(res, 429, 'Too many tool calls for this MCP client; retry in a minute');
  }

  const context = externalClientContext(client);
  const activeServerIds = resolveContextServers(context).map((server) => /** @type {{ id?: string }} */ (server).id);
  if (!activeServerIds.includes(BUILTIN_CRETILI_SERVER_ID)) {
    for (const tool of calledTools) appendExternalMcpAudit({ clientId: client.id, tool, outcome: 'rejected' });
    return sendMcpHttpError(res, 503, 'The built-in Cretli MCP server is disabled or out of scope for this workspace');
  }

  const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: externalMcpInstructions(client.mode, client.workspaceFolder) });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await listContextTools(context, BUILTIN_CRETILI_SERVER_ID);
    const listed = tools.map((tool) => Object.fromEntries(Object.entries(tool).filter(([key]) => !key.startsWith('_'))));
    return { tools: client.mode === 'operator' ? [...listed, ...EXTERNAL_OPERATOR_TOOLS] : listed };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    console.info(`[mcp-external] ${client.name} (${client.id.slice(0, 8)}) -> ${toolName}`);
    // Fail-closed: the tool runs only after its `started` audit record is durable.
    try {
      appendExternalMcpAuditStarted({ clientId: client.id, tool: toolName });
    } catch (err) {
      console.error(`[mcp-external] audit write failed, refusing ${toolName}: ${err instanceof Error ? err.message : err}`);
      throw new McpError(ErrorCode.InternalError, 'Audit log unavailable; tool call refused and not executed');
    }
    /** @type {import('@modelcontextprotocol/sdk/types.js').CallToolResult} */
    let outcome;
    try {
      if (client.mode === 'operator' && isExternalOperatorTool(toolName)) {
        outcome = await callExternalOperatorTool(client, toolName, request.params.arguments || {}, { signal: extra.signal });
      } else {
        const scoutAuditKind = client.mode === 'operator' ? classifyScoutMutation(toolName, request.params.arguments?.action) : null;
        if (client.mode === 'operator' && (toolName === 'todo_integration' || scoutAuditKind)) {
          assertOperatorLease({ workspaceFolder: client.workspaceFolder, sessionId: client.sessionId, clientId: client.id, clientName: client.name });
        }
        outcome = toCallToolResult(
          await callContextTool(context, BUILTIN_CRETILI_SERVER_ID, toolName, request.params.arguments || {}, extra.signal),
        );
        if (client.mode === 'operator' && toolName === 'todo_integration' && !outcome.isError) {
          recordOperatorEvent(client.workspaceFolder, 'integration', `Todo integration: ${String(request.params.arguments?.todo_id || 'unknown')}`);
        }
        if (scoutAuditKind && !outcome.isError && outcome.structuredContent?.ok !== false) {
          const args = request.params.arguments || {};
          const ref = toolName === 'scout_findings' ? (args.ids || args.id || 'unknown') : (args.scout_id || args.id || 'unknown');
          recordOperatorEvent(client.workspaceFolder, scoutAuditKind, `${String(args.action)} ${String(ref)}`);
        }
      }
    } catch (err) {
      appendExternalMcpAudit({ clientId: client.id, tool: toolName, outcome: 'error' });
      throw err;
    }
    appendExternalMcpAudit({ clientId: client.id, tool: toolName, outcome: outcome?.isError ? 'error' : 'ok' });
    return outcome;
  });
  // Stateless: one server and transport per HTTP request, JSON responses.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) sendMcpHttpError(res, 500, err instanceof Error ? err.message : 'MCP request failed');
  }
}

/**
 * @param {import('express').Express} app
 */
export function registerExternalMcpRoutes(app) {
  app.get('/api/mcp/external-clients', (req, res) => {
    if (rejectLimitedClients(req, res)) return;
    const settings = loadSettings();
    res.json({
      ok: true,
      enabled: settings.externalMcpEnabled === true,
      allowLan: settings.externalMcpAllowLan === true,
      endpointPath: EXTERNAL_MCP_PATH,
      modes: EXTERNAL_MCP_MODES,
      clients: listExternalMcpClients(),
    });
  });

  app.post('/api/mcp/external-clients', (req, res) => {
    if (rejectLimitedClients(req, res)) return;
    try {
      const created = createExternalMcpClient(req.body || {});
      res.status(201).json({ ok: true, ...created, endpointPath: EXTERNAL_MCP_PATH });
    } catch (err) {
      const status = err instanceof ExternalMcpClientError ? err.status : 500;
      res.status(status).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/mcp/external-clients/:id', (req, res) => {
    if (rejectLimitedClients(req, res)) return;
    try {
      const client = updateExternalMcpClientMode(String(req.params.id || ''), req.body?.mode);
      if (!client) return res.status(404).json({ ok: false, error: 'MCP client not found' });
      return res.json({ ok: true, client });
    } catch (err) {
      const status = err instanceof ExternalMcpClientError ? err.status : 500;
      return res.status(status).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/mcp/external-clients/:id/rotate', (req, res) => {
    if (rejectLimitedClients(req, res)) return;
    try {
      const rotated = rotateExternalMcpClientToken(String(req.params.id || ''));
      if (!rotated) return res.status(404).json({ ok: false, error: 'MCP client not found' });
      return res.json({ ok: true, ...rotated, endpointPath: EXTERNAL_MCP_PATH });
    } catch (err) {
      const status = err instanceof ExternalMcpClientError ? err.status : 500;
      return res.status(status).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Writes the client configuration (token by env reference) into the client's workspace folder.
  app.post('/api/mcp/external-clients/:id/install', (req, res) => {
    if (rejectLimitedClients(req, res)) return;
    const client = listExternalMcpClients().find((row) => row.id === String(req.params.id || ''));
    if (!client) return res.status(404).json({ ok: false, error: 'MCP client not found' });
    if (client.revokedAt) return res.status(409).json({ ok: false, error: 'MCP client is revoked' });
    try {
      // An optional token is written into the file, but only the client's own valid token.
      let token;
      if (req.body?.token) {
        const verified = verifyExternalMcpToken(String(req.body.token));
        if (verified.id !== client.id) throw new ExternalMcpInstallError('The token does not belong to this client', 403);
        token = String(req.body.token);
      }
      // Optional custom folder; defaults to the client's workspace folder.
      const customFolder = typeof req.body?.folder === 'string' ? req.body.folder.trim() : '';
      if (customFolder && !path.isAbsolute(customFolder)) {
        throw new ExternalMcpInstallError('folder must be an absolute path');
      }
      const result = installExternalMcpConfig({
        target: req.body?.target,
        folder: customFolder ? path.resolve(customFolder) : client.workspaceFolder,
        mode: req.body?.mode || 'http',
        url: req.body?.url,
        token,
      });
      return res.json({ ok: true, ...result });
    } catch (err) {
      const status = err instanceof ExternalMcpInstallError || err instanceof ExternalMcpClientError ? err.status : 500;
      return res.status(status).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/mcp/external-clients/:id', (req, res) => {
    if (rejectLimitedClients(req, res)) return;
    if (!revokeExternalMcpClient(String(req.params.id || ''))) {
      return res.status(404).json({ ok: false, error: 'MCP client not found' });
    }
    return res.json({ ok: true });
  });

  app.all(EXTERNAL_MCP_PATH, (req, res) => {
    void handleExternalMcpRequest(req, res);
  });
}
