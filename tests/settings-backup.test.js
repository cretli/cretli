import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import net from 'node:net';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

// Any process start, socket or fetch from the import path is a failure.
let sideEffects = 0;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  cp[name] = () => { sideEffects += 1; throw new Error(`child_process.${name} must not run`); };
}
net.connect = () => { sideEffects += 1; throw new Error('net.connect must not run'); };
net.Socket.prototype.connect = () => { sideEffects += 1; throw new Error('socket connect must not run'); };
globalThis.fetch = () => { sideEffects += 1; throw new Error('fetch must not run'); };

const svc = await import('../lib/backup/settings-backup-service.js');
const classification = await import('../lib/backup/settings-classification.js');
const { registerSettingsBackupRoutes } = await import('../lib/routes/settings-backup-routes.js');
const { mutateMcpConfiguration, loadMcpDocument } = await import('../lib/persist/mcp-persist.js');
const { completeConfigWithWorkspaces } = await import('../lib/persist/settings.js');

const CONFIG = path.join(ISOLATED_DATA_DIR, 'config.json');
const SECRETS = path.join(ISOLATED_DATA_DIR, 'mcp-secrets.json');
const SECRET_VALUE = 'sk-live-super-secret-value-123456';
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const writeConfig = (value) => fs.writeFileSync(CONFIG, JSON.stringify(value, null, 2));
const reject = async (fn, code) => {
  await assert.rejects(Promise.resolve().then(fn), (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
  });
};

const baseConfig = () => ({
  autoTitle: { mode: 'continuous', provider: 'auto', source: 'both', model: 'm1' },
  chatAutoArchive: { enabled: true, idleValue: 5, idleUnit: 'days' },
  defaultNewChatHarness: 'claude',
  enabledHarnesses: ['claude', 'codex'],
  approvalBroker: { mode: 'shadow', advisor: { enabled: false, baseUrl: 'https://advisor.example.com/v1?api_key=abc', model: 'x' } },
  openrouterApiKey: SECRET_VALUE,
  claudeApiKey: 'sk-ant-another-secret-9999',
  codexBin: '/opt/tools/codex',
  mistralBaseUrl: 'https://llm.example.com/v1',
  lanHost: 'your-pc',
  frontHmrEnabled: true,
  unknownFutureKey: { a: 1 },
  workspaces: [{ id: 'ws-a', kind: 'file', workspaceFile: '/home/someone/a.code-workspace', label: 'Alpha' }],
  workspaceSidebarConfig: { 'ws-a': { enabled: true, label: 'Alpha', folder: '/home/someone/a' } },
});

// --- 1. Classified projection: no secrets, machine fields or unknown keys ---
writeConfig(baseConfig());
let doc = svc.buildSettingsDocument();
let text = JSON.stringify(doc);
assert.ok(!text.includes(SECRET_VALUE) && !text.includes('sk-ant-another'), 'secrets must not be exported');
assert.ok(!text.includes('abc'), 'URL query credentials must be dropped');
assert.ok(!text.includes('someone') && !text.includes('your-pc'), 'machine fields omitted by default');
const reasons = Object.fromEntries(doc.omissions.map((o) => [o.path, o.reason]));
assert.equal(reasons.openrouterApiKey, 'secret');
assert.equal(reasons.lanHost, 'machine');
assert.equal(reasons.unknownFutureKey, 'unclassified');
assert.equal(reasons.frontHmrEnabled, undefined, 'legacy HMR setting is omitted without a warning');
assert.equal(JSON.stringify(doc.sections).includes('frontHmrEnabled'), false, 'legacy HMR setting is not exported');
assert.deepEqual(classification.classifyConfigKey('frontHmrEnabled'), { class: 'ignored', section: null });
const ignoredLegacyImport = classification.sanitizeImportedSection('general', {
  frontHmrEnabled: true,
});
assert.deepEqual(ignoredLegacyImport, { values: {}, rejected: [] }, 'legacy HMR setting is silently ignored on import');
assert.equal(doc.sections.connections.codexBin, '/opt/tools/codex');
assert.equal(doc.sections.connections['approvalBroker.advisor.baseUrl'], 'https://advisor.example.com/v1');
assert.equal(doc.sections.approval.approvalBroker.advisor.baseUrl, undefined);
assert.equal(doc.sections.workspaces, undefined);

