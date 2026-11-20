#!/usr/bin/env node
/**
 * Operator entry point for the Browser egress proxy service.
 */

import { loadEgressProxyConfig } from '../lib/browser/egress-proxy/config.js';
import { createEgressProxyServer } from '../lib/browser/egress-proxy/server.js';

async function main() {
  let config;
  try {
    config = loadEgressProxyConfig(process.env);
  } catch (err) {
    console.error(`[egress-proxy] config error: ${err?.message || err}`);
    process.exit(1);
  }
  const server = createEgressProxyServer({ config });
  try {
    const { host, port } = await server.listen();
    console.log(`ready ${host} ${port}`);
  } catch (err) {
    console.error(`[egress-proxy] listen failed: ${err?.message || err}`);
    process.exit(1);
  }
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
