import assert from 'node:assert/strict';
import path from 'node:path';
import {
  isMutatingPlanModeShellCommand,
  isPlanModeMutatingSdkEvent,
  isPlanModeMutatingToolName,
  isPlanModeShellToolName,
  resolvePlanModeToolDecision,
  resolveReadOnlyGuardUserMessage,
  ASK_GUARD_USER_MESSAGE,
  DEEPSEEK_REVIEW_GUARD_USER_MESSAGE,
  PLAN_GUARD_USER_MESSAGE,
  REVIEW_GUARD_USER_MESSAGE,
} from '../lib/sdk/sdk-plan-guard.js';

assert.equal(isPlanModeMutatingToolName('shell'), true);
assert.equal(isPlanModeMutatingToolName('edit'), true);
assert.equal(isPlanModeMutatingToolName('write'), true);
assert.equal(isPlanModeMutatingToolName('read'), false);
assert.equal(isPlanModeMutatingToolName('todo'), false);
assert.equal(isPlanModeMutatingToolName('todo_write'), false);

// Claude Code native tool classification (SDK 0.3.284 aliases included).
for (const name of [
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Agent', 'Task', 'BashOutput', 'ExitPlanMode', 'AskUserQuestion',
  'ListMcpResources', 'ListMcpResourcesTool', 'ReadMcpResource',
  'ReadMcpResourceTool', 'ReadMcpResourceDir', 'ReadMcpResourceDirTool',
  'Skill',
]) {
  assert.equal(isPlanModeMutatingToolName(name), false, `${name} must stay read-only`);
}
for (const name of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'KillShell', 'KillBash', 'TaskStop']) {
  assert.equal(isPlanModeMutatingToolName(name), true, `${name} must stay mutating`);
}

// The Claude transport denies KillShell in Plan/Ask and aborts the run.
{
  const killShell = resolvePlanModeToolDecision({
    transport: 'claude',
    mode: 'plan',
    toolName: 'KillShell',
    input: { shell_id: 'bg-1' },
  });
  assert.equal(killShell.deny, true);
  assert.equal(killShell.abortRun, true);
  assert.equal(killShell.notify, true);
  const skillPlan = resolvePlanModeToolDecision({
    transport: 'claude',
    mode: 'plan',
    toolName: 'Skill',
    input: { skill: 'canvas' },
  });
  assert.equal(skillPlan.deny, false);
}

assert.equal(isMutatingPlanModeShellCommand(''), false);
assert.equal(isMutatingPlanModeShellCommand('ls'), false);
assert.equal(isMutatingPlanModeShellCommand('rg -n "harness" --glob "*.js"'), false);
assert.equal(isMutatingPlanModeShellCommand('cat app_front/App.js'), false);
assert.equal(isMutatingPlanModeShellCommand('git status'), false);
assert.equal(isMutatingPlanModeShellCommand('git --no-pager diff'), false);
assert.equal(isMutatingPlanModeShellCommand('git remote'), false);
assert.equal(isMutatingPlanModeShellCommand('git remote -v'), false);
assert.equal(isMutatingPlanModeShellCommand('git remote --verbose'), false);
assert.equal(isMutatingPlanModeShellCommand('git --no-pager remote -v'), false);
assert.equal(isMutatingPlanModeShellCommand('git remote show origin'), false);
assert.equal(isMutatingPlanModeShellCommand('git remote get-url origin'), false);
assert.equal(isMutatingPlanModeShellCommand('git remote get-url --push origin'), false);
assert.equal(
  isMutatingPlanModeShellCommand(
    "git status --short && git remote -v && git log --merges --format='%h %ad %s' --date=short -10",
  ),
  false,
);
assert.equal(isMutatingPlanModeShellCommand('git remote add origin git@example.com:acme/app.git'), true);
assert.equal(isMutatingPlanModeShellCommand('git remote remove origin'), true);
assert.equal(isMutatingPlanModeShellCommand('git remote rename origin upstream'), true);
assert.equal(isMutatingPlanModeShellCommand('git remote set-url origin git@example.com:acme/app.git'), true);
assert.equal(isMutatingPlanModeShellCommand('git remote prune origin'), true);
// M3: `git -c safe.directory=...` is whitelisted (documented dubious-ownership
// practice) and stays a read-only command.
assert.equal(isMutatingPlanModeShellCommand('git -c safe.directory=/tmp/app remote -v'), false);
assert.equal(isMutatingPlanModeShellCommand('git -c safe.directory=x status'), false);
assert.equal(isMutatingPlanModeShellCommand('git --config safe.directory=x log -1'), false);
// Any other `-c` config key (which can execute a program) stays denied.
assert.equal(isMutatingPlanModeShellCommand('git -c core.editor=x status'), true);
assert.equal(isMutatingPlanModeShellCommand('git -c alias.x=status status'), true);
assert.equal(isMutatingPlanModeShellCommand('cd app_front && rg modal'), false);
assert.equal(isMutatingPlanModeShellCommand('ls | head'), false);
assert.equal(isMutatingPlanModeShellCommand('sed -n "1,80p" README.md'), false);
assert.equal(isMutatingPlanModeShellCommand('ls 2>/dev/null'), false);
assert.equal(
  isMutatingPlanModeShellCommand("/bin/bash -lc 'pwd && rg --files | head -200'"),
  false,
);
assert.equal(
  isMutatingPlanModeShellCommand('/bin/bash -lc pwd && rg --files | head -200'),
  false,
);
assert.equal(isMutatingPlanModeShellCommand('/usr/bin/rg foo'), false);
assert.equal(isMutatingPlanModeShellCommand("/bin/bash -lc 'rm -rf tmp'"), true);
assert.equal(isMutatingPlanModeShellCommand(['/bin/bash', '-lc', 'ls']), false);
assert.equal(isMutatingPlanModeShellCommand(['/bin/bash', '-lc', 'git add -A']), true);
assert.equal(
  isMutatingPlanModeShellCommand([
    { type: 'list_files', cmd: 'rg --files tests', path: 'tests' },
    { type: 'search', cmd: "rg 'approval-.*\\.test\\.js$'", query: 'approval', path: null },
  ]),
  false,
);

