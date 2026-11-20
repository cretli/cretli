import '../tests/helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOperatorNativeToolDecision } from '../lib/operator/operator-native-tool-policy.js';
import { noteChatRowsForOperatorIndex, resetOperatorRunChatRegistry } from '../lib/operator/operator-run-chat-registry.js';
import { isOperatorRunChatId, isOperatorRunChatIdAsync } from '../lib/operator/operator-run-chat.js';
import {
  CLAUDE_OPERATOR_DISALLOWED_TOOLS,
  CLAUDE_SCOUT_READ_ONLY_DISALLOWED_TOOLS,
  buildClaudeQueryOptions,
  createRoomClaudeCanUseTool,
  createRoomClaudePreToolUseHook,
} from '../lib/claude/claude-agent-ws.ts';
import { executeTool } from '../lib/agent-harness/tool-executor.ts';
import { resolvePlanModeToolDecision } from '../lib/sdk/sdk-plan-guard.ts';
import { buildPlanPermissionRuleset, shouldRejectPlanPermission } from '../lib/approval/permission-classifier.ts';
import { resolveSdkPlanCreateOptions } from '../lib/agent-harness/harness-plan-policy.ts';
import { operatorRunChatRow } from './helpers/operator-run-chat-fixture.js';

const BRIDGE = 'mcp__cretli_bridge__mcp__cretli_builtincretl__';

function workspace() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-operator-native-')));
  const root = path.join(base, 'ws');
  const outside = path.join(base, 'outside');
  for (const dir of ['src', 'keys', 'data', '.git', 'credentials', 'docs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.mkdirSync(outside);
  const files = {
    'src/app.js': 'ok', 'data/chats.json': '{}', '.env': 'S=1', '.env.local': 'S=2', 'keys/server.pem': 'x', 'keys/tls.key': 'x',
    'keys/id_rsa': 'x', '.git/config': '[core]', 'credentials/aws.txt': 'x', 'docs/readme.md': 'ok',
  };
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), text);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'docs', 'link-out'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'src', 'link-file'));
  return { root, outside, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const decide = (root, toolName, args) => resolveOperatorNativeToolDecision({ toolName, args, workspaceRoot: root });

test('Read / Glob / Grep are allowed inside the workspace only', () => {
  const w = workspace();
  try {
    assert.equal(decide(w.root, 'Read', { file_path: 'src/app.js' }).deny, false);
    assert.equal(decide(w.root, 'Read', { file_path: path.join(w.root, 'docs/readme.md') }).deny, false);
    assert.equal(decide(w.root, 'Glob', { pattern: '**/*.js', path: 'src' }).deny, false);
    assert.equal(decide(w.root, 'Grep', { pattern: 'ok', path: 'src/app.js' }).deny, false, 'grep on one regular file');
    assert.equal(decide(w.root, 'Grep', { pattern: 'ok', path: 'src' }).deny, true, 'grep never scans a directory');
    assert.equal(decide(w.root, 'read_file', { path: 'docs/readme.md' }).deny, false);
    for (const bad of ['../outside/secret.txt', path.join(w.outside, 'secret.txt'), '/etc/passwd', 'src/../../outside/secret.txt']) {
      assert.equal(decide(w.root, 'Read', { file_path: bad }).deny, true, bad);
    }
    assert.equal(decide(w.root, 'Read', {}).deny, true, 'no path');
    assert.equal(decide('', 'Read', { file_path: 'src/app.js' }).deny, true, 'no workspace');
  } finally { w.cleanup(); }
});

test('path denials: data/, .env*, *.pem, *.key, id_*, .git/config, credentials, symlink escape', () => {
  const w = workspace();
  try {
    const cases = {
      'data/': 'data/chats.json', '.env': '.env', '.env.local': '.env.local', pem: 'keys/server.pem', key: 'keys/tls.key',
      'id_*': 'keys/id_rsa', '.git/config': '.git/config', credentials: 'credentials/aws.txt',
      'symlinked dir out of the workspace': 'docs/link-out/secret.txt', 'symlinked file out of the workspace': 'src/link-file',
    };
    for (const [label, rel] of Object.entries(cases)) {
      assert.equal(decide(w.root, 'Read', { file_path: rel }).deny, true, `Read ${label}`);
      assert.equal(decide(w.root, 'Read', { file_path: path.join(w.root, rel) }).deny, true, `Read abs ${label}`);
    }
    // Content search: one regular file only; a directory (or no path) could reach nested secrets.
    assert.equal(decide(w.root, 'Grep', { pattern: 'x' }).deny, true, 'no path');
    assert.equal(decide(w.root, 'Grep', { pattern: 'x', path: 'keys' }).deny, true, 'directory');
    assert.equal(decide(w.root, 'Grep', { pattern: 'x', path: 'data' }).deny, true);
    assert.equal(decide(w.root, 'Grep', { pattern: 'x', path: 'keys/tls.key' }).deny, true);
    assert.equal(decide(w.root, 'Grep', { pattern: 'x', path: 'src/app.js', glob: '*.pem' }).deny, true, 'extra scan options');
    // Glob returns names only, but its pattern may not aim at protected names.
    assert.equal(decide(w.root, 'Glob', { pattern: '**/*', path: '.' }).deny, false);
    assert.equal(decide(w.root, 'Glob', { pattern: '../outside/*' }).deny, true);
    assert.equal(decide(w.root, 'Glob', { pattern: `${w.outside}/*` }).deny, true);
    assert.equal(decide(w.root, 'Glob', { pattern: '.env*', path: 'docs' }).deny, true);
    assert.equal(decide(w.root, 'Glob', { pattern: '**/*.pem' }).deny, true);
    assert.equal(decide(w.root, 'Glob', { pattern: 'data/*' }).deny, true);
    assert.equal(decide(w.root, 'Glob', { pattern: '*', path: 'data' }).deny, true);
    assert.equal(decide(w.root, 'Glob', { pattern: '*', path: 'docs/link-out' }).deny, true, 'symlinked directory');
  } finally { w.cleanup(); }
});

test('every other native tool is denied', () => {
  const w = workspace();
  try {
    for (const name of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Skill', 'Task', 'Agent', 'apply_patch',
      'run_terminal_command', 'write_file', 'search_replace', 'shell', 'TodoWrite', 'Monitor', 'mystery_tool', '']) {
      assert.equal(decide(w.root, name, { command: 'ls', file_path: 'src/app.js', url: 'https://example.com' }).deny, true, name || '(empty)');
    }
  } finally { w.cleanup(); }
});

