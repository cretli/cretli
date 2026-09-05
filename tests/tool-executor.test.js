import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { executeTool } from '../lib/agent-harness/tool-executor.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-tool-exec-'));
const sampleFile = path.join(tmpRoot, 'hello.txt');
fs.writeFileSync(sampleFile, 'hello world', 'utf8');

const readResult = await executeTool('read_file', { path: 'hello.txt' }, { cwd: tmpRoot, mode: 'agent' });
assert.equal(readResult.ok, true);
assert.match(readResult.output, /hello world/);

const blocked = await executeTool('write_file', { path: 'x.txt', content: 'nope' }, { cwd: tmpRoot, mode: 'plan' });
assert.equal(blocked.ok, false);
assert.match(String(blocked.error), /blocked/i);
assert.equal(fs.existsSync(path.join(tmpRoot, 'x.txt')), false);

const blockedShell = await executeTool('run_terminal_command', { command: 'echo pwned > pwned.txt' }, { cwd: tmpRoot, mode: 'plan' });
assert.equal(blockedShell.ok, false);
assert.equal(fs.existsSync(path.join(tmpRoot, 'pwned.txt')), false);

const blockedReplace = await executeTool('search_replace', {
  path: 'hello.txt',
  old_string: 'hello',
  new_string: 'mutated',
}, { cwd: tmpRoot, mode: 'plan' });
assert.equal(blockedReplace.ok, false);
assert.equal(fs.readFileSync(sampleFile, 'utf8'), 'hello world');

const planRead = await executeTool('read_file', { path: 'hello.txt' }, { cwd: tmpRoot, mode: 'plan' });
assert.equal(planRead.ok, true);

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('tool-executor.test.js OK');
