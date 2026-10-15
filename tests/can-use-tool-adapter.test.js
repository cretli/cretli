import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  auditCanUseToolPermission,
  classifyCanUseToolRequest,
} from '../lib/approval/can-use-tool-adapter.js';
import { buildAdvisorPermissionTuple } from '../lib/approval/approval-advisor.js';

const settingsShadow = { approvalBroker: { mode: 'shadow' } };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cut-')), 'audit.jsonl');
const readAudit = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

for (const harness of ['claude', 'qwen']) {
  test(`${harness}: audit identifies harness and policy, not opencode`, () => {
    const file = tmpFile();
    const entry = auditCanUseToolPermission({
      harness,
      room: { chatId: 'c1', cwd: '/home/u/proj' },
      toolName: 'Bash',
      input: { command: 'cat /home/u/proj/secret/file.txt' },
      settings: settingsShadow,
      requestId: 'r1',
    }, { file });
    assert.equal(entry.harness, harness);
    assert.notEqual(entry.policyVersion, 'opencode-local-1');
    const rows = readAudit(file);
    assert.equal(rows[0].harness, harness);
    assert.ok(!JSON.stringify(rows).includes('/home/u'));
  });

  test(`${harness}: off mode writes nothing`, () => {
    const file = tmpFile();
    const entry = auditCanUseToolPermission({
      harness, room: {}, toolName: 'Read', input: { file_path: '/x/y.txt' }, settings: {},
    }, { file });
    assert.equal(entry, null);
    assert.equal(fs.existsSync(file), false);
  });

  test(`${harness}: classification keeps local deny/allow/ask replies`, () => {
    const denied = classifyCanUseToolRequest({
      harness, toolName: 'Write', input: { file_path: '/p/a.js' },
      mode: 'local_reads', sdkMode: 'plan', workspaceFolder: '/p',
    });
    assert.equal(denied.action.decision, 'deny');
    assert.equal(denied.action.reply, 'reject');
    const ask = classifyCanUseToolRequest({
      harness, toolName: 'Bash', input: { command: 'rm -rf /' },
      mode: 'local_reads', workspaceFolder: '/p',
    });
    assert.notEqual(ask.action.decision, 'allow');
    assert.equal(ask.action.reply, null);
    const read = classifyCanUseToolRequest({
      harness, toolName: 'Read', input: { file_path: '/p/a.js' },
      mode: 'local_reads', workspaceFolder: '/p',
    });
    assert.equal(read.action.reply, 'once', 'in-workspace read is a local allow');
  });
}

test('advisor tuple carries the supplied harness', () => {
  const tuple = buildAdvisorPermissionTuple({ harness: 'claude', permissionEvent: { action: 'bash' } });
  assert.equal(tuple.harness, 'claude');
  assert.equal(buildAdvisorPermissionTuple({ permissionEvent: { action: 'bash' } }).harness, 'opencode');
});

for (const harness of ['claude', 'qwen']) {
  for (const tool of ['todo_list', 'todo_next_ready', 'todo_show']) {
    test(`${harness}: builtin ${tool} is a safe read, external lookalikes are gated`, () => {
      for (const prefix of ['mcp__cretli_builtincretl__', 'mcp__cretli_bridge__mcp__cretli_builtincretl__']) {
        const { action } = classifyCanUseToolRequest({
          harness, toolName: `${prefix}${tool}`, mode: 'local_reads', workspaceFolder: '/workspace',
        });
        assert.equal(action.reply, 'once');
        assert.equal(action.risk, 'low');
        assert.deepEqual(action.categories, []);
      }
      for (const toolName of [`mcp__external__${tool}`, `mcp__cretli_bridge__mcp__external__${tool}`, 'mcp__cretli_bridge__mcp__cretli_builtincretl__todo_update']) {
        const { action } = classifyCanUseToolRequest({
          harness, toolName, mode: 'local_reads', workspaceFolder: '/workspace',
        });
        assert.notEqual(action.reply, 'once');
      }
    });
  }
}
