#!/usr/bin/env node
import { probeSupervisorHealth } from '../lib/cretli-supervisor.js';
import { isHttpsRequested } from '../lib/server-tls.js';

const result = await probeSupervisorHealth({
  port: process.env.PORT || 3011,
  useHttps: isHttpsRequested(process.env.USE_HTTPS ?? '1'),
  timeoutMs: 10_000,
});
process.exitCode = result.ok ? 0 : 1;
