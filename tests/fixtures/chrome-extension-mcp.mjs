/** Hermetic extension stand-in: no browser, network or user credentials. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'fake-chrome', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ['echo', 'slow', 'fail'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name === 'fail') throw new Error('upstream failure');
  if (params.name === 'slow') await new Promise((resolve) => setTimeout(resolve, 100));
  return { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, args: params.arguments }) }] };
});
await server.connect(new StdioServerTransport());
