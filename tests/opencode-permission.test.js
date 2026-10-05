import assert from 'node:assert/strict';
import {
  buildOpenCodePermissionSdkEvent,
  buildOpenCodePlanPermissionRuleset,
  classifyOpenCodePermissionRisk,
  isOpenCodePermissionWithinWorkspace,
  isOpenCodePlanMutatingPermission,
  listOpenCodePermissionIdsForFailedTool,
  postOpenCodePermissionResponse,
  resolveOpenCodeApprovalAction,
  resolveOpenCodePermissionResolvedRequestId,
  shouldAutoAllowOpenCodeDelegationPermission,
  shouldAutoAllowOpenCodeReviewPermission,
  shouldRejectOpenCodePlanPermission,
} from '../lib/opencode/opencode-permission.js';
import { isOpenCodeStaleSkillError } from '../lib/opencode/opencode-instance-http.js';

const askedV2 = buildOpenCodePermissionSdkEvent({
  type: 'permission.v2.asked',
  properties: {
    id: 'perm_test',
    sessionID: 'ses_test',
    action: 'Write file',
    resources: ['src/app.js'],
    save: ['write'],
  },
}, { opencodeSessionId: 'ses_test' });
assert.ok(askedV2);
assert.equal(askedV2.type, 'opencode_permission');
assert.equal(askedV2.requestId, 'perm_test');
assert.equal(askedV2.action, 'Write file');
assert.deepEqual(askedV2.resources, ['src/app.js']);

const askedV1 = buildOpenCodePermissionSdkEvent({
  type: 'permission.asked',
  properties: {
    id: 'perm_v1',
    sessionID: 'ses_test',
    permission: 'bash',
    patterns: ['npm test'],
    metadata: {},
    always: ['bash'],
  },
}, { opencodeSessionId: 'ses_test' });
assert.ok(askedV1);
assert.equal(askedV1.action, 'bash');
assert.deepEqual(askedV1.resources, ['npm test']);
assert.deepEqual(askedV1.saveOptions, ['bash']);

const resolved = resolveOpenCodePermissionResolvedRequestId({
  type: 'permission.v2.replied',
  properties: {
    sessionID: 'ses_test',
    requestID: 'perm_test',
    reply: 'once',
  },
}, { opencodeSessionId: 'ses_test' });
assert.equal(resolved, 'perm_test');

assert.equal(isOpenCodePlanMutatingPermission(askedV2), true);
assert.equal(isOpenCodePlanMutatingPermission(askedV1), true);
assert.equal(isOpenCodePlanMutatingPermission({ action: 'Read file' }), false);
assert.equal(isOpenCodePlanMutatingPermission({ action: 'task' }), false);
assert.equal(isOpenCodePlanMutatingPermission({
  action: 'bash',
  metadata: { command: 'ls node_modules/@mdi/' },
}), false);
assert.equal(isOpenCodePlanMutatingPermission({
  action: 'bash',
  metadata: { command: 'node tests/conversation-fork.test.js' },
}), true);

const inputPlanRules = buildOpenCodePlanPermissionRuleset('plan');
const expectedPlanRules = [
  { permission: 'edit', pattern: '*', action: 'deny' },
  { permission: 'bash', pattern: '*', action: 'ask' },
];
assert.deepEqual(inputPlanRules, expectedPlanRules);
assert.equal(buildOpenCodePlanPermissionRuleset('agent')[0].action, 'ask');
assert.equal(shouldRejectOpenCodePlanPermission('plan', askedV2), true);
assert.equal(shouldRejectOpenCodePlanPermission('plan', askedV1), true);
assert.equal(shouldRejectOpenCodePlanPermission('agent', askedV2), false);
assert.equal(shouldRejectOpenCodePlanPermission('plan', { action: 'Read file' }), false);
assert.equal(shouldRejectOpenCodePlanPermission('agent', askedV2, 'review'), true);
assert.equal(
  shouldRejectOpenCodePlanPermission('agent', {
    action: 'bash',
    metadata: { command: 'node tests/conversation-fork.test.js' },
  }, 'review'),
  true,
);
assert.equal(
  shouldRejectOpenCodePlanPermission('agent', {
    action: 'bash',
    metadata: { command: 'node scripts/review-verify.js mcp-chat-history-format' },
  }, 'review'),
  false,
);
assert.equal(
  shouldRejectOpenCodePlanPermission('agent', {
    action: 'bash',
    metadata: { command: 'rm -rf tmp' },
  }, 'review'),
  true,
);
assert.equal(
  shouldRejectOpenCodePlanPermission('plan', {
    action: 'bash',
    metadata: { command: 'node tests/conversation-fork.test.js' },
  }),
  true,
);

