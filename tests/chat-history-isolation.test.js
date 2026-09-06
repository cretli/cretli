import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addChat } from '../lib/persist/chats-persist.js';
import { appendChatHistoryEvents } from '../lib/persist/chat-history-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { buildConversationForkPrompt } from '../lib/conversation-fork.js';
import {
  isHistoryStorePath,
  matchesHistoryStoreIgnore,
} from '../lib/agent-harness/history-store-guard.js';
import { executeTool } from '../lib/agent-harness/tool-executor.js';
import {
  ASK_TASK_ASSISTANT,
  ASK_TASK_LATER,
  ASK_TASK_USER,
  DELEGATION_TASK_ASSISTANT,
  seedAndExecuteAskDelegationFork,
} from '../lib/sdk/sdk-history-isolation-fork.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const incidentRel = 'data/runtime-home/.cursor/projects/home-ar2oor-www-cretli/agent-transcripts/agent-9bd3fb76.jsonl';
assert.equal(matchesHistoryStoreIgnore(incidentRel), true);
assert.equal(isHistoryStorePath(path.join('/workspace', incidentRel)), true);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-hist-iso-'));
const extraWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-hist-iso-extra-'));
const ask = addChat('sess-ask', 'Ask', null, workspace, 'model-a', { agentTransport: 'sdk' });
const delegation = addChat('sess-del', 'Dokończono delegacje wiadomościowe etap 1', null, workspace, 'model-b', {
  agentTransport: 'sdk',
});
appendChatHistoryEvents(ask.id, 'sess-ask', [
  { rec: { kind: 'localUser', text: 'Plan / Agent / Ask dropdown' } },
  {
    rec: {
      kind: 'sdk',
      event: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Dropdown work is in progress.' }] },
      },
    },
  },
]);
appendChatHistoryEvents(delegation.id, 'sess-del', [
  { rec: { kind: 'localUser', text: 'Finish mailbox delegations' } },
  {
    rec: {
      kind: 'sdk',
      event: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Delegation stage 1 is unfinished.' }] },
      },
    },
  },
]);

const forkPrompt = buildConversationForkPrompt('User: Plan / Agent / Ask dropdown\nAgent: Dropdown work is in progress.', 'Kontynuuj pracę poprzedniego agenta.', {
  sourceChatId: ask.id,
  sourceChatTitle: ask.title,
  copiedThroughSeq: 2,
});
assert.match(forkPrompt, new RegExp(ask.id));
assert.doesNotMatch(forkPrompt, /Dokończono delegacje/);

const transcriptDir = path.join(workspace, path.dirname(incidentRel));
fs.mkdirSync(transcriptDir, { recursive: true });
fs.writeFileSync(path.join(workspace, incidentRel), '{"text":"delegation unfinished"}\n', 'utf8');
fs.copyFileSync(path.join(repoRoot, '.cursorignore'), path.join(workspace, '.cursorignore'));
fs.writeFileSync(path.join(workspace, 'hello.txt'), 'ok\n', 'utf8');
const extraTranscript = path.join(extraWorkspace, 'agent-transcripts', 'agent-other.jsonl');
fs.mkdirSync(path.dirname(extraTranscript), { recursive: true });
fs.writeFileSync(extraTranscript, '{"text":"other workspace transcript"}\n', 'utf8');
fs.writeFileSync(path.join(extraWorkspace, 'note.txt'), 'extra-ok\n', 'utf8');
fs.symlinkSync(path.join(workspace, incidentRel), path.join(workspace, 'safe-link.txt'));

function resolveRipgrepBin() {
  const envPath = String(process.env.CURSOR_RIPGREP_PATH || '').trim();
  if (envPath) {
    return envPath;
  }
  const bundled = path.join(repoRoot, 'node_modules', '.bin', 'rg');
  if (fs.existsSync(bundled)) {
    return bundled;
  }
  return 'rg';
}