assert.equal(isMutatingPlanModeShellCommand('rm -rf tmp'), true);
assert.equal(isMutatingPlanModeShellCommand('echo hi > file.txt'), true);
assert.equal(isMutatingPlanModeShellCommand('git commit -m "wip"'), true);
assert.equal(isMutatingPlanModeShellCommand('git add -A'), true);
assert.equal(isMutatingPlanModeShellCommand('sed -i s/a/b/ file.js'), true);
assert.equal(isMutatingPlanModeShellCommand('find . -delete'), true);
assert.equal(isMutatingPlanModeShellCommand('python3 -c "open(\'x\',\'w\').write(\'a\')"'), true);
// A read-only-looking heredoc script is still opaque code: no filesystem sandbox.
assert.equal(
  isMutatingPlanModeShellCommand("cd /tmp && python3 - <<'EOF'\nimport json\nprint(json.dumps({}))\nEOF"),
  true,
);
assert.equal(
  isMutatingPlanModeShellCommand(
    "rg -n 'export|import|backup|localStorage|save|delete|status' app_front/Modules/ShippingConfirmations.js",
  ),
  false,
);
assert.equal(
  isPlanModeMutatingSdkEvent({
    type: 'tool_call',
    name: 'shell',
    status: 'running',
    args: {
      command: [
        '/bin/bash',
        '-lc',
        "rg -n 'export|import|save|delete|status' app_front/x.js",
      ],
    },
  }),
  false,
);
assert.equal(isPlanModeMutatingToolName('web_search'), false);
assert.equal(isPlanModeMutatingToolName('mcp.web_search'), true);
assert.equal(isPlanModeMutatingToolName('mcp__cretli_abc__chat_list'), true);
assert.equal(isPlanModeMutatingToolName('mcp__cretli_abc__chat_delete'), true);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'qwen',
    mode: 'plan',
    toolName: 'mcp__cretli_abc__chat_show',
  }).deny,
  false,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'qwen',
    mode: 'plan',
    toolName: 'chat_show',
  }).deny,
  false,
);
assert.equal(
  isPlanModeMutatingSdkEvent({ type: 'tool_call', name: 'web_search', status: 'running' }),
  false,
);
assert.equal(isMutatingPlanModeShellCommand('ls | rm -rf tmp'), true);
assert.equal(
  isMutatingPlanModeShellCommand(
    "rg -n '^(export |    (async |static )?[a-zA-Z_].*\\(|const )' app_front/Modules/Module.js && cat spec.js",
  ),
  false,
);
assert.equal(isMutatingPlanModeShellCommand("rg -n 'foo$(bar)|delete' x.js"), false);
assert.equal(isMutatingPlanModeShellCommand('echo $(whoami)'), true);
assert.equal(
  isMutatingPlanModeShellCommand(
    'for p in /AGENTS.md /home/AGENTS.md; do if test -f "$p"; then cat "$p"; fi; done',
  ),
  false,
);
assert.equal(
  isMutatingPlanModeShellCommand(
    "cat lib/sdk/sdk-history-isolation.js; rg -n 'extractTodoSummary' tests app_front lib/sdk; for p in /AGENTS.md /home/AGENTS.md /home/ar2oor/AGENTS.md; do if test -f \"$p\"; then cat \"$p\"; fi; done",
  ),
  false,
);
assert.equal(
  isMutatingPlanModeShellCommand('if test -f README.md; then cat README.md; fi'),
  false,
);
assert.equal(
  isMutatingPlanModeShellCommand('for p in a b; do rm -rf tmp; done'),
  true,
);
assert.equal(
  isMutatingPlanModeShellCommand('if test -f x; then rm x; fi'),
  true,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'codex',
    mode: 'agent',
    assignment: 'review',
    toolName: 'shell',
    input: {
      command: [
        '/bin/bash',
        '-lc',
        'cat lib/sdk/sdk-history-isolation.js; for p in /AGENTS.md /home/AGENTS.md; do if test -f "$p"; then cat "$p"; fi; done',
      ],
    },
  }).deny,
  false,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'codex',
    mode: 'agent',
    assignment: 'review',
    toolName: 'shell',
    input: { command: 'for p in a; do python3 -c "open(\'x\',\'w\').write(\'a\')"; done' },
  }).deny,
  true,
);
const reviewRemote = resolvePlanModeToolDecision({
  transport: 'codex',
  mode: 'agent',
  assignment: 'review',
  toolName: 'shell',
  input: {
    command: ['/bin/bash', '-lc', 'git status --short && git remote -v && git log -1'],
  },
});
assert.equal(reviewRemote.deny, false);
assert.equal(reviewRemote.abortRun, false);

