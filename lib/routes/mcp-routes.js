/**
 * HTTP API for MCP server registry, diagnostics, and session bridge.
 */

import {
  createMcpServer,
  deleteMcpServer,
  getContextStatus,
  getServerTools,
  listMcpServers,
  listContextTools,
  callContextTool,
  testServer,
  updateMcpServer,
  resolveContextServers,
} from '../mcp/mcp-service.js';
import { McpConfigCorruptError, McpRevisionConflictError, loadMcpDocument } from '../persist/mcp-persist.js';
import { normalizeMcpServers } from '../mcp/mcp-config.js';
import { invalidateServerConnections } from '../mcp/mcp-runtime.js';
import {
  MCP_OAUTH_CALLBACK_PATH,
  clearMcpOAuth,
  findMcpServerIdByOAuthState,
  finishMcpOAuth,
  startMcpOAuth,
} from '../mcp/mcp-oauth.js';
import { decodeMcpToolName, encodeMcpToolName, findServerByRuntimeName } from '../mcp/mcp-tool-names.js';
import { McpAuthorizationError, resolveAuthorizedMcpContext } from '../mcp/mcp-session.js';
import { markMcpBridgeToolsListed } from '../mcp/mcp-bridge-ready.js';
import { msg } from '../messages.js';

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean}
 */
function rejectLimitedClients(req, res) {
  if (req.widgetAccess) {
    res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    return true;
  }
  if (req.mcpIntegration && !String(req.path || '').startsWith('/api/mcp/bridge')) {
    res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    return true;
  }
  return false;
}

function sendMcpError(req, res, err) {
  if (err instanceof McpRevisionConflictError) {
    return res.status(409).json({
      ok: false,
      error: err.message,
      revision: err.currentRevision,
      conflict: true,
    });
  }
  if (err instanceof McpConfigCorruptError) {
    return res.status(500).json({ ok: false, error: err.message, corrupt: true });
  }
  if (err?.code === 'NOT_FOUND') {
    return res.status(404).json({ ok: false, error: err.message });
  }
  if (err?.code === 'VALIDATION') {
    return res.status(400).json({ ok: false, error: err.message });
  }
  if (err instanceof McpAuthorizationError) {
    return res.status(403).json({ ok: false, error: err.message });
  }
  return res.status(500).json({ ok: false, error: err?.message || 'MCP request failed' });
}

function expectedRevision(req) {
  const body = Number(req.body?.expectedRevision);
  if (Number.isInteger(body)) return body;
  const query = Number(req.query?.expectedRevision);
  if (Number.isInteger(query)) return query;
  return null;
}

function contextFromQuery(req) {
  return {
    harness: String(req.query.harness || '').trim(),
    sessionId: String(req.query.sessionId || '').trim(),
    workspaceId: String(req.query.workspaceId || '').trim(),
    workspaceFile: String(req.query.workspaceFile || '').trim(),
    workspaceFolder: String(req.query.workspaceFolder || '').trim(),
    mode: String(req.query.mode || 'agent').trim(),
  };
}

function contextFromIntegration(req) {
  return resolveAuthorizedMcpContext(req.mcpIntegration || {});
}

/**
 * @param {string} id
 * @returns {Record<string, any>}
 */
function findRawServer(id) {
  const server = normalizeMcpServers(loadMcpDocument().servers).find((row) => row.id === String(id || ''));
  if (!server) {
    const err = new Error('MCP server not found');
    /** @type {any} */ (err).code = 'NOT_FOUND';
    throw err;
  }
  return server;
}

/**
 * Cretli origin as the browser sees it; the OAuth callback URL is built from it.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function requestOrigin(req) {
  const origin = String(req.get('origin') || '').trim();
  if (/^https?:\/\/[^/\s]+$/i.test(origin)) return origin;
  return `${req.protocol}://${req.get('host')}`;
}

/**
 * Small page shown in the login window; it tells the Settings panel and closes itself.
 *
 * @param {import('express').Response} res
 * @param {number} status
 * @param {boolean} ok
 * @param {string} message
 */
