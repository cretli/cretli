/**
 * Scout profile API tests (stage 4a).
 *
 * Exercises the control/REST surface the settings UI and MCP clients share:
 * create/list/get, revision CAS updates, duplicate, archive, preview, bounded
 * history (no submit token), the `scoutId` findings filter, workspace isolation
 * and that the legacy `/api/workspace-watcher/scout` list/submit surface still
 * behaves as before.
 *
 * Isolation: the first import points persist at a temp data dir; every
 * workspace lives under `os.tmpdir()`.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs, { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTodosData } from '../lib/persist/todos-persist.js';
import {
  SCOUT_GENERAL_PROFILE_ID,
  getWorkspaceWatcher,
  mutateWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import { materializeProfileFromTemplate } from '../lib/workspace-scout-templates.js';
import { registerWorkspaceWatcherRoutes } from '../lib/routes/workspace-watcher-routes.js';
import { WATCHER_MCP_TOOLS } from '../lib/mcp/builtin/watcher-tools.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

let failed = 0;
/** @type {Array<{ name: string, fn: Function }>} */
const cases = [];

function runCase(name, fn) {
  cases.push({ name, fn });
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cr-scout-profiles-api-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });

let wsCounter = 0;
/**
 * @param {string} name
 * @returns {string}
 */
function freshWorkspace(name) {
  wsCounter += 1;
  const folder = path.join(tmpRoot, `${name}-${wsCounter}`);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

/**
 * @returns {{ invoke: (method: string, urlPath: string, req?: object) => Promise<{status: number, body: object}> }}
 */
function makeApp() {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const app = {
    get(p, fn) { handlers.set(`GET ${p}`, fn); },
    post(p, fn) { handlers.set(`POST ${p}`, fn); },
    patch(p, fn) { handlers.set(`PATCH ${p}`, fn); },
    delete(p, fn) { handlers.set(`DELETE ${p}`, fn); },
  };
  registerWorkspaceWatcherRoutes(app, { dataDir, getCurrentCwd: () => process.cwd() });

  /**
   * Resolve a handler by exact path first, then by `:param` pattern so a test
   * can call the API with a real profile id (mirroring the browser client).
   *
   * @param {string} method
   * @param {string} urlPath
   * @returns {{ fn: Function, params: Record<string, string> } | null}
   */
  function resolveHandler(method, urlPath) {
    const direct = handlers.get(`${method} ${urlPath}`);
    if (direct) return { fn: direct, params: {} };
    const pathParts = urlPath.split('/');
    for (const [key, fn] of handlers) {
      const spaceAt = key.indexOf(' ');
      if (spaceAt < 0) continue;
      if (key.slice(0, spaceAt) !== method) continue;
      const pattern = key.slice(spaceAt + 1);
      if (!pattern.includes(':')) continue;
      const patternParts = pattern.split('/');
      if (patternParts.length !== pathParts.length) continue;
      /** @type {Record<string, string>} */
      const params = {};
      let matched = true;
      for (let index = 0; index < patternParts.length; index += 1) {
        const segment = patternParts[index];
        if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(pathParts[index]);
        else if (segment !== pathParts[index]) { matched = false; break; }
      }
      if (matched) return { fn, params };
    }
    return null;
  }

  const invoke = (method, urlPath, req = {}) => {
    const resolved = resolveHandler(method, urlPath);
    if (!resolved) throw new Error(`no handler ${method} ${urlPath}`);
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ status: this.statusCode, body }); },
      };
      try {
        const pending = resolved.fn({ params: resolved.params, query: {}, body: {}, ...req }, res);
        if (pending && typeof pending.then === 'function') pending.catch(reject);
      } catch (err) {
        reject(err);
      }
    });
  };
  return { invoke };
}
const { invoke } = makeApp();

/**
 * A minimal profile that validates. Nested objects are complete so a test can
 * override one leaf without losing the rest.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function validProfile(overrides = {}) {
  return {
    name: 'Wydajność zapytań',
    description: '',
    enabled: false,
    objective: 'Znajdź N+1 i brakujące indeksy.',
    instructions: 'Każda propozycja wskazuje zapytanie i sposób pomiaru.',
    scope: { mode: 'area', base: 'main', include: ['src/**'], exclude: [] },
    categories: ['bug', 'improvement', 'refactor', 'security', 'opportunity', 'documentation'],
    executor: { auto: true, harness: '', model: '', allowedHarnesses: [] },
    schedule: { mode: 'manual', intervalHours: 6 },
    limits: { maxPerDay: 4, maxFindingsPerScan: 10, timeoutMs: 60_000 },
    ...overrides,
  };
}

/* ------------------------------------------------------- create/list/get */

