#!/usr/bin/env node
/**
 * Stdio MCP whose tool list is read from the JSON file in MCP_TOOLS_FILE on every
 * tools/list, so a test can change the schemas while the server keeps running.
 */
import { createInterface } from 'node:readline';
import fs from 'node:fs';

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: String(message.params?.protocolVersion || '2025-03-26'),
      capabilities: { tools: {} },
      serverInfo: { name: 'cretli-mutable-test', version: '1.0.0' },
    });
  } else if (message.method === 'tools/list') {
    reply(message.id, { tools: JSON.parse(fs.readFileSync(String(process.env.MCP_TOOLS_FILE), 'utf8')) });
  } else if (message.method === 'ping') {
    reply(message.id, {});
  }
});