assert.equal(shouldAutoAllowOpenCodeReviewPermission('agent', { action: 'Read file' }, 'review'), true);
assert.equal(shouldAutoAllowOpenCodeReviewPermission('agent', askedV2, 'review'), false);
assert.equal(shouldAutoAllowOpenCodeReviewPermission('agent', askedV1, 'review'), false);
assert.equal(
  shouldAutoAllowOpenCodeReviewPermission('agent', {
    action: 'bash',
    metadata: { command: 'ls node_modules/@mdi/' },
  }, 'review'),
  true,
);
assert.equal(shouldAutoAllowOpenCodeReviewPermission('agent', { action: 'Read file' }, 'implement'), false);
assert.equal(shouldAutoAllowOpenCodeDelegationPermission('agent', { action: 'Read file' }, 'implement'), true);
assert.equal(
  shouldAutoAllowOpenCodeDelegationPermission('agent', {
    action: 'bash',
    metadata: { command: 'rg -n "todo" .' },
  }, 'implement'),
  true,
);
assert.equal(
  shouldAutoAllowOpenCodeDelegationPermission('agent', {
    action: 'bash',
    metadata: { command: 'rm -rf data' },
  }, 'implement'),
  false,
);

const askedFromData = buildOpenCodePermissionSdkEvent({
  type: 'permission.v2.asked',
  properties: { extra: true },
  data: {
    id: 'per_data',
    sessionID: 'ses_test',
    action: 'bash',
    resources: ['ls'],
  },
}, { opencodeSessionId: 'ses_test' });
assert.ok(askedFromData);
assert.equal(askedFromData.requestId, 'per_data');

assert.equal(
  buildOpenCodePermissionSdkEvent({
    type: 'permission.v2.asked',
    properties: {
      id: 'perm_leak',
      sessionID: 'ses_other',
      action: 'Write file',
    },
  }, {}),
  null,
);