// Device preferences: allowlisted keys only.
doc = svc.buildSettingsDocument({ devicePreferences: { 'cretli-theme': 'light', 'cretli-lang': 'pl', 'cretli-theme-dark': 'custom-dark', 'cretli-theme-light': 'custom-light', 'cretli-theme-cache': 'ignored', other: 'x', 'cretli-session': 'tok' } });
assert.deepEqual(doc.devicePreferences, { 'cretli-theme': 'light', 'cretli-lang': 'pl', 'cretli-theme-dark': 'custom-dark', 'cretli-theme-light': 'custom-light' });

const themeSnapshot = svc.createSnapshot({ name: 'theme round trip', devicePreferences: doc.devicePreferences });
const themeDocument = svc.readSnapshot(themeSnapshot.snapshot.id).document;
const themePreview = svc.previewImport({ document: themeDocument });
assert.deepEqual(themePreview.devicePreferences, doc.devicePreferences);

// --- 2. Per-section round trip with secret preservation ---
for (const section of ['general', 'harnesses', 'approval']) {
  writeConfig(baseConfig());
  const saved = svc.createSnapshot({ name: `rt ${section}` });
  assert.equal(saved.status, 'saved');
  assert.equal(saved.durability.fileFsync, true);
  assert.ok(Array.isArray(saved.durability.limitations));
  const mutated = baseConfig();
  mutated.autoTitle.mode = 'off';
  mutated.chatAutoArchive.idleValue = 99;
  mutated.defaultNewChatHarness = 'sdk';
  mutated.enabledHarnesses = ['sdk'];
  mutated.approvalBroker.mode = 'off';
  mutated.openrouterApiKey = 'sk-destination-key-keep-me-1234';
  writeConfig(mutated);
  const snap = svc.readSnapshot(saved.snapshot.id);
  const preview = svc.previewImport({ document: snap.document });
  assert.ok(preview.sections.find((s) => s.id === section), `preview has ${section}`);
  const result = await svc.applyImport({ previewId: preview.previewId, sections: [section] });
  assert.equal(result.ok, true);
  const after = readConfig();
  assert.equal(after.openrouterApiKey, 'sk-destination-key-keep-me-1234', 'destination credential preserved');
  assert.equal(after.codexBin, '/opt/tools/codex');
  if (section === 'general') {
    assert.equal(after.autoTitle.mode, 'continuous');
    assert.equal(after.chatAutoArchive.idleValue, 5);
    assert.equal(after.defaultNewChatHarness, 'sdk', 'other sections untouched');
  }
  if (section === 'harnesses') {
    assert.equal(after.defaultNewChatHarness, 'claude');
    assert.deepEqual(after.enabledHarnesses, ['claude', 'codex']);
    assert.equal(after.autoTitle.mode, 'off');
  }
  if (section === 'approval') {
    assert.equal(after.approvalBroker.mode, 'shadow');
    assert.equal(after.defaultNewChatHarness, 'sdk');
  }
  assert.ok(result.backups.snapshotId && result.backups.recoveryCopy, 'pre-import backups reported');
  // Verified raw recovery copy keeps the destination secret for rollback.
  const copy = fs.readFileSync(path.join(ISOLATED_DATA_DIR, 'settings-recovery', result.backups.recoveryCopy), 'utf8');
  assert.ok(copy.includes('sk-destination-key-keep-me-1234'));
}

