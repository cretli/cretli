/** Reproducible size audit; all mutable artifacts and fixture commits are temporary. */
import { removeIsolatedDataDir } from '../tests/helpers/isolated-data-dir.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createTempRepo, git, tempDir, worktreeConfig } from '../tests/helpers/temp-git-repo.js';
import { collectWorktreeExecutionDiff } from '../lib/worktree/git-worktree.ts';
import { addTodo } from '../lib/persist/todos-persist.js';
import { ensureWorktree } from '../lib/worktree-manager.js';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { buildSmartMergeRequest, buildVerifyIntegrationRequest } from '../lib/workspace-watcher-integration.js';
import { buildMailboxDeliveryPrompt } from '../lib/delegation-mailbox.js';
import { buildWorkspaceWatcherCyclePrompt, buildWorkspaceWatcherCyclePromptPlan, buildWorkspaceMemoryPromptBlock } from '../lib/workspace-watcher-prompt.js';
import { buildScoutPrompt, buildScoutPromptForProfile } from '../lib/workspace-watcher-scout.js';
import { buildConversationForkPrompt, buildHarnessHandoffPrompt, buildAgentAnalysisPrompt, buildForkInitialPrompt } from '../lib/conversation-fork.js';
import { buildTodoAgentInitialPrompt } from '../lib/todo-agent.js';
import { buildApprovedPlanImplementPrompt } from '../lib/chat-plan-path.js';
import { buildChatPlanPromptContext, writeChatPlanFile } from '../lib/chat-plan-persist.js';
import { decorateHarnessPrompt } from '../lib/sdk/harness-plan-prompt.ts';