test('MCP tools: only allowlisted builtin Cretli tools pass; external servers and mutations are denied', () => {
  const w = workspace();
  try {
    assert.equal(decide(w.root, `${BRIDGE}todo_list`, {}).deny, false);
    assert.equal(decide(w.root, `${BRIDGE}scout_findings`, { action: 'list' }).deny, false);
    assert.equal(decide(w.root, `${BRIDGE}scout_findings`, { action: 'submit' }).deny, true);
    for (const name of ['todo_update', 'delegation_start', 'cretli_feedback', 'voice_reply', 'chat_delete']) {
      assert.equal(decide(w.root, `${BRIDGE}${name}`, {}).deny, true, name);
    }
    assert.equal(decide(w.root, 'mcp__github__todo_list', {}).deny, true);
    assert.equal(decide(w.root, 'mcp__cretli_0123456789ab__todo_list', {}).deny, true);
    assert.equal(decide(w.root, 'mcp', { toolName: 'mcp__github__issues', arguments: {} }).deny, true);
    assert.equal(resolveOperatorNativeToolDecision({ toolName: `${BRIDGE}todo_list`, args: {}, workspaceRoot: w.root, server: { id: 'abc', kind: 'external' } }).deny, true);
  } finally { w.cleanup(); }
});

test('operator run registry: trusted pickPurpose only, sync and async', async () => {
  resetOperatorRunChatRegistry();
  assert.equal(isOperatorRunChatId('operator-run-chat-1'), false, 'unknown chat is not an operator run');
  noteChatRowsForOperatorIndex([operatorRunChatRow(), { id: 'scout-1', pickPurpose: 'scout' }, { id: 'plain', readOnlyScout: true }]);
  assert.equal(isOperatorRunChatId('operator-run-chat-1'), true);
  for (const id of ['scout-1', 'plain', '', undefined]) assert.equal(isOperatorRunChatId(id), false, String(id));
  assert.equal(isOperatorRunChatId('x', { loadChats: () => [operatorRunChatRow({ id: 'x' })] }), true);
  assert.equal(await isOperatorRunChatIdAsync('y', { loadChats: async () => [operatorRunChatRow({ id: 'y' })] }), true);
  assert.equal(await isOperatorRunChatIdAsync('z', { loadChats: async () => [{ id: 'z', pickPurpose: 'scout' }] }), false);
  assert.equal(await isOperatorRunChatIdAsync('w', { loadChats: async () => { throw new Error('down'); } }), false);
  resetOperatorRunChatRegistry();
});