function sendOAuthResultPage(res, status, ok, message) {
  const text = String(message).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const payload = JSON.stringify({ type: 'cretli-mcp-oauth', ok }).replace(/</g, '\\u003c');
  res.status(status).type('html').set('Cache-Control', 'no-store').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cretli MCP</title></head>
<body style="font-family:system-ui,sans-serif;padding:24px;max-width:520px;margin:auto">
<p>${text}</p>
<script>
try { if (window.opener) window.opener.postMessage(${payload}, window.location.origin); } catch (e) {}
${ok ? 'setTimeout(function () { window.close(); }, 1200);' : ''}
</script>
</body></html>`);
}

/**
 * @param {import('express').Express} app
 */
export function registerMcpRoutes(app) {
  app.get('/api/mcp/servers', (req, res) => {
    if (rejectLimitedClients(req, res)) return;
    try {
      const payload = listMcpServers();
      return res.json({ ok: true, ...payload });
    } catch (err) {
      return sendMcpError(req, res, err);
    }
  });

  app.post('/api/mcp/servers', async (req, res) => {
    if (rejectLimitedClients(req, res)) return;
    try {
      const result = await createMcpServer(req.body || {}, expectedRevision(req));
      return res.status(201).json({ ok: true, ...result });
    } catch (err) {
      return sendMcpError(req, res, err);
    }
  });

  app.patch('/api/mcp/servers/:id', async (req, res) => {
    if (rejectLimitedClients(req, res)) return;
    try {
      const result = await updateMcpServer(req.params.id, req.body || {}, expectedRevision(req));
      return res.json({ ok: true, ...result });
    } catch (err) {
      return sendMcpError(req, res, err);
    }
  });

  app.delete('/api/mcp/servers/:id', async (req, res) => {
    if (rejectLimitedClients(req, res)) return;
    try {
      const result = await deleteMcpServer(req.params.id, expectedRevision(req));
      return res.json({ ok: true, ...result });
    } catch (err) {
      return sendMcpError(req, res, err);
    }
  });

  app.post('/api/mcp/servers/:id/test', async (req, res) => {
    if (rejectLimitedClients(req, res)) return;
    try {
      const result = await testServer(contextFromQuery(req), req.params.id);
      return res.json({ ok: result.ok, tools: result.tools, error: result.error || '' });
    } catch (err) {
      return sendMcpError(req, res, err);
    }
  });

  app.post('/api/mcp/servers/:id/oauth/start', async (req, res) => {
    if (rejectLimitedClients(req, res)) return;
    try {
      const server = findRawServer(req.params.id);
      const result = await startMcpOAuth(server, requestOrigin(req));
      if (result.authorized) await invalidateServerConnections(server.id);
      return res.json({ ok: true, ...result });
    } catch (err) {
      if (err?.code || err instanceof McpAuthorizationError) return sendMcpError(req, res, err);
      return res.status(502).json({ ok: false, error: `OAuth: ${err?.message || err}` });
    }
  });

  app.post('/api/mcp/servers/:id/oauth/logout', async (req, res) => {
    if (rejectLimitedClients(req, res)) return;
    try {
      const server = findRawServer(req.params.id);
      await clearMcpOAuth(server.id);
      await invalidateServerConnections(server.id);
      return res.json({ ok: true });
    } catch (err) {
      return sendMcpError(req, res, err);
    }
  });

  // Browser redirect from the authorization server (same browser, so the Cretli session cookie is present).
  app.get(MCP_OAUTH_CALLBACK_PATH, async (req, res) => {
    if (rejectLimitedClients(req, res)) return;
    const serverId = findMcpServerIdByOAuthState(String(req.query.state || ''));
    if (!serverId) return sendOAuthResultPage(res, 400, false, 'Unknown or expired login request. Start the login again.');
    if (req.query.error) {
      const reason = String(req.query.error_description || req.query.error);
      return sendOAuthResultPage(res, 400, false, `Authorization was not granted: ${reason}`);
    }
    try {
      const server = findRawServer(serverId);
      await finishMcpOAuth(server, String(req.query.code || ''));
      await invalidateServerConnections(server.id);
      return sendOAuthResultPage(res, 200, true, `Connected: ${server.name}. You can close this window.`);
    } catch (err) {
      return sendOAuthResultPage(res, 502, false, `OAuth: ${err?.message || err}`);
    }
  });

  app.get('/api/mcp/servers/:id/tools', (req, res) => {
    if (rejectLimitedClients(req, res)) return;
    try {
      const catalog = getServerTools(req.params.id);
      return res.json({ ok: true, ...catalog });
    } catch (err) {
      return sendMcpError(req, res, err);
    }
  });

  app.get('/api/mcp/status', (req, res) => {
    if (rejectLimitedClients(req, res)) return;
    try {
      return res.json({ ok: true, statuses: getContextStatus(contextFromQuery(req)) });
    } catch (err) {
      return sendMcpError(req, res, err);
    }
  });

  app.get('/api/mcp/bridge/tools', async (req, res) => {
    if (!req.mcpIntegration) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    try {
      const context = contextFromIntegration(req);
      const servers = resolveContextServers(context);
      /** @type {Record<string, any>[]} */
      const tools = [];
      for (const server of servers) {
        const listed = await listContextTools(context, server.id);
        for (const tool of listed) {
          tools.push({
            ...tool,
            name: encodeMcpToolName(server.id, tool.name),
            _serverId: server.id,
          });
        }
      }
      markMcpBridgeToolsListed(context.chatId, { toolNames: tools.map((tool) => tool?.name) });
      return res.json({ ok: true, tools });
    } catch (err) {
      return sendMcpError(req, res, err);
    }
  });

  app.post('/api/mcp/bridge/call', async (req, res) => {
    if (!req.mcpIntegration) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    try {
      const context = contextFromIntegration(req);
      const body = req.body || {};
      const encoded = String(body.name || '').trim();
      const decoded = decodeMcpToolName(encoded.startsWith('mcp__') ? encoded : `mcp__${encoded}`);
      const servers = resolveContextServers(context);
      let server = null;
      let toolName = '';
      if (decoded) {
        server = findServerByRuntimeName(servers, decoded.runtimeName);
        toolName = decoded.toolName;
      }
      if (!server) {
        const sep = encoded.indexOf('__');
        if (sep > 0) {
          server = findServerByRuntimeName(servers, encoded.slice(0, sep));
          toolName = encoded.slice(sep + 2);
        }
      }
      if (!server || !toolName) {
        return res.status(400).json({ ok: false, error: 'Unknown MCP tool' });
      }
      const abortController = new AbortController();
      const onRequestClose = () => {
        if (!res.headersSent && req.aborted) abortController.abort();
      };
      req.on('close', onRequestClose);
      try {
        const result = await callContextTool(
          context,
          server.id,
          toolName,
          body.arguments || {},
          abortController.signal,
        );
        if (result.raw && typeof result.raw === 'object') {
          return res.json({
            ok: result.ok !== false,
            ...result.raw,
            output: result.output,
            error: result.error || '',
            denied: result.denied === true,
          });
        }
        return res.json({ ok: result.ok !== false, ...result });
      } finally {
        req.off('close', onRequestClose);
      }
    } catch (err) {
      return sendMcpError(req, res, err);
    }
  });
}
