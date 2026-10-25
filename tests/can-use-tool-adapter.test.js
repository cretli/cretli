import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  auditCanUseToolPermission,
  classifyCanUseToolRequest,
} from '../lib/approval/can-use-tool-adapter.ts';
import { buildAdvisorPermissionTuple } from '../lib/approval/approval-advisor.ts';
import { createRoomClaudeCanUseTool } from '../lib/claude/claude-agent-ws.ts';
import { createRoomQwenCanUseTool } from '../harnesses/qwen/qwen-agent-ws.js';

const settingsShadow = { approvalBroker: { mode: 'shadow' } };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cut-')), 'audit.jsonl');
const readAudit = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const reviewReplyNames = [
  'mcp__cretli_builtincretl__delegation_reply',
  'mcp__cretli_bridge__mcp__cretli_builtincretl__delegation_reply',
  'mcp.cretli_builtincretl.delegation_reply',
  'mcp/cretli_builtincretl/delegation_reply',
  'mcp.cretli_bridge.mcp.cretli_builtincretl.delegation_reply',
  'mcp/cretli_bridge/mcp/cretli_builtincretl/delegation_reply',
  'functions.mcp__cretli_builtincretl__delegation_reply',
  'functions.mcp__cretli_bridge__mcp__cretli_builtincretl__delegation_reply',
];

for (const harness of ['claude', 'qwen']) {
  test(`${harness}: local_reads allows only builtin review replies across naming forms`, () => {
    for (const toolName of reviewReplyNames) {
      const { permissionEvent, action } = classifyCanUseToolRequest({
        harness, toolName, assignment: 'review', sdkMode: 'agent',
        mode: 'local_reads', workspaceFolder: '/workspace',
      });
      assert.equal(action.reply, 'once', toolName);
      assert.equal(permissionEvent.action, 'read', toolName);
      assert.equal(action.risk, 'low', toolName);
      assert.deepEqual(action.categories, [], toolName);
    }
  });

  test(`${harness}: external replies and other builtin mutations remain gated in review`, () => {
    for (const toolName of [
      'mcp__external__delegation_reply',
      'mcp__cretli_bridge__mcp__external__delegation_reply',
      'mcp__cretli_builtincretl__delegation_reply_extra',
      'mcp__cretli_builtincretl__todo_update',
      'mcp__cretli_builtincretl__delegation_start',
    ]) {
      const { action } = classifyCanUseToolRequest({
        harness, toolName, assignment: 'review', sdkMode: 'agent',
        mode: 'local_reads', workspaceFolder: '/workspace',
      });
      assert.equal(action.reply, 'reject', toolName);
    }
  });

  test(`${harness}: non-review reply permissions keep their existing decisions`, () => {
    for (const toolName of reviewReplyNames) {
      for (const assignment of ['', 'implement', 'fix', 'audit']) {
        for (const sdkMode of ['agent', 'plan']) {
          const { action } = classifyCanUseToolRequest({
            harness, toolName, assignment, sdkMode,
            mode: 'local_reads', workspaceFolder: '/workspace',
          });
          const expected = toolName.startsWith('mcp__')
            ? (sdkMode === 'plan' ? 'reject' : null)
            : (assignment === '' || assignment === 'implement' ? 'once' : null);
          assert.equal(action.reply, expected, `${assignment}/${sdkMode}/${toolName}`);
        }
      }
    }
  });

  test(`${harness}: review reply exemption preserves the Scout hard block`, () => {
    for (const toolName of reviewReplyNames.slice(0, 2)) {
      const { action } = classifyCanUseToolRequest({
        harness, toolName, assignment: 'review', sdkMode: 'agent', scoutReadOnly: true,
        mode: 'local_reads', workspaceFolder: '/workspace',
      });
      assert.equal(action.reply, 'reject', toolName);
    }
  });

  test(`${harness}: production callback passes review reply through both guards without a card`, async () => {
    const room = {
      chatId: 'review-child', cwd: '/workspace', sdkMode: 'agent',
      _activeRunMode: 'agent', delegationAssignment: 'review', clients: new Set(),
    };
    const createCallback = harness === 'claude' ? createRoomClaudeCanUseTool : createRoomQwenCanUseTool;
    const callback = createCallback(room, {
      loadSettings: () => ({ approvalBroker: { mode: 'local_reads' } }),
      auditOptions: { file: tmpFile() },
      permissionTimeoutMs: 50,
    });
    const result = await callback('mcp__cretli_builtincretl__delegation_reply', {
      message_text: 'TASK: review\nVERDICT: FAIL', idempotency_key: 'review-report',
    }, {});
    assert.equal(result.behavior, 'allow', result.message);
    assert.equal(room._pendingQuestions?.size || 0, 0);
  });
}

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