assert.equal(
  isPlanModeMutatingSdkEvent({ type: 'tool_call', name: 'shell', status: 'running' }),
  false,
);
assert.equal(
  isPlanModeMutatingSdkEvent({
    type: 'tool_call',
    name: 'shell',
    status: 'running',
    args: { command: 'ls' },
  }),
  false,
);
assert.equal(
  isPlanModeMutatingSdkEvent({
    type: 'tool_call',
    name: 'shell.exec',
    status: 'started',
    args: { command: 'rg foo' },
  }),
  false,
);
assert.equal(
  isPlanModeMutatingSdkEvent({
    type: 'tool_call',
    name: 'shell',
    status: 'running',
    args: { command: 'echo hi > out.txt' },
  }),
  true,
);
assert.equal(
  isPlanModeMutatingSdkEvent({
    type: 'tool_call',
    name: 'shell',
    status: 'running',
    args: { command: ['/bin/bash', '-lc', 'pwd && rg --files | head -200'] },
  }),
  false,
);
assert.equal(
  isPlanModeMutatingSdkEvent({
    type: 'tool_call',
    name: 'shell',
    status: 'running',
    args: { command: "/bin/bash -lc 'pwd && rg --files | head -200'" },
  }),
  false,
);
assert.equal(
  isPlanModeMutatingSdkEvent({ type: 'tool_call', name: 'edit', status: 'running' }),
  true,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'sdk',
    mode: 'ask',
    toolName: 'edit',
  }).deny,
  true,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'sdk',
    mode: 'ask',
    toolName: 'read',
  }).deny,
  false,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'codex',
    mode: 'ask',
    toolName: 'edit',
  }).deny,
  true,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'codex',
    mode: 'plan',
    toolName: 'edit',
  }).deny,
  false,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'codex',
    mode: 'ask',
    toolName: 'edit',
  }).abortRun,
  true,
);

assert.equal(
  resolvePlanModeToolDecision({
    transport: 'sdk',
    mode: 'agent',
    assignment: 'review',
    toolName: 'edit',
  }).deny,
  true,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'sdk',
    mode: 'agent',
    toolName: 'edit',
  }).deny,
  false,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'deepseek',
    mode: 'agent',
    assignment: 'review',
    toolName: 'todo_write',
  }).deny,
  false,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'deepseek',
    mode: 'agent',
    assignment: 'review',
    toolName: 'bash',
    input: { command: 'ls -la', description: 'List files in current directory' },
  }).deny,
  false,
);
// The dsh read-only sandbox refuses the write, so the run keeps going and the
// reviewer can still finish the report.
assert.deepEqual(
  resolvePlanModeToolDecision({
    transport: 'deepseek',
    mode: 'agent',
    assignment: 'review',
    toolName: 'write',
  }),
  { deny: true, abortRun: false, notify: true },
);
assert.equal(resolveReadOnlyGuardUserMessage('agent', 'review'), REVIEW_GUARD_USER_MESSAGE);
assert.equal(resolveReadOnlyGuardUserMessage('agent'), PLAN_GUARD_USER_MESSAGE);
// DeepSeek review runs in DSH's read-only sandbox, so it gets its own wording.
assert.equal(
  resolveReadOnlyGuardUserMessage('agent', 'review', 'deepseek'),
  DEEPSEEK_REVIEW_GUARD_USER_MESSAGE,
);
assert.equal(
  resolveReadOnlyGuardUserMessage('agent', 'review', 'sdk'),
  REVIEW_GUARD_USER_MESSAGE,
);
assert.ok(REVIEW_GUARD_USER_MESSAGE.includes('read-only review policy'));
// The guard points the reviewer at the audited test runner instead of a shell.
assert.match(REVIEW_GUARD_USER_MESSAGE, /scripts\/review-verify\.js/);
// Unknown ids are a per-command deny, so the reviewer must not treat Bash as dead.
assert.match(REVIEW_GUARD_USER_MESSAGE, /unknown catalog id/i);
assert.match(REVIEW_GUARD_USER_MESSAGE, /other commands are not blocked/);
// A denied interpreter must be explained, with a usable read-only alternative.
assert.match(REVIEW_GUARD_USER_MESSAGE, /python3/);
assert.match(REVIEW_GUARD_USER_MESSAGE, /`jq`/);
// The DeepSeek variant explains the sandbox and keeps the audited test runner.
assert.match(DEEPSEEK_REVIEW_GUARD_USER_MESSAGE, /read-only sandbox/);
assert.match(DEEPSEEK_REVIEW_GUARD_USER_MESSAGE, /scripts\/review-verify\.js/);

