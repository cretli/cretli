import assert from 'node:assert/strict';
import { resolveAgentCommand, buildAgentSpawnEnv } from '../lib/agent-cli.js';

const resolved = resolveAgentCommand('agent');
assert.ok(typeof resolved === 'string' && resolved.length > 0);

assert.equal(resolveAgentCommand('/opt/cursor/agent'), '/opt/cursor/agent');

const previousApiKey = process.env.CURSOR_API_KEY;
process.env.CURSOR_API_KEY = 'crsr_env_fixture';

const env = buildAgentSpawnEnv({ PATH: '/usr/bin' });
assert.ok(typeof env === 'object');
assert.equal(env.PATH, '/usr/bin');
assert.equal(
  env.CURSOR_API_KEY,
  'crsr_env_fixture',
  'expected the effective API key in the spawn env',
);

const explicit = buildAgentSpawnEnv({ PATH: '/usr/bin', CURSOR_API_KEY: 'crsr_explicit' });
assert.equal(explicit.CURSOR_API_KEY, 'crsr_explicit', 'an explicit key must win over settings');

if (previousApiKey === undefined) delete process.env.CURSOR_API_KEY;
else process.env.CURSOR_API_KEY = previousApiKey;

console.log('agent-cli.test.js: ok');