runCase('create -> list -> get a profile without auto ready/approval', async () => {
  const ws = freshWorkspace('create');
  const created = await invoke('POST', '/api/workspace-watcher/scout/profiles', {
    body: { workspaceFolder: ws, profile: validProfile() },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
  const profile = created.body.profile;
  assert.ok(profile.id, 'a server id is minted');
  assert.equal(profile.revision, 1);
  assert.equal(profile.name, 'Wydajność zapytań');
  assert.equal(profile.enabled, false);
  assert.equal('approvedAt' in profile, false, 'creating a profile never approves a plan');
  assert.equal('ready' in profile, false, 'creating a profile never marks work ready');
  assert.equal('status' in profile, false);

  const listed = await invoke('GET', '/api/workspace-watcher/scout/profiles', {
    query: { workspaceFolder: ws },
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.profiles.map((row) => row.id), [profile.id]);

  const fetched = await invoke('GET', `/api/workspace-watcher/scout/profiles/${profile.id}`, {
    query: { workspaceFolder: ws },
  });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.profile.id, profile.id);
  assert.equal(fetched.body.profile.objective, 'Znajdź N+1 i brakujące indeksy.');

  const missing = await invoke('GET', '/api/workspace-watcher/scout/profiles/does-not-exist', {
    query: { workspaceFolder: ws },
  });
  assert.equal(missing.status, 404);

  assert.equal(loadTodosData(dataDir, ws).items.length, 0, 'profile CRUD creates no todos');
});

/* --------------------------------------------------------------- CAS */

runCase('PATCH with a stale revision returns 409 and changes nothing', async () => {
  const ws = freshWorkspace('cas');
  const created = await invoke('POST', '/api/workspace-watcher/scout/profiles', {
    body: { workspaceFolder: ws, profile: validProfile() },
  });
  const id = created.body.profile.id;

  const stale = await invoke('PATCH', `/api/workspace-watcher/scout/profiles/${id}`, {
    query: { workspaceFolder: ws },
    body: { expectedRevision: 99, profile: { name: 'Nie powinno się zapisać' } },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.ok, false);

  const unchanged = await invoke('GET', `/api/workspace-watcher/scout/profiles/${id}`, {
    query: { workspaceFolder: ws },
  });
  assert.equal(unchanged.body.profile.revision, 1);
  assert.equal(unchanged.body.profile.name, 'Wydajność zapytań');

  const accepted = await invoke('PATCH', `/api/workspace-watcher/scout/profiles/${id}`, {
    query: { workspaceFolder: ws },
    body: { expectedRevision: 1, profile: { name: 'Wydajność v2' } },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.profile.revision, 2);
  assert.equal(accepted.body.profile.name, 'Wydajność v2');
  // A partial patch must not wipe the untouched fields.
  assert.equal(accepted.body.profile.objective, 'Znajdź N+1 i brakujące indeksy.');
  assert.deepEqual(accepted.body.profile.scope.include, ['src/**']);

  const badRevision = await invoke('PATCH', `/api/workspace-watcher/scout/profiles/${id}`, {
    query: { workspaceFolder: ws },
    body: { profile: { name: 'Bez CAS' } },
  });
  assert.equal(badRevision.status, 400);

  const missing = await invoke('PATCH', '/api/workspace-watcher/scout/profiles/nope', {
    query: { workspaceFolder: ws },
    body: { expectedRevision: 1, profile: { name: 'X' } },
  });
  assert.equal(missing.status, 404);

  const invalid = await invoke('PATCH', `/api/workspace-watcher/scout/profiles/${id}`, {
    query: { workspaceFolder: ws },
    body: { expectedRevision: 2, profile: { name: '' } },
  });
  assert.equal(invalid.status, 400);
});

runCase('PATCH virtual scout-general uses CAS before materializing', async () => {
  const ws = freshWorkspace('virtual-general-cas');
  assert.equal(getWorkspaceWatcher(ws, { dataDir }), null, 'no watcher row yet');

  const stale = await invoke('PATCH', `/api/workspace-watcher/scout/profiles/${SCOUT_GENERAL_PROFILE_ID}`, {
    query: { workspaceFolder: ws },
    body: { expectedRevision: 99, profile: { name: 'Should not persist' } },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.ok, false);
  const rowAfterStale = getWorkspaceWatcher(ws, { dataDir });
  assert.equal(rowAfterStale, null, 'stale CAS must not materialize a stored profile');

  const listedAfterStale = await invoke('GET', '/api/workspace-watcher/scout/profiles', {
    query: { workspaceFolder: ws },
  });
  assert.deepEqual(listedAfterStale.body.profiles.map((profile) => profile.id), [SCOUT_GENERAL_PROFILE_ID]);
  assert.equal(listedAfterStale.body.profiles[0].revision, 1);

  const materialized = await invoke('PATCH', `/api/workspace-watcher/scout/profiles/${SCOUT_GENERAL_PROFILE_ID}`, {
    query: { workspaceFolder: ws },
    body: { expectedRevision: 1, profile: { name: 'Scout ogólny (zapisany)' } },
  });
  assert.equal(materialized.status, 200);
  assert.equal(materialized.body.profile.id, SCOUT_GENERAL_PROFILE_ID);
  assert.equal(materialized.body.profile.revision, 2);
  assert.equal(materialized.body.profile.name, 'Scout ogólny (zapisany)');

  const stored = getWorkspaceWatcher(ws, { dataDir });
  assert.ok(stored);
  assert.equal(stored.scoutProfiles.length, 1);
  assert.equal(stored.scoutProfiles[0].id, SCOUT_GENERAL_PROFILE_ID);
  assert.equal(stored.scoutProfiles[0].revision, 2);
});

/* ------------------------------------------------------------- duplicate */

runCase('duplicate creates a distinct id without touching the source', async () => {
  const ws = freshWorkspace('duplicate');
  const created = await invoke('POST', '/api/workspace-watcher/scout/profiles', {
    body: { workspaceFolder: ws, profile: validProfile({ name: 'Źródłowy' }) },
  });
  const id = created.body.profile.id;
  const before = (await invoke('GET', `/api/workspace-watcher/scout/profiles/${id}`, {
    query: { workspaceFolder: ws },
  })).body.profile;

  const duplicated = await invoke('POST', `/api/workspace-watcher/scout/profiles/${id}/duplicate`, {
    query: { workspaceFolder: ws },
  });
  assert.equal(duplicated.status, 200);
  const copy = duplicated.body.profile;
  assert.notEqual(copy.id, id);
  assert.equal(copy.revision, 1);
  assert.equal(copy.name, 'Źródłowy (kopia)');
  assert.equal(duplicated.body.sourceId, id);

  const after = (await invoke('GET', `/api/workspace-watcher/scout/profiles/${id}`, {
    query: { workspaceFolder: ws },
  })).body.profile;
  assert.deepEqual(after, before, 'the source profile is untouched');

  const listed = (await invoke('GET', '/api/workspace-watcher/scout/profiles', {
    query: { workspaceFolder: ws },
  })).body.profiles;
  assert.deepEqual(listed.map((row) => row.id).sort(), [id, copy.id].sort());
});

runCase('duplicate truncates a long name within the stored limit', async () => {
  const ws = freshWorkspace('duplicate-long');
  const longName = 'x'.repeat(120);
  const created = await invoke('POST', '/api/workspace-watcher/scout/profiles', {
    body: { workspaceFolder: ws, profile: validProfile({ name: longName }) },
  });
  const id = created.body.profile.id;
  const duplicated = await invoke('POST', `/api/workspace-watcher/scout/profiles/${id}/duplicate`, {
    query: { workspaceFolder: ws },
  });
  assert.equal(duplicated.status, 200);
  const name = duplicated.body.profile.name;
  assert.ok(name.length <= 120, `name length ${name.length} must fit the limit`);
  assert.ok(name.endsWith(' (kopia)'));
});

/* --------------------------------------------------------------- archive */

runCase('archive stamps archivedAt and keeps the profile readable', async () => {
  const ws = freshWorkspace('archive');
  const created = await invoke('POST', '/api/workspace-watcher/scout/profiles', {
    body: { workspaceFolder: ws, profile: validProfile({ name: 'Archiwizowany' }) },
  });
  const id = created.body.profile.id;

  const archived = await invoke('POST', `/api/workspace-watcher/scout/profiles/${id}/archive`, {
    query: { workspaceFolder: ws },
  });
  assert.equal(archived.status, 200);
  assert.ok(archived.body.profile.archivedAt);
  assert.ok(!Number.isNaN(Date.parse(archived.body.profile.archivedAt)));
  assert.equal(archived.body.profile.revision, 2);

  const fetched = await invoke('GET', `/api/workspace-watcher/scout/profiles/${id}`, {
    query: { workspaceFolder: ws },
  });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.profile.id, id);
  assert.equal(fetched.body.profile.archivedAt, archived.body.profile.archivedAt);

  const listed = (await invoke('GET', '/api/workspace-watcher/scout/profiles', {
    query: { workspaceFolder: ws },
  })).body.profiles;
  assert.equal(listed.length, 1);
  assert.ok(listed[0].archivedAt);
});

/* --------------------------------------------------------------- preview */

runCase('preview returns prompt/matchedFiles/blockers without starting a model', async () => {
  const ws = freshWorkspace('preview');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src', 'app.js'), 'export const x = 1;\n', 'utf8');

  const created = await invoke('POST', '/api/workspace-watcher/scout/profiles', {
    body: { workspaceFolder: ws, profile: validProfile() },
  });
  const id = created.body.profile.id;

  const preview = await invoke('GET', `/api/workspace-watcher/scout/profiles/${id}/preview`, {
    query: { workspaceFolder: ws },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.modelStarted, false, 'preview never starts a model');
  assert.equal(typeof preview.body.prompt, 'string');
  assert.ok(preview.body.prompt.length > 0);
  assert.ok(Array.isArray(preview.body.matchedFiles));
  assert.ok(preview.body.matchedFiles.includes('src/app.js'));
  assert.ok(Array.isArray(preview.body.blockers));
  assert.ok(preview.body.config);

  const row = getWorkspaceWatcher(ws, { dataDir });
  assert.deepEqual(row.scoutScanHistory || [], [], 'a preview reserves no scan');

  const missing = await invoke('GET', '/api/workspace-watcher/scout/profiles/nope/preview', {
    query: { workspaceFolder: ws },
  });
  assert.equal(missing.status, 404);
});

/* --------------------------------------------------------------- history */

runCase('history filters by scoutId, is newest-first and omits submitToken', async () => {
  const ws = freshWorkspace('history');
  mutateWorkspaceWatcherRow(ws, () => ({
    scoutScanHistory: [
      {
        scanId: 'scan-old',
        scoutId: 'perf',
        scoutRevision: 1,
        status: 'completed',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:01:00.000Z',
        added: 2,
        submitToken: 'secret-token-old',
      },
      {
        scanId: 'scan-other',
        scoutId: 'security',
        status: 'failed',
        startedAt: '2026-01-03T00:00:00.000Z',
        error: 'boom',
      },
      {
        scanId: 'scan-new',
        scoutId: 'perf',
        scoutRevision: 2,
        status: 'completed',
        startedAt: '2026-01-02T00:00:00.000Z',
        finishedAt: '2026-01-02T00:01:00.000Z',
        added: 1,
        submitToken: 'secret-token-new',
      },
    ],
  }), { dataDir });

  const filtered = await invoke('GET', '/api/workspace-watcher/scout/history', {
    query: { workspaceFolder: ws, scoutId: 'perf' },
  });
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.history.map((entry) => entry.scanId), ['scan-new', 'scan-old']);
  assert.ok(filtered.body.history.every((entry) => entry.scoutId === 'perf'));
  assert.ok(filtered.body.history.every((entry) => !('submitToken' in entry)));
  const serialized = JSON.stringify(filtered.body);
  assert.equal(serialized.includes('submitToken'), false);
  assert.equal(serialized.includes('secret-token'), false);

  const all = await invoke('GET', '/api/workspace-watcher/scout/history', {
    query: { workspaceFolder: ws },
  });
  assert.equal(all.body.history.length, 3);
  assert.deepEqual(all.body.history.map((entry) => entry.scanId), ['scan-other', 'scan-new', 'scan-old']);

  const bounded = await invoke('GET', '/api/workspace-watcher/scout/history', {
    query: { workspaceFolder: ws, scoutId: 'perf', max: '1' },
  });
  assert.deepEqual(bounded.body.history.map((entry) => entry.scanId), ['scan-new']);
});

/* ----------------------------------------------------- findings scoutId */

runCase('GET /scout filters findings by scoutId without changing the legacy shape', async () => {
  const ws = freshWorkspace('findings-filter');
  mutateWorkspaceWatcherRow(ws, () => ({
    pendingScoutFindings: [
      {
        id: 'finding-perf',
        title: 'N+1 w zamówieniach',
        category: 'bug',
        status: 'pending',
        createdAt: '2026-02-01T00:00:00.000Z',
        sources: [{ scoutId: 'perf', scanId: 'scan-perf' }],
      },
      {
        id: 'finding-security',
        title: 'Brak walidacji wejścia',
        category: 'security',
        status: 'pending',
        createdAt: '2026-02-02T00:00:00.000Z',
        sources: [{ scoutId: 'security', scanId: 'scan-sec' }],
      },
    ],
  }), { dataDir });

  const filtered = await invoke('GET', '/api/workspace-watcher/scout', {
    query: { workspaceFolder: ws, scoutId: 'perf' },
  });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.ok, true);
  assert.deepEqual(filtered.body.findings.map((finding) => finding.id), ['finding-perf']);

  const all = await invoke('GET', '/api/workspace-watcher/scout', {
    query: { workspaceFolder: ws },
  });
  assert.equal(all.body.findings.length, 2);
});

/* ---------------------------------------------------- workspace isolation */

runCase('a profile created for workspace A is invisible in workspace B', async () => {
  const wsA = freshWorkspace('isolation-a');
  const wsB = freshWorkspace('isolation-b');
  const created = await invoke('POST', '/api/workspace-watcher/scout/profiles', {
    body: { workspaceFolder: wsA, profile: validProfile({ name: 'Tylko A' }) },
  });
  const id = created.body.profile.id;

  const listB = await invoke('GET', '/api/workspace-watcher/scout/profiles', {
    query: { workspaceFolder: wsB },
  });
  assert.equal(listB.status, 200);
  assert.equal(listB.body.profiles.some((profile) => profile.id === id), false);
  // A workspace with no stored profile reads the deterministic virtual general.
  assert.deepEqual(listB.body.profiles.map((profile) => profile.id), ['scout-general']);

  const getB = await invoke('GET', `/api/workspace-watcher/scout/profiles/${id}`, {
    query: { workspaceFolder: wsB },
  });
  assert.equal(getB.status, 404);

  const historyB = await invoke('GET', '/api/workspace-watcher/scout/history', {
    query: { workspaceFolder: wsB },
  });
  assert.deepEqual(historyB.body.history, []);

  // A read of B must not have materialized a stored row.
  assert.equal(getWorkspaceWatcher(wsB, { dataDir }), null);
});

/* ------------------------------------------------------------- legacy API */

runCase('legacy GET/POST /api/workspace-watcher/scout keep working', async () => {
  const ws = freshWorkspace('legacy');
  const viaGet = await invoke('GET', '/api/workspace-watcher/scout', {
    query: { workspaceFolder: ws },
  });
  assert.equal(viaGet.status, 200);
  assert.equal(viaGet.body.ok, true);
  assert.ok(Array.isArray(viaGet.body.findings));

  const viaPost = await invoke('POST', '/api/workspace-watcher/scout', {
    body: { workspaceFolder: ws, action: 'list' },
  });
  assert.equal(viaPost.status, 200);
  assert.equal(viaPost.body.ok, true);
  assert.ok(Array.isArray(viaPost.body.findings));

  // The legacy POST surface still rejects an unknown action with a 400.
  const unknown = await invoke('POST', '/api/workspace-watcher/scout', {
    body: { workspaceFolder: ws, action: 'nope' },
  });
  assert.equal(unknown.status, 400);
});

/* ----------------------------------------------------------- scout run */

runCase('profile-scoped scout run route is registered', async () => {
  const ws = freshWorkspace('profile-run-route');
  const resolved = invoke('POST', `/api/workspace-watcher/scout/profiles/${SCOUT_GENERAL_PROFILE_ID}/run`, {
    query: { workspaceFolder: ws },
    body: {},
  });
  await assert.doesNotReject(resolved);
});

runCase('legacy POST /scout action=run forwards scoutId (REST + MCP profiles run + in-process)', async () => {
  const ws = freshWorkspace('rest-scout-run');
  const viaRest = await invoke('POST', '/api/workspace-watcher/scout', {
    body: { workspaceFolder: ws, action: 'run', scoutId: 'missing-profile-id' },
  });
  assert.equal(viaRest.status, 200);
  assert.equal(viaRest.body.reason, 'scout_not_found');

  const tools = new Map(WATCHER_MCP_TOOLS.map((tool) => [tool.name, tool]));
  /** @type {object[]} */
  const calls = [];
  const client = {
    async workspaceWatcherScoutProfiles(input) {
      calls.push(input);
      return { ok: true, action: input.action };
    },
  };
  const session = { chatId: 'chat-1', workspaceFolder: freshWorkspace('scout-run-forward') };
  const profiles = tools.get('scout_profiles');
  assert.ok(profiles);
  const missingRunId = await profiles.handler({ action: 'run' }, { client, session }).catch((err) => err);
  assert.equal(missingRunId.code, 'VALIDATION_ERROR');
  await profiles.handler({ action: 'run', scout_id: 'profile-abc' }, { client, session });
  assert.equal(calls.at(-1).action, 'run');
  assert.equal(calls.at(-1).scoutId, 'profile-abc');

  const { createInProcessMcpClient } = await import('../lib/mcp/mcp-inprocess-client.js');
  const { setBuiltinMcpRuntimeDeps } = await import('../lib/mcp/builtin/runtime-deps.js');
  const inProcessWs = freshWorkspace('inprocess-scout-run');
  setBuiltinMcpRuntimeDeps({ dataDir });
  const inProcess = createInProcessMcpClient({});
  const withUnknownProfile = await inProcess.workspaceWatcherScout({
    workspaceFolder: inProcessWs,
    action: 'run',
    scoutId: 'missing-profile-id',
  });
  assert.equal(withUnknownProfile.reason, 'scout_not_found');
});

/* ------------------------------------------------------------------- MCP */

runCase('MCP scout_profiles validates before dispatch and scout_id is forwarded', async () => {
  const tools = new Map(WATCHER_MCP_TOOLS.map((tool) => [tool.name, tool]));
  /** @type {object[]} */
  const calls = [];
  const client = {
    async workspaceWatcherScoutProfiles(input) {
      calls.push(input);
      return { ok: true, action: input.action, profiles: [] };
    },
    async workspaceWatcherScout(input) {
      calls.push(input);
      return { ok: true, findings: [] };
    },
  };
  const session = { chatId: 'chat-1', workspaceFolder: freshWorkspace('mcp') };

  const profiles = tools.get('scout_profiles');
  assert.ok(profiles, 'the tool is registered');
  assert.equal(profiles.readOnly, false);
  assert.ok(profiles.inputSchema.properties.action);
  assert.ok(profiles.inputSchema.properties.scout_id);

  const invalidAction = await profiles.handler({ action: 'bogus' }, { client, session }).catch((err) => err);
  assert.equal(invalidAction.code, 'VALIDATION_ERROR');
  const missingId = await profiles.handler({ action: 'get' }, { client, session }).catch((err) => err);
  assert.equal(missingId.code, 'VALIDATION_ERROR');
  const missingRevision = await profiles.handler(
    { action: 'update', scout_id: 'p1', profile: { name: 'x' } },
    { client, session },
  ).catch((err) => err);
  assert.equal(missingRevision.code, 'VALIDATION_ERROR');

  const listed = await profiles.handler({ action: 'list' }, { client, session });
  assert.equal(listed.isError, false);
  assert.equal(calls.at(-1).action, 'list');

  await profiles.handler({ action: 'create', profile: { name: 'x' } }, { client, session });
  assert.equal(calls.at(-1).action, 'create');
  assert.deepEqual(calls.at(-1).profile, { name: 'x' });

  const findings = tools.get('scout_findings');
  await findings.handler({ action: 'list', scout_id: 'perf' }, { client, session });
  assert.equal(calls.at(-1).scoutId, 'perf');
});

/* --------------------------------------------------- additive runtime state */

runCase('list/get carry an additive per-profile state without changing the profile shape', async () => {
  const ws = freshWorkspace('profile-state');
  const perfCreated = await invoke('POST', '/api/workspace-watcher/scout/profiles', {
    body: { workspaceFolder: ws, profile: validProfile({ name: 'Perf' }) },
  });
  const perfId = perfCreated.body.profile.id;
  const securityCreated = await invoke('POST', '/api/workspace-watcher/scout/profiles', {
    body: { workspaceFolder: ws, profile: validProfile({ name: 'Security' }) },
  });
  const securityId = securityCreated.body.profile.id;
  const intervalCreated = await invoke('POST', '/api/workspace-watcher/scout/profiles', {
    body: {
      workspaceFolder: ws,
      profile: validProfile({ name: 'Interwałowy', enabled: true, schedule: { mode: 'interval', intervalHours: 6 } }),
    },
  });
  const intervalId = intervalCreated.body.profile.id;

  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  mutateWorkspaceWatcherRow(ws, () => ({
    // Scout is globally off, so a manual run must be reported as blocked.
    policy: { scoutEnabled: false, scoutMaxPerDay: 4 },
    scoutSchedules: {
      [perfId]: { lastRunAt: '2026-02-01T00:00:00.000Z', nextRunAt: '', day, count: 2, updatedAt: '' },
    },
    pendingScoutFindings: [
      { id: 'f1', title: 'N+1', category: 'bug', status: 'pending', sources: [{ scoutId: perfId, scanId: 's1', scoutRevision: 1 }] },
      { id: 'f2', title: 'Other', category: 'bug', status: 'pending', sources: [{ scoutId: securityId, scanId: 's2', scoutRevision: 1 }] },
      { id: 'f3', title: 'Resolved', category: 'bug', status: 'accepted', sources: [{ scoutId: perfId, scanId: 's1', scoutRevision: 1 }] },
    ],
    activeScoutScans: [
      { scanId: 'scan-perf', scoutId: perfId, scoutRevision: 1, status: 'running', launchIssued: true, chatId: 'chat-1', startedAt: new Date(now).toISOString() },
      { scanId: 'scan-sec', scoutId: securityId, scoutRevision: 1, status: 'running', launchIssued: true, chatId: 'chat-2', startedAt: new Date(now).toISOString() },
    ],
  }), { dataDir });

  const listed = await invoke('GET', '/api/workspace-watcher/scout/profiles', {
    query: { workspaceFolder: ws },
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.profiles.length, 3);

  const perf = listed.body.profiles.find((profile) => profile.id === perfId);
  assert.ok(perf, 'perf profile is listed');
  // The stored profile fields are untouched (backward compatible shape).
  assert.equal(perf.name, 'Perf');
  assert.equal(perf.revision, 1);
  assert.equal(perf.enabled, false);
  assert.deepEqual(perf.scope.include, ['src/**']);
  assert.equal(perf.limits.maxPerDay, 4);
  assert.ok(perf.state && typeof perf.state === 'object', 'state is additive');

  assert.equal(perf.state.lastRunAt, '2026-02-01T00:00:00.000Z');
  assert.equal(perf.state.usedToday, 2);
  assert.equal(perf.state.maxPerDay, 4);
  assert.equal(perf.state.remainingToday, 2);
  assert.equal(perf.state.pendingFindings, 1, 'only pending findings attributed to this profile count');
  assert.equal(perf.state.running, 1, 'only this profile active scan counts');
  assert.equal(perf.state.archived, false);
  assert.equal(perf.state.nextRunAt, '', 'a manual profile has no next run');
  assert.equal(perf.state.blockedReason, 'scout_disabled', 'the manual-run gate explains itself');

  const security = listed.body.profiles.find((profile) => profile.id === securityId);
  assert.equal(security.state.pendingFindings, 1);
  assert.equal(security.state.running, 1);
  assert.equal(security.state.lastRunAt, '');
  assert.equal(security.state.usedToday, 0, 'a fresh UTC-day counter reads 0');
  assert.equal(security.state.remainingToday, 4);

  const interval = listed.body.profiles.find((profile) => profile.id === intervalId);
  assert.ok(interval.state.nextRunAt, 'an enabled interval profile gets a next run');
  assert.ok(Number.isFinite(Date.parse(interval.state.nextRunAt)), 'nextRunAt is an ISO instant');

  // `get` exposes the same additive state.
  const fetched = await invoke('GET', `/api/workspace-watcher/scout/profiles/${perfId}`, {
    query: { workspaceFolder: ws },
  });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.profile.state.pendingFindings, 1);
  assert.equal(fetched.body.profile.state.lastRunAt, '2026-02-01T00:00:00.000Z');
  assert.equal(fetched.body.profile.name, 'Perf');

  // A read never materializes a row for an untouched workspace.
  const fresh = freshWorkspace('profile-state-fresh');
  const freshList = await invoke('GET', '/api/workspace-watcher/scout/profiles', {
    query: { workspaceFolder: fresh },
  });
  assert.equal(freshList.body.profiles[0].state.usedToday, 0);
  assert.equal(freshList.body.profiles[0].state.archived, false);
  assert.equal(getWorkspaceWatcher(fresh, { dataDir }), null);
});

runCase('an archived profile reports state.archived and the profile_archived blocker', async () => {
  const ws = freshWorkspace('profile-state-archived');
  const created = await invoke('POST', '/api/workspace-watcher/scout/profiles', {
    body: { workspaceFolder: ws, profile: validProfile({ name: 'Do archiwum' }) },
  });
  const id = created.body.profile.id;
  // Open the global gates so the per-profile archive gate is what blocks.
  mutateWorkspaceWatcherRow(ws, () => ({
    mode: 'observe',
    policy: { scoutEnabled: true, scoutMaxPerDay: 4, scoutMaxParallel: 1 },
  }), { dataDir });

  const archived = await invoke('POST', `/api/workspace-watcher/scout/profiles/${id}/archive`, {
    query: { workspaceFolder: ws },
  });
  assert.equal(archived.status, 200);

  const fetched = await invoke('GET', `/api/workspace-watcher/scout/profiles/${id}`, {
    query: { workspaceFolder: ws },
  });
  assert.equal(fetched.body.profile.state.archived, true);
  assert.equal(fetched.body.profile.state.blockedReason, 'profile_archived');
});

runCase('an occupied scan makes an otherwise allowed manual run report profile_scan_active', async () => {
  const ws = freshWorkspace('profile-state-scan-active');
  const created = await invoke('POST', '/api/workspace-watcher/scout/profiles', {
    body: { workspaceFolder: ws, profile: validProfile({ name: 'Zajęty' }) },
  });
  const id = created.body.profile.id;
  const now = Date.now();
  // scoutMaxParallel > 1 so the global parallel gate allows the click; the
  // profile's own occupied scan is then the only thing that blocks it.
  mutateWorkspaceWatcherRow(ws, () => ({
    mode: 'observe',
    policy: { scoutEnabled: true, scoutMaxPerDay: 4, scoutMaxParallel: 2 },
    activeScoutScans: [
      {
        scanId: 'scan-busy',
        scoutId: id,
        scoutRevision: 1,
        status: 'running',
        launchIssued: true,
        chatId: 'chat-busy',
        startedAt: new Date(now).toISOString(),
      },
    ],
  }), { dataDir });

  const fetched = await invoke('GET', `/api/workspace-watcher/scout/profiles/${id}`, {
    query: { workspaceFolder: ws },
  });
  assert.equal(fetched.body.profile.state.running, 1);
  assert.equal(fetched.body.profile.state.blockedReason, 'profile_scan_active');
});

/* ------------------------------------- templates + draft + restore (5.2) */

runCase('GET /scout/templates returns the versioned catalog as deep copies', async () => {
  const ws = freshWorkspace('templates');
  const res = await invoke('GET', '/api/workspace-watcher/scout/templates', {
    query: { workspaceFolder: ws },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.templates));
  assert.ok(res.body.templates.length >= 6, 'the built-in catalog is complete');
  const perf = res.body.templates.find((template) => template.id === 'performance');
  assert.ok(perf, 'the performance template exists');
  assert.ok(Array.isArray(perf.scope.include));
  perf.scope.include.push('HACKED');
  const again = await invoke('GET', '/api/workspace-watcher/scout/templates', {
    query: { workspaceFolder: ws },
  });
  const fresh = again.body.templates.find((template) => template.id === 'performance');
  assert.ok(!fresh.scope.include.includes('HACKED'), 'the catalog is never mutated by a response');
});

runCase('POST /profiles/from-template validates, saves disabled+manual and keeps the template link', async () => {
  const ws = freshWorkspace('from-template');
  const missing = await invoke('POST', '/api/workspace-watcher/scout/profiles/from-template', {
    body: { workspaceFolder: ws },
  });
  assert.equal(missing.status, 400);
  const unknown = await invoke('POST', '/api/workspace-watcher/scout/profiles/from-template', {
    body: { workspaceFolder: ws, templateId: 'does-not-exist' },
  });
  assert.equal(unknown.status, 400);

  const created = await invoke('POST', '/api/workspace-watcher/scout/profiles/from-template', {
    body: { workspaceFolder: ws, templateId: 'performance', overrides: { name: 'Zapytania zamówień' } },
  });
  assert.equal(created.status, 200);
  const profile = created.body.profile;
  assert.equal(profile.name, 'Zapytania zamówień');
  assert.equal(profile.enabled, false, 'a template never opts into automatic scans');
  assert.equal(profile.schedule.mode, 'manual');
  assert.equal(profile.templateId, 'performance');
  assert.equal(profile.templateVersion, '1');
  assert.equal(profile.revision, 1);
  assert.equal(created.body.templateId, 'performance');

  // A caller cannot smuggle automation through overrides.
  const forced = await invoke('POST', '/api/workspace-watcher/scout/profiles/from-template', {
    body: {
      workspaceFolder: ws,
      templateId: 'bugs',
      overrides: { name: 'Wymuszone', enabled: true, schedule: { mode: 'interval', intervalHours: 3 } },
    },
  });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.profile.enabled, false);
  assert.equal(forced.body.profile.schedule.mode, 'manual');

  // An override that breaks server validation is a readable 400.
  const invalid = await invoke('POST', '/api/workspace-watcher/scout/profiles/from-template', {
    body: { workspaceFolder: ws, templateId: 'bugs', overrides: { name: '' } },
  });
  assert.equal(invalid.status, 400);
  assert.ok(invalid.body.error);
});

runCase('preview-draft builds the effective config without creating a profile or a scan reservation', async () => {
  const ws = freshWorkspace('preview-draft');
  fs.mkdirSync(path.join(ws, 'lib', 'orders'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'lib', 'orders', 'order.js'), 'export const x = 1;\n');
  const draft = materializeProfileFromTemplate('performance', {
    name: 'Zapytania zamówień',
    scope: { mode: 'area', base: 'main', include: ['lib/orders/**'], exclude: [] },
    instructions: 'Własne instrukcje: wskaż zapytanie N+1.',
  });
  const res = await invoke('POST', '/api/workspace-watcher/scout/profiles/preview-draft', {
    body: { workspaceFolder: ws, profile: draft },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.modelStarted, false);
  assert.match(res.body.prompt, /Zapytania zamówień/);
  assert.match(res.body.prompt, /Znajdź problemy wydajnościowe/, 'the template objective reaches the prompt');
  assert.match(res.body.prompt, /lib\/orders\/\*\*/, 'the scope reaches the prompt');
  assert.ok(res.body.matchedFiles.includes('lib/orders/order.js'));
  assert.deepEqual(res.body.blockers, [], 'a populated in-scope workspace has no blockers');

  // No profile is written and no scan slot is reserved.
  assert.equal(getWorkspaceWatcher(ws, { dataDir }), null, 'a draft preview never materializes a row');
  const listed = await invoke('GET', '/api/workspace-watcher/scout/profiles', {
    query: { workspaceFolder: ws },
  });
  assert.equal(listed.body.profiles.length, 1);
  assert.equal(listed.body.profiles[0].id, SCOUT_GENERAL_PROFILE_ID);

  // An empty scope reports no_files_in_scope instead of widening to the repo.
  const empty = freshWorkspace('preview-draft-empty');
  const emptyRes = await invoke('POST', '/api/workspace-watcher/scout/profiles/preview-draft', {
    body: { workspaceFolder: empty, profile: draft },
  });
  assert.equal(emptyRes.status, 200);
  assert.deepEqual(emptyRes.body.matchedFiles, []);
  assert.ok(emptyRes.body.blockers.some((blocker) => blocker.code === 'no_files_in_scope'));

  // With a stored row, a draft preview still writes nothing and reserves no scan.
  const existing = freshWorkspace('preview-draft-existing');
  const seeded = await invoke('POST', '/api/workspace-watcher/scout/profiles', {
    body: { workspaceFolder: existing, profile: validProfile({ name: 'Istniejący' }) },
  });
  assert.equal(seeded.status, 200);
  const beforeProfiles = await invoke('GET', '/api/workspace-watcher/scout/profiles', {
    query: { workspaceFolder: existing },
  });
  const withRow = await invoke('POST', '/api/workspace-watcher/scout/profiles/preview-draft', {
    body: { workspaceFolder: existing, profile: draft },
  });
  assert.equal(withRow.status, 200);
  const afterProfiles = await invoke('GET', '/api/workspace-watcher/scout/profiles', {
    query: { workspaceFolder: existing },
  });
  assert.equal(afterProfiles.body.profiles.length, beforeProfiles.body.profiles.length);
  const row = getWorkspaceWatcher(existing, { dataDir });
  assert.ok(row, 'the seeded profile materialized a row');
  assert.deepEqual(row.activeScoutScans || [], [], 'a draft preview reserves no scan slot');
  assert.deepEqual(row.scoutScanHistory || [], [], 'a draft preview writes no scan history');
});

runCase('restore-diff and restore apply the template definition under CAS', async () => {
  const ws = freshWorkspace('restore');
  const created = await invoke('POST', '/api/workspace-watcher/scout/profiles/from-template', {
    body: { workspaceFolder: ws, templateId: 'performance' },
  });
  const id = created.body.profile.id;
  const edited = await invoke('PATCH', `/api/workspace-watcher/scout/profiles/${id}`, {
    query: { workspaceFolder: ws },
    body: {
      expectedRevision: 1,
      profile: validProfile({
        name: 'Moje zapytania',
        objective: 'Zmieniony cel',
        templateId: 'performance',
        templateVersion: '1',
      }),
    },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.profile.revision, 2);

  const diffRes = await invoke('GET', `/api/workspace-watcher/scout/profiles/${id}/restore-diff`, {
    query: { workspaceFolder: ws },
  });
  assert.equal(diffRes.status, 200);
  assert.ok(Array.isArray(diffRes.body.diff));
  assert.ok(diffRes.body.diff.some((entry) => entry.field === 'name'));
  assert.equal(diffRes.body.templateId, 'performance');
  assert.equal(diffRes.body.templateVersion, '1');

  const noConfirm = await invoke('POST', `/api/workspace-watcher/scout/profiles/${id}/restore`, {
    body: { workspaceFolder: ws, expectedRevision: 2 },
  });
  assert.equal(noConfirm.status, 400);

  const before = await invoke('GET', `/api/workspace-watcher/scout/profiles/${id}`, {
    query: { workspaceFolder: ws },
  });
  const stale = await invoke('POST', `/api/workspace-watcher/scout/profiles/${id}/restore`, {
    body: { workspaceFolder: ws, expectedRevision: 99, confirm: true },
  });
  assert.equal(stale.status, 409);
  const afterStale = await invoke('GET', `/api/workspace-watcher/scout/profiles/${id}`, {
    query: { workspaceFolder: ws },
  });
  assert.equal(afterStale.body.profile.revision, before.body.profile.revision);
  assert.equal(afterStale.body.profile.name, 'Moje zapytania', 'a stale restore changes nothing');

  const applied = await invoke('POST', `/api/workspace-watcher/scout/profiles/${id}/restore`, {
    body: { workspaceFolder: ws, expectedRevision: before.body.profile.revision, confirm: true },
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.profile.name, 'Wydajność');
  assert.ok(Array.isArray(applied.body.diff));
  assert.equal(applied.body.profile.revision, before.body.profile.revision + 1);
});

runCase('editing one profile leaves another profile and the scan reservations untouched', async () => {
  const ws = freshWorkspace('edit-isolation');
  const first = await invoke('POST', '/api/workspace-watcher/scout/profiles/from-template', {
    body: { workspaceFolder: ws, templateId: 'performance' },
  });
  const second = await invoke('POST', '/api/workspace-watcher/scout/profiles/from-template', {
    body: { workspaceFolder: ws, templateId: 'bugs' },
  });
  const firstId = first.body.profile.id;
  const secondId = second.body.profile.id;
  mutateWorkspaceWatcherRow(ws, () => ({
    activeScoutScans: [
      {
        scanId: 'scan-keep',
        scoutId: firstId,
        scoutRevision: 1,
        status: 'running',
        launchIssued: true,
        chatId: 'chat-keep',
        startedAt: new Date().toISOString(),
      },
    ],
  }), { dataDir });

  const secondBefore = await invoke('GET', `/api/workspace-watcher/scout/profiles/${secondId}`, {
    query: { workspaceFolder: ws },
  });
  const patched = await invoke('PATCH', `/api/workspace-watcher/scout/profiles/${firstId}`, {
    query: { workspaceFolder: ws },
    body: {
      expectedRevision: 1,
      profile: validProfile({ name: 'Pierwszy po edycji', templateId: 'performance', templateVersion: '1' }),
    },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.profile.revision, 2);

  const secondAfter = await invoke('GET', `/api/workspace-watcher/scout/profiles/${secondId}`, {
    query: { workspaceFolder: ws },
  });
  assert.equal(secondAfter.body.profile.revision, secondBefore.body.profile.revision);
  assert.equal(secondAfter.body.profile.updatedAt, secondBefore.body.profile.updatedAt);
  assert.equal(secondAfter.body.profile.name, secondBefore.body.profile.name);

  const row = getWorkspaceWatcher(ws, { dataDir });
  assert.equal(row.activeScoutScans.length, 1, 'a profile write never touches an active scan');
  assert.equal(row.activeScoutScans[0].scanId, 'scan-keep');
});

runCase('MCP scout_profiles exposes templates/from_template/restore_preview/restore', async () => {
  const tools = new Map(WATCHER_MCP_TOOLS.map((tool) => [tool.name, tool]));
  /** @type {object[]} */
  const calls = [];
  const client = {
    async workspaceWatcherScoutProfiles(input) {
      calls.push(input);
      return { ok: true, action: input.action };
    },
  };
  const session = { chatId: 'chat-1', workspaceFolder: freshWorkspace('mcp-52') };
  const profiles = tools.get('scout_profiles');
  assert.ok(profiles);

  const missingTemplate = await profiles.handler({ action: 'from_template' }, { client, session }).catch((err) => err);
  assert.equal(missingTemplate.code, 'VALIDATION_ERROR');

  await profiles.handler({ action: 'templates' }, { client, session });
  assert.equal(calls.at(-1).action, 'templates');

  await profiles.handler(
    { action: 'from_template', template_id: 'performance', overrides: { name: 'X' } },
    { client, session },
  );
  assert.equal(calls.at(-1).action, 'from_template');
  assert.equal(calls.at(-1).templateId, 'performance');
  assert.deepEqual(calls.at(-1).overrides, { name: 'X' });

  await profiles.handler({ action: 'restore_preview', scout_id: 'p1' }, { client, session });
  assert.equal(calls.at(-1).action, 'restore_preview');
  assert.equal(calls.at(-1).scoutId, 'p1');

  const noConfirm = await profiles.handler(
    { action: 'restore', scout_id: 'p1', expected_revision: 1 },
    { client, session },
  ).catch((err) => err);
  assert.equal(noConfirm.code, 'VALIDATION_ERROR');
  await profiles.handler(
    { action: 'restore', scout_id: 'p1', expected_revision: 1, confirm: true },
    { client, session },
  );
  assert.equal(calls.at(-1).action, 'restore');
  assert.equal(calls.at(-1).confirm, true);
});

runCase('preview-draft blocks an explicit harness the host cannot keep read-only', async () => {
  const ws = freshWorkspace('preview-readonly');
  fs.mkdirSync(path.join(ws, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'lib', 'a.js'), 'export const a = 1;\n');
  const base = materializeProfileFromTemplate('performance', {
    name: 'Read-only check',
    scope: { mode: 'area', base: 'main', include: ['lib/**'], exclude: [] },
  });
  const unsupported = await invoke('POST', '/api/workspace-watcher/scout/profiles/preview-draft', {
    body: {
      workspaceFolder: ws,
      profile: { ...base, executor: { auto: false, harness: 'mystery-harness', model: '', allowedHarnesses: [] } },
    },
  });
  assert.equal(unsupported.status, 200);
  assert.ok(
    unsupported.body.blockers.some((blocker) => blocker.code === 'read_only_unsupported_harness'),
    'an unenforceable harness blocks the scan',
  );

  const supported = await invoke('POST', '/api/workspace-watcher/scout/profiles/preview-draft', {
    body: {
      workspaceFolder: ws,
      profile: { ...base, executor: { auto: false, harness: 'sdk', model: '', allowedHarnesses: [] } },
    },
  });
  assert.equal(supported.status, 200);
  assert.ok(!supported.body.blockers.some((blocker) => blocker.code === 'read_only_unsupported_harness'));
});

runCase('preview ignores an explicit executor while auto mode is on', async () => {
  const ws = freshWorkspace('preview-auto-ignore');
  fs.mkdirSync(path.join(ws, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'lib', 'a.js'), 'export const a = 1;\n');
  const base = materializeProfileFromTemplate('performance', {
    name: 'Auto executor',
    scope: { mode: 'area', base: 'main', include: ['lib/**'], exclude: [] },
  });
  // An auto profile ignores `executor.harness`: it must not be reported as a
  // profile override and must not gate read-only on a field the runner drops.
  const ignored = await invoke('POST', '/api/workspace-watcher/scout/profiles/preview-draft', {
    body: {
      workspaceFolder: ws,
      profile: { ...base, executor: { auto: true, harness: 'mystery-harness', model: '', allowedHarnesses: [] } },
    },
  });
  assert.equal(ignored.status, 200);
  assert.equal(ignored.body.config.executor.source, 'default');
  assert.equal(ignored.body.config.executor.value.harness, '');
  assert.ok(!ignored.body.blockers.some((blocker) => blocker.code === 'read_only_unsupported_harness'));

  // Auto candidates still fail closed when none of them can enforce read-only.
  const narrowed = await invoke('POST', '/api/workspace-watcher/scout/profiles/preview-draft', {
    body: {
      workspaceFolder: ws,
      profile: { ...base, executor: { auto: true, harness: '', model: '', allowedHarnesses: ['mystery-harness'] } },
    },
  });
  assert.equal(narrowed.status, 200);
  assert.ok(
    narrowed.body.blockers.some((blocker) => blocker.code === 'read_only_unsupported_harness'),
    'auto candidates with no read-only harness block the scan',
  );
});

runCase('the start path blocks an explicit harness the host cannot keep read-only', async () => {
  const ws = freshWorkspace('start-readonly-explicit');
  fs.mkdirSync(path.join(ws, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'lib', 'a.js'), 'export const a = 1;\n');
  upsertWorkspaceWatcher(ws, {
    mode: 'observe',
    policy: { scoutEnabled: true, scoutMaxPerDay: 10 },
  }, { dataDir });
  const created = await invoke('POST', '/api/workspace-watcher/scout/profiles', {
    body: {
      workspaceFolder: ws,
      profile: validProfile({
        enabled: true,
        scope: { mode: 'area', base: 'main', include: ['lib/**'], exclude: [] },
        executor: { auto: false, harness: 'nope', model: '', allowedHarnesses: [] },
      }),
    },
  });
  assert.equal(created.status, 200);
  const id = created.body.profile.id;
  const run = await invoke('POST', `/api/workspace-watcher/scout/profiles/${id}/run`, {
    query: { workspaceFolder: ws },
  });
  assert.equal(run.status, 200);
  assert.equal(run.body.ok, false);
  assert.equal(run.body.scanned, false);
  assert.equal(run.body.reason, 'read_only_unsupported_harness');
});

runCase('the start path fails closed when auto candidates cannot keep read-only', async () => {
  const ws = freshWorkspace('start-readonly-auto');
  fs.mkdirSync(path.join(ws, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'lib', 'a.js'), 'export const a = 1;\n');
  upsertWorkspaceWatcher(ws, {
    mode: 'observe',
    policy: { scoutEnabled: true, scoutMaxPerDay: 10, scoutAllowedHarnesses: ['nope'] },
  }, { dataDir });
  const created = await invoke('POST', '/api/workspace-watcher/scout/profiles', {
    body: {
      workspaceFolder: ws,
      profile: validProfile({
        enabled: true,
        scope: { mode: 'area', base: 'main', include: ['lib/**'], exclude: [] },
        executor: { auto: true, harness: '', model: '', allowedHarnesses: [] },
      }),
    },
  });
  assert.equal(created.status, 200);
  const id = created.body.profile.id;
  const run = await invoke('POST', `/api/workspace-watcher/scout/profiles/${id}/run`, {
    query: { workspaceFolder: ws },
  });
  assert.equal(run.status, 200);
  assert.equal(run.body.ok, false);
  assert.equal(run.body.reason, 'read_only_unsupported_harness');
});

runCase('a manual executor without a harness is rejected at validation', async () => {
  const ws = freshWorkspace('manual-no-harness');
  const rejected = await invoke('POST', '/api/workspace-watcher/scout/profiles', {
    body: {
      workspaceFolder: ws,
      profile: validProfile({ executor: { auto: false, harness: '', model: '', allowedHarnesses: [] } }),
    },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.ok, false);
  assert.match(String(rejected.body.error || ''), /harness/i);
});

/* ----------------------------------------------------------------- finish */

for (const { name, fn } of cases) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') await result;
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}
removeIsolatedDataDir();
fs.rmSync(tmpRoot, { recursive: true, force: true });
if (failed > 0) {
  console.error(`\n${failed} workspace scout profile API test case(s) failed`);
  process.exit(1);
}
console.log('\nworkspace scout profile API tests passed');