const grokReviewMcpRead = resolvePlanModeToolDecision({
  transport: 'sdk',
  mode: 'agent',
  assignment: 'review',
  toolName: 'mcp',
  input: {
    providerIdentifier: 'cretli_bridge',
    toolName: 'mcp__cretli_builtincretl__delegation_show',
    args: { delegation_id: 'e0d7e1f3-63a5-461d-84ad-044c06c27342' },
  },
});
assert.equal(grokReviewMcpRead.deny, false);
assert.equal(grokReviewMcpRead.abortRun, false);
const grokReviewMcpWait = resolvePlanModeToolDecision({
  transport: 'sdk',
  mode: 'agent',
  assignment: 'review',
  toolName: 'mcp',
  input: {
    providerIdentifier: 'cretli_bridge',
    toolName: 'mcp__cretli_builtincretl__delegation_wait',
    args: { ids: ['e0d7e1f3-63a5-461d-84ad-044c06c27342'] },
  },
});
assert.equal(grokReviewMcpWait.deny, false);
const grokReviewMcpOpaque = resolvePlanModeToolDecision({
  transport: 'sdk',
  mode: 'agent',
  assignment: 'review',
  toolName: 'mcp',
  input: { providerIdentifier: 'cretli_bridge' },
});
assert.equal(grokReviewMcpOpaque.deny, true);
assert.equal(grokReviewMcpOpaque.abortRun, false);
const grokReviewMcpWrite = resolvePlanModeToolDecision({
  transport: 'sdk',
  mode: 'agent',
  assignment: 'review',
  toolName: 'mcp',
  input: { toolName: 'mcp__other__write_file' },
});
assert.equal(grokReviewMcpWrite.deny, true);
assert.equal(grokReviewMcpWrite.abortRun, false);
const grokReviewDelegationReply = resolvePlanModeToolDecision({
  transport: 'sdk',
  mode: 'agent',
  assignment: 'review',
  toolName: 'mcp',
  input: {
    providerIdentifier: 'cretli_bridge',
    toolName: 'mcp__cretli_builtincretl__delegation_reply',
  },
});
assert.equal(grokReviewDelegationReply.deny, false);
assert.equal(grokReviewDelegationReply.abortRun, false);

const reviewVerifyAllowed = [
  'node scripts/review-verify.js',
  'node ./scripts/review-verify.js mcp-chat-history-format',
  'node scripts/review-verify.js sdk-history-stream-coalesce sdk-assistant-block-reuse',
  ['/bin/bash', '-lc', 'node scripts/review-verify.js mcp-chat-history-format'],
  // wrapper without path is still allowed (skipReadOnlyShellPrefix handles it)
  'env node scripts/review-verify.js notices',
  'node scripts/review-verify.js mcp-chat-history-format 2>&1 | tail -40',
  'node scripts/review-verify.js notices 2>/dev/null | head -5',
  'node scripts/review-verify.js notices >/dev/null',
];
for (const command of reviewVerifyAllowed) {
  assert.equal(
    isMutatingPlanModeShellCommand(command, { allowReviewVerify: true }),
    false,
    String(command),
  );
  assert.equal(isMutatingPlanModeShellCommand(command), true, String(command));
}
for (const command of [
  'node tests/mcp-chat-history-format.test.js',
  'node tests/conversation-fork.test.js',
  'node --test tests/sidebar-layout.test.js tests/sidebar-render-metrics.test.js',
  'node --test tests/sidebar-layout.test.js tests/sidebar-render-metrics.test.js 2>&1 | tail -20',
]) {
  assert.equal(isMutatingPlanModeShellCommand(command, { allowReviewVerify: true }), true, command);
  assert.equal(isMutatingPlanModeShellCommand(command), true, command);
}

assert.equal(
  resolvePlanModeToolDecision({
    transport: 'codex',
    mode: 'agent',
    assignment: 'review',
    toolName: 'shell',
    input: { command: 'node scripts/review-verify.js mcp-chat-history-format' },
  }).deny,
  false,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'sdk',
    mode: 'agent',
    assignment: 'review',
    toolName: 'shell',
    input: { command: 'node scripts/review-verify.js mcp-chat-history-format' },
  }).deny,
  false,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'sdk',
    mode: 'plan',
    toolName: 'shell',
    input: { command: 'node scripts/review-verify.js' },
  }).deny,
  true,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'openrouter',
    mode: 'agent',
    assignment: 'review',
    toolName: 'run_terminal_command',
    input: { command: 'node scripts/review-verify.js sdk-assistant-block-reuse' },
  }).deny,
  false,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'sdk',
    mode: 'agent',
    assignment: 'review',
    toolName: 'shell',
    input: { command: 'cat lib/sdk/sdk-plan-guard.js' },
  }).deny,
  false,
);

