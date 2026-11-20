import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  checkStorageRuntime,
  MIN_STORAGE_NODE_VERSION,
  MIN_STORAGE_SQLITE_VERSION,
  parseVersion,
} from '../lib/storage/runtime-check.js';
import {
  fromJSON,
  isStorageError,
  isStorageErrorCode,
  StorageError,
  STORAGE_ERROR_CODES,
} from '../lib/storage/errors.js';
import { readMinimumNode } from '../scripts/node-version-check.mjs';

const SUPPORTED = Object.freeze({
  nodeVersion: '22.18.0',
  sqliteVersion: '3.51.0',
  foreignKeys: true,
  backupApi: true,
});

/**
 * @param {() => unknown} fn
 * @returns {StorageError}
 */
function captureStorageError(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(isStorageError(err), `expected StorageError, got ${err}`);
    return /** @type {StorageError} */ (err);
  }
  assert.fail('expected checkStorageRuntime to throw');
}

describe('storage runtime check', () => {
  it('pins the minimums from docs/storage-gates.md', () => {
    assert.equal(MIN_STORAGE_NODE_VERSION, '22.18.0');
    assert.equal(MIN_STORAGE_SQLITE_VERSION, '3.51.0');
  });

  it('parses versions with and without a v prefix', () => {
    assert.deepEqual(parseVersion('v22.16.1'), [22, 16, 1]);
    assert.deepEqual(parseVersion('3.51'), [3, 51, 0]);
    assert.equal(parseVersion('not-a-version'), null);
    assert.equal(parseVersion(undefined), null);
  });

  it('rejects trailing garbage and treats a prerelease as its release triple', () => {
    for (const bad of ['22.16abc', '3.51.0.junk', '22.16.0.1', '22.16.', '22', '']) {
      assert.equal(parseVersion(bad), null, bad);
    }
    assert.deepEqual(parseVersion('22.16.0-rc.1'), [22, 16, 0]);
    assert.deepEqual(parseVersion('v24.0.0-nightly2025'), [24, 0, 0]);
  });

  it('accepts the minimum supported pair without probing SQLite', () => {
    const result = checkStorageRuntime({
      ...SUPPORTED,
      loadSqlite: () => assert.fail('must not probe when everything is injected'),
    });
    assert.deepEqual(result, {
      ok: true,
      node: '22.18.0',
      sqlite: '3.51.0',
      features: { foreignKeys: true, backupApi: true },
    });
  });

  it('rejects Node older than 22.18 before loading SQLite', () => {
    for (const nodeVersion of ['22.13.0', '22.15.9', '22.17.9', 'v20.19.0', 'garbage']) {
      let loaded = false;
      const err = captureStorageError(() => checkStorageRuntime({
        ...SUPPORTED,
        nodeVersion,
        sqliteVersion: undefined,
        loadSqlite: () => { loaded = true; throw new Error('must not load SQLite on an old Node'); },
      }));
      assert.equal(loaded, false, `SQLite loaded before the Node check for ${nodeVersion}`);
      assert.equal(err.code, 'unsupported_runtime');
      assert.equal(err.retryable, false);
      assert.equal(err.details.actualNode, nodeVersion);
      assert.equal(err.details.requiredNode, '22.18.0');
    }
  });

  it('rejects bundled SQLite older than 3.51.0', () => {
    const err = captureStorageError(() => checkStorageRuntime({ ...SUPPORTED, sqliteVersion: '3.50.4' }));
    assert.equal(err.code, 'unsupported_runtime');
    assert.equal(err.details.actualSqlite, '3.50.4');
    assert.equal(err.details.requiredSqlite, '3.51.0');
  });

  it('rejects missing foreign keys or backup API', () => {
    const err = captureStorageError(() => checkStorageRuntime({
      ...SUPPORTED,
      foreignKeys: false,
      backupApi: false,
    }));
    assert.equal(err.code, 'unsupported_runtime');
    assert.deepEqual(err.details.missingFeatures, ['foreign_keys', 'backup_api']);
  });

  it('maps an unloadable node:sqlite to unsupported_runtime with the cause kept server-side', () => {
    const cause = new Error('Cannot find module node:sqlite at /home/someone/secret');
    const err = captureStorageError(() => checkStorageRuntime({
      nodeVersion: '22.18.0',
      loadSqlite: () => { throw cause; },
    }));
    assert.equal(err.code, 'unsupported_runtime');
    assert.equal(err.cause, cause);
    assert.doesNotMatch(JSON.stringify(err), /secret|\/home/);
  });

  it('probes SQLite through an injected module (in-memory only)', () => {
    const opened = [];
    const fakeSqlite = {
      backup() {},
      DatabaseSync: class {
        constructor(path) { opened.push(path); }
        prepare(sql) {
          return {
            get: () => (sql.includes('sqlite_version') ? { version: '3.51.3' } : { foreign_keys: 1 }),
          };
        }
        exec() {}
        close() {}
      },
    };
    const result = checkStorageRuntime({ nodeVersion: '24.0.0', loadSqlite: () => fakeSqlite });
    assert.equal(result.sqlite, '3.51.3');
    assert.deepEqual(opened, [':memory:']);
  });

  it('reports a build without foreign key support', () => {
    const fakeSqlite = {
      backup() {},
      DatabaseSync: class {
        prepare(sql) {
          return { get: () => (sql.includes('sqlite_version') ? { version: '3.52.0' } : undefined) };
        }
        exec() {}
        close() {}
      },
    };
    const err = captureStorageError(() => checkStorageRuntime({ nodeVersion: '24.0.0', loadSqlite: () => fakeSqlite }));
    assert.deepEqual(err.details.missingFeatures, ['foreign_keys']);
  });

  it('accepts the live runtime when bundled SQLite is >= 3.51', (t) => {
    const live = parseVersion(process.versions.sqlite);
    if (!live || live[0] < 3 || (live[0] === 3 && live[1] < 51)) {
      t.skip(`bundled SQLite ${process.versions.sqlite} < 3.51 on this runtime`);
      return;
    }
    const result = checkStorageRuntime();
    assert.equal(result.ok, true);
    assert.equal(result.node, process.versions.node);
    assert.equal(result.sqlite, process.versions.sqlite);
  });

  it('closes the probe database on the success and throw paths', () => {
    let closed = 0;
    const makeSqlite = (failOn) => ({
      backup() {},
      DatabaseSync: class {
        prepare(sql) {
          if (sql.includes(failOn)) throw new Error('boom');
          return { get: () => (sql.includes('sqlite_version') ? { version: '3.51.0' } : { foreign_keys: 1 }) };
        }
        exec() {}
        close() { closed += 1; }
      },
    });
    checkStorageRuntime({ nodeVersion: '24.0.0', loadSqlite: () => makeSqlite('none') });
    assert.equal(closed, 1);
    const err = captureStorageError(() => checkStorageRuntime({
      nodeVersion: '24.0.0',
      loadSqlite: () => makeSqlite('sqlite_version'),
    }));
    assert.equal(err.code, 'unsupported_runtime');
    assert.equal(closed, 2);
  });

  it('keeps the Node floor in sync across package.json, test runner, registry and constant', () => {
    const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    const engines = JSON.parse(read('package.json')).engines.node;
    assert.match(engines, /^>=\d+\.\d+(\.\d+)?$/);
    const [major, minor] = parseVersion(engines.slice(2));
    // The runner derives its floor from package.json via assertNodeVersion (single source).
    const runner = read('scripts/run-unit-tests.mjs');
    assert.match(runner, /import \{ assertNodeVersion \} from '\.\/node-version-check\.mjs'/);
    assert.match(runner, /assertNodeVersion\(path\.join\(projectRoot, 'package\.json'\)\)/);
    assert.deepEqual(
      readMinimumNode(new URL('../package.json', import.meta.url).pathname),
      [major, minor, 0],
    );
    const matrix = JSON.parse(read('docs/storage-registry.json')).runtimeMatrix;
    assert.deepEqual(parseVersion(matrix.enginesNode), [major, minor, 0]);
    assert.deepEqual(parseVersion(matrix.minNode), [major, minor, 0]);
    assert.deepEqual(parseVersion(MIN_STORAGE_NODE_VERSION), [major, minor, 0]);
  });
});