// --- 3. Hostile document: injected secrets / unknown keys never reach config ---
writeConfig(baseConfig());
doc = svc.buildSettingsDocument();
doc.sections.general.openrouterApiKey = 'sk-injected-evil-0000000000';
doc.sections.general.evilKey = 'x';
doc.sections.general.autoTitle = { mode: 'off', nested: { apiKey: 'sk-nested-evil-00000000' } };
doc.sections.approval.approvalBroker.advisor = { baseUrl: 'https://evil.example.com', enabled: true };
let preview = svc.previewImport({ document: doc });
const generalPreview = preview.sections.find((s) => s.id === 'general');
assert.ok(generalPreview.rejected.some((r) => r.path === 'openrouterApiKey' && r.reason === 'secret'));
assert.ok(generalPreview.rejected.some((r) => r.path === 'evilKey'));
await svc.applyImport({ previewId: preview.previewId, sections: ['general', 'approval'] });
let cfg = readConfig();
assert.equal(cfg.openrouterApiKey, SECRET_VALUE);
assert.equal(cfg.evilKey, undefined);
assert.equal(JSON.stringify(cfg.autoTitle).includes('nested-evil'), false);
assert.equal(cfg.approvalBroker.advisor.baseUrl, 'https://advisor.example.com/v1?api_key=abc', 'endpoint URL not imported via approval section');
assert.equal(JSON.stringify(cfg).includes('evil.example.com'), false);

// Invalid / unsupported documents fail before any write.
await reject(() => svc.previewImport({ document: { profile: 'portable-settings-v1' } }), 'INVALID_DOCUMENT');
await reject(() => svc.previewImport({ document: { ...svc.buildSettingsDocument(), manifestFormatVersion: 2 } }), 'INVALID_DOCUMENT');

// --- 4. Connections stay pending until explicit activation ---
writeConfig(baseConfig());
doc = svc.buildSettingsDocument();
doc.sections.connections.codexBin = '/opt/other/codex';
doc.sections.connections.mistralBaseUrl = 'https://new.example.com/v1';
preview = svc.previewImport({ document: doc });
const conn = preview.sections.find((s) => s.id === 'connections');
assert.ok(conn.entries.filter((e) => e.status === 'changed').every((e) => e.requiresActivation && e.startsDisabled));
const connResult = await svc.applyImport({ previewId: preview.previewId, sections: ['connections'] });
assert.deepEqual(new Set(connResult.pendingActivation), new Set(Object.keys(doc.sections.connections)));
assert.equal(readConfig().codexBin, '/opt/tools/codex', 'config definition not activated by import');
assert.ok(svc.readPending().items.some((i) => i.key === 'codexBin' && i.value === '/opt/other/codex'));
await reject(() => svc.activatePending({ keys: ['codexBin'], confirm: false }), 'CONFIRM_REQUIRED');
await reject(() => svc.activatePending({ keys: ['nope'], confirm: true }), 'NOT_FOUND');
const activated = await svc.activatePending({ keys: ['codexBin'], confirm: true });
assert.deepEqual(activated.activated, ['codexBin']);
assert.equal(readConfig().codexBin, '/opt/other/codex');
assert.ok(!svc.readPending().items.some((i) => i.key === 'codexBin'));

