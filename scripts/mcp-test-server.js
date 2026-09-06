#!/usr/bin/env node
/**
 * Local stdio MCP for Cretli Settings (ping_read + write_note).
 * Tests spawn the same process via tests/helpers/mcp-fixture-server.js.
 */

import { createInterface } from 'node:readline';
import fs from 'node:fs';

const TOOLS = [
  {
    name: 'ping_read',
    description: 'Read-only ping. Safe in Plan.',
    inputSchema: { type: 'object', properties: { token: { type: 'string' } } },
  },
  {
    name: 'write_note',
    description: 'Echo a note. Blocked in Plan unless allowlisted.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function error(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  const id = message.id;
  if (message.method === 'initialize') {
    const delayMs = Number(process.env.MCP_CONNECT_DELAY_MS);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
    reply(id, {
      protocolVersion: String(message.params?.protocolVersion || '2025-03-26'),
      capabilities: { tools: {} },
      serverInfo: { name: 'cretli-mcp-test', version: '1.0.0' },
    });
    return;
  }
  if (String(message.method || '').startsWith('notifications/')) return;
  if (message.method === 'ping') {
    reply(id, {});
    return;
  }
  if (message.method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }
  if (message.method === 'tools/call') {
    const name = String(message.params?.name || '');
    if (name === 'ping_read') {
      reply(id, { content: [{ type: 'text', text: `pong:${message.params?.arguments?.token || ''}` }] });
      return;
    }
    if (name === 'write_note') {
      const counterFile = String(process.env.MCP_WRITE_COUNTER_FILE || '').trim();
      if (counterFile) {
        const current = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) || 0 : 0;
        fs.writeFileSync(counterFile, String(current + 1));
      }
      reply(id, { content: [{ type: 'text', text: `wrote:${message.params?.arguments?.text || ''}` }] });
      return;
    }
    error(id, -32602, `Unknown tool ${name}`);
  }
});