const listedRoot = spawnSync(resolveRipgrepBin(), ['--files', '--ignore-file', '.cursorignore'], {
  cwd: workspace,
  encoding: 'utf8',
});
assert.equal(listedRoot.status, 0, listedRoot.stderr || listedRoot.error?.message || 'rg failed');
assert.match(listedRoot.stdout || '', /hello\.txt/);
assert.doesNotMatch(listedRoot.stdout || '', /agent-9bd3fb76/);
assert.doesNotMatch(listedRoot.stdout || '', /agent-other/);

const listedHello = await executeTool('read_file', { path: 'hello.txt' }, { cwd: workspace, mode: 'agent' });
assert.equal(listedHello.ok, true);
assert.match(listedHello.output, /ok/);

const blockedRead = await executeTool('read_file', { path: incidentRel }, { cwd: workspace, mode: 'agent' });
assert.equal(blockedRead.ok, false);
assert.match(String(blockedRead.error), /chat_history/);

const blockedAbsolute = await executeTool(
  'read_file',
  { path: path.join(workspace, incidentRel) },
  { cwd: workspace, mode: 'agent' },
);
assert.equal(blockedAbsolute.ok, false);

const blockedAlias = await executeTool('read_file', { path: 'safe-link.txt' }, { cwd: workspace, mode: 'agent' });
assert.equal(blockedAlias.ok, false);

const blockedList = await executeTool('list_directory', { path: path.dirname(incidentRel) }, { cwd: workspace, mode: 'agent' });
assert.equal(blockedList.ok, false);

const rootList = await executeTool('list_directory', { path: '.' }, { cwd: workspace, mode: 'agent' });
assert.equal(rootList.ok, true);
assert.match(rootList.output, /hello\.txt/);
assert.doesNotMatch(rootList.output, /agent-9bd3fb76/);

const grepHello = await executeTool('grep', { pattern: 'ok' }, { cwd: workspace, mode: 'agent' });
assert.equal(grepHello.ok, true);
assert.match(grepHello.output, /hello\.txt/);
assert.doesNotMatch(grepHello.output, /delegation unfinished/);

const blockedGrep = await executeTool(
  'grep',
  { pattern: 'delegation', path: path.dirname(incidentRel) },
  { cwd: workspace, mode: 'agent' },
);
assert.equal(blockedGrep.ok, false);

const blockedExtra = await executeTool(
  'read_file',
  { path: extraTranscript },
  { cwd: extraWorkspace, mode: 'ask' },
);
assert.equal(blockedExtra.ok, false);

const extraNote = await executeTool('read_file', { path: 'note.txt' }, { cwd: extraWorkspace, mode: 'agent' });
assert.equal(extraNote.ok, true);

const blockedShell = await executeTool(
  'run_terminal_command',
  { command: `cat ${JSON.stringify(path.join(workspace, incidentRel))}` },
  { cwd: workspace, mode: 'agent' },
);
assert.equal(blockedShell.ok, false);
assert.match(String(blockedShell.error), /chat_history/);

const helloShell = await executeTool(
  'run_terminal_command',
  { command: 'cat hello.txt' },
  { cwd: workspace, mode: 'agent' },
);
assert.equal(helloShell.ok, true);
assert.match(helloShell.output, /ok/);

const reread = await executeTool('read_file', { path: incidentRel }, { cwd: workspace, mode: 'agent' });
assert.equal(reread.ok, false);

const client = createInProcessMcpClient({ harness: 'sdk', chatId: ask.id, workspaceFolder: workspace });
const handlers = createCretliMcpToolHandlers(client, {
  chatId: ask.id,
  workspaceFolder: workspace,
  mode: 'agent',
});
const askHistory = await handlers.chat_history({ chat: ask.id });
assert.match(askHistory.content[0].text, /Plan \/ Agent \/ Ask dropdown/);
assert.doesNotMatch(askHistory.content[0].text, /mailbox delegations/);
assert.match(askHistory.content[0].text, /--- paging ---/);

fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(extraWorkspace, { recursive: true, force: true });

const forkWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-hist-fork-'));
const newerTranscript = path.join(forkWorkspace, 'agent-transcripts', 'agent-newer-delegation.jsonl');
const seededFork = await seedAndExecuteAskDelegationFork({
  workspaceFolder: forkWorkspace,
  extraTranscriptAbs: newerTranscript,
});
assert.equal(seededFork.parentAfter?.id, seededFork.ask.id);
assert.equal(seededFork.fullFork.chat.forkParentChatId, seededFork.ask.id);
assert.equal(seededFork.partialFork.chat.forkParentChatId, seededFork.ask.id);
assert.equal(seededFork.partialFork.partial, true);
assert.equal(seededFork.fullCopiedText.includes(ASK_TASK_USER), true);
assert.equal(seededFork.fullCopiedText.includes(ASK_TASK_ASSISTANT), true);
assert.equal(seededFork.fullCopiedText.includes(ASK_TASK_LATER), true);
assert.equal(seededFork.fullCopiedText.includes('mailbox arrows'), false);
assert.equal(seededFork.fullFork.initialPrompt.includes('queued-mail'), false);
assert.equal(seededFork.fullFork.initialPrompt.includes(seededFork.ask.id), true);
assert.equal(seededFork.partialCopiedText.includes(ASK_TASK_USER), true);
assert.equal(seededFork.partialCopiedText.includes(ASK_TASK_ASSISTANT), true);
assert.equal(seededFork.partialCopiedText.includes(ASK_TASK_LATER), false);
assert.equal(seededFork.partialFork.initialPrompt.includes(ASK_TASK_LATER), false);
assert.match(seededFork.partialFork.initialPrompt, /only through event seq/);
assert.equal(seededFork.partialCopiedText.includes(DELEGATION_TASK_ASSISTANT), false);
assert.equal(fs.existsSync(newerTranscript), true);
assert.match(fs.readFileSync(newerTranscript, 'utf8'), /FOREIGN_DELEGATION_MARKER/);
fs.rmSync(forkWorkspace, { recursive: true, force: true });

const cliDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-hist-fork-cli-'));
const cliWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-hist-fork-cli-ws-'));
const cliPayload = path.join(cliDataDir, 'payload.json');
const cliResult = path.join(cliDataDir, 'result.json');
const cliTranscript = path.join(cliWorkspace, 'agent-transcripts', 'agent-newer-delegation.jsonl');
const prodChatsPath = path.join(repoRoot, 'data', 'chats.json');
const prodChatsMtime = fs.existsSync(prodChatsPath) ? fs.statSync(prodChatsPath).mtimeMs : 0;
fs.writeFileSync(cliPayload, JSON.stringify({
  workspaceFolder: cliWorkspace,
  extraTranscriptAbs: cliTranscript,
  resultPath: cliResult,
}), 'utf8');
const cliSpawn = spawnSync(
  process.execPath,
  [path.join(repoRoot, 'lib/sdk/sdk-history-isolation-fork-cli.js'), cliPayload],
  {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      CRETLI_DATA_DIR: cliDataDir,
      CURSOR_REMOTE_DATA_DIR: cliDataDir,
      CRETLI_TEST_DATA_DIR: cliDataDir,
    },
  },
);
assert.equal(cliSpawn.status, 0, cliSpawn.stderr || cliSpawn.stdout || 'fork cli failed');
const cliRecord = JSON.parse(fs.readFileSync(cliResult, 'utf8'));
assert.equal(cliRecord.parentStillPresent, true);
assert.equal(cliRecord.full.forkParentChatId, cliRecord.parentChatId);
assert.equal(cliRecord.partial.partial, true);
assert.match(cliRecord.full.copiedText, /three mode buttons/);
assert.doesNotMatch(cliRecord.full.copiedText, /queued-mail/);
assert.doesNotMatch(cliRecord.partial.copiedText, /keyboard shortcut/);
const prodChatsMtimeAfter = fs.existsSync(prodChatsPath) ? fs.statSync(prodChatsPath).mtimeMs : 0;
assert.equal(prodChatsMtimeAfter, prodChatsMtime);
fs.rmSync(cliDataDir, { recursive: true, force: true });
fs.rmSync(cliWorkspace, { recursive: true, force: true });

console.log('chat-history-isolation.test.js OK');
// Native Cursor SDK Glob/Read/resume lives in tests/live/cursor-sdk-history-isolation.test.js
// (`npm run test:live-cursor-sdk`). rg --ignore-file is not that test.