const originalFetch = globalThis.fetch;
/** @type {Array<{ url: string, init?: RequestInit }>} */
const fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  if (fetchCalls.length === 1) {
    return new Response(JSON.stringify({
      _tag: 'PermissionNotFoundError',
      requestID: 'per_0710aab7c001tNzSXJ7FmCltDr',
      message: 'Permission request not found: per_0710aab7c001tNzSXJ7FmCltDr',
    }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(null, { status: 204 });
};
try {
  await postOpenCodePermissionResponse({
    baseUrl: 'http://127.0.0.1:4096',
    requestId: 'per_0710aab7c001tNzSXJ7FmCltDr',
    sessionId: 'ses_f8ef57ab2ffe8vNtb0MDAa4EPv',
    directory: '/tmp/cretli-workspace',
    reply: 'once',
  });
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(fetchCalls.length, 2);
assert.match(fetchCalls[0].url, /\/api\/session\/ses_f8ef57ab2ffe8vNtb0MDAa4EPv\/permission\/per_0710aab7c001tNzSXJ7FmCltDr\/reply/);
assert.match(fetchCalls[0].url, /directory=/);
assert.equal(
  /** @type {Record<string, string>} */ (fetchCalls[0].init?.headers)?.['x-opencode-directory'],
  encodeURIComponent('/tmp/cretli-workspace'),
);
assert.match(fetchCalls[1].url, /\/permission\/per_0710aab7c001tNzSXJ7FmCltDr\/reply\?/);

const askedWithCommand = buildOpenCodePermissionSdkEvent({
  type: 'permission.v2.asked',
  properties: {
    id: 'per_cmd',
    sessionID: 'ses_test',
    action: 'bash',
    resources: ['ls', 'head -2'],
    metadata: {
      command: 'ls; head -2',
    },
  },
}, { opencodeSessionId: 'ses_test' });
assert.deepEqual(askedWithCommand?.resources, ['ls; head -2']);

const repliedFromRequestId = resolveOpenCodePermissionResolvedRequestId({
  type: 'permission.v2.replied',
  id: 'evt_not_the_permission',
  properties: { extra: true },
  data: {
    sessionID: 'ses_test',
    requestID: 'per_from_data',
    reply: 'once',
  },
}, { opencodeSessionId: 'ses_test' });
assert.equal(repliedFromRequestId, 'per_from_data');

const pending = new Map([
  ['per_bash', { action: 'bash', requestId: 'per_bash' }],
  ['per_edit', { action: 'edit', requestId: 'per_edit' }],
]);
assert.deepEqual(
  listOpenCodePermissionIdsForFailedTool(pending, { type: 'tool_call', name: 'bash', status: 'error' }),
  ['per_bash'],
);
assert.deepEqual(
  listOpenCodePermissionIdsForFailedTool(pending, { type: 'tool_call', name: 'bash', status: 'running' }),
  [],
);
assert.equal(isOpenCodeStaleSkillError(404, '{"_tag":"PermissionNotFoundError"}'), true);
assert.equal(isOpenCodeStaleSkillError(404, '{"_tag":"NotFoundError"}'), false);

fetchCalls.length = 0;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  return new Response(JSON.stringify({
    _tag: 'PermissionNotFoundError',
    requestID: 'per_gone',
    message: 'Permission request not found: per_gone',
  }), { status: 404, headers: { 'Content-Type': 'application/json' } });
};
try {
  await postOpenCodePermissionResponse({
    baseUrl: 'http://127.0.0.1:4096',
    requestId: 'per_gone',
    sessionId: 'ses_test',
    directory: '/tmp/cretli-workspace',
    reply: 'once',
  });
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(fetchCalls.length, 2);

// --- approval broker local policy (MVP) -----------------------------------

const brokerRead = { action: 'read', resources: ['src/app.js'] };
const brokerRm = { action: 'bash', metadata: { command: 'rm -rf data' } };
const brokerEdit = { action: 'edit', resources: ['src/app.js'] };
const brokerCurl = { action: 'bash', metadata: { command: 'curl https://example.com' } };
const brokerSecret = { action: 'bash', metadata: { command: 'cat .env' } };
const brokerWorkspace = process.cwd();

assert.equal(classifyOpenCodePermissionRisk(brokerCurl).categories.includes('network'), true);
assert.equal(classifyOpenCodePermissionRisk(brokerSecret).categories.includes('secrets'), true);
assert.equal(classifyOpenCodePermissionRisk(brokerRead).risk, 'low');

// default mode is off: interactive permissions stay on the manual card.
const defaultOff = resolveOpenCodeApprovalAction({
  sdkMode: 'agent',
  permissionEvent: brokerRead,
  assignment: '',
});
assert.equal(defaultOff.mode, 'off');
assert.equal(defaultOff.decision, 'ask_user');
assert.equal(defaultOff.reply, null);

// shadow computes a recommendation but never replies.
const shadow = resolveOpenCodeApprovalAction({
  mode: 'shadow',
  sdkMode: 'agent',
  permissionEvent: brokerRead,
  assignment: '',
  workspaceFolder: brokerWorkspace,
});
assert.equal(shadow.decision, 'allow');
assert.equal(shadow.reply, null);
assert.equal(shadow.shadow, true);

// local_reads allows only safe local reads, once, and never `always`.
const localRead = resolveOpenCodeApprovalAction({
  mode: 'local_reads',
  sdkMode: 'agent',
  permissionEvent: brokerRead,
  assignment: '',
  workspaceFolder: brokerWorkspace,
});
assert.equal(localRead.decision, 'allow');
assert.equal(localRead.reply, 'once');
assert.notEqual(localRead.reply, 'always');
const localLs = resolveOpenCodeApprovalAction({
  mode: 'local_reads',
  sdkMode: 'agent',
  permissionEvent: { action: 'bash', metadata: { command: 'rg -n "todo" .' } },
  assignment: '',
  workspaceFolder: brokerWorkspace,
});
assert.equal(localLs.reply, 'once');

// mutating / network / secret / edit paths never auto-reply.
for (const event of [brokerRm, brokerCurl, brokerSecret, brokerEdit]) {
  const action = resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: event,
    assignment: '',
    workspaceFolder: brokerWorkspace,
  });
  assert.equal(action.reply, null);
  assert.notEqual(action.reply, 'always');
  assert.equal(action.notifyUser, true);
}
assert.equal(
  resolveOpenCodeApprovalAction({ mode: 'local_reads', sdkMode: 'plan', permissionEvent: brokerRm, workspaceFolder: brokerWorkspace }).decision,
  'deny',
);
assert.equal(
  resolveOpenCodeApprovalAction({ mode: 'off', sdkMode: 'agent', permissionEvent: brokerRm, assignment: 'review' }).decision,
  'deny',
);
// Delegated implement children keep their one-shot read auto-allow.
assert.equal(
  resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: { action: 'bash', metadata: { command: 'ls -la' } },
    assignment: 'implement',
    workspaceFolder: brokerWorkspace,
  }).reply,
  'once',
);
// But a secret read for a delegated child stays on the card.
assert.equal(
  resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: brokerSecret,
    assignment: 'implement',
    workspaceFolder: brokerWorkspace,
  }).reply,
  null,
);
// Review keeps the host-owned verify runner allowed, arbitrary tests denied.
assert.equal(
  resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: { action: 'bash', metadata: { command: 'node scripts/review-verify.js delegation-contract' } },
    assignment: 'review',
    workspaceFolder: brokerWorkspace,
  }).reply,
  'once',
);
assert.equal(
  resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: { action: 'bash', metadata: { command: 'node tests/conversation-fork.test.js' } },
    assignment: 'review',
    workspaceFolder: brokerWorkspace,
  }).decision,
  'deny',
);

