import assert from 'node:assert/strict';
import {
  isMutatingPlanModeShellCommand,
  isPlanModeMutatingSdkEvent,
  isPlanModeMutatingToolName,
  resolvePlanModeToolDecision,
} from '../lib/sdk/sdk-plan-guard.js';

assert.equal(isPlanModeMutatingToolName('shell'), true);
assert.equal(isPlanModeMutatingToolName('edit'), true);
assert.equal(isPlanModeMutatingToolName('read'), false);

assert.equal(isMutatingPlanModeShellCommand(''), false);
assert.equal(isMutatingPlanModeShellCommand('ls'), false);
assert.equal(isMutatingPlanModeShellCommand('rg -n "harness" --glob "*.js"'), false);
assert.equal(isMutatingPlanModeShellCommand('cat app_front/App.js'), false);
assert.equal(isMutatingPlanModeShellCommand('git status'), false);
assert.equal(isMutatingPlanModeShellCommand('git --no-pager diff'), false);
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

assert.equal(isMutatingPlanModeShellCommand('rm -rf tmp'), true);
assert.equal(isMutatingPlanModeShellCommand('echo hi > file.txt'), true);
assert.equal(isMutatingPlanModeShellCommand('git commit -m "wip"'), true);
assert.equal(isMutatingPlanModeShellCommand('git add -A'), true);
assert.equal(isMutatingPlanModeShellCommand('sed -i s/a/b/ file.js'), true);
assert.equal(isMutatingPlanModeShellCommand('find . -delete'), true);
assert.equal(isMutatingPlanModeShellCommand('python3 -c "open(\'x\',\'w\').write(\'a\')"'), true);
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

console.log('sdk-plan-guard.test.js OK');
