/**
 * Scout profile store tests (stage 1a).
 *
 * Covers the additive v2 model: the closed sets, normalization/validation,
 * legacy `policy.scout*` -> single general profile migration, the read/write
 * API with revision CAS, and that none of it disturbs the legacy Scout state.
 *
 * Isolation: the very first import points persist at a temp data dir; every
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
  WORKSPACE_SCOUT_PROFILE_SCHEDULE_MODES,
  WORKSPACE_SCOUT_PROFILE_SCOPE_MODES,
  WORKSPACE_SCOUT_PROFILE_SOURCES,
  WORKSPACE_WATCHERS_SCHEMA_VERSION,
  defaultWorkspaceScoutProfile,
  defaultWorkspaceWatcherPolicy,
  getWorkspaceScoutProfile,
  getWorkspaceWatcher,
  getWorkspaceWatchersDataPath,
  listWorkspaceScoutProfiles,
  mutateWorkspaceWatcherRow,
  normalizeWorkspaceScoutProfile,
  normalizeWorkspaceWatcherRow,
  upsertWorkspaceScoutProfile,
  upsertWorkspaceWatcher,
  validateWorkspaceScoutProfile,
} from '../lib/persist/workspace-watchers-persist.js';
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-scout-profiles-'));
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
 * A minimal profile that validates. Nested objects are intentionally complete so
 * a test can override one leaf without losing the rest.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function validProfile(overrides = {}) {
  return {
    id: 'perf',
    name: 'Wydajność zapytań',
    description: '',
    enabled: false,
    objective: 'Znajdź N+1 i brakujące indeksy.',
    instructions: 'Każda propozycja wskazuje zapytanie i sposób pomiaru.',
    scope: { mode: 'area', base: 'main', include: ['lib/orders/**'], exclude: [] },
    sources: [...WORKSPACE_SCOUT_PROFILE_SOURCES],
    categories: [...WORKSPACE_SCOUT_CATEGORIES],
    executor: { auto: true, harness: '', model: '', allowedHarnesses: [] },
    schedule: { mode: 'manual', intervalHours: 6 },
    limits: { maxPerDay: 4, maxFindingsPerScan: 10, timeoutMs: 60_000 },
    ...overrides,
  };
}

/**
 * @param {string} dataDir
 * @param {string} workspaceFolder
 * @param {object} row
 * @returns {void}
 */
function writeLegacyV1Document(dataDir, workspaceFolder, row) {
  const filePath = getWorkspaceWatchersDataPath({ dataDir });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    v: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
    items: { [workspaceFolder]: row },
  }), 'utf8');
}

/* --------------------------------------------------------------- closed sets */

runCase('closed sets are exported and frozen', () => {
  assert.deepEqual([...WORKSPACE_SCOUT_PROFILE_SOURCES], ['diff', 'gitHistory', 'todoMarkers', 'testResults', 'logs']);
  assert.deepEqual([...WORKSPACE_SCOUT_PROFILE_SCHEDULE_MODES], ['manual', 'interval']);
  assert.deepEqual([...WORKSPACE_SCOUT_PROFILE_SCOPE_MODES], ['changes', 'area']);
  assert.equal(SCOUT_GENERAL_PROFILE_ID, 'scout-general');
  assert.equal(WORKSPACE_WATCHERS_SCHEMA_VERSION, 2);
});

/* ------------------------------------------------------- normalize / default */

