import assert from 'node:assert/strict';
import { CRETILI_MCP_TOOL_DEFS } from '../lib/mcp/mcp-builtin-tools.js';
import { buildWorkspaceWatcherCyclePrompt } from '../lib/workspace-watcher-prompt.js';
import { SCOUT_PROTOCOL_TOOL, isScoutProtocolToolCall } from '../lib/workspace-scout-chat.js';
import {
  BUILTIN_PLAN_PROTOCOL_TOOLS,
  getBuiltinMcpMutatingTools,
  isMcpToolAllowedInPlan,
  isReadOnlyBuiltinMcpToolName,
  isReviewProtocolMcpToolName,
} from '../lib/mcp/mcp-policy.js';
import { resolveScoutNativeToolDecision } from '../lib/workspace-scout-read-only.js';
import {
  PLAN_PROTOCOL_TOOL_ACTIONS,
  createCretliMcpToolHandlers,
} from '../lib/mcp/builtin/catalog.js';
import {
  MCP_BUILTIN_TOOL_NAME_LIMIT,
  MCP_CRETILI_BRIDGE_PREFIX,
  MCP_TOOL_LEGACY_NAMES,
  isCretliBuiltinToolName,
  mcpBuiltinToolBridgeEncodedName,
  mcpBuiltinToolEncodedLength,
  resolveCretliBuiltinToolName,
  resolveMcpBuiltinToolName,
  simulateHarnessTruncatedEncodedName,
} from '../lib/mcp/mcp-tool-names.js';

const toolDefs = CRETILI_MCP_TOOL_DEFS;
const catalogNames = new Set(toolDefs.map((tool) => tool.name));
const defsByName = new Map(toolDefs.map((tool) => [tool.name, tool]));
const builtinServer = { kind: 'builtin-cretli' };

/**
 * (a) The guard is on the exported table itself, not on a Set built from it:
 * a duplicate `tool.name` would be silently dropped by `catalogNames`.
 */
assert.equal(
  toolDefs.length,
  new Set(toolDefs.map((tool) => tool.name)).size,
  'CRETILI_MCP_TOOL_DEFS contains a duplicate tool.name',
);

/**
 * (d) Segment budget derived from the real bridge prefix, never a hardcoded 46.
 * If the bridge runtime name or the inner server id changes, the budget moves.
 * `encodeMcpToolName` substitutes `tool` for an empty name, so the fixed prefix
 * is read off a one-character tool name instead of being spelled out here.
 */
const bridgePrefix = mcpBuiltinToolBridgeEncodedName('x').slice(0, -1);
assert.ok(bridgePrefix.startsWith(MCP_CRETILI_BRIDGE_PREFIX));
assert.ok(bridgePrefix.endsWith('__'));
const segmentBudget = MCP_BUILTIN_TOOL_NAME_LIMIT - bridgePrefix.length;
assert.ok(segmentBudget > 0, `bridge prefix already fills the ${MCP_BUILTIN_TOOL_NAME_LIMIT}-char cap`);

for (const def of toolDefs) {
  const encoded = mcpBuiltinToolBridgeEncodedName(def.name);
  assert.ok(
    encoded.length <= MCP_BUILTIN_TOOL_NAME_LIMIT,
    `${def.name} bridge encoded length ${encoded.length} > ${MCP_BUILTIN_TOOL_NAME_LIMIT}`,
  );
  assert.equal(mcpBuiltinToolEncodedLength(def.name), encoded.length);
  assert.ok(
    def.name.length <= segmentBudget,
    `${def.name} is ${def.name.length} chars, over the ${segmentBudget}-char segment budget`,
  );
  assert.ok(def.description, `${def.name} has no description to carry the canonical prefix`);
}

/**
 * The harness truncates only when the encoded name exceeds the cap, so below
 * the cap this loop proves full-name uniqueness (already covered by (a)). It
 * stays as the guard for a future name that does overflow and would be hashed
 * down to `head5_hash12`.
 */
/** @type {Map<string, string>} */
const truncatedByEncoded = new Map();
for (const name of catalogNames) {
  const encoded = mcpBuiltinToolBridgeEncodedName(name);
  const truncated = simulateHarnessTruncatedEncodedName(encoded);
  if (truncatedByEncoded.has(truncated)) {
    assert.fail(
      `truncated collision: ${truncatedByEncoded.get(truncated)} and ${name} both -> ${truncated}`,
    );
  }
  truncatedByEncoded.set(truncated, name);
}

