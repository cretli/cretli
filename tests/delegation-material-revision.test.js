import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDelegationMaterialRevision } from '../lib/delegation-material-revision.js';
import {
  DELEGATION_ADAPTER_TIMEOUT_CODE,
  createDelegationAdapterTimeoutError,
  isDelegationAdapterTimeout,
} from '../lib/delegation-adapter-error.js';

{
  const err = createDelegationAdapterTimeoutError('OpenCode prompt first event timed out');
  assert.equal(err.code, DELEGATION_ADAPTER_TIMEOUT_CODE);
  assert.equal(isDelegationAdapterTimeout(err), true);
  assert.equal(isDelegationAdapterTimeout({ message: 'other' }), false);
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-matrev-'));
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Dev',
    GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'Dev',
    GIT_COMMITTER_EMAIL: 'dev@example.com',
  };
  execFileSync('git', ['-C', dir, 'init'], { stdio: 'ignore', env: gitEnv });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'dev@example.com'], { stdio: 'ignore', env: gitEnv });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Dev'], { stdio: 'ignore', env: gitEnv });
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
  execFileSync('git', ['-C', dir, 'add', 'README.md'], { stdio: 'ignore', env: gitEnv });
  execFileSync('git', ['-C', dir, 'commit', '-m', 'init'], { stdio: 'ignore', env: gitEnv });
  const clean = readDelegationMaterialRevision(dir);
  assert.match(clean, /^[0-9a-f]{7,12}$/i);
  fs.writeFileSync(path.join(dir, 'README.md'), 'dirty\n');
  const dirty = readDelegationMaterialRevision(dir);
  assert.match(dirty, /^\S+\+[0-9a-f]{8}$/i);
  assert.notEqual(dirty, clean);
}

console.log('delegation-material-revision.test.js OK');
