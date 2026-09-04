import assert from 'node:assert/strict';
import {
  buildOpenCodeSpawnPath,
  resolveOpenCodeExecutable,
  sanitizeSpawnPath,
} from '../lib/opencode/opencode-spawn-path.js';

const unreadableRootDir = '/root/.cursor-server/bin/fake';
const linuxBin = '/usr/bin';
const pathEnv = `/home/user/bin:${unreadableRootDir}:${linuxBin}:${unreadableRootDir}`;
const searchable = new Set(['/home/user/bin', linuxBin, '/opt/opencode/bin']);

const sanitized = sanitizeSpawnPath(pathEnv, {
  canSearchDir: (dir) => searchable.has(dir),
  delimiter: ':',
});
assert.equal(sanitized, `/home/user/bin:${linuxBin}`);

const withBin = buildOpenCodeSpawnPath({
  pathEnv,
  executablePath: '/opt/opencode/bin/opencode',
  canSearchDir: (dir) => searchable.has(dir),
  delimiter: ':',
});
assert.equal(withBin, `/opt/opencode/bin:/home/user/bin:${linuxBin}`);
assert.ok(!withBin.includes(unreadableRootDir));

const missingBin = buildOpenCodeSpawnPath({
  pathEnv,
  executablePath: '',
  canSearchDir: (dir) => searchable.has(dir),
  delimiter: ':',
});
assert.equal(missingBin, `/home/user/bin:${linuxBin}`);

const executable = new Set([
  '/opt/cretli/node_modules/.bin/opencode',
  '/home/user/.opencode/bin/opencode',
]);
assert.equal(
  resolveOpenCodeExecutable({
    configuredBin: '/stale/cursor-remote/node_modules/.bin/opencode',
    homeDirs: ['/home/user', '/root'],
    projectRoot: '/opt/cretli',
    isExecutable: (filePath) => executable.has(filePath),
  }),
  '/opt/cretli/node_modules/.bin/opencode',
);

assert.equal(
  resolveOpenCodeExecutable({
    configuredBin: '/home/user/.opencode/bin/opencode',
    homeDirs: ['/home/user'],
    projectRoot: '/opt/cretli',
    isExecutable: (filePath) => executable.has(filePath),
  }),
  '/home/user/.opencode/bin/opencode',
);

assert.equal(
  resolveOpenCodeExecutable({
    configuredBin: 'opencode',
    homeDirs: [],
    projectRoot: '',
    isExecutable: () => true,
  }),
  '',
);

console.log('opencode-spawn-path.test.js OK');
