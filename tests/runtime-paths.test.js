import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveDataPath, resolveProjectPath } from '../lib/runtime-paths.js';

const projectRoot = resolveProjectPath();
const dataRoot = resolveDataPath();
const expectedDataRoot = process.env.CRETLI_DATA_DIR
  ? path.resolve(projectRoot, process.env.CRETLI_DATA_DIR)
  : path.join(projectRoot, 'data');

assert.ok(path.isAbsolute(projectRoot));
assert.equal(dataRoot, expectedDataRoot);
assert.equal(resolveDataPath('chat-history'), path.join(expectedDataRoot, 'chat-history'));
assert.equal(resolveProjectPath('lib', 'persist'), path.join(projectRoot, 'lib', 'persist'));

const { execFileSync } = await import('node:child_process');
const overriddenRoot = execFileSync(
  process.execPath,
  ['-e', "import('./lib/runtime-paths.js').then((m) => process.stdout.write(m.resolveDataPath()))"],
  { cwd: projectRoot, env: { ...process.env, CRETLI_DATA_DIR: '/tmp/cretli-data-override' } },
).toString();
assert.equal(overriddenRoot, '/tmp/cretli-data-override');

const legacyRoot = execFileSync(
  process.execPath,
  ['-e', "import('./lib/runtime-paths.js').then((m) => process.stdout.write(m.resolveDataPath()))"],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      CRETLI_DATA_DIR: '',
      CURSOR_REMOTE_DATA_DIR: '/tmp/cretli-data-legacy',
    },
  },
).toString();
assert.equal(legacyRoot, '/tmp/cretli-data-legacy');

console.log('runtime-paths.test.js OK');
