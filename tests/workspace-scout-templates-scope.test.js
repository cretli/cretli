/**
 * Stage 2 tests: Scout templates, profile-scoped signals/prompt/preview and the
 * host read-only policy.
 *
 * Covers:
 *   - the versioned template catalog and that materialize/restore never share
 *     mutable state with the catalog or with a stored profile;
 *   - `collectScoutSignalsForProfile` scope filtering (include/exclude globs,
 *     empty match => no full-repo scan) and source toggles while the dedup
 *     context stays mandatory;
 *   - `buildScoutPromptForProfile` for two different profiles;
 *   - `buildScoutPreview` without starting a model;
 *   - the host read-only gate: mutation/delegation denied, read/submit allowed;
 *   - the legacy general fallback (all six categories).
 *
 * Isolation: the first import points persist at a temp data dir; every
 * workspace and dataDir below lives in `os.tmpdir()`, never the real `data/`.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SCOUT_GENERAL_PROFILE_ID,
  WORKSPACE_SCOUT_CATEGORIES,
  defaultWorkspaceScoutProfile,
  normalizeWorkspaceScoutProfile,
} from '../lib/persist/workspace-watchers-persist.js';
import {
  SCOUT_TEMPLATE_CATALOG_VERSION,
  getScoutTemplate,
  listScoutTemplates,
  materializeProfileFromTemplate,
  restoreProfileInstructionsFromTemplate,
} from '../lib/workspace-scout-templates.js';
import {
  buildScoutPreview,
  buildScoutPromptForProfile,
  collectScoutSignalsForProfile,
  resolveEffectiveScoutConfig,
} from '../lib/workspace-watcher-scout.js';
import {
  SCOUT_READ_ONLY_MESSAGE,
  resolveScoutNativeToolDecision,
  resolveScoutReadOnlySdkEventDecision,
} from '../lib/workspace-scout-read-only.js';
import { isScoutProtocolToolCall } from '../lib/workspace-scout-chat.js';
import { resolvePlanModeToolDecision } from '../lib/sdk/sdk-plan-guard.js';
import { resolveSdkPlanCreateOptions } from '../lib/agent-harness/harness-plan-policy.js';
import { shouldRejectOpenCodePlanPermission } from '../lib/opencode/opencode-permission.js';
import { executeTool } from '../lib/agent-harness/tool-executor.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/builtin/catalog.js';
import { setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

let failed = 0;
/** @type {Promise<void>[]} */
const pending = [];

/**
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 */
function runCase(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(result.then(() => console.log('OK:', name), (err) => {
        failed += 1;
        console.error('FAIL:', name);
        console.error(err && err.stack ? err.stack : String(err));
      }));
      return;
    }
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-scout-stage2-'));
let counter = 0;

/**
 * @param {string} name
 * @returns {{ cwd: string, dataDir: string }}
 */
function freshWorkspace(name) {
  counter += 1;
  const cwd = path.join(tmpRoot, `${name}-${counter}`);
  fs.mkdirSync(cwd, { recursive: true });
  const dataDir = path.join(tmpRoot, `${name}-${counter}-data`);
  fs.mkdirSync(dataDir, { recursive: true });
  return { cwd, dataDir };
}

/**
 * A profile that differs from the defaults only where the case says so.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function scoutProfile(overrides = {}) {
  const base = defaultWorkspaceScoutProfile({
    id: 'p-base',
    name: 'Bazowy',
    objective: 'Analizuj ogólnie.',
    instructions: '',
  });
  return normalizeWorkspaceScoutProfile({ ...base, ...overrides }, { now: 0 });
}

/** Git stub with a resolvable base and a bounded name-only diff. */
function fakeGit(changedFiles) {
  return (args) => {
    if (args[0] === 'rev-parse') return 'a'.repeat(40);
    if (args[0] === 'diff' && args[1] === '--name-only') return changedFiles.join('\n');
    return '';
  };
}

/* ----------------------------------------------------------------- templates */