// --- 5. MCP: definitions imported disabled, env/headers/secrets never travel ---
fs.rmSync(path.join(ISOLATED_DATA_DIR, 'mcp.json'), { force: true });
let rev = loadMcpDocument().revision;
await mutateMcpConfiguration(rev, () => ({
  servers: [
    { id: 'tool-a', name: 'Tool A', kind: 'external', enabled: true, scope: 'all', harnesses: [], transport: 'stdio',
      connection: { command: 'node', args: ['server.js', '--token=sk-arg-secret-0000000000'], cwd: '', env: { API_KEY: 'plain-env-secret' } }, toolPolicy: { allowInPlan: [] } },
    { id: 'tool-b', name: 'Tool B', kind: 'external', enabled: true, scope: 'all', harnesses: [], transport: 'http',
      connection: { url: 'https://user:pw@mcp.example.com/sse?token=zzz', headers: { Authorization: 'Bearer abc' } }, toolPolicy: { allowInPlan: [] } },
  ],
  secrets: { 'tool-a': { API_KEY: 'stored-secret-value' } },
}));
const secretsBefore = fs.readFileSync(SECRETS, 'utf8');
const mcpDoc = svc.buildSettingsDocument();
text = JSON.stringify(mcpDoc);
for (const leak of ['plain-env-secret', 'stored-secret-value', 'sk-arg-secret', 'Bearer abc', 'user:pw', 'zzz']) {
  assert.ok(!text.includes(leak), `MCP export leaked ${leak}`);
}
assert.deepEqual(mcpDoc.sections.mcp.servers.find((s) => s.id === 'tool-a').connection.envKeys, ['API_KEY']);
// Mutate destination: tool-a definition drifts and tool-b is removed; a new server arrives via the doc.
mcpDoc.sections.mcp.servers.push({ id: 'tool-c', name: 'Tool C', transport: 'stdio', connection: { command: 'evil-binary', args: ['--run'], cwd: '' } });
mcpDoc.sections.mcp.servers.find((s) => s.id === 'tool-a').connection.command = 'node-changed';
preview = svc.previewImport({ document: mcpDoc });
const mcpPreview = preview.sections.find((s) => s.id === 'mcp');
const byKey = Object.fromEntries(mcpPreview.entries.map((e) => [e.key, e]));
assert.equal(byKey['tool-a'].status, 'changed');
assert.equal(byKey['tool-b'].status, 'unchanged');
assert.equal(byKey['tool-c'].status, 'added');
assert.equal(byKey['tool-c'].after.connection.command, 'evil-binary', 'preview shows the definition');
const mcpResult = await svc.applyImport({ previewId: preview.previewId, sections: ['mcp'] });
assert.equal(mcpResult.ok, true);
const servers = Object.fromEntries(loadMcpDocument().servers.map((s) => [s.id, s]));
assert.equal(servers['tool-c'].enabled, false, 'new definition starts disabled');
assert.equal(servers['tool-a'].enabled, false, 'changed definition of an installed server is disabled');
assert.equal(servers['tool-a'].connection.command, 'node-changed');
assert.equal(servers['tool-a'].connection.env.API_KEY, 'plain-env-secret', 'existing env untouched');
assert.equal(servers['tool-b'].enabled, true, 'unchanged definition left alone');
assert.equal(fs.readFileSync(SECRETS, 'utf8').includes('stored-secret-value'), true, 'secrets preserved');
assert.equal(JSON.parse(fs.readFileSync(SECRETS, 'utf8')).secrets['tool-a'].API_KEY, 'stored-secret-value');
void secretsBefore;

// --- 6. Concurrent modification: CAS conflict requires a new preview ---
writeConfig(baseConfig());
doc = svc.buildSettingsDocument();
doc.sections.general.autoTitle.mode = 'off';
const p1 = svc.previewImport({ document: doc });
fs.appendFileSync(CONFIG, '\n'); // byte-level change that JSON equality would miss
const beforeBytes = fs.readFileSync(CONFIG);
await reject(() => svc.applyImport({ previewId: p1.previewId, sections: ['general'] }), 'PREVIEW_STALE');
assert.deepEqual(fs.readFileSync(CONFIG), beforeBytes, 'stale apply wrote nothing');
await reject(() => svc.applyImport({ previewId: p1.previewId, sections: ['general'] }), 'PREVIEW_NOT_FOUND');
const p2 = svc.previewImport({ document: doc });
// Modification landing between preview and the locked CAS read (simulated via hook).
await reject(() => svc.applyImport({
  previewId: p2.previewId, sections: ['general'],
  beforeCas: () => writeConfig({ ...baseConfig(), debugApi: true }),
}), 'PREVIEW_STALE');
assert.equal(readConfig().debugApi, true);
assert.equal(readConfig().autoTitle.mode, 'continuous');
// Two previews of the same state: the first apply invalidates the second.
const pa = svc.previewImport({ document: doc });
const pb = svc.previewImport({ document: doc });
const [ra, rb] = await Promise.allSettled([
  svc.applyImport({ previewId: pa.previewId, sections: ['general'] }),
  svc.applyImport({ previewId: pb.previewId, sections: ['general'] }),
]);
assert.equal(ra.status, 'fulfilled');
assert.equal(rb.status, 'rejected');
assert.equal(rb.reason.code, 'PREVIEW_STALE');
await reject(() => svc.applyImport({ previewId: 'missing', sections: ['general'] }), 'PREVIEW_NOT_FOUND');
const p3 = svc.previewImport({ document: doc });
await reject(() => svc.applyImport({ previewId: p3.previewId, sections: [] }), 'VALIDATION');
await reject(() => svc.applyImport({ previewId: p3.previewId, sections: ['workspaces'] }), 'VALIDATION');