const reviewBlocked = [
  'node --test-reporter=./evil.js scripts/review-verify.js',
  'node scripts/review-verify.js --test-reporter=spec',
  'node scripts/review-verify.js unknown-id',
  'node -e "require(\'fs\').writeFileSync(\'x.js\',\'a\')"',
  'node --eval "console.log(1)"',
  'node scripts/run-unit-tests.mjs',
  'node tests/e2e/chat-mock.spec.js',
  'node tests/../lib/sdk/sdk-plan-guard.js',
  'npm test',
  'npx playwright test',
  'node scripts/review-verify.js && rm -rf tmp',
  // Z1 regression: binary with path separator must be blocked in review
  './node scripts/review-verify.js notices',
  '/tmp/evil/node scripts/review-verify.js notices',
  'env /usr/bin/node scripts/review-verify.js notices',
  // Z1 regression: wrapper with path separator must be blocked too
  '/tmp/evil/env node scripts/review-verify.js notices',
  './time node scripts/review-verify.js notices',
  // Z1 regression: env-var prefix (PATH=./evil) bypasses binary check in tokenizeShellSegment
  'PATH=. node scripts/review-verify.js notices',
  'PATH=/tmp/evil node scripts/review-verify.js notices',
  'NODE_OPTIONS=--require ./payload.js node scripts/review-verify.js notices',
  'LD_PRELOAD=./fixture.so node scripts/review-verify.js notices',
  // Z1 regression: newline/& separator hides env-var prefix from start-of-segment check
  'ls\nPATH=. node scripts/review-verify.js notices',
  'ls & PATH=. node scripts/review-verify.js notices',
  'rg foo\nLD_PRELOAD=./x.so node scripts/review-verify.js notices',
  'python3 -c "open(\'x\',\'w\').write(\'a\')"',
  'echo pwned > pwned.txt',
  'node scripts/review-verify.js notices >out.txt',
  'node scripts/review-verify.js notices 2>&1 >out.txt',
  'node scripts/review-verify.js notices 2>/dev/null > out.txt',
  'git commit -m wip',
];
for (const command of reviewBlocked) {
  assert.equal(
    resolvePlanModeToolDecision({
      transport: 'sdk',
      mode: 'agent',
      assignment: 'review',
      toolName: 'shell',
      input: { command },
    }).deny,
    true,
    command,
  );
}

const opaqueExec = resolvePlanModeToolDecision({
  transport: 'sdk',
  mode: 'agent',
  assignment: 'review',
  toolName: 'functions.exec',
  input: { code: 'await exec("node tests/mcp-chat-history-format.test.js")' },
});
assert.equal(opaqueExec.deny, true);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'sdk',
    mode: 'agent',
    assignment: 'review',
    toolName: 'functions.exec',
    input: { javascript: 'require("fs").writeFileSync("x","a")' },
  }).deny,
  true,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'codex',
    mode: 'agent',
    assignment: 'review',
    toolName: 'functions.exec',
  }).deny,
  true,
);

const openRouterDenyContinue = resolvePlanModeToolDecision({
  transport: 'openrouter',
  mode: 'agent',
  assignment: 'review',
  toolName: 'run_terminal_command',
  input: { command: 'rm -rf tmp' },
});
assert.equal(openRouterDenyContinue.deny, true);
assert.equal(openRouterDenyContinue.abortRun, false);

const qwenDenyContinue = resolvePlanModeToolDecision({
  transport: 'qwen',
  mode: 'agent',
  assignment: 'review',
  toolName: 'shell',
  input: { command: 'rm -rf tmp' },
});
assert.equal(qwenDenyContinue.deny, true);
assert.equal(qwenDenyContinue.abortRun, false);

const codexMutationAborts = resolvePlanModeToolDecision({
  transport: 'codex',
  mode: 'agent',
  assignment: 'review',
  toolName: 'shell',
  input: { command: 'rm -rf tmp' },
});
assert.equal(codexMutationAborts.deny, true);
assert.equal(codexMutationAborts.abortRun, true);

const codexVerifyContinues = resolvePlanModeToolDecision({
  transport: 'codex',
  mode: 'agent',
  assignment: 'review',
  toolName: 'shell',
  input: { command: 'node scripts/review-verify.js mcp-chat-history-format' },
});
assert.equal(codexVerifyContinues.deny, false);
assert.equal(codexVerifyContinues.abortRun, false);

assert.equal(
  resolvePlanModeToolDecision({
    transport: 'sdk',
    mode: 'agent',
    assignment: 'review',
    toolName: 'edit',
  }).deny,
  true,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'sdk',
    mode: 'agent',
    assignment: 'review',
    toolName: 'delete',
  }).deny,
  true,
);