test('claude adapter: start options, canUseTool and PreToolUse decisions for an operator run', async () => {
  const w = workspace();
  try {
    resetOperatorRunChatRegistry();
    noteChatRowsForOperatorIndex(operatorRunChatRow({ id: 'op-claude' }));
    const room = { chatId: 'op-claude', cwd: w.root, _activeRunMode: 'plan', sdkMode: 'plan', delegationAssignment: '' };
    const options = buildClaudeQueryOptions(room, 'plan', {});
    assert.deepEqual(options.settingSources, []);
    assert.deepEqual(options.disallowedTools, [...CLAUDE_OPERATOR_DISALLOWED_TOOLS]);
    for (const tool of [...CLAUDE_SCOUT_READ_ONLY_DISALLOWED_TOOLS, 'Bash', 'WebFetch', 'WebSearch', 'Skill']) {
      assert.ok(options.disallowedTools.includes(tool), tool);
    }
    assert.equal(typeof options.canUseTool, 'function');
    const canUse = createRoomClaudeCanUseTool(room, { loadSettings: () => ({}) });
    assert.equal((await canUse('Read', { file_path: 'src/app.js' })).behavior, 'allow');
    assert.equal((await canUse('Grep', { pattern: 'x', path: 'src' })).behavior, 'deny', 'directory grep');
    assert.equal((await canUse(`${BRIDGE}todo_list`, {})).behavior, 'allow');
    for (const [name, input] of [['Bash', { command: 'ls' }], ['Edit', { file_path: 'src/app.js' }], ['Read', { file_path: '.env' }],
      ['Read', { file_path: '/etc/passwd' }], ['WebFetch', { url: 'https://x.test' }], ['Task', {}], [`${BRIDGE}todo_update`, {}], ['mcp__github__x', {}]]) {
      assert.equal((await canUse(name, input)).behavior, 'deny', name);
    }
    const hook = options.hooks.PreToolUse[0].hooks[0];
    assert.equal((await hook({ tool_name: 'Bash', tool_input: { command: 'ls' } })).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal((await hook({ tool_name: 'Read', tool_input: { file_path: 'data/chats.json' } })).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal((await hook({ tool_name: 'Read', tool_input: { file_path: 'src/app.js' } })).continue, true);
    assert.equal((await createRoomClaudePreToolUseHook(room)({ tool_name: 'Glob', tool_input: { pattern: '*.js', path: 'src' } })).continue, true);

    // A normal chat is untouched.
    noteChatRowsForOperatorIndex({ id: 'plain-chat', pickPurpose: '' });
    const plain = buildClaudeQueryOptions({ chatId: 'plain-chat', cwd: w.root }, 'agent', {});
    assert.equal(plain.settingSources, undefined);
    assert.equal(plain.disallowedTools, undefined);
  } finally { resetOperatorRunChatRegistry(); w.cleanup(); }
});

test('sdk executor, plan guard and permission classifier: shell, edit, write, task, web, Read outside', async () => {
  const w = workspace();
  try {
    const ctx = { cwd: w.root, mode: 'agent', operatorRun: true };
    for (const [name, args] of [
      ['run_terminal_command', { command: 'echo hi' }], ['write_file', { path: 'x.txt', content: 'x' }], ['search_replace', { path: 'src/app.js', old: 'a', new: 'b' }],
      ['task', {}], ['web_fetch', { url: 'https://x.test' }], ['read_file', { path: '../outside/secret.txt' }], ['read_file', { path: '.env' }],
      ['git_run', { args: ['status'] }],
    ]) {
      const result = await executeTool(name, args, ctx);
      assert.equal(result.ok, false, name);
    }
    assert.equal(fs.existsSync(path.join(w.root, 'x.txt')), false);
    assert.equal((await executeTool('read_file', { path: 'src/app.js' }, ctx)).ok, true);
    assert.equal((await executeTool('read_file', { path: 'src/app.js' }, { cwd: w.root, mode: 'agent' })).ok, true, 'a normal agent run is unaffected');

    const guard = (toolName, input) => resolvePlanModeToolDecision({ transport: 'sdk', mode: 'agent', operatorRun: true, toolName, input, projectRoot: w.root });
    assert.equal(guard('shell', { command: 'ls' }).deny, true);
    assert.equal(guard('edit', { path: 'src/app.js' }).deny, true);
    assert.equal(guard('write', { path: 'a' }).deny, true);
    assert.equal(guard('task', {}).deny, true);
    assert.equal(guard('web_search', { query: 'x' }).deny, true);
    assert.equal(guard('read', { path: '/etc/passwd' }).deny, true);
    assert.equal(guard('read', { path: 'src/app.js' }).deny, false);
    assert.equal(guard('shell', {}).abortRun, true, 'a violation aborts the run');
    assert.deepEqual(resolveSdkPlanCreateOptions('agent', '', { operatorRun: true }).disallowedTools?.length > 0, true);

    const permission = (action, metadata = {}) => shouldRejectPlanPermission('agent', { action, metadata }, '', { operatorRun: true, projectRoot: w.root });
    assert.equal(permission('bash', { command: 'ls' }), true);
    assert.equal(permission('edit', { path: 'src/app.js' }), true);
    assert.equal(permission('read', { path: '.env' }), true);
    assert.equal(permission('read', { path: 'src/app.js' }), false);
    assert.equal(shouldRejectPlanPermission('agent', null, '', { operatorRun: true }), true);
    assert.deepEqual(buildPlanPermissionRuleset('agent', { operatorRun: true }).map((rule) => [rule.permission, rule.action]), [['edit', 'deny'], ['bash', 'deny']]);
  } finally { w.cleanup(); }
});
