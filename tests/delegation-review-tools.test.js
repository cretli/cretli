import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../lib/agent-harness/tool-executor.js';
import { getToolsForMode } from '../lib/agent-harness/tool-definitions.js';
import { resolvePlanModeToolDecision } from '../lib/sdk/sdk-plan-guard.js';
import { resolveHarnessReadOnlyPolicy } from '../lib/agent-harness/harness-plan-policy.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-review-tools-'));
fs.writeFileSync(path.join(tmpRoot, 'hello.txt'), 'hello world', 'utf8');

const reviewCtx = { cwd: tmpRoot, mode: 'agent', assignment: 'review' };
const readOk = await executeTool('read_file', { path: 'hello.txt' }, reviewCtx);
assert.equal(readOk.ok, true);
assert.match(readOk.output, /hello world/);

const grepOk = await executeTool('grep', { pattern: 'hello' }, reviewCtx);
assert.equal(grepOk.ok, true);

const writeDenied = await executeTool('write_file', { path: 'x.txt', content: 'nope' }, reviewCtx);
assert.equal(writeDenied.ok, false);
assert.equal(fs.existsSync(path.join(tmpRoot, 'x.txt')), false);

const shellDenied = await executeTool('run_terminal_command', { command: 'echo pwned > pwned.txt' }, reviewCtx);
assert.equal(shellDenied.ok, false);
assert.equal(fs.existsSync(path.join(tmpRoot, 'pwned.txt')), false);

const bypass = await executeTool('run_terminal_command', {
  command: "python -c \"open('pwned2.txt','w').write('x')\"",
}, reviewCtx);
assert.equal(bypass.ok, false);
assert.equal(fs.existsSync(path.join(tmpRoot, 'pwned2.txt')), false);

const reviewTools = getToolsForMode('agent', 'review').map((tool) => tool.function?.name);
assert.ok(reviewTools.includes('read_file'));
assert.ok(reviewTools.includes('grep'));
assert.ok(!reviewTools.includes('write_file'));
assert.ok(!reviewTools.includes('run_terminal_command'));

assert.equal(resolveHarnessReadOnlyPolicy('deepseek', 'agent', 'review').denyMutatingTools, true);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'deepseek',
    mode: 'agent',
    assignment: 'review',
    toolName: 'edit',
  }).deny,
  true,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'deepseek',
    mode: 'agent',
    assignment: 'review',
    toolName: 'read',
  }).deny,
  false,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'deepseek',
    mode: 'agent',
    assignment: 'review',
    toolName: 'shell',
    input: { command: 'rm -rf .' },
  }).deny,
  true,
);

console.log('delegation-review-tools.test.js OK');
