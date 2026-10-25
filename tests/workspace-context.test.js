import assert from 'node:assert/strict';
import {
  isTaskRunInScope,
  normalizeWorkspaceScopePath,
} from '../lib/workspace-context.js';

const inputFile = '/tmp/a/../ws.code-workspace';
const actualPath = normalizeWorkspaceScopePath(inputFile);
const expectedPath = normalizeWorkspaceScopePath('/tmp/ws.code-workspace');
assert.equal(actualPath, expectedPath);
assert.equal(normalizeWorkspaceScopePath('  '), '');
assert.equal(normalizeWorkspaceScopePath(null), '');

const inputRun = { workspaceFile: '/tmp/ws.code-workspace', cwd: '/tmp/project' };
const inputScope = { workspaceFile: '/tmp/a/../ws.code-workspace', cwd: '/tmp/project' };
assert.equal(isTaskRunInScope(inputRun, inputScope), true);
assert.equal(isTaskRunInScope(inputRun, { ...inputScope, cwd: '/tmp/other' }), false);
assert.equal(isTaskRunInScope(null, inputScope), false);

console.log('workspace-context.test.js OK');