runCase('normalizeWorkspaceScoutProfile never throws and fills safe defaults', () => {
  const profile = normalizeWorkspaceScoutProfile({ name: '  X  ' });
  assert.equal(profile.id.length > 0, true);
  assert.equal(profile.revision, 1);
  assert.equal(profile.name, 'X');
  assert.equal(profile.enabled, false);
  assert.deepEqual(profile.scope, { mode: 'changes', base: 'main', include: [], exclude: [] });
  assert.deepEqual(profile.sources, [...WORKSPACE_SCOUT_PROFILE_SOURCES]);
  assert.deepEqual(profile.categories, [...WORKSPACE_SCOUT_CATEGORIES]);
  assert.deepEqual(profile.executor, { auto: true, harness: '', model: '', allowedHarnesses: [] });
  assert.deepEqual(profile.schedule, { mode: 'manual', intervalHours: 6 });
  assert.deepEqual(profile.limits, { maxPerDay: 4, maxFindingsPerScan: 10, timeoutMs: 300_000 });

  // Garbage input must not throw and must never lose revision >= 1.
  const garbage = normalizeWorkspaceScoutProfile({ revision: -3, categories: 'nope', scope: 7 });
  assert.equal(garbage.revision, 1);
  assert.equal(normalizeWorkspaceScoutProfile(null).revision, 1);
  assert.equal(normalizeWorkspaceScoutProfile('nope').revision, 1);
  assert.equal(normalizeWorkspaceScoutProfile([]).revision, 1);
});

runCase('defaultWorkspaceScoutProfile is the deterministic disabled general profile', () => {
  const first = defaultWorkspaceScoutProfile();
  const second = defaultWorkspaceScoutProfile();
  assert.deepEqual(first, second);
  assert.equal(first.id, SCOUT_GENERAL_PROFILE_ID);
  assert.equal(first.revision, 1);
  assert.equal(first.enabled, false);
  assert.equal(first.name, 'Scout ogólny');
  assert.deepEqual(first.categories, [...WORKSPACE_SCOUT_CATEGORIES]);
  assert.deepEqual(first.sources, [...WORKSPACE_SCOUT_PROFILE_SOURCES]);
  assert.deepEqual(first.scope, { mode: 'changes', base: 'main', include: [], exclude: [] });
  assert.deepEqual(first.schedule, { mode: 'manual', intervalHours: 6 });
  assert.equal(first.limits.maxPerDay, 4);
  assert.equal(first.limits.maxFindingsPerScan, 10);

  const overridden = defaultWorkspaceScoutProfile({ name: 'Nazwany' });
  assert.equal(overridden.name, 'Nazwany');
  assert.equal(overridden.id, SCOUT_GENERAL_PROFILE_ID);
});

/* ------------------------------------------------------------- validation */

runCase('validateWorkspaceScoutProfile accepts a complete profile', () => {
  const result = validateWorkspaceScoutProfile(validProfile());
  assert.deepEqual(result, { ok: true, errors: [] });
});

runCase('validateWorkspaceScoutProfile rejects malformed input with readable reasons', () => {
  /** @type {Array<[object, RegExp]>} */
  const cases = [
    [validProfile({ name: '' }), /name/],
    [validProfile({ name: 'x'.repeat(121) }), /name/],
    [validProfile({ objective: '' }), /objective/],
    [validProfile({ objective: 'x'.repeat(8001) }), /objective/],
    [validProfile({ instructions: 'x'.repeat(8001) }), /instructions/],
    [validProfile({ categories: [] }), /categories/],
    [validProfile({ categories: ['bug', 'bogus'] }), /kategoria/],
    [validProfile({ sources: ['diff', 'nope'] }), /źródło/],
    [validProfile({ scope: { mode: 'nope' } }), /scope\.mode/],
    [validProfile({ scope: { mode: 'area', include: ['../etc/passwd'] } }), /scope\.include/],
    [validProfile({ scope: { mode: 'area', exclude: [''] } }), /scope\.exclude/],
    [validProfile({ schedule: { mode: 'hourly' } }), /schedule\.mode/],
    [validProfile({ schedule: { mode: 'interval', intervalHours: 0 } }), /intervalHours/],
    [validProfile({ limits: { maxPerDay: -1 } }), /limits\.maxPerDay/],
    [validProfile({ limits: { maxPerDay: 1.5 } }), /limits\.maxPerDay/],
    [validProfile({ limits: { maxPerDay: 101 } }), /limits\.maxPerDay/],
    [validProfile({ limits: { maxFindingsPerScan: 201 } }), /limits\.maxFindingsPerScan/],
    [validProfile({ limits: { timeoutMs: 25 * 60 * 60 * 1000 } }), /limits\.timeoutMs/],
    [validProfile({ executor: { auto: false, harness: 'codex', allowedHarnesses: ['claude'] } }), /allowedHarnesses/],
  ];
  for (const [invalid, pattern] of cases) {
    const result = validateWorkspaceScoutProfile(invalid);
    assert.equal(result.ok, false, `expected invalid for ${JSON.stringify(invalid).slice(0, 90)}`);
    assert.ok(
      result.errors.some((error) => pattern.test(error)),
      `no error matching ${pattern} in ${result.errors.join('; ')}`,
    );
  }

  // An empty allow-list means "no extra restriction", not an empty intersection.
  assert.equal(
    validateWorkspaceScoutProfile(validProfile({
      executor: { auto: false, harness: 'codex', model: '', allowedHarnesses: [] },
    })).ok,
    true,
  );
  // A null/undefined profile is reported, not thrown.
  assert.equal(validateWorkspaceScoutProfile(null).ok, false);
});