assert.equal(
  resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: { action: 'read', resources: ['/etc/passwd'] },
    assignment: '',
    workspaceFolder: brokerWorkspace,
  }).reply,
  null,
  'local_reads must not auto-approve reads outside the workspace',
);
assert.equal(
  resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: { action: 'read', resources: ['src/app.js'] },
    assignment: '',
    workspaceFolder: '/tmp/approval-workspace',
  }).reply,
  'once',
  'relative workspace resources resolve against the assigned workspace',
);

// --- off-mode workspace + secret gates -------------------------------------

// Delegated read auto-allow stays inside the assigned workspace.
const offReviewDiff = resolveOpenCodeApprovalAction({
  mode: 'off',
  sdkMode: 'agent',
  permissionEvent: { action: 'bash', metadata: { command: 'git diff --stat' } },
  assignment: 'review',
  workspaceFolder: brokerWorkspace,
});
assert.equal(offReviewDiff.decision, 'allow');
assert.equal(offReviewDiff.reply, 'once');

for (const command of ['cat /etc/passwd', 'cat /tmp/outside.txt']) {
  const offOutside = resolveOpenCodeApprovalAction({
    mode: 'off',
    sdkMode: 'agent',
    permissionEvent: { action: 'bash', metadata: { command } },
    assignment: 'review',
    workspaceFolder: brokerWorkspace,
  });
  assert.notEqual(offOutside.reply, 'once', `off must not auto-approve outside the workspace: ${command}`);
  assert.equal(offOutside.decision, 'ask_user');
}
assert.equal(
  resolveOpenCodeApprovalAction({
    mode: 'off',
    sdkMode: 'agent',
    permissionEvent: { action: 'read', resources: ['/etc/hostname'] },
    assignment: 'implement',
    workspaceFolder: brokerWorkspace,
  }).decision,
  'ask_user',
  'off must not auto-approve delegated reads outside the workspace',
);

// Cretli runtime secrets in data/ never get an auto-`once` in any mode.
const cretliConfig = { action: 'bash', metadata: { command: 'cat data/config.json' } };
const cretliMcpSecrets = { action: 'bash', metadata: { command: 'cat data/mcp-secrets.json' } };
assert.equal(classifyOpenCodePermissionRisk(cretliConfig).categories.includes('secrets'), true);
assert.equal(classifyOpenCodePermissionRisk(cretliMcpSecrets).categories.includes('secrets'), true);
for (const [mode, assignment] of [['off', 'implement'], ['local_reads', 'implement'], ['off', 'review'], ['shadow', '']]) {
  const action = resolveOpenCodeApprovalAction({
    mode,
    sdkMode: 'agent',
    permissionEvent: cretliConfig,
    assignment,
    workspaceFolder: brokerWorkspace,
  });
  assert.notEqual(action.reply, 'once', `data/config.json must not be auto-approved in ${mode}/${assignment}`);
  assert.notEqual(action.reply, 'always');
}

