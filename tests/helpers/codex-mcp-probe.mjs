/** Isolated stdio MCP fixture for real Codex transport checks. */
import { createInterface } from 'node:readline';

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'codex-probe', version: '1.0.0' },
    });
  } else if (message.method === 'tools/list') {
    reply(message.id, { tools: ['probe', 'fail_probe'].map((name) => ({
      name,
      description: name === 'probe' ? 'Read the probe token.' : 'Return the expected probe error.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    })) });
  } else if (message.method === 'tools/call') {
    const failed = message.params.name === 'fail_probe';
    reply(message.id, {
      content: [{ type: 'text', text: failed ? 'Expected probe error' : process.env.MCP_PROBE_TOKEN }],
      ...(failed ? { isError: true } : { structuredContent: { token: process.env.MCP_PROBE_TOKEN } }),
    });
  } else if (message.method === 'ping') {
    reply(message.id, {});
  }
});