// MCP revision CAS.
const pm = svc.previewImport({ document: svc.buildSettingsDocument() });
await mutateMcpConfiguration(loadMcpDocument().revision, (s) => ({ servers: s.servers, secrets: s.secrets }));
await reject(() => svc.applyImport({ previewId: pm.previewId, sections: ['mcp'] }), 'PREVIEW_STALE');

// --- 7. Snapshot write failure never reports success ---
writeConfig(baseConfig());
const snapDir = path.join(ISOLATED_DATA_DIR, 'settings-snapshots');
const countSnaps = () => (fs.existsSync(snapDir) ? fs.readdirSync(snapDir).length : 0);
const baseline = countSnaps();
for (const method of ['fsyncSync', 'renameSync', 'writeSync']) {
  const broken = { ...fs, [method]: (...args) => {
    if (method === 'fsyncSync' && args[0] === undefined) return undefined;
    throw Object.assign(new Error(`${method} failed`), { code: 'EIO' });
  } };
  await reject(() => svc.createSnapshot({ name: `fail ${method}`, fsImpl: broken }), 'SNAPSHOT_WRITE_FAILED');
  assert.equal(countSnaps(), baseline, `${method}: nothing published, temp files cleaned`);
}
// Read-back mismatch (silent corruption) is also an error.
const lying = { ...fs, writeSync: (fd, buf, ...rest) => fs.writeSync(fd, Buffer.from(buf.toString().replace('"name"', '"nome"')), ...rest) };
await reject(() => svc.createSnapshot({ name: 'liar', fsImpl: lying }), 'SNAPSHOT_WRITE_FAILED');
assert.equal(countSnaps(), baseline);
// Unsupported directory fsync is reported as a limitation, not hidden and not fatal.
const noDirSync = { ...fs, openSync: (p, flags, ...rest) => {
  if (flags === 'r') throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
  return fs.openSync(p, flags, ...rest);
} };
const limited = svc.createSnapshot({ name: 'limited', fsImpl: noDirSync });
assert.equal(limited.status, 'saved');
assert.equal(limited.durability.directoryFsync, false);
assert.ok(limited.durability.limitations.length > 0);
const full = svc.createSnapshot({ name: 'full' });
assert.equal(full.durability.directoryFsync, process.platform !== 'win32' ? true : full.durability.directoryFsync);
// Failed pre-import backup aborts before any mutation.
writeConfig(baseConfig());
doc = svc.buildSettingsDocument();
doc.sections.general.autoTitle.mode = 'off';
const pf = svc.previewImport({ document: doc });
const cfgBefore = fs.readFileSync(CONFIG);
await reject(() => svc.applyImport({
  previewId: pf.previewId, sections: ['general'],
  fsImpl: { ...fs, fsyncSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } },
}), 'PRE_IMPORT_BACKUP_FAILED');
assert.deepEqual(fs.readFileSync(CONFIG), cfgBefore, 'config untouched when backup fails');
// Name validation and corrupt-file reporting.
await reject(() => svc.createSnapshot({ name: '   ' }), 'VALIDATION');
await reject(() => svc.createSnapshot({ name: 'x'.repeat(81) }), 'VALIDATION');
fs.writeFileSync(path.join(snapDir, 's-zzzz-deadbeef.json'), '{not json');
const listed = svc.listSnapshots();
assert.ok(listed.corrupt.some((c) => c.file === 's-zzzz-deadbeef.json'));
assert.ok(listed.snapshots.some((s) => s.name === 'full'));
await reject(() => svc.readSnapshot('s-zzzz-deadbeef'), 'SNAPSHOT_CORRUPT');
await reject(() => svc.readSnapshot('../../etc/passwd'), 'VALIDATION');
await reject(() => svc.readSnapshot('s-aaaa-00000000'), 'NOT_FOUND');
// Corrupt config.json is a hard error, never an empty export.
fs.writeFileSync(CONFIG, '{broken');
await reject(() => svc.buildSettingsDocument(), 'CONFIG_CORRUPT');
writeConfig(baseConfig());