runCase('template catalog is versioned, complete and frozen', () => {
  assert.equal(SCOUT_TEMPLATE_CATALOG_VERSION, '1');
  const ids = listScoutTemplates().map((template) => template.id);
  for (const id of ['general', 'bugs', 'security', 'refactor', 'docs', 'performance']) {
    assert.ok(ids.includes(id), `catalog exposes ${id}`);
  }
  const general = getScoutTemplate('general');
  assert.equal(general.version, 1);
  assert.ok(general.objective.length > 0);
  assert.ok(Array.isArray(general.categories) && general.categories.length > 0);

  // Mutating a returned copy must not leak back into the catalog.
  general.scope.include.push('lib/**');
  general.categories.push('made-up');
  assert.deepEqual(getScoutTemplate('general').scope.include, []);
  assert.ok(!getScoutTemplate('general').categories.includes('made-up'));
});

runCase('materializeProfileFromTemplate returns an independent, disabled profile', () => {
  const first = materializeProfileFromTemplate('security', { id: 'sec-1' });
  const second = materializeProfileFromTemplate('security', { id: 'sec-2' });
  assert.equal(first.id, 'sec-1');
  assert.equal(first.templateId, 'security');
  assert.equal(first.templateVersion, '1');
  assert.equal(first.enabled, false);
  assert.equal(first.schedule.mode, 'manual');
  assert.deepEqual(first.categories, ['security']);

  // Deep independence: editing one copy cannot touch the other or the catalog.
  first.scope.include.push('lib/**');
  first.instructions = 'zmienione';
  assert.deepEqual(second.scope.include, []);
  assert.notEqual(second.instructions, 'zmienione');
  assert.deepEqual(getScoutTemplate('security').scope.include, []);
  assert.equal(materializeProfileFromTemplate('missing-template'), null);
});

