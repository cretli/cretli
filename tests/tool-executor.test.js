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

const transcriptDir = path.join(tmpRoot, 'data', 'runtime-home', '.cursor', 'projects', 'ws', 'agent-transcripts');
fs.mkdirSync(transcriptDir, { recursive: true });
const transcriptFile = path.join(transcriptDir, 'agent-delegation.jsonl');
fs.writeFileSync(transcriptFile, '{"text":"delegation unfinished"}', 'utf8');
fs.mkdirSync(path.join(tmpRoot, 'data', 'chat-history'), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, 'data', 'chat-history', 'chat.json'), '{"events":[]}', 'utf8');

const blockedRead = await executeTool(
  'read_file',
  { path: 'data/runtime-home/.cursor/projects/ws/agent-transcripts/agent-delegation.jsonl' },
  { cwd: tmpRoot, mode: 'agent' },
);
assert.equal(blockedRead.ok, false);
assert.match(String(blockedRead.error), /chat_show|chat_history/);

const blockedList = await executeTool(
  'list_directory',
  { path: 'data/runtime-home/.cursor/projects/ws/agent-transcripts' },
  { cwd: tmpRoot, mode: 'agent' },
);
assert.equal(blockedList.ok, false);

const dataList = await executeTool('list_directory', { path: 'data' }, { cwd: tmpRoot, mode: 'agent' });
assert.equal(dataList.ok, true);
assert.doesNotMatch(dataList.output, /runtime-home/);
assert.doesNotMatch(dataList.output, /chat-history/);

const blockedGrep = await executeTool(
  'grep',
  { pattern: 'delegation', path: 'data/runtime-home' },
  { cwd: tmpRoot, mode: 'agent' },
);
assert.equal(blockedGrep.ok, false);

const blockedHistoryShell = await executeTool(
  'run_terminal_command',
  { command: 'cat data/chat-history/chat.json' },
  { cwd: tmpRoot, mode: 'agent' },
);
assert.equal(blockedHistoryShell.ok, false);
assert.match(String(blockedHistoryShell.error), /chat_history/);

const workspaceGrep = await executeTool('grep', { pattern: 'delegation unfinished' }, { cwd: tmpRoot, mode: 'agent' });
assert.equal(workspaceGrep.ok, true);
assert.doesNotMatch(workspaceGrep.output || '', /agent-delegation/);

const extraTranscript = path.join(tmpRoot, 'extra-cwd', 'agent-transcripts', 'agent-other.jsonl');
fs.mkdirSync(path.dirname(extraTranscript), { recursive: true });
fs.writeFileSync(extraTranscript, '{"text":"other chat"}', 'utf8');
const blockedExtra = await executeTool(
  'read_file',
  { path: 'extra-cwd/agent-transcripts/agent-other.jsonl' },
  { cwd: tmpRoot, mode: 'ask' },
);
assert.equal(blockedExtra.ok, false);

const askRead = await executeTool('read_file', { path: 'hello.txt' }, { cwd: tmpRoot, mode: 'ask' });
assert.equal(askRead.ok, true);
const askBlocked = await executeTool('write_file', { path: 'ask.txt', content: 'nope' }, { cwd: tmpRoot, mode: 'ask' });
assert.equal(askBlocked.ok, false);
assert.match(String(askBlocked.error), /Ask mode blocked/i);
assert.equal(fs.existsSync(path.join(tmpRoot, 'ask.txt')), false);

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('tool-executor.test.js OK');