// --- 8. Workspace mapping ---
doc = svc.buildSettingsDocument({ includeMachine: true });
assert.ok(!JSON.stringify(doc).includes('someone'), 'no local paths in the export');
assert.deepEqual(doc.sections.workspaces.workspaces, [{ id: 'ws-a', kind: 'file', label: 'Alpha' }]);
doc.sections.workspaces.workspaces.push({ id: 'ws-b', kind: 'folders', label: 'Beta' }, { id: 'ws-c', kind: 'folders' });
const pw = svc.previewImport({ document: doc });
assert.ok(pw.sections.find((s) => s.id === 'workspaces').machine);
writeConfig({ ...baseConfig(), workspaces: [], workspaceSidebarConfig: {} });
// Preview was taken on the old bytes -> stale; take a fresh one.
await reject(() => svc.applyImport({ previewId: pw.previewId, sections: ['workspaces'] }), 'PREVIEW_STALE');
const pw2 = svc.previewImport({ document: doc });
const wsResult = await svc.applyImport({
  previewId: pw2.previewId, sections: ['workspaces'],
  workspaceMapping: { 'ws-a': '/mnt/new/a.code-workspace', 'ws-b': 'relative/path', 'ws-c': null },
});
const wsDetail = wsResult.results[0].detail;
assert.deepEqual(wsDetail.applied, ['ws-a']);
assert.deepEqual(wsDetail.invalid, ['ws-b']);
assert.deepEqual(wsDetail.unmapped, ['ws-c']);
// The workspace registry lives in SQL (store.workspaces), not in config.json.
assert.equal(readConfig().workspaces, undefined);
assert.equal(completeConfigWithWorkspaces(readConfig()).workspaces[0].workspaceFile, '/mnt/new/a.code-workspace');

// --- 9. Routes: admin only, error shape, no fake success ---
const routes = new Map();
const reg = (method) => (p, fn) => routes.set(`${method} ${p}`, fn);
registerSettingsBackupRoutes({ get: reg('GET'), post: reg('POST'), delete: reg('DELETE') });
const call = async (method, route, req = {}) => {
  let status = 200; let body; const headers = {};
  const res = { status(c) { status = c; return this; }, json(d) { body = d; return this; }, setHeader(k, v) { headers[k] = v; } };
  await routes.get(`${method} ${route}`)({ params: {}, query: {}, body: {}, ...req }, res);
  return { status, body, headers };
};
assert.equal((await call('GET', '/api/settings-backup/snapshots', { widgetAccess: { installationId: 'w' } })).status, 403);
assert.equal((await call('POST', '/api/settings-backup/apply', { mcpIntegration: {} })).status, 403);
const made = await call('POST', '/api/settings-backup/snapshots', { body: { name: 'via route' } });
assert.equal(made.status, 200);
assert.equal(made.body.status, 'saved');
const dl = await call('GET', '/api/settings-backup/snapshots/:id', { params: { id: made.body.snapshot.id } });
assert.equal(dl.body.profile, 'portable-settings-v1');
assert.ok(dl.headers['Content-Disposition'].includes(made.body.snapshot.id));
assert.equal((await call('GET', '/api/settings-backup/snapshots/:id', { params: { id: '../x' } })).status, 400);
assert.equal((await call('POST', '/api/settings-backup/snapshots', { body: { name: '' } })).status, 400);
const prev = await call('POST', '/api/settings-backup/preview', { body: { snapshotId: made.body.snapshot.id } });
assert.equal(prev.status, 200);
const stale = await call('POST', '/api/settings-backup/apply', { body: { previewId: 'nope', sections: ['general'] } });
assert.equal(stale.status, 410);
assert.equal(stale.body.status, 'error');
assert.equal((await call('POST', '/api/settings-backup/preview', { body: { document: { profile: 'x' } } })).status, 400);
assert.equal((await call('DELETE', '/api/settings-backup/snapshots/:id', { params: { id: made.body.snapshot.id } })).status, 200);
const caps = await call('GET', '/api/settings-backup/capabilities');
assert.deepEqual(caps.body.devicePreferenceAllowlist, ['cretli-theme', 'cretli-theme-dark', 'cretli-theme-light', 'cretli-lang']);

// --- 10. Zero execution / probe / push from imported definitions ---
assert.equal(sideEffects, 0, 'import/export/activate must not start processes or open connections');

console.log('settings-backup tests passed');