describe('start-server-node22.sh', () => {
  const script = new URL('../scripts/start-server-node22.sh', import.meta.url).pathname;
  const run = (version) => spawnSync('bash', [script], {
    env: { ...process.env, CRETLI_NODE_VERSION_OVERRIDE: version },
    encoding: 'utf8',
    timeout: 20000,
  });

  it('exits with an error when Node is below the floor', () => {
    for (const version of ['22.17.9', '22.16.0', '20.19.0']) {
      const res = run(version);
      assert.equal(res.status, 1, version);
      assert.match(res.stderr, /needs >= 22\.18/);
    }
  });
});

describe('StorageError', () => {
  it('exposes every stable code with a retryable default', () => {
    assert.deepEqual(Object.values(STORAGE_ERROR_CODES).sort(), [
      'busy', 'conflict', 'corrupt', 'full_disk', 'io', 'missing', 'unknown_commit', 'unsupported_runtime',
    ]);
    const retryable = Object.fromEntries(
      Object.values(STORAGE_ERROR_CODES).map((code) => [code, new StorageError(code).retryable]),
    );
    assert.deepEqual(retryable, {
      missing: false,
      corrupt: false,
      io: true,
      conflict: false,
      busy: true,
      full_disk: false,
      unsupported_runtime: false,
      unknown_commit: false,
    });
    assert.equal(isStorageErrorCode('busy'), true);
    assert.equal(isStorageErrorCode('nope'), false);
  });

  it('rejects unknown codes', () => {
    assert.throws(() => new StorageError('nope'), TypeError);
  });

  it('keeps name, code, cause and an explicit retryable override', () => {
    const cause = new Error('SQLITE_BUSY');
    const err = new StorageError('busy', 'database is locked', { cause, retryable: false });
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'StorageError');
    assert.equal(err.code, 'busy');
    assert.equal(err.cause, cause);
    assert.equal(err.retryable, false);
    assert.equal(err.message, 'database is locked');
  });

  it('serializes without raw message, cause, stack, paths or unknown details', () => {
    const err = new StorageError('io', 'EIO writing /home/someone/data/chats.sqlite token=abc123', {
      cause: new Error('EIO /home/someone/data/chats.sqlite'),
      details: {
        storeId: 'store.chats',
        operation: 'append',
        commandId: 'cmd-1',
        path: '/home/someone/data/chats.sqlite',
        token: 'abc123',
        actualNode: '/usr/bin/node',
        missingFeatures: ['backup_api', 'C:\\data'],
        nested: { secret: 'x' },
      },
    });
    const json = JSON.parse(JSON.stringify(err));
    assert.deepEqual(json, {
      name: 'StorageError',
      code: 'io',
      message: 'Storage I/O error',
      retryable: true,
      details: {
        storeId: 'store.chats',
        operation: 'append',
        commandId: 'cmd-1',
        missingFeatures: ['backup_api'],
      },
    });
    assert.doesNotMatch(JSON.stringify(err), /home|abc123|stack|cause/);
  });
});