runCase('validateWorkspaceScoutProfile enforces the per-workspace profile ceiling', () => {
  const full = validateWorkspaceScoutProfile(validProfile(), { profileCount: 50 });
  assert.equal(full.ok, false);
  assert.ok(full.errors.some((error) => /limit/.test(error)));
  // Updating an existing profile is allowed even at the ceiling.
  assert.equal(validateWorkspaceScoutProfile(validProfile(), { profileCount: 50, isUpdate: true }).ok, true);
  assert.equal(validateWorkspaceScoutProfile(validProfile(), { profileCount: 49 }).ok, true);
});

/* --------------------------------------------------------- legacy migration */

runCase('legacy policy.scout* migrates to exactly one general profile', () => {
  const { cwd, dataDir } = freshWorkspace('legacy-migrate');
  const legacyRow = {
    workspaceFolder: cwd,
    mode: 'observe',
    policy: {
      scoutEnabled: true,
      scoutIntervalHours: 12,
      scoutCategories: ['bug', 'security'],
      scoutAllowedHarnesses: ['claude', 'codex'],
      scoutMaxPerDay: 3,
      scoutMaxPerScan: 7,
      orchestrator: { harness: 'codex', model: 'gpt-5' },
    },
  };
  writeLegacyV1Document(dataDir, cwd, legacyRow);

  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.scoutProfiles.length, 1, 'exactly one migrated profile');
  const profile = row.scoutProfiles[0];
  assert.equal(profile.id, SCOUT_GENERAL_PROFILE_ID);
  assert.equal(profile.revision, 1);
  assert.equal(profile.enabled, true);
  assert.equal(profile.schedule.mode, 'interval');
  assert.equal(profile.schedule.intervalHours, 12);
  assert.deepEqual(profile.categories, ['bug', 'security']);
  assert.equal(profile.limits.maxPerDay, 3);
  assert.equal(profile.limits.maxFindingsPerScan, 7);
  assert.deepEqual(profile.executor.allowedHarnesses, ['claude', 'codex']);
  assert.equal(profile.executor.auto, false);
  assert.equal(profile.executor.harness, 'codex');
  assert.equal(profile.executor.model, 'gpt-5');
  assert.deepEqual(profile.sources, [...WORKSPACE_SCOUT_PROFILE_SOURCES]);

  // Re-normalizing the same legacy row yields one profile again, not two.
  const again = normalizeWorkspaceWatcherRow(legacyRow);
  assert.equal(again.scoutProfiles.length, 1);
  assert.equal(again.scoutProfiles[0].id, SCOUT_GENERAL_PROFILE_ID);

  // A write-then-load round-trip does not duplicate or change the profile.
  const saved = upsertWorkspaceWatcher(cwd, { lastTickAt: '2026-01-02T00:00:00.000Z' }, { dataDir });
  assert.equal(saved.scoutProfiles.length, 1);
  const reloaded = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(reloaded.scoutProfiles.length, 1);
  assert.equal(reloaded.scoutProfiles[0].id, SCOUT_GENERAL_PROFILE_ID);
  assert.equal(reloaded.scoutProfiles[0].enabled, true);
  assert.equal(reloaded.scoutProfiles[0].schedule.intervalHours, 12);
  assert.equal(reloaded.policy.scoutEnabled, true);

  // v2 is what actually lands on disk.
  const doc = JSON.parse(fs.readFileSync(getWorkspaceWatchersDataPath({ dataDir }), 'utf8'));
  assert.equal(doc.v, 2);
  assert.equal(doc.items[cwd].scoutProfiles.length, 1);
});