/**
 * (b) The defect this rename had to kill: all five `workspace_*` tools shared
 * one head5 (`works`), so any head5-based truncation collapsed them together.
 * They must now split across exactly two distinct heads — `watch` for the
 * watcher pair, `wmem_` for the memory trio — and none may keep `works`.
 *
 * Head5 collisions *inside* a family are acceptable and are not asserted away:
 * `watcher_show`/`watcher_update` and `wmem_add`/`wmem_list`/`wmem_delete` are
 * readable families, and a name at or below the limit is never truncated, so a
 * global head5-uniqueness rule would be red without guarding anything real.
 * What families must keep is full-name uniqueness, already asserted by (a).
 */
const workspaceLegacyNames = Object.keys(MCP_TOOL_LEGACY_NAMES).filter((name) => name.startsWith('workspace_'));
assert.deepEqual(workspaceLegacyNames.slice().sort(), [
  'workspace_memory_add',
  'workspace_memory_delete',
  'workspace_memory_list',
  'workspace_watcher_show',
  'workspace_watcher_update',
]);
const workspaceCanonical = workspaceLegacyNames.map((name) => MCP_TOOL_LEGACY_NAMES[name]);
assert.equal(
  new Set(workspaceCanonical).size,
  workspaceCanonical.length,
  'two legacy workspace_* names collapse onto one canonical name',
);
for (const name of workspaceCanonical) {
  assert.notEqual(name.slice(0, 5), 'works', `${name} still shares the old works_* head5`);
}
const watcherHeads = workspaceCanonical
  .filter((name) => name.startsWith('watcher_'))
  .map((name) => name.slice(0, 5));
const memoryHeads = workspaceCanonical
  .filter((name) => name.startsWith('wmem_'))
  .map((name) => name.slice(0, 5));
assert.deepEqual([...new Set(watcherHeads)], ['watch']);
assert.deepEqual([...new Set(memoryHeads)], ['wmem_']);
assert.equal(watcherHeads.length, 2, 'expected the watcher pair to survive the rename');
assert.equal(memoryHeads.length, 3, 'expected the memory trio to survive the rename');
assert.equal(new Set([...watcherHeads, ...memoryHeads]).size, 2);
// A head5 collision inside one family is by design, so the measurable version of
// "no two names in the group collapse together" is a longer prefix: five characters
// are enough to separate every renamed tool, which is what a harness-side shortening
// would actually key on.
assert.equal(
  new Set(workspaceCanonical.map((name) => name.slice(0, 12))).size,
  workspaceCanonical.length,
  'two renamed workspace_* tools share a 12-character prefix',
);

/**
 * (c) Acceptance criterion: every renamed tool advertises the alias in its own
 * description, anchored at the start of the string (an `includes` check would
 * also pass on a mention buried in the body).
 */
for (const [legacy, canonical] of Object.entries(MCP_TOOL_LEGACY_NAMES)) {
  const def = defsByName.get(canonical);
  assert.ok(def, `missing catalog entry for ${canonical}`);
  assert.match(
    def.description,
    new RegExp(`^Canonical name: ${canonical} \\(formerly ${legacy}\\)\\. `),
    `${canonical} description must open with the canonical/alias sentence`,
  );
}

assert.equal(resolveMcpBuiltinToolName('workflow_update'), 'workflow_update');
assert.equal(resolveMcpBuiltinToolName('delegation_workflow_update'), 'workflow_update');
assert.equal(
  resolveMcpBuiltinToolName('mcp__cretli_bridge__mcp__cretli_builtincretl__workspace_memory_add'),
  'wmem_add',
);
const hashed = simulateHarnessTruncatedEncodedName(
  mcpBuiltinToolBridgeEncodedName('delegation_workflow_update'),
);
assert.match(hashed, /deleg_[a-f0-9]{12}$/);
assert.equal(resolveMcpBuiltinToolName(hashed), hashed.split('__').pop());

/**
 * Finding 1 regression: an alias must classify exactly like its canonical name
 * at every host gate that runs *before* the dispatch handler. Otherwise a read
 * alias (`wmem_list` under its old name) is rejected by the review/Scout gate
 * before its handler — which does know the alias — ever runs.
 */
const mutatingToolNames = new Set(getBuiltinMcpMutatingTools());
const planHandlers = createCretliMcpToolHandlers({}, { mode: 'plan' });

/**
 * @param {string} name
 * @returns {string}
 */
function fullShape(name) {
  return mcpBuiltinToolBridgeEncodedName(name);
}