// --- Hardening bypass regressions (each maps to todo bypass #) ---
const bypassMutating = [
  ['bypass1_double_quote_subshell', 'echo "$(rm x)"'],
  ['bypass1_double_quote_backtick', 'echo "`rm x`"'],
  ['bypass2_backslash_single_quote', "echo \\'; rm x; echo \\'"],
  ['bypass2_backslash_double_quote_subshell', 'echo \\" $(rm x) \\"'],
  ['bypass3_process_substitution_in', 'cat <(rm x)'],
  ['bypass3_process_substitution_out', 'cat >(rm x)'],
  ['bypass4_brace_expansion', 'echo ${HOME}'],
  ['bypass4_double_quote_arithmetic', 'echo "$((1+1))"'],
  ['bypass5_stderr_redirect_file', 'ls 2>file.txt'],
  ['bypass5_stderr_append_file', 'ls 2>>file.txt'],
  ['bypass6_untrusted_path_basename', './untrusted/cat x'],
  ['bypass7_find_quoted_delete', 'find . "-delete"'],
  ['bypass7_find_execdir', 'find . -execdir rm {} \\;'],
  ['bypass7_sed_write', "sed -n 'w /tmp/out' file"],
  ['bypass7_awk_system', 'awk \'BEGIN{system("id")}\''],
  ['bypass7_rg_pre', 'rg --pre=sh foo'],
  ['bypass7_sort_output', 'sort -o out.txt x'],
  ['bypass7_git_diff_output', 'git diff --output=out.txt'],
  ['bypass7_less_shell_escape', 'less +!sh file'],
  ['bypass8_heredoc', 'cat <<EOF\n$(rm x)\nEOF'],
  ['bypass8_here_string', 'cat <<< $(rm x)'],
  ['bypass9_unbalanced_double_quote', 'echo "unclosed'],
];
for (const [label, command] of bypassMutating) {
  assert.equal(isMutatingPlanModeShellCommand(command), true, label);
}

assert.equal(isMutatingPlanModeShellCommand("echo '$(rm x)'"), false, 'bypass1_single_quote_literal');
assert.equal(isMutatingPlanModeShellCommand('PATH=. rg x'), false, 'path_prefix_allowed_without_review_verify');
assert.equal(
  isMutatingPlanModeShellCommand('PATH=. rg x', { allowReviewVerify: true }),
  true,
  'path_prefix_blocked_in_review_verify',
);

assert.equal(
  resolvePlanModeToolDecision({
    transport: 'claude',
    mode: 'agent',
    assignment: 'review',
    projectRoot: '/tmp/my-app',
    toolName: 'Bash',
    input: { command: 'node tests/conversation-fork.test.js' },
  }).deny,
  true,
  'claude_review_node_test_with_projectRoot',
);

// --- Round-1 review fixes ------------------------------------------------
// Each finding below was a guard hole (or over-broad deny) confirmed against the
// production code and is covered by a focused unit test (AAA style).

// C1: `run_shell_command` must be recognized as a shell tool so the whole guard
// is reachable for the Qwen harness. Without it the Qwen path skips the guard.
const shellToolNames = ['run_shell_command', 'bash', 'shell', 'exec', 'run_terminal_command', 'functions.exec', 'shell.x'];
for (const toolName of shellToolNames) {
  assert.equal(
    resolvePlanModeToolDecision({
      transport: 'qwen', mode: 'agent', assignment: 'review',
      toolName, input: { command: 'rm -rf /tmp/important' },
    }).deny,
    true,
    `${toolName} must be guarded against rm`,
  );
  assert.equal(
    resolvePlanModeToolDecision({
      transport: 'qwen', mode: 'agent', assignment: 'review',
      toolName, input: { command: 'ls' },
    }).deny,
    false,
    `${toolName} must allow read-only ls`,
  );
}
assert.equal(isPlanModeShellToolName('run_shell_command'), true, 'run_shell_command is a shell tool name');

// C2: sed `s` command with `e`/`w`/`W` flag executes or writes; `-i`/`--in-place`
// edits in place.
assert.equal(isMutatingPlanModeShellCommand("sed 's/.*/id/e' /etc/hostname"), true, 'C2 sed e flag executes');
assert.equal(isMutatingPlanModeShellCommand("sed 's/a/b/w out.txt' file"), true, 'C2 sed w flag writes');
assert.equal(isMutatingPlanModeShellCommand("sed 's/a/b/W' file"), true, 'C2 sed W flag writes');
assert.equal(isMutatingPlanModeShellCommand("sed 's/a/b/g' file"), false, 'C2 sed g flag is read-only');
assert.equal(isMutatingPlanModeShellCommand("sed -n '1,80p' README.md"), false, 'C2 sed print is read-only');

// C3: awk `|` operator pipes to a shell command; `system(` already blocked.
assert.equal(isMutatingPlanModeShellCommand("awk 'BEGIN{print \"x\" | \"cat\"}'"), true, 'C3 awk pipe to command');
assert.equal(isMutatingPlanModeShellCommand("awk 'BEGIN{ \"touch /tmp/pwned\" | getline x }'"), true, 'C3 awk getline pipe');
assert.equal(isMutatingPlanModeShellCommand("awk '/a|b/' file"), false, 'C3 awk regex alternation is read-only');

// C4: digit-adjacent redirects write a file (`echo pwned2>file`, `printf x1>file`).
assert.equal(isMutatingPlanModeShellCommand('echo pwned2>/nonexistent-zz-probe/out'), true, 'C4 digit-adjacent redirect');
assert.equal(isMutatingPlanModeShellCommand("printf 'x'1>/tmp/out"), true, 'C4 printf digit-adjacent redirect');
assert.equal(isMutatingPlanModeShellCommand('cat README.md0>/tmp/out'), true, 'C4 cat digit-adjacent redirect');
// Safe sinks stay allowed.
assert.equal(isMutatingPlanModeShellCommand('ls 2>/dev/null'), false, 'C4 fd redirect to /dev/null is safe');
assert.equal(isMutatingPlanModeShellCommand('cat README.md 2>&1'), false, 'C4 fd dup is safe');