describe('StorageError wire format', () => {
  it('round-trips toJSON through fromJSON keeping whitelist semantics', () => {
    const original = new StorageError('conflict', 'secret /home/x', {
      details: { storeId: 'store.chats', expectedRevision: 3, actualRevision: 4, path: '/etc' },
    });
    const revived = fromJSON(JSON.parse(JSON.stringify(original)));
    assert.ok(revived instanceof StorageError);
    assert.equal(revived.code, 'conflict');
    assert.equal(revived.retryable, false);
    assert.deepEqual(revived.details, { storeId: 'store.chats', expectedRevision: 3, actualRevision: 4 });
    assert.deepEqual(revived.toJSON(), original.toJSON());
  });

  it('re-sanitizes revived details and rejects invalid shapes', () => {
    const revived = fromJSON({
      name: 'StorageError',
      code: 'io',
      details: { operation: 'x', actualNode: '/usr/bin/node', missingFeatures: [['nested'], 'a'], expectedRevision: Infinity, actualRevision: NaN },
    });
    assert.deepEqual(revived.details, { operation: 'x', missingFeatures: ['a'] });
    for (const bad of [null, 'x', {}, { name: 'Error', code: 'io' }, { name: 'StorageError', code: 'nope' }]) {
      assert.equal(fromJSON(bad), null);
    }
  });

  it('isStorageError accepts the known name+code shape but not lookalikes', () => {
    assert.equal(isStorageError({ name: 'StorageError', code: 'busy' }), true);
    assert.equal(isStorageError({ name: 'StorageError', code: 'ENOENT' }), false);
    assert.equal(isStorageError(new Error('x')), false);
    assert.equal(isStorageError(null), false);
  });

  it('drops non-finite numbers and nested arrays when constructing', () => {
    const err = new StorageError('conflict', undefined, {
      details: { expectedRevision: NaN, actualRevision: 2, missingFeatures: [['a'], 'b', Infinity] },
    });
    assert.deepEqual(err.details, { actualRevision: 2, missingFeatures: ['b'] });
  });
});