// --- shell suffixes and relative escapes ------------------------------------

// A shell separator directly after a Cretli secret path must not hide the
// `secrets` category, and must never produce an auto-`once`.
const secretSuffixCommands = [
  'cat data/config.json|head',
  'cat ./data/config.json',
  `cat ${brokerWorkspace}/data/config.json`,
  'grep key data/config.json',
  'rg token data/mcp-secrets.json',
  'head -5 data/config.json',
];
for (const command of secretSuffixCommands) {
  const event = { action: 'bash', metadata: { command } };
  assert.ok(
    classifyOpenCodePermissionRisk(event).categories.includes('secrets'),
    `expected secrets category for: ${command}`,
  );
  for (const mode of ['off', 'local_reads']) {
    const action = resolveOpenCodeApprovalAction({
      mode,
      sdkMode: 'agent',
      permissionEvent: event,
      assignment: 'review',
      workspaceFolder: brokerWorkspace,
    });
    assert.notEqual(action.reply, 'once', `${mode} must not auto-approve secrets: ${command}`);
  }
}

// Plain in-workspace reads (including a `..` that resolves back inside) keep
// the off-mode review auto-allow; no false alarms.
for (const command of ['git diff --stat lib/x.js', 'rg foo lib/', 'cat lib/../package.json']) {
  const action = resolveOpenCodeApprovalAction({
    mode: 'off',
    sdkMode: 'agent',
    permissionEvent: { action: 'bash', metadata: { command } },
    assignment: 'review',
    workspaceFolder: brokerWorkspace,
  });
  assert.equal(action.reply, 'once', `off review must still auto-approve: ${command}`);
}

// Relative tokens that climb outside the workspace need the user.
for (const command of ['cat ../other/secret.txt', 'cat lib/../../x', 'cd .. && cat other/secret.txt', 'ls ..']) {
  const action = resolveOpenCodeApprovalAction({
    mode: 'off',
    sdkMode: 'agent',
    permissionEvent: { action: 'bash', metadata: { command } },
    assignment: 'review',
    workspaceFolder: brokerWorkspace,
  });
  assert.equal(action.decision, 'ask_user', `off must not auto-approve outside the workspace: ${command}`);
  assert.notEqual(action.reply, 'once', `off must not auto-approve outside the workspace: ${command}`);
}

// Quoted text is search data, not a path argument: `grep -r 'foo' '../i18n'`
// is a within-workspace read even though the pattern spells `..`.
const quotedPatternRead = { action: 'bash', metadata: { command: "grep -r 'foo' '../i18n'" } };
assert.equal(
  isOpenCodePermissionWithinWorkspace(quotedPatternRead, brokerWorkspace),
  true,
  "quoted pattern '../i18n' is data, not an escaped path",
);
assert.equal(
  resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: quotedPatternRead,
    assignment: 'implement',
    workspaceFolder: brokerWorkspace,
  }).reply,
  'once',
  "local_reads must auto-approve a delegated read with a quoted '../' pattern",
);

// Unquoted relative escapes and absolute paths still leave the workspace.
for (const command of ['cat ../etc/shadow', 'cat /etc/passwd']) {
  const event = { action: 'bash', metadata: { command } };
  assert.equal(
    isOpenCodePermissionWithinWorkspace(event, brokerWorkspace),
    false,
    `must stay outside the workspace: ${command}`,
  );
  const action = resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: event,
    assignment: 'implement',
    workspaceFolder: brokerWorkspace,
  });
  assert.equal(action.decision, 'ask_user', `must ask the user: ${command}`);
  assert.equal(action.reply, null, `must not auto-reply: ${command}`);
}

// A nested shell runs its quoted argument, so there quotes are separators.
assert.equal(
  isOpenCodePermissionWithinWorkspace(
    { action: 'bash', metadata: { command: "bash -c 'cat ../etc/shadow'" } },
    brokerWorkspace,
  ),
  false,
  "bash -c 'cat ../etc/shadow' must stay outside the workspace",
);

