import {
  CLIENT_INSTANCE_COMMAND_TYPES,
  completeClientInstanceCommand,
  dequeueClientInstanceCommands,
  enqueueClientInstanceCommand,
  getClientInstanceCommand,
  listClientInstanceCommandResults,
} from '../client-instance-commands.js';
import {
  clearClientInstanceLogFile,
  readClientInstanceLogTail,
} from '../client-instance-logs.js';
import {
  getClientInstance,
  isValidClientInstanceId,
  listClientInstances,
  upsertClientInstance,
} from '../client-instance-registry.js';

import { getRequestClientIp } from '../http-request.js';

/**
 * @typedef {Object} ClientInstancesRoutesContext
 * @property {string} dataDir
 */

/**
 * @param {import('express').Express} app
 * @param {ClientInstancesRoutesContext} ctx
 */
export function registerClientInstancesRoutes(app, ctx) {
  app.post('/api/client-instances/heartbeat', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const record = upsertClientInstance(body, getRequestClientIp(req));
    if (!record) {
      return res.status(400).json({ ok: false, error: 'Missing or invalid clientInstanceId' });
    }
    const commandResults = Array.isArray(body.commandResults) ? body.commandResults : [];
    for (const row of commandResults) {
      if (!row || typeof row !== 'object') continue;
      const commandId = typeof row.commandId === 'string' ? row.commandId.trim() : '';
      if (!commandId) continue;
      completeClientInstanceCommand(commandId, {
        ok: row.ok === true,
        type: typeof row.type === 'string' ? row.type : null,
        pong: row.pong === true,
        elapsedMs: Number.isFinite(Number(row.elapsedMs)) ? Number(row.elapsedMs) : null,
        error: typeof row.error === 'string' ? row.error.slice(0, 240) : null,
      });
    }
    return res.json({ ok: true, instance: { ...record, status: 'online' } });
  });
  app.get('/api/client-instances', (_req, res) => {
    const instances = listClientInstances();
    return res.json({ ok: true, instances, serverTime: Date.now() });
  });
  app.get('/api/client-instances/commands', (req, res) => {
    const clientInstanceId = typeof req.query.clientInstanceId === 'string' ? req.query.clientInstanceId.trim() : '';
    if (!isValidClientInstanceId(clientInstanceId)) {
      return res.status(400).json({ ok: false, error: 'Missing or invalid clientInstanceId' });
    }
    const commands = dequeueClientInstanceCommands(clientInstanceId);
    return res.json({ ok: true, clientInstanceId, commands, serverTime: Date.now() });
  });
  app.get('/api/client-instances/commands/:commandId', (req, res) => {
    const command = getClientInstanceCommand(req.params.commandId);
    if (!command) return res.status(404).json({ ok: false, error: 'Command not found' });
    return res.json({ ok: true, command, serverTime: Date.now() });
  });
  app.get('/api/client-instances/:id', (req, res) => {
    const record = getClientInstance(req.params.id);
    if (!record) return res.status(404).json({ ok: false, error: 'Client instance not found' });
    const now = Date.now();
    return res.json({
      ok: true,
      instance: {
        ...record,
        status: record.lastSeenAt >= now - 30000 ? 'online' : record.lastSeenAt >= now - 120000 ? 'stale' : 'offline',
      },
      commandResults: listClientInstanceCommandResults(req.params.id, 10),
      serverTime: now,
    });
  });
  app.post('/api/client-instances/:targetId/commands', (req, res) => {
    const targetId = req.params.targetId;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const fromInstanceId = typeof body.fromInstanceId === 'string' ? body.fromInstanceId.trim() : '';
    const type = typeof body.type === 'string' ? body.type.trim() : '';
    if (!isValidClientInstanceId(targetId)) {
      return res.status(400).json({ ok: false, error: 'Invalid target client instance id' });
    }
    if (!isValidClientInstanceId(fromInstanceId)) {
      return res.status(400).json({ ok: false, error: 'Missing or invalid fromInstanceId' });
    }
    if (!CLIENT_INSTANCE_COMMAND_TYPES.includes(type)) {
      return res.status(400).json({ ok: false, error: 'Invalid command type', allowed: CLIENT_INSTANCE_COMMAND_TYPES });
    }
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : null;
    const command = enqueueClientInstanceCommand(targetId, fromInstanceId, type, payload);
    if (!command) {
      return res.status(429).json({ ok: false, error: 'Command queue full or invalid request' });
    }
    return res.json({ ok: true, command, serverTime: Date.now() });
  });
  app.get('/api/client-instances/:id/logs', (req, res) => {
    const id = req.params.id;
    if (!isValidClientInstanceId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid client instance id' });
    }
    const limitRaw = Number.parseInt(String(req.query.limit || '200'), 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 200;
    const tail = readClientInstanceLogTail(ctx.dataDir, id, { limit });
    return res.json({
      ok: true,
      clientInstanceId: id,
      lines: tail.lines,
      totalBytes: tail.totalBytes,
      serverTime: Date.now(),
    });
  });
  app.delete('/api/client-instances/:id/logs', (req, res) => {
    const id = req.params.id;
    if (!isValidClientInstanceId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid client instance id' });
    }
    const cleared = clearClientInstanceLogFile(ctx.dataDir, id);
    return res.json({ ok: true, cleared });
  });
}