runCase('legacy empty scoutCategories materialize as all categories', () => {
  const row = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/tmp/legacy-empty-cats',
    policy: { scoutEnabled: false, scoutCategories: [] },
  });
  assert.equal(row.scoutProfiles.length, 1);
  assert.deepEqual(row.scoutProfiles[0].categories, [...WORKSPACE_SCOUT_CATEGORIES]);
  assert.equal(row.scoutProfiles[0].enabled, false);
  // Empty orchestrator means auto selection.
  assert.equal(row.scoutProfiles[0].executor.auto, true);
});

runCase('an explicit scoutProfiles key (even []) is never synthesized again', () => {
  const normalized = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/tmp/has-profiles',
    policy: { scoutEnabled: true, scoutIntervalHours: 9 },
    scoutProfiles: [],
  });
  assert.deepEqual(normalized.scoutProfiles, []);

  const { cwd, dataDir } = freshWorkspace('has-profiles');
  // A fresh upsert with scout policy does not materialize a profile.
  const row = upsertWorkspaceWatcher(cwd, { policy: { scoutEnabled: true } }, { dataDir });
  assert.deepEqual(row.scoutProfiles, []);
  // Reads still expose the virtual general profile without writing it.
  assert.equal(listWorkspaceScoutProfiles(cwd, { dataDir }).length, 1);
  assert.equal(listWorkspaceScoutProfiles(cwd, { dataDir })[0].id, SCOUT_GENERAL_PROFILE_ID);
  assert.deepEqual(getWorkspaceWatcher(cwd, { dataDir }).scoutProfiles, []);
});

/* ------------------------------------------------------------- read helpers */

runCase('empty workspace reads the virtual general profile and writes nothing', () => {
  const { cwd, dataDir } = freshWorkspace('virtual');
  const filePath = getWorkspaceWatchersDataPath({ dataDir });
  assert.equal(fs.existsSync(filePath), false);

  const profiles = listWorkspaceScoutProfiles(cwd, { dataDir });
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, SCOUT_GENERAL_PROFILE_ID);
  assert.equal(profiles[0].enabled, false);
  assert.deepEqual(profiles, listWorkspaceScoutProfiles(cwd, { dataDir }), 'virtual profile is deterministic');

  const general = getWorkspaceScoutProfile(cwd, SCOUT_GENERAL_PROFILE_ID, { dataDir });
  assert.equal(general.id, SCOUT_GENERAL_PROFILE_ID);
  assert.equal(getWorkspaceScoutProfile(cwd, 'missing', { dataDir }), null);

  // Read-only means read-only: no store file appears, and a pre-existing file
  // is left byte-identical.
  assert.equal(fs.existsSync(filePath), false);
  fs.writeFileSync(filePath, JSON.stringify({ v: 2, updatedAt: 'at', revision: 1, items: {} }), 'utf8');
  const before = fs.readFileSync(filePath, 'utf8');
  listWorkspaceScoutProfiles(cwd, { dataDir });
  getWorkspaceScoutProfile(cwd, SCOUT_GENERAL_PROFILE_ID, { dataDir });
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
});