runCase('restoreProfileInstructionsFromTemplate reports a diff and never mutates the input', () => {
  const profile = materializeProfileFromTemplate('docs', { id: 'docs-1' });
  const edited = { ...profile, instructions: 'moje własne instrukcje', objective: 'mój cel' };
  const restored = restoreProfileInstructionsFromTemplate(edited, { templateId: 'docs' });
  assert.equal(restored.ok, true);
  assert.ok(restored.diff.some((row) => row.field === 'instructions'));
  assert.ok(restored.diff.some((row) => row.field === 'objective'));
  assert.notEqual(restored.profile.instructions, 'moje własne instrukcje');
  assert.equal(restored.profile.instructions, getScoutTemplate('docs').instructions);
  // The caller's object stays untouched (the UI shows a diff before applying).
  assert.equal(edited.instructions, 'moje własne instrukcje');
  assert.equal(edited.objective, 'mój cel');

  const missing = restoreProfileInstructionsFromTemplate(edited, { templateId: 'nope' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'template_not_found');
});

runCase('resolveEffectiveScoutConfig marks template provenance and keeps the general fallback', () => {
  const materialized = materializeProfileFromTemplate('performance', { id: 'perf-1' });
  const config = resolveEffectiveScoutConfig(materialized);
  assert.equal(config.instructions.source, 'template');
  assert.equal(config.objective.source, 'template');
  assert.deepEqual(config.categories.value, materialized.categories);

  // Legacy general profile: no categories in the stored payload normalizes to
  // the full closed set, and the effective preview says so.
  const legacy = normalizeWorkspaceScoutProfile({ id: 'legacy', name: 'Legacy', objective: 'x' }, { now: 0 });
  assert.deepEqual(legacy.categories, [...WORKSPACE_SCOUT_CATEGORIES]);
  const generalConfig = resolveEffectiveScoutConfig(legacy);
  assert.deepEqual(generalConfig.categories.value, [...WORKSPACE_SCOUT_CATEGORIES]);
  const general = defaultWorkspaceScoutProfile();
  assert.deepEqual(resolveEffectiveScoutConfig(general).categories.value, [...WORKSPACE_SCOUT_CATEGORIES]);
});

/* ---------------------------------------------------------- scope & signals */

runCase('area scope include/exclude decides matchedFiles and markers', () => {
  const files = ['lib/orders/a.js', 'lib/orders/legacy/b.js', 'lib/other.js', 'docs/readme.md'];
  const profile = scoutProfile({
    id: 'orders',
    objective: 'Znajdź N+1 w zamówieniach.',
    scope: { mode: 'area', base: 'main', include: ['lib/orders/**'], exclude: ['lib/orders/legacy/**'] },
  });
  const signals = collectScoutSignalsForProfile(profile, { workspaceFolder: '/ws', dataDir: '/tmp' }, {
    listFiles: () => files,
    // Every file carries a marker; only in-scope files may surface.
    readFile: () => 'const x = 1; // TODO: fix\n',
  });
  assert.deepEqual(signals.matchedFiles, ['lib/orders/a.js']);
  assert.deepEqual(signals.changedFiles, ['lib/orders/a.js']);
  assert.ok(signals.markers.every((marker) => marker.startsWith('lib/orders/a.js:')));
  assert.ok(signals.hasFiles);
});

runCase('empty scope match never falls back to a full-repo scan', () => {
  const profile = scoutProfile({
    id: 'empty',
    objective: 'Nic nie pasuje.',
    scope: { mode: 'area', base: 'main', include: ['nope/**'], exclude: [] },
  });
  const signals = collectScoutSignalsForProfile(profile, { workspaceFolder: '/ws', dataDir: '/tmp' }, {
    listFiles: () => ['lib/a.js', 'lib/b.js', 'README.md'],
    execGit: () => 'SHOULD NOT BE USED',
  });
  assert.deepEqual(signals.matchedFiles, []);
  assert.equal(signals.hasFiles, false);
  assert.equal(signals.diff, '');
  assert.deepEqual(signals.markers, []);
});

runCase('source toggles gate git/tests/logs while dedup context is always included', () => {
  const profile = scoutProfile({
    id: 'markers-only',
    objective: 'Tylko markery.',
    sources: ['todoMarkers'],
    scope: { mode: 'changes', base: 'main', include: [], exclude: [] },
  });
  const watcher = {
    findings: { byTodo: { t1: { hash: 'h1', streak: 2, summary: 'Popraw logowanie' } } },
  };
  const signals = collectScoutSignalsForProfile(profile, { workspaceFolder: '/ws', dataDir: '/tmp', watcher }, {
    execGit: fakeGit(['lib/a.js']),
    readFile: () => '// FIXME: later\n',
    loadTodosData: () => ({ items: [{ id: 't1', title: 'Istniejące TODO', status: 'ready' }] }),
    listWorkspaceMemory: () => [{ type: 'finding', key: 'explored:auth', value: 'already explored auth' }],
  });
  assert.deepEqual(signals.sources, ['todoMarkers']);
  assert.equal(signals.diff, '');
  assert.equal(signals.log, '');
  assert.equal(signals.failingTests, '');
  assert.equal(signals.errorLogs, '');
  assert.equal(signals.markers.length, 1);
  // Mandatory dedup context is present regardless of `sources`.
  assert.equal(signals.existingTodos.length, 1);
  assert.equal(signals.priorFindings.length, 1);
  assert.equal(signals.memory.length, 1);
});

runCase('two profiles produce different prompts and contexts', () => {
  const files = ['lib/orders/a.js', 'lib/orders/legacy/b.js', 'docs/readme.md', 'lib/other.js'];
  const orders = scoutProfile({
    id: 'orders-2',
    name: 'Zapytania zamówień',
    objective: 'Znajdź N+1 i brakujące indeksy.',
    instructions: 'Każda propozycja wskazuje zapytanie i sposób pomiaru.',
    scope: { mode: 'area', base: 'main', include: ['lib/orders/**'], exclude: ['lib/orders/legacy/**'] },
  });
  const docs = scoutProfile({
    id: 'docs-2',
    name: 'Porządki w dokumentacji',
    objective: 'Uzupełnij brakującą dokumentację.',
    instructions: 'Wskaż plik kodu i brakującą sekcję.',
    scope: { mode: 'area', base: 'main', include: ['docs/**'], exclude: [] },
  });
  const deps = { listFiles: () => files };
  const ordersSignals = collectScoutSignalsForProfile(orders, { workspaceFolder: '/ws' }, deps);
  const docsSignals = collectScoutSignalsForProfile(docs, { workspaceFolder: '/ws' }, deps);
  const ordersPrompt = buildScoutPromptForProfile(orders, { workspaceFolder: '/ws', signals: ordersSignals });
  const docsPrompt = buildScoutPromptForProfile(docs, { workspaceFolder: '/ws', signals: docsSignals });

  assert.deepEqual(ordersSignals.matchedFiles, ['lib/orders/a.js']);
  assert.deepEqual(docsSignals.matchedFiles, ['docs/readme.md']);
  assert.notEqual(ordersPrompt, docsPrompt);
  assert.ok(ordersPrompt.includes('Znajdź N+1 i brakujące indeksy.'));
  assert.ok(ordersPrompt.includes('lib/orders/a.js'));
  assert.ok(docsPrompt.includes('Uzupełnij brakującą dokumentację.'));
  // The false PLAN-mode claim is gone; the read-only contract is host-enforced.
  assert.ok(!/PLAN mode/i.test(ordersPrompt));
  assert.ok(/host blocks/i.test(ordersPrompt));
});

runCase('preview returns effective config, prompt and blockers without starting a model', () => {
  const profile = scoutProfile({
    id: 'preview-1',
    objective: 'Podejrzyj bez startu.',
    scope: { mode: 'area', base: 'main', include: ['lib/**'], exclude: [] },
  });
  let runScoutCalls = 0;
  const preview = buildScoutPreview(profile, { workspaceFolder: '/ws', dataDir: '/tmp' }, {
    listFiles: () => ['lib/a.js'],
    runScout: async () => { runScoutCalls += 1; return { started: true }; },
  });
  assert.equal(runScoutCalls, 0);
  assert.equal(preview.modelStarted, false);
  assert.equal(preview.scoutId, 'preview-1');
  assert.ok(preview.prompt.length > 0);
  assert.deepEqual(preview.matchedFiles, ['lib/a.js']);
  assert.ok(preview.config.objective.source);
  assert.deepEqual(preview.blockers, []);

  const empty = buildScoutPreview(profile, { workspaceFolder: '/ws' }, { listFiles: () => [] });
  assert.ok(empty.blockers.some((blocker) => blocker.code === 'no_files_in_scope'));
});

/* ---------------------------------------------------- read-only enforcement */

runCase('native mutation and delegation are denied; reads are allowed', () => {
  assert.equal(resolveScoutNativeToolDecision({ toolName: 'read', args: { path: 'lib/a.js' } }).deny, false);
  assert.equal(resolveScoutNativeToolDecision({ toolName: 'grep', args: { pattern: 'x' } }).deny, false);
  assert.equal(
    resolveScoutNativeToolDecision({ toolName: 'bash', args: { command: 'git log --oneline -5' } }).deny,
    false,
  );
  assert.equal(
    resolveScoutNativeToolDecision({ toolName: 'bash', args: { command: 'rm -rf lib' } }).deny,
    true,
  );
  assert.equal(resolveScoutNativeToolDecision({ toolName: 'bash', args: { command: 'ls > out.txt' } }).deny, true);
  assert.equal(resolveScoutNativeToolDecision({ toolName: 'write', args: {} }).deny, true);
  assert.equal(resolveScoutNativeToolDecision({ toolName: 'apply_patch', args: {} }).deny, true);
  assert.equal(resolveScoutNativeToolDecision({ toolName: 'str_replace_editor', args: {} }).deny, true);
  assert.equal(resolveScoutNativeToolDecision({ toolName: 'delegation_start', args: {} }).deny, true);
  assert.equal(resolveScoutNativeToolDecision({ toolName: 'subagent', args: {} }).deny, true);
  assert.equal(resolveScoutNativeToolDecision({ toolName: 'task', args: {} }).deny, true);
  assert.equal(
    resolveScoutNativeToolDecision({ toolName: 'scout_findings', args: { action: 'submit' } }).deny,
    false,
  );
  assert.equal(
    resolveScoutNativeToolDecision({ toolName: 'scout_findings', args: { action: 'accept', id: 'x' } }).deny,
    true,
  );
  assert.equal(isScoutProtocolToolCall('mcp__cretli__scout_findings', { action: 'list' }), true);
});

runCase('production resolvePlanModeToolDecision matches scout read-only policy in agent mode', () => {
  const base = { transport: 'claude', mode: 'agent', scoutReadOnly: true };
  const deny = (toolName, input = {}) => resolvePlanModeToolDecision({ ...base, toolName, input }).deny;
  assert.equal(deny('Agent'), true);
  assert.equal(deny('todo_create'), true);
  assert.equal(deny('wmem_add', { text: 'x' }), true);
  assert.equal(deny('mcp__cretli__todo_create', { title: 'x' }), true);
  assert.equal(deny('read', { path: 'lib/a.js' }), false);
  assert.equal(deny('mcp__cretli__scout_findings', { action: 'list' }), false);
  assert.equal(deny('mcp__cretli__scout_findings', { action: 'submit', findings: [] }), false);
});

runCase('scout fail-closed: unknown Claude natives denied; reads and read-only MCP allowed', () => {
  const base = { transport: 'claude', mode: 'agent', scoutReadOnly: true };
  const decision = (toolName, input = {}) => resolvePlanModeToolDecision({ ...base, toolName, input });
  const denyNames = ['Monitor', 'EnterWorktree', 'CronCreate', 'RemoteTrigger', 'SendMessage'];
  for (const toolName of denyNames) {
    assert.equal(
      decision(toolName, { command: 'rm -rf x' }).deny,
      true,
      `expected deny for ${toolName}`,
    );
  }
  for (const toolName of ['Read', 'Grep', 'Glob', 'LS', 'WebFetch']) {
    assert.equal(decision(toolName, {}).deny, false, `expected allow for ${toolName}`);
  }
  assert.equal(decision('mcp__cretli__wmem_list', {}).deny, false);
  assert.equal(decision('mcp__cretli__todo_create', { title: 'x' }).deny, true);
  assert.equal(
    resolvePlanModeToolDecision({ transport: 'claude', mode: 'agent', toolName: 'Monitor', input: {} }).deny,
    false,
    'non-scout must not apply scout fail-closed policy',
  );
});

runCase('OpenCode scoutReadOnly rejects task and agent permissions', () => {
  assert.equal(
    shouldRejectOpenCodePlanPermission('agent', { action: 'task' }, undefined, { scoutReadOnly: true }),
    true,
  );
  assert.equal(
    shouldRejectOpenCodePlanPermission('agent', { action: 'agent' }, undefined, { scoutReadOnly: true }),
    true,
  );
  assert.equal(
    shouldRejectOpenCodePlanPermission('agent', { action: 'Read file' }, undefined, { scoutReadOnly: true }),
    false,
  );
});

runCase('area mode with empty include matches no files (not the whole repo)', () => {
  const profile = scoutProfile({
    scope: { mode: 'area', base: 'main', include: [], exclude: [] },
  });
  const files = ['lib/x.js', 'docs/readme.md', 'package.json'];
  const signals = collectScoutSignalsForProfile(profile, { workspaceFolder: '/ws' }, { listFiles: () => files });
  assert.deepEqual(signals.matchedFiles, []);
  assert.equal(signals.hasFiles, false);
  const preview = buildScoutPreview(profile, { workspaceFolder: '/ws' }, { listFiles: () => files });
  assert.ok(preview.blockers.some((blocker) => blocker.code === 'scope_requires_include'));
  assert.ok(preview.blockers.some((blocker) => blocker.code === 'no_files_in_scope'));
});

runCase('OpenRouter executor blocks writes when scoutReadOnly is set on context', async () => {
  const { cwd } = freshWorkspace('openrouter-scout-ro');
  fs.writeFileSync(path.join(cwd, 'keep.txt'), 'ok');
  const scoutCtx = { cwd, mode: 'agent', scoutReadOnly: true };
  const write = await executeTool('write_file', { path: 'nope.txt', content: 'x' }, scoutCtx);
  assert.equal(write.ok, false);
  assert.match(String(write.error || ''), /read-only/i);
  const read = await executeTool('read_file', { path: 'keep.txt' }, scoutCtx);
  assert.equal(read.ok, true);
});

runCase('SDK create options deny edit and shell for scoutReadOnly', () => {
  const opts = resolveSdkPlanCreateOptions('agent', undefined, { scoutReadOnly: true });
  assert.ok(Array.isArray(opts.disallowedTools) && opts.disallowedTools.length > 0);
  assert.ok(opts.disallowedTools.includes('edit'));
  assert.ok(opts.disallowedTools.includes('shell'));
});

runCase('scout SDK event decision blocks writes in technical agent mode', () => {
  const writeEvent = {
    type: 'tool_call',
    name: 'edit',
    status: 'running',
    args: { path: 'lib/a.js' },
  };
  const blocked = resolveScoutReadOnlySdkEventDecision(writeEvent);
  assert.equal(blocked.deny, true);
  assert.equal(blocked.abortRun, true);
  assert.match(String(blocked.reason || ''), /read-only/i);

  const readEvent = { type: 'tool_call', name: 'read', status: 'running', args: { path: 'lib/a.js' } };
  assert.equal(resolveScoutReadOnlySdkEventDecision(readEvent).deny, false);

  const submitEvent = {
    type: 'tool_call',
    name: 'mcp',
    status: 'running',
    args: { toolName: 'scout_findings', action: 'submit' },
  };
  assert.equal(resolveScoutReadOnlySdkEventDecision(submitEvent).deny, false);
});

runCase('builtin MCP tools deny mutation and allow read/submit for a Scout chat', async () => {
  const { cwd, dataDir } = freshWorkspace('readonly-mcp');
  setBuiltinMcpRuntimeDeps({ dataDir });
  addChat('scan-1', '[Scout] ws', null, cwd, 'test-model', {
    id: 'scout-chat',
    pickPurpose: 'scout',
  });
  const client = createInProcessMcpClient({ chatId: 'scout-chat', workspaceFolder: cwd });
  assert.equal(client.isWorkspaceScoutChat(), true);
  const handlers = createCretliMcpToolHandlers(client, {
    mode: 'agent',
    chatId: 'scout-chat',
    workspaceFolder: cwd,
  });

  const denied = await handlers.todo_create({ workspaceFolder: cwd, title: 'Nie wolno' });
  assert.equal(denied?.isError, true);
  assert.match(JSON.stringify(denied), /read-only/i);

  const deniedDelegation = await handlers.delegation_start({ workspaceFolder: cwd });
  assert.equal(deniedDelegation?.isError, true);

  // A read tool passes the Scout gate and reaches its handler.
  const listed = await handlers.todo_list({ workspaceFolder: cwd });
  assert.notEqual(listed?.isError, true);

  // The scan protocol action passes the gate too.
  const findings = await handlers.scout_findings({ action: 'list', workspaceFolder: cwd });
  assert.notEqual(findings?.isError, true);
  assert.equal(SCOUT_READ_ONLY_MESSAGE.includes('read-only'), true);
});

runCase('a non-scout chat is unaffected by the scout gate', async () => {
  const { cwd, dataDir } = freshWorkspace('readonly-human');
  setBuiltinMcpRuntimeDeps({ dataDir });
  addChat('scan-2', 'Zwykły chat', null, cwd, 'test-model', { id: 'human-chat' });
  const client = createInProcessMcpClient({ chatId: 'human-chat', workspaceFolder: cwd });
  assert.equal(client.isWorkspaceScoutChat(), false);
  const handlers = createCretliMcpToolHandlers(client, {
    mode: 'agent',
    chatId: 'human-chat',
    workspaceFolder: cwd,
  });
  const created = await handlers.todo_create({ workspaceFolder: cwd, title: 'Wolno' });
  // The same call is refused for a Scout chat; here it must not be the
  // read-only denial (any other validation outcome is fine).
  assert.ok(!JSON.stringify(created).includes('read-only'), 'non-scout call is not blocked by the scout gate');
  // The general profile id stays the deterministic legacy identity.
  assert.equal(SCOUT_GENERAL_PROFILE_ID, 'scout-general');
});

/* ------------------------------------------------------------------- finish */

Promise.all(pending).then(() => {
  removeIsolatedDataDir();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`\nworkspace scout stage 2 tests: ${failed} failure(s)`);
    process.exit(1);
  }
  console.log('\nworkspace scout stage 2 tests passed');
});
