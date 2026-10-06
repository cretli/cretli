import assert from 'node:assert/strict';
import {
  isMutatingPlanModeShellCommand,
  isPlanModeMutatingSdkEvent,
  isPlanModeMutatingToolName,
  resolvePlanModeToolDecision,
  resolveReadOnlyGuardUserMessage,
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
assert.equal(isMutatingPlanModeShellCommand('git -c safe.directory=/tmp/app remote -v'), false);
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
  'node tests/mcp-chat-history-format.test.js',
  'node tests/conversation-fork.test.js',
  'node tests/sdk-history-stream-coalesce.test.js',
  'node --test tests/sidebar-layout.test.js tests/sidebar-render-metrics.test.js',
  'node --test tests/sidebar-layout.test.js tests/sidebar-render-metrics.test.js 2>&1 | tail -20',
];
for (const command of reviewVerifyAllowed) {
  assert.equal(
    isMutatingPlanModeShellCommand(command, { allowReviewVerify: true }),
    false,
    String(command),
  );
  assert.equal(isMutatingPlanModeShellCommand(command), true, String(command));
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

console.log('sdk-plan-guard.test.js OK');