runCase('a non-empty stored list is returned without the virtual general profile', () => {
  const { cwd, dataDir } = freshWorkspace('stored-list');
  const created = upsertWorkspaceScoutProfile(cwd, validProfile(), { dataDir });
  assert.equal(created.ok, true);
  const listed = listWorkspaceScoutProfiles(cwd, { dataDir });
  assert.deepEqual(listed.map((profile) => profile.id), ['perf']);
  assert.equal(getWorkspaceScoutProfile(cwd, SCOUT_GENERAL_PROFILE_ID, { dataDir }), null);
  assert.equal(getWorkspaceScoutProfile(cwd, 'perf', { dataDir }).id, 'perf');
});

/* ------------------------------------------------------------ upsert CAS */

runCase('upsertWorkspaceScoutProfile creates, bumps revision and enforces CAS', () => {
  const { cwd, dataDir } = freshWorkspace('cas');
  const created = upsertWorkspaceScoutProfile(cwd, validProfile(), { dataDir });
  assert.equal(created.ok, true);
  assert.equal(created.profile.revision, 1);
  assert.equal(created.profile.createdAt, created.profile.updatedAt);

  const first = upsertWorkspaceScoutProfile(cwd, validProfile({ name: 'Wydajność v2' }), {
    dataDir,
    expectedRevision: 1,
  });
  assert.equal(first.ok, true);
  assert.equal(first.profile.revision, 2);
  assert.equal(first.profile.name, 'Wydajność v2');

  // Second writer still on revision 1 must lose.
  const stale = upsertWorkspaceScoutProfile(cwd, validProfile({ name: 'Wydajność v3' }), {
    dataDir,
    expectedRevision: 1,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'revision_conflict');

  // A missing expectedRevision is also a conflict.
  const missing = upsertWorkspaceScoutProfile(cwd, validProfile({ name: 'Bez CAS' }), { dataDir });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'revision_conflict');

  const read = getWorkspaceScoutProfile(cwd, 'perf', { dataDir });
  assert.equal(read.revision, 2);
  assert.equal(read.name, 'Wydajność v2');

  // Another valid write moves it forward again.
  const second = upsertWorkspaceScoutProfile(cwd, validProfile({ name: 'Wydajność v4' }), {
    dataDir,
    expectedRevision: 2,
  });
  assert.equal(second.ok, true);
  assert.equal(second.profile.revision, 3);
  assert.equal(getWorkspaceScoutProfile(cwd, 'perf', { dataDir }).name, 'Wydajność v4');
});

runCase('upsertWorkspaceScoutProfile rejects invalid input without writing', () => {
  const { cwd, dataDir } = freshWorkspace('invalid-upsert');
  const emptyCategories = upsertWorkspaceScoutProfile(cwd, validProfile({ categories: [] }), { dataDir });
  assert.equal(emptyCategories.ok, false);
  assert.equal(emptyCategories.reason, 'invalid');
  assert.ok(emptyCategories.errors.some((error) => /categories/.test(error)));
  assert.deepEqual(getWorkspaceWatcher(cwd, { dataDir }), null, 'a rejected upsert never materializes a row');

  const noName = upsertWorkspaceScoutProfile(cwd, validProfile({ name: '' }), { dataDir });
  assert.equal(noName.ok, false);
  assert.equal(noName.reason, 'invalid');

  // The store row only appears once a valid profile is written.
  assert.equal(upsertWorkspaceScoutProfile(cwd, validProfile(), { dataDir }).ok, true);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).scoutProfiles.length, 1);
});

/* ----------------------------------------- legacy fields survive migration */

