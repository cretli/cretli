import assert from 'node:assert/strict';
import {
  isMutatingPlanModeShellCommand,
  isPlanModeMutatingSdkEvent,
  isPlanModeMutatingToolName,
} from '../lib/sdk/sdk-plan-guard.js';

assert.equal(isPlanModeMutatingToolName('shell'), true);
assert.equal(isPlanModeMutatingToolName('edit'), true);
assert.equal(isPlanModeMutatingToolName('read'), false);

assert.equal(isMutatingPlanModeShellCommand(''), true);
assert.equal(isMutatingPlanModeShellCommand('ls'), false);
assert.equal(isMutatingPlanModeShellCommand('rg -n "harness" --glob "*.js"'), false);
assert.equal(isMutatingPlanModeShellCommand('cat app_front/App.js'), false);
assert.equal(isMutatingPlanModeShellCommand('git status'), false);
assert.equal(isMutatingPlanModeShellCommand('git --no-pager diff'), false);
assert.equal(isMutatingPlanModeShellCommand('cd app_front && rg modal'), false);
assert.equal(isMutatingPlanModeShellCommand('ls | head'), false);
assert.equal(isMutatingPlanModeShellCommand('sed -n "1,80p" README.md'), false);
assert.equal(isMutatingPlanModeShellCommand('ls 2>/dev/null'), false);

assert.equal(isMutatingPlanModeShellCommand('rm -rf tmp'), true);
assert.equal(isMutatingPlanModeShellCommand('echo hi > file.txt'), true);
assert.equal(isMutatingPlanModeShellCommand('git commit -m "wip"'), true);
assert.equal(isMutatingPlanModeShellCommand('git add -A'), true);
assert.equal(isMutatingPlanModeShellCommand('sed -i s/a/b/ file.js'), true);
assert.equal(isMutatingPlanModeShellCommand('find . -delete'), true);
assert.equal(isMutatingPlanModeShellCommand('python3 -c "open(\'x\',\'w\').write(\'a\')"'), true);

assert.equal(
  isPlanModeMutatingSdkEvent({ type: 'tool_call', name: 'shell', status: 'running' }),
  true,
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
  isPlanModeMutatingSdkEvent({ type: 'tool_call', name: 'edit', status: 'running' }),
  true,
);

console.log('sdk-plan-guard.test.js OK');