// Globs, path spellings, env dumps and shell expansion never get an auto-once.
for (const command of [
  'cat data/conf*.json',
  'cat data/*.json',
  'cat data/./config.json',
  'git show HEAD:data/config.json',
  'env',
  'env | head',
  'cat $HOME/notes.txt',
  'cat $HOME/../x',
  'cd ${HOME}/.. && ls',
  'cat ~root/x',
  'env|head',
  'printenv|head',
  'git status; export',
  "cat 'data/'config.json",
  'cat data/"config.json"',
  'cat data/config\\.json',
  'cat DATA/*.json',
  'head {data/config.json,}',
  'cat data/{config,x}.json',
  'cat data/mcp-tx.json',
  'cat data/vapid-keys.json',
  'rg foo data/',
  'grep -rn key ./data',
  'ls ~',
  'cd data && cat config.json',
  'cd data&&head -n 40 config.json',
  "bash -c 'printenv'",
  'sh -c "env | head"',
  "echo 'x'; env",
  "rg 'a|b' lib | env",
  'echo "a\\"; env; echo \\"b"; printenv',
]) {
  for (const mode of ['off', 'local_reads']) {
    const action = resolveOpenCodeApprovalAction({
      mode,
      sdkMode: 'agent',
      permissionEvent: { action: 'bash', metadata: { command } },
      assignment: 'review',
      workspaceFolder: brokerWorkspace,
    });
    assert.notEqual(action.reply, 'once', `${mode} must not auto-approve: ${command}`);
  }
}

// A quoted search pattern is data, not a pipeline stage: `|export|` or `|kill|`
// inside quotes must not read as an env dump or a privilege command.
for (const command of [
  "rg -n 'memory-tools|watcher-tools|builtin' lib/mcp/builtin/*.js | rg -i 'register|export|tools' | head -20",
  'rg -n "export function startChatRun|export async function startChatRun" lib/chat-run-service.js | head',
  "grep -nE 'env|set|declare' lib/x.js",
  "rg 'sudo|kill|docker' lib/",
]) {
  const event = { action: 'bash', metadata: { command } };
  assert.deepEqual(classifyOpenCodePermissionRisk(event).categories, [], `expected no risk category for: ${command}`);
  for (const assignment of ['review', '']) {
    const action = resolveOpenCodeApprovalAction({
      mode: 'local_reads',
      sdkMode: 'agent',
      permissionEvent: event,
      assignment,
      workspaceFolder: brokerWorkspace,
    });
    assert.equal(action.reply, 'once', `local_reads must auto-approve quoted pattern read: ${command}`);
  }
}

for (const command of [
  'git log --oneline -5',
  'ls data/',
  'cat testdata/config.json',
  'git diff main..HEAD',
  'rg data lib/',
  'grep -rn "a..b" lib/',
  "rg -n 'foo$' lib/",
  'rg -n env lib/',
  'rg -n data app_front/data/',
]) {
  const action = resolveOpenCodeApprovalAction({
    mode: 'off',
    sdkMode: 'agent',
    permissionEvent: { action: 'bash', metadata: { command } },
    assignment: 'review',
    workspaceFolder: brokerWorkspace,
  });
  assert.equal(action.reply, 'once', `off review must still auto-approve: ${command}`);
}

// Escaped quotes break naive single-quote stripping; privilege/env must still flag.
const escapedPrivilege = { action: 'bash', metadata: { command: "echo \\'; sudo systemctl stop x; echo \\'" } };
const escapedEnv = { action: 'bash', metadata: { command: "echo \\'; env; echo \\'" } };
const escapedPrivRisk = classifyOpenCodePermissionRisk(escapedPrivilege);
const escapedEnvRisk = classifyOpenCodePermissionRisk(escapedEnv);
assert.ok(escapedPrivRisk.categories.includes('privilege'), 'escaped-quote sudo must be privilege');
assert.equal(escapedPrivRisk.risk, 'high');
assert.ok(escapedEnvRisk.categories.includes('secrets'), 'escaped-quote env must be secrets');
assert.equal(escapedEnvRisk.risk, 'high');
for (const event of [escapedPrivilege, escapedEnv]) {
  const action = resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: event,
    assignment: '',
    workspaceFolder: brokerWorkspace,
  });
  assert.notEqual(action.reply, 'once', `must not auto-approve: ${event.metadata.command}`);
  assert.equal(action.decision, 'ask_user');
}

console.log('opencode-permission.test.js OK');