// H1: `--output` / `--ext-diff` on any read-only git subcommand writes / runs.
assert.equal(isMutatingPlanModeShellCommand('git log --output=/nonexistent-zz-probe/out -1'), true, 'H1 git log --output');
assert.equal(isMutatingPlanModeShellCommand('git show --output=out --stat HEAD'), true, 'H1 git show --output');
assert.equal(isMutatingPlanModeShellCommand('git shortlog --output=out'), true, 'H1 git shortlog --output');
assert.equal(isMutatingPlanModeShellCommand('git diff --ext-diff'), true, 'H1 git diff --ext-diff');

// H2: `sed --in-place` (and `=SUFFIX`) edits the file.
assert.equal(isMutatingPlanModeShellCommand("sed --in-place 's/x/y/' file"), true, 'H2 sed --in-place');
assert.equal(isMutatingPlanModeShellCommand("sed --in-place=.bak 's/x/y/' file"), true, 'H2 sed --in-place=.bak');

// H3: sort output / compress-program write or run.
assert.equal(isMutatingPlanModeShellCommand('sort --output FILE'), true, 'H3 sort --output');
assert.equal(isMutatingPlanModeShellCommand('sort -ro FILE'), true, 'H3 sort -ro');
assert.equal(isMutatingPlanModeShellCommand('sort --compress-program=touch'), true, 'H3 sort --compress-program');
assert.equal(isMutatingPlanModeShellCommand('sort -r file'), false, 'H3 sort reverse is read-only');

// H4: find `-fls` writes a file.
assert.equal(isMutatingPlanModeShellCommand('find . -maxdepth 0 -fls FILE'), true, 'H4 find -fls');

// H5: `uniq INPUT OUTPUT` writes the second operand.
assert.equal(isMutatingPlanModeShellCommand('uniq INPUT OUTPUT'), true, 'H5 uniq second operand is output');
assert.equal(isMutatingPlanModeShellCommand('uniq INPUT'), false, 'H5 uniq single operand is read-only');
assert.equal(isMutatingPlanModeShellCommand('uniq -c INPUT'), false, 'H5 uniq single operand with flag is read-only');

// H6: execution-enabling env vars are rejected even though the prefix is stripped.
assert.equal(isMutatingPlanModeShellCommand('GIT_EXTERNAL_DIFF=touch git diff'), true, 'H6 GIT_EXTERNAL_DIFF');
assert.equal(isMutatingPlanModeShellCommand("LESSOPEN='|touch /tmp/p' less file"), true, 'H6 LESSOPEN');
assert.equal(isMutatingPlanModeShellCommand('PATH=. rg x'), false, 'H6 PATH prefix stays read-only');

// M1: unbalanced parentheses outside quotes are opaque / fail closed.
assert.equal(isMutatingPlanModeShellCommand('cat ((x'), true, 'M1 unbalanced open paren');
assert.equal(isMutatingPlanModeShellCommand('cat ))x'), true, 'M1 unbalanced close paren');
assert.equal(isMutatingPlanModeShellCommand('echo (ls)'), false, 'M1 balanced subshell is read-only');

// M2: quoted literals must stay allowed (no false deny on raw text).
assert.equal(isMutatingPlanModeShellCommand("rg '=>' lib"), false, 'M2 rg quoted arrow');
assert.equal(isMutatingPlanModeShellCommand("rg 'a>b' lib"), false, 'M2 rg quoted redirect char');
assert.equal(isMutatingPlanModeShellCommand("grep -rn 'eval' lib"), false, 'M2 grep quoted eval');
assert.equal(isMutatingPlanModeShellCommand("rg 'sudo' docs"), false, 'M2 rg quoted sudo');

// M3: `git -c safe.directory=...` whitelisted; other config keys denied.
assert.equal(isMutatingPlanModeShellCommand('git -c safe.directory=x status'), false, 'M3 git safe.directory allowed');
assert.equal(isMutatingPlanModeShellCommand('git --config safe.directory=x log -1'), false, 'M3 git --config safe.directory allowed');
assert.equal(isMutatingPlanModeShellCommand('git -c core.editor=x status'), true, 'M3 git other -c denied');

// M4: awk/sed `-f` / `--file` read program from a file (unclassified).
assert.equal(isMutatingPlanModeShellCommand('awk -f PROG'), true, 'M4 awk -f');
assert.equal(isMutatingPlanModeShellCommand('sed -f PROG'), true, 'M4 sed -f');
assert.equal(isMutatingPlanModeShellCommand('awk --file=PROG'), true, 'M4 awk --file');
assert.equal(isMutatingPlanModeShellCommand("sed -nf PROG"), true, 'M4 sed bundled -nf');
// Still allow awk without a file flag.
assert.equal(isMutatingPlanModeShellCommand("awk '{print $1}' file"), false, 'M4 awk no file flag read-only');