const root = path.resolve(import.meta.dirname, '..');
const baseline = process.argv[2] || 'df2b920891f663c627090b9707ecd5127099eee2';
const temporaryModules = [];
async function previousModule(file) {
  const destination = path.join(root, path.dirname(file), `.prompt-audit-${process.pid}-${path.basename(file)}`);
  fs.writeFileSync(destination, execFileSync('git', ['show', `${baseline}:${file}`], { cwd: root }));
  temporaryModules.push(destination);
  return import(pathToFileURL(destination).href);
}
const workspace = createTempRepo().dir;
const dataDir = tempDir('cretli-prompt-audit-data-');
const baseDir = tempDir('cretli-prompt-audit-worktrees-');
try {
  const beforeIntegration = await previousModule('lib/workspace-watcher-integration.js');
  const beforeMailbox = await previousModule('lib/delegation-mailbox.js');
  const beforeBranch = await previousModule('lib/worktree-merge.js');
  const beforeTodoAgent = await previousModule('lib/todo-agent.js');
  const beforeScout = await previousModule('lib/workspace-watcher-scout.js');
  const { buildGitBranchMergePrompt } = await import('../lib/worktree-merge.js');
  const files = Array.from({ length: 60 }, (_, i) => `src/file-${String(i).padStart(2, '0')}.txt`);
  const todo = addTodo(dataDir, workspace, { title: 'Fixture task', status: 'doing', body: files.join('\n'), plan: { markdown: 'Read the files and implement the task.\n' + files.join('\n') } }).item;
  todo.plan = { markdown: 'Read the files and implement the task.\n' + files.join('\n') };
  const chatId = '00000000-0000-4000-8000-000000000001';
  const sourceChatId = '00000000-0000-4000-8000-000000000002';
  const { record } = ensureWorktree({ todoId: todo.id, workspaceFolder: workspace, mode: 'worktree', config: worktreeConfig(baseDir), registryOptions: { dataDir } });
  fs.mkdirSync(path.join(record.worktreePath, 'src'));
  for (const file of files) fs.writeFileSync(path.join(record.worktreePath, file), 'fixture change\n');
  const mergeInput = { todoId: todo.id, workspaceFolder: workspace, dataDir, baseUrl: 'https://localhost:3011' };
  const done = addTodo(dataDir, workspace, { title: 'Finished task', status: 'done' }).item;
  const verifyInput = { ...mergeInput, todoId: done.id };
  const branchInput = { workspaceFolder: workspace, record, preflight: { targetBranch: 'main', branch: record.branch, baseCommit: record.baseCommit }, changedFiles: files, callback: 'curl <callback>' };
  const report = files.map((file) => `Changed ${file}; checks passed.`).join('\n') + '\nVERDICT: PASS';
  const delegation = createDelegationRecord({ parentChatId: sourceChatId, childChatId: chatId, attemptId: '00000000-0000-4000-8000-000000000003', sourceKind: 'message', sourceChatId, sourceHistorySeq: 42, sourceText: todo.plan.markdown });
  updateDelegationRecord(delegation.id, { report });
  const message = { id: '00000000-0000-4000-8000-000000000004', kind: 'reply', replyKind: 'final_report', delegationId: delegation.id, delegationAttemptId: delegation.attemptId, fromChatId: chatId, body: report };
  const memory = [{ id: 'memory-1', type: 'context', key: 'fixture', value: 'Use focused checks for changed files.' }];
  const cycle = { workspaceFolder: workspace, todo, cycleId: 'fixture-cycle', memory, watcher: { policy: {} }, decision: { planOnly: false } };
  const signals = { resolvedBase: record.baseCommit, diff: collectWorktreeExecutionDiff({ worktreePath: record.worktreePath, baseCommit: record.baseCommit }).patch, log: git(workspace, ['log', '--oneline', '-20']), changedFiles: files, existingTodos: [todo], memory };
  const scout = { workspaceFolder: workspace, scanId: 'fixture-scan', submitToken: 'fixture-token', signals };
  const fork = { sourceText: report, message: 'Continue.', sourceChatId, copiedThroughSeq: 42, fromHarness: 'codex', toHarness: 'claude', historyPointer: true };
  // Inline fallback, kept byte-compatible for unsaved/unavailable sources.
  const forkInline = { ...fork, historyPointer: false };
  writeChatPlanFile({ cwd: workspace, chatId, markdown: todo.plan.markdown });
  const rows = [];
  function measure(name, after, before = after) {
    // Fresh room: measure complete first-turn decoration rather than session deduplication.
    const decorate = (prompt) => decorateHarnessPrompt({ cwd: workspace, chatId, sdkMode: 'agent' }, prompt, 'codex');
    rows.push({ name, before: Buffer.byteLength(before), after: Buffer.byteLength(after), decoratedBefore: Buffer.byteLength(decorate(before)), decoratedAfter: Buffer.byteLength(decorate(after)) });
  }
  measure('buildSmartMergeRequest', (await buildSmartMergeRequest(mergeInput)).prompt, (await beforeIntegration.buildSmartMergeRequest(mergeInput)).prompt);
  measure('buildVerifyIntegrationRequest', buildVerifyIntegrationRequest(verifyInput).prompt, beforeIntegration.buildVerifyIntegrationRequest(verifyInput).prompt);
  measure('buildGitBranchMergePrompt', buildGitBranchMergePrompt(branchInput), beforeBranch.buildGitBranchMergePrompt(branchInput));
  measure('buildMailboxDeliveryPrompt', buildMailboxDeliveryPrompt(message), beforeMailbox.buildMailboxDeliveryPrompt(message));
  measure('buildWorkspaceWatcherCyclePrompt', buildWorkspaceWatcherCyclePrompt(cycle));
  measure('buildWorkspaceWatcherCyclePromptPlan', buildWorkspaceWatcherCyclePromptPlan({ ...cycle, decision: { planOnly: true } }).prompt);
  measure('buildWorkspaceMemoryPromptBlock', buildWorkspaceMemoryPromptBlock(memory));
  measure('buildScoutPrompt', buildScoutPrompt(scout), beforeScout.buildScoutPrompt(scout));
  measure('buildScoutPromptForProfile', buildScoutPromptForProfile({}, { ...scout, matchedFiles: files }), beforeScout.buildScoutPromptForProfile({}, { ...scout, matchedFiles: files }));
  measure('buildConversationForkPrompt', buildConversationForkPrompt(report, 'Continue.', fork), buildConversationForkPrompt(report, 'Continue.', forkInline));
  measure('buildHarnessHandoffPrompt', buildHarnessHandoffPrompt(fork), buildHarnessHandoffPrompt(forkInline));
  measure('buildAgentAnalysisPrompt', buildAgentAnalysisPrompt('Inspect current status.', sourceChatId));
  measure('buildForkInitialPrompt', buildForkInitialPrompt(fork), buildForkInitialPrompt(forkInline));
  measure('buildTodoAgentInitialPrompt', buildTodoAgentInitialPrompt(todo, chatId), beforeTodoAgent.buildTodoAgentInitialPrompt(todo, chatId, 'https://localhost:3011'));
  measure('buildApprovedPlanImplementPrompt', buildApprovedPlanImplementPrompt(chatId));
  measure('buildChatPlanPromptContext', buildChatPlanPromptContext({ cwd: workspace, chatId }));
  console.log(JSON.stringify({ baseline, fixture: '60 ASCII paths, 60-line final report, saved plan, one memory entry; fresh codex Agent decoration in isolated workspace', rows }, null, 2));
} finally {
  for (const file of temporaryModules) fs.rmSync(file, { force: true });
  for (const dir of [workspace, dataDir, baseDir]) fs.rmSync(dir, { recursive: true, force: true });
  removeIsolatedDataDir();
}
