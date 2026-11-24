/**
 * REST for operator chats (Remote Control sessions, lib/remote-control/rc-sessions.js).
 * Login-session only: widgets, per-chat MCP tokens and agent sessions are refused,
 * because a session gets the folder's Cretli MCP in the chosen (possibly operator) mode.
 */

import { getSessionIdFromRequest, isBrowserOwnerSessionActive } from '../auth.js';
import { ExternalMcpClientError, verifyExternalMcpToken } from '../mcp/mcp-external-clients.js';
import { isLoopbackAddress } from '../local-login.js';
import { ExternalMcpInstallError } from '../mcp/mcp-external-install.js';
import { loadSettings } from '../persist/settings.js';
import {
  configureRemoteControl,
  createRemoteControlSession,
  deleteRemoteControlSession,
  healRemoteControlSession,
  listRemoteControlSessions,
  RemoteControlError,
  startRemoteControlAutostart,
  startRemoteControlSession,
  stopRemoteControlSession,
  updateRemoteControlSession,
} from '../remote-control/rc-sessions.js';

const AUTOSTART_DELAY_MS = 5000;

/**
 * @param {import('express').Request & { widgetAccess?: unknown, mcpIntegration?: unknown }} req
 * @param {import('express').Response} res
 */
function rejectNonHuman(req, res) {
  const sessionId = getSessionIdFromRequest(req) || '';
  if (req.widgetAccess || req.mcpIntegration || !sessionId || !isBrowserOwnerSessionActive(sessionId)) {
    res.status(403).json({ ok: false, error: 'Operator chats are managed by a person logged in to Cretli' });
    return true;
  }
  return false;
}

/**
 * @param {import('express').Response} res
 * @param {() => unknown} action
 * @param {number} [okStatus]
 */
function respond(res, action, okStatus = 200) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const result = action();
    return res.status(okStatus).json({ ok: true, ...(result && typeof result === 'object' ? result : {}) });
  } catch (err) {
    const known = err instanceof RemoteControlError || err instanceof ExternalMcpInstallError || err instanceof ExternalMcpClientError;
    return res.status(known ? /** @type {any} */ (err).status : 500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * @param {import('express').Express} app
 * @param {Parameters<typeof configureRemoteControl>[0] & { autostart?: false }} ctx
 *   `autostart: false` skips starting the saved sessions after boot (tests).
 */
export function registerRemoteControlRoutes(app, ctx) {
  configureRemoteControl(ctx);
  if (ctx.autostart !== false) setTimeout(startRemoteControlAutostart, AUTOSTART_DELAY_MS).unref();

  app.get('/api/remote-control/sessions', (req, res) => {
    if (rejectNonHuman(req, res)) return;
    respond(res, () => ({ sessions: listRemoteControlSessions() }));
  });

  app.post('/api/remote-control/sessions', (req, res) => {
    if (rejectNonHuman(req, res)) return;
    if (loadSettings().externalMcpEnabled !== true) {
      return res.status(409).json({ ok: false, error: 'External MCP access is disabled (Settings → MCP)' });
    }
    return respond(res, () => ({ session: createRemoteControlSession(req.body || {}) }), 201);
  });

  app.post('/api/remote-control/sessions/:id/start', (req, res) => {
    if (rejectNonHuman(req, res)) return;
    respond(res, () => ({ session: startRemoteControlSession(String(req.params.id)) }));
  });

  app.post('/api/remote-control/sessions/:id/stop', (req, res) => {
    if (rejectNonHuman(req, res)) return;
    respond(res, () => ({ session: stopRemoteControlSession(String(req.params.id)) }));
  });

  app.patch('/api/remote-control/sessions/:id', (req, res) => {
    if (rejectNonHuman(req, res)) return;
    respond(res, () => ({ session: updateRemoteControlSession(String(req.params.id), req.body || {}) }));
  });

  app.delete('/api/remote-control/sessions/:id', (req, res) => {
    if (rejectNonHuman(req, res)) return;
    respond(res, () => { deleteRemoteControlSession(String(req.params.id)); });
  });

  // Self-heal for a session that lost its Cretli tools (scripts/cretli-mcp-heal.mjs). Outside /api like
  // /mcp: authenticated by the folder connection's own token, local machine only, no browser requests.
  app.post('/mcp/remote-control/heal', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (loadSettings().externalMcpEnabled !== true) {
      return res.status(404).json({ ok: false, error: 'External MCP access is disabled (Settings → MCP)' });
    }
    if (req.headers.origin) return res.status(403).json({ ok: false, error: 'Browser requests are not accepted' });
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      return res.status(403).json({ ok: false, error: 'Only a session on the Cretli machine can heal itself' });
    }
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    let client;
    try {
      client = verifyExternalMcpToken(authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '');
    } catch (err) {
      return res.status(401).json({ ok: false, error: err instanceof Error ? err.message : 'Invalid MCP client token' });
    }
    if (!client.managed || client.installTarget !== 'claude' || !client.installFolder) {
      return res.status(403).json({ ok: false, error: 'Only a Claude Code connection made by Cretli can heal its operator chat' });
    }
    return respond(res, () => {
      const result = healRemoteControlSession(String(client.installFolder));
      return {
        ...result,
        message: `Cretli approved the cretli MCP server and restarts the operator chat "${result.name}" in ${Math.round(result.restartInMs / 1000)} s; the conversation resumes with the Cretli tools.`,
      };
    });
  });
}