for (const [legacy, canonical] of Object.entries(MCP_TOOL_LEGACY_NAMES)) {
  assert.ok(catalogNames.has(canonical), `missing canonical ${canonical} for legacy ${legacy}`);
  assert.equal(resolveMcpBuiltinToolName(legacy), canonical);
  const mutating = mutatingToolNames.has(canonical);
  // `scout_findings` is a Plan protocol tool; only a mutating action shows the
  // difference, so probe it the way the orchestrator prompt describes it.
  const scoutArgs = canonical === SCOUT_PROTOCOL_TOOL ? { action: 'accept' } : {};

  for (const [legacyName, canonicalName] of [
    [legacy, canonical],
    [fullShape(legacy), fullShape(canonical)],
  ]) {
    assert.equal(
      isReadOnlyBuiltinMcpToolName(legacyName),
      isReadOnlyBuiltinMcpToolName(canonicalName),
      `read-only classification differs between alias ${legacyName} and ${canonicalName}`,
    );
    assert.equal(
      isMcpToolAllowedInPlan(builtinServer, legacyName),
      isMcpToolAllowedInPlan(builtinServer, canonicalName),
      `Plan allow-list differs between alias ${legacyName} and ${canonicalName}`,
    );
    assert.equal(
      isReviewProtocolMcpToolName(legacyName),
      isReviewProtocolMcpToolName(canonicalName),
      `review protocol classification differs between alias ${legacyName} and ${canonicalName}`,
    );
    assert.equal(
      resolveScoutNativeToolDecision({ toolName: legacyName, args: scoutArgs }).deny,
      resolveScoutNativeToolDecision({ toolName: canonicalName, args: scoutArgs }).deny,
      `Scout deny differs between alias ${legacyName} and ${canonicalName}`,
    );
  }

  if (mutating) {
    // The gate must stay closed for the alias, not just the new name.
    for (const name of [legacy, fullShape(legacy), canonical, fullShape(canonical)]) {
      assert.equal(isReadOnlyBuiltinMcpToolName(name), false, `${name} must not read as read-only`);
      assert.equal(
        resolveScoutNativeToolDecision({ toolName: name, args: scoutArgs }).deny,
        true,
        `Scout must deny mutating ${name}`,
      );
    }
    for (const name of [legacy, canonical]) {
      const result = await planHandlers[name](scoutArgs, {});
      const text = result?.content?.[0]?.text || '';
      assert.match(text, /PLAN_MODE_DENIED/, `Plan mode must deny mutating ${name}: ${text}`);
    }
  } else {
    for (const name of [legacy, fullShape(legacy), canonical, fullShape(canonical)]) {
      assert.equal(isReadOnlyBuiltinMcpToolName(name), true, `${name} must read as read-only`);
      assert.equal(
        isMcpToolAllowedInPlan(builtinServer, name),
        true,
        `Plan mode must allow read tool ${name}`,
      );
      assert.equal(
        resolveScoutNativeToolDecision({ toolName: name, args: {} }).deny,
        false,
        `Scout must allow read tool ${name}`,
      );
    }
  }
}

/**
 * Review r2 finding (c): resolving an MCP basename is only safe for chains the
 * builtin catalog owns. `resolveMcpBuiltinToolName` cannot know the server, so
 * the gates use `resolveCretliBuiltinToolName`, which rejects a foreign runtime
 * that happens to expose a builtin basename. This was loose at HEAD 79b8329
 * (`mcp__github__todo_list` read as a builtin read tool) and is pinned here.
 * Harness name-mangling is tolerated: a chain may rewrite the middle of the
 * runtime (`mcp__cretli_bridge__mcp__cre___tincretl__…`) and stay owned.
 */
const ownedReadNames = [
  'wmem_list',
  'workspace_memory_list',
  'mcp__cretli_builtincretl__todo_list',
  'mcp__cretli_bridge__mcp__cretli_builtincretl__workspace_memory_list',
  'mcp__cretli_bridge__mcp__cre___tincretl__workspace_watcher_show',
];
for (const name of ownedReadNames) {
  assert.equal(isCretliBuiltinToolName(name), true, `${name} must be owned by the builtin catalog`);
  assert.equal(isReadOnlyBuiltinMcpToolName(name), true, `${name} must classify as read`);
  assert.equal(
    resolveScoutNativeToolDecision({ toolName: name, args: {} }).deny,
    false,
    `Scout must allow the owned read tool ${name}`,
  );
}