runCase('migration keeps legacy scout state intact through a round-trip', () => {
  const { cwd, dataDir } = freshWorkspace('legacy-keep');
  const policy = {
    ...defaultWorkspaceWatcherPolicy(),
    scoutEnabled: true,
    scoutIntervalHours: 4,
    scoutAutoCreate: true,
    scoutAllowedHarnesses: ['claude'],
    scoutCategories: ['bug'],
    scoutMaxPerDay: 5,
    scoutMaxPerScan: 9,
    scoutTestProbe: true,
    scoutTestCommand: ['node', '-v'],
    orchestrator: { harness: '', model: '' },
  };
  const legacyRow = {
    workspaceFolder: cwd,
    mode: 'observe',
    policy,
    lastScoutAt: '2026-02-02T10:00:00.000Z',
    scoutScans: { day: '2026-02-02', count: 1 },
    activeScoutScan: {
      scanId: 'scan-9',
      chatId: 'chat-9',
      startedAt: '2026-02-02T10:00:00.000Z',
      expiresAt: '2026-02-02T11:00:00.000Z',
      submitToken: 'secret-token',
    },
    pendingScoutFindings: [{ title: 'Keep me', category: 'bug', status: 'pending' }],
  };
  writeLegacyV1Document(dataDir, cwd, legacyRow);

  // A read materializes the profile in memory only.
  const read = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(read.scoutProfiles.length, 1);

  const mutated = mutateWorkspaceWatcherRow(cwd, () => ({ mode: 'off' }), { dataDir });
  assert.equal(mutated.ok, true);

  const after = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(after.lastScoutAt, '2026-02-02T10:00:00.000Z');
  assert.deepEqual(after.scoutScans, { day: '2026-02-02', count: 1 });
  // The v1 singleton is migrated into the collection; the mirror keeps the five
  // legacy fields and adds the v2 Scout identity + snapshot.
  assert.equal(after.activeScoutScans.length, 1);
  assert.equal(after.activeScoutScans[0].scanId, 'scan-9');
  assert.equal(after.activeScoutScans[0].chatId, 'chat-9');
  assert.equal(after.activeScoutScans[0].startedAt, '2026-02-02T10:00:00.000Z');
  assert.equal(after.activeScoutScans[0].expiresAt, '2026-02-02T11:00:00.000Z');
  assert.equal(after.activeScoutScans[0].submitToken, 'secret-token');
  assert.equal(after.activeScoutScans[0].scoutId, SCOUT_GENERAL_PROFILE_ID);
  assert.equal(after.activeScoutScans[0].snapshot.id, SCOUT_GENERAL_PROFILE_ID);
  assert.equal(after.activeScoutScan.scanId, 'scan-9');
  assert.equal(after.activeScoutScan.submitToken, 'secret-token');
  assert.equal(after.pendingScoutFindings.length, 1);
  assert.equal(after.pendingScoutFindings[0].title, 'Keep me');
  assert.equal(after.pendingScoutFindings[0].status, 'pending');

  assert.equal(after.policy.scoutEnabled, true);
  assert.equal(after.policy.scoutIntervalHours, 4);
  assert.equal(after.policy.scoutAutoCreate, true);
  assert.deepEqual(after.policy.scoutAllowedHarnesses, ['claude']);
  assert.deepEqual(after.policy.scoutCategories, ['bug']);
  assert.equal(after.policy.scoutMaxPerDay, 5);
  assert.equal(after.policy.scoutMaxPerScan, 9);
  assert.equal(after.policy.scoutTestProbe, true);
  assert.deepEqual(after.policy.scoutTestCommand, ['node', '-v']);

  // The migrated profile mirrors the same values and is still a single entry.
  assert.equal(after.scoutProfiles.length, 1);
  assert.equal(after.scoutProfiles[0].enabled, true);
  assert.equal(after.scoutProfiles[0].schedule.intervalHours, 4);
  assert.equal(after.scoutProfiles[0].limits.maxPerDay, 5);
  assert.deepEqual(after.scoutProfiles[0].categories, ['bug']);
});

/* ----------------------------------------------------------------- finish */

Promise.all(pending).then(() => {
  removeIsolatedDataDir();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`\nworkspace scout profile tests: ${failed} failure(s)`);
    process.exit(1);
  }
  console.log('\nworkspace scout profile tests passed');
});