// L1: `>/dev/null7` is a real file, not the /dev/null sink.
assert.equal(isMutatingPlanModeShellCommand('echo hi >/dev/null7'), true, 'L1 /dev/null prefix boundary');

// L2: a literal `\cat` is not the `cat` binary; do not strip the backslash.
assert.equal(isMutatingPlanModeShellCommand('/usr/bin/\\cat x'), true, 'L2 backslash not stripped from basename');

// M7: qwen canUseTool passes projectRoot; direct node test execution stays denied.
const m7AbsTest = path.join(process.cwd(), 'tests', 'sdk-plan-guard.test.js');
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'qwen', mode: 'agent', assignment: 'review',
    projectRoot: process.cwd(),
    toolName: 'run_shell_command',
    input: { command: `node ${m7AbsTest}` },
  }).deny,
  true,
  'M7 qwen absolute node test denied with projectRoot',
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'qwen', mode: 'agent', assignment: 'review',
    toolName: 'run_shell_command',
    input: { command: `node ${m7AbsTest}` },
  }).deny,
  true,
  'M7 qwen absolute node test denied without projectRoot',
);

// --- Reviewer UX: substitution/assignment denial must be actionable --------
// The read-only review child ran `f=$(grep -rln "x" lib); echo $f; grep -n e $f | head`.
// The commands are read-only, but the construct (`$(...)` + `name=value`)
// stays denied; the denial message must say what is not allowed and what to
// do instead. Guard logic is unchanged — only the wording is asserted here.
{
  const incidentCommand = 'f=$(grep -rln "x" lib); echo $f; grep -n e $f | head';
  // Arrange: the exact incident command is classified as mutating.
  // Act: classify it both directly and through the review tool decision.
  const directMutating = isMutatingPlanModeShellCommand(incidentCommand);
  const reviewDecision = resolvePlanModeToolDecision({
    transport: 'sdk',
    mode: 'agent',
    assignment: 'review',
    toolName: 'shell',
    input: { command: incidentCommand },
  });
  // Assert: denied in both paths, and the review stays recoverable.
  assert.equal(directMutating, true, 'incident command must stay denied');
  assert.equal(reviewDecision.deny, true, 'review decision must deny the incident command');

  // Arrange: the resolved review guard message shown on the denial.
  // Act: read the message for agent mode + review assignment.
  const message = resolveReadOnlyGuardUserMessage('agent', 'review');
  // Assert: it names the forbidden constructs and the supported alternative.
  assert.match(message, /substitution|assignment|\$\(/i, 'message must name substitution/assignment as not allowed');
  assert.match(message, /separate/i, 'message must tell the reviewer to use separate calls');
  assert.match(message, /rg -l|grep -rln/, 'message must name the supported search call');
  assert.match(message, /`cat`|`rg -n`|`sed -n`/, 'message must name the supported read calls');
}

// The Plan/Ask guard messages are out of scope for this task; pin their
// behavior so a wording change here cannot leak into them.
{
  assert.equal(PLAN_GUARD_USER_MESSAGE, 'Plan mode blocked execution. Switch to Agent mode to apply changes.');
  assert.equal(ASK_GUARD_USER_MESSAGE, 'Ask mode blocked this change. Switch to Agent mode to apply changes.');
}

// Read-only syntax/lint/branch checks are not mutations; code-running forms stay blocked.
for (const cmd of [
  'node --check lib/x.js',
  'node -c lib/x.js',
  'cd repo && node --check lib/x.js',
  'FOO=bar node --check lib/x.js',
  'npx eslint lib/x.js',
  'eslint lib/x.js tests/y.js',
  'git branch --show-current',
  'git branch --list',
  "git branch --list 'next/*'",
]) {
  assert.equal(isMutatingPlanModeShellCommand(cmd), false, cmd);
}
for (const cmd of [
  'node -e "1"',
  'node -p 1',
  'node lib/x.js',
  'node --test tests/x.test.js',
  'node tests/x.test.js',
  'node -r ./evil.js --check x.js',
  'node --check x.js > out.txt',
  'NODE_OPTIONS=--require=./x.js node --check y.js',
  'env NODE_OPTIONS=--require=./x.js node --check y.js',
  'cd repo && NODE_OPTIONS=--require=./x.js node --check y.js',
  'NODE_PATH=./evil node --check y.js',
  'LD_PRELOAD=./x.so node --check y.js',
  'DYLD_INSERT_LIBRARIES=./x.dylib node --check y.js',
  'npm test',
  'npm run lint',
  'npx eslint --fix lib/x.js',
  'npx eslint --fix-dry-run lib/x.js',
  'eslint --fix lib/x.js',
  'eslint -o out.json lib/x.js',
  'npx prettier --write .',
  'git branch feature',
  'git branch -d feature',
  'git branch -D feature',
  'git branch -m old new',
  'git branch',
  'python3 -c "open(\'x\',\'w\')"',
  'tee out.txt',
]) {
  assert.equal(isMutatingPlanModeShellCommand(cmd), true, cmd);
}

console.log('sdk-plan-guard.test.js OK');