const foreignNames = [
  'mcp__github__todo_list',
  'mcp.acme.todo_list',
  'mcp/notion/chat_list',
  'mcp__cretli_bridge__mcp__cretli_4824fda0bfee__todo_list',
];
for (const name of foreignNames) {
  assert.equal(isCretliBuiltinToolName(name), false, `${name} belongs to another server`);
  assert.equal(resolveCretliBuiltinToolName(name), null, `${name} must not resolve to a builtin`);
  assert.equal(
    isReadOnlyBuiltinMcpToolName(name),
    false,
    `${name} must not classify as a builtin read tool`,
  );
  assert.equal(
    resolveScoutNativeToolDecision({ toolName: name, args: {} }).deny,
    true,
    `Scout is fail-closed for the external tool ${name}`,
  );
}

// A hashed tool segment cannot be resolved back, so it stays unread and denied;
// no fuzzy match is allowed here or a hash could be read as a builtin name.
const hashedName = 'mcp__cretli_bridge__mcp__cretli_builtincretl__works_a5ccd6d6b932';
assert.equal(isReadOnlyBuiltinMcpToolName(hashedName), false);
assert.equal(resolveScoutNativeToolDecision({ toolName: hashedName, args: {} }).deny, true);

const watcherCyclePromptInput = {
  workspaceFolder: '/tmp/ws',
  todo: { id: 'todo-1', title: 'Task' },
  policy: { requirePlanApproval: true },
  orchestrator: { harness: 'sdk', model: 'm', source: 'default' },
  allowedHarnesses: ['sdk'],
  blockedHarnesses: [],
  pickRoles: 'plan, implement, review',
};
const prompt = buildWorkspaceWatcherCyclePrompt(watcherCyclePromptInput);
const promptNonToolRefs = new Set([
  'pick_id',
  'pickId',
  'review',
  'ttl_ms',
  'requirePlanApproval',
  'findings_text',
  'approvedAt',
  'chat_history',
  'plan_markdown',
  'idempotency_key',
  // Rating tags, the rating source and the report acknowledgement flag are
  // prompt vocabulary, not MCP tool ids.
  'caught_bug',
  'missed_bug',
  'user',
  'unverified',
]);
const toolRefs = [...prompt.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((match) => match[1]);
for (const ref of toolRefs) {
  if (promptNonToolRefs.has(ref)) continue;
  assert.ok(catalogNames.has(ref), `prompt references unknown tool \`${ref}\``);
}
assert.match(prompt, /workflow_update/);
assert.match(prompt, /delegation_rate/);

/**
 * Finding 3: the cycle prompt is the only instruction an orchestrator model
 * reads, so the `workflow_update` sentence itself must name `role` and `round`.
 * Omitting `round` leaves the stored value (0) and a PASS forces it back to 0,
 * so the round cap never advances. Checked per branch: a sentence present only
 * in one of the two prompt shapes would otherwise slip through.
 */
for (const requirePlanApproval of [true, false]) {
  const branchPrompt = buildWorkspaceWatcherCyclePrompt({
    ...watcherCyclePromptInput,
    policy: { requirePlanApproval },
  });
  const workflowLines = branchPrompt
    .split('\n')
    .filter((line) => line.includes('workflow_update'));
  assert.equal(workflowLines.length, 1, `expected one workflow_update line (requirePlanApproval=${requirePlanApproval})`);
  const [workflowLine] = workflowLines;
  assert.match(workflowLine, /\bworkflow_update\b/, 'cycle prompt must name workflow_update');
  /**
   * Naming the fields is not enough: a model that sees only `round` in a list
   * omits it, and the server keeps the stored value (0) — so the round cap never
   * advances. The sentence must state the value of each field.
   */
  assert.match(
    workflowLine,
    /role\s*=\s*this step \(plan\|implement\|review\|fix\)/,
    'workflow_update line must define role as one of the four loop roles',
  );
  assert.match(
    workflowLine,
    /round\s*=\s*the 1-based number of the current implement\/fix cycle/,
    'workflow_update line must define round as the 1-based implement/fix cycle number',
  );
  assert.match(
    workflowLine,
    /increment it before every new implement or fix/,
    'workflow_update line must tell the orchestrator to increment round',
  );
}

assert.ok(BUILTIN_PLAN_PROTOCOL_TOOLS.has('scout_findings'));
assert.ok(PLAN_PROTOCOL_TOOL_ACTIONS.has('scout_findings'));
assert.equal(SCOUT_PROTOCOL_TOOL, 'scout_findings');
assert.equal(isScoutProtocolToolCall('scout_findings', { action: 'list' }), true);
assert.equal(isScoutProtocolToolCall('watcher_scout_findings', { action: 'submit' }), true);
assert.equal(
  isScoutProtocolToolCall('mcp__cretli__watcher_scout_findings', { action: 'list' }),
  true,
);

console.log('mcp-tool-names.test.js: ok');
