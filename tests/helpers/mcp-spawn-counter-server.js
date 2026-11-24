#!/usr/bin/env node
// Fixture stdio MCP that records every process start (one line per spawn) in MCP_SPAWN_LOG.
import fs from 'node:fs';

if (process.env.MCP_SPAWN_LOG) fs.appendFileSync(process.env.MCP_SPAWN_LOG, `${process.pid}\n`);
await import('../../scripts/mcp-test-server.js');
