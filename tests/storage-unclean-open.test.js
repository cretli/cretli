import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStorageDb } from '../lib/storage/db-lifecycle.js';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-worker-handlers.js', import.meta.url));
const hosts = [];
const roots = [];

function prepareUncleanStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-storage-unclean-'));
  roots.push(root);
  openStorageDb({ dir: root }).close();
  openStorageDb({ dir: root, fullCheck: true }).close();
  const dbFile = path.join(root, 'cretli-store.sqlite');
  fs.rmSync(`${dbFile}.clean`, { force: true });
  return { root, dbFile, stampFile: `${dbFile}.full-check` };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close({ timeoutMs: 1000 }).catch(() => {});
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('unclean storage open', () => {
  it('opens from a recent stamp and completes integrity_check in the background worker', async () => {
    const { root, dbFile, stampFile } = prepareUncleanStore();
    const priorStamp = JSON.parse(fs.readFileSync(stampFile, 'utf8')).lastFullCheckAt;
    const host = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH });
    hosts.push(host);
    await host.start();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && JSON.parse(fs.readFileSync(stampFile, 'utf8')).lastFullCheckAt <= priorStamp) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(JSON.parse(fs.readFileSync(stampFile, 'utf8')).lastFullCheckAt > priorStamp);
    assert.equal(fs.existsSync(`${dbFile}.check-failed`), false);
  });

  it('persists a corruption finding and refuses the following ordinary open', async () => {
    const { root, dbFile } = prepareUncleanStore();
    const host = createStorageWorkerHost({
      dbDir: root,
      handlersPath: HANDLERS_PATH,
      faultInjection: true,
      deferredCheckFault: 'corrupt',
    });
    hosts.push(host);
    await host.start();
    const failedMarker = `${dbFile}.check-failed`;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !fs.existsSync(failedMarker)) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(failedMarker), true);
    assert.throws(() => openStorageDb({ dir: root }), (error) => error.code === 'corrupt');
  });

  it('does not mark a non-corruption background error as a corrupt store', async () => {
    const { root, dbFile, stampFile } = prepareUncleanStore();
    const previousStamp = JSON.parse(fs.readFileSync(stampFile, 'utf8')).lastFullCheckAt;
    const host = createStorageWorkerHost({
      dbDir: root,
      handlersPath: HANDLERS_PATH,
      faultInjection: true,
      deferredCheckFault: 'ioerr',
    });
    hosts.push(host);
    await host.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(`${dbFile}.check-failed`), false);
    assert.equal(JSON.parse(fs.readFileSync(stampFile, 'utf8')).lastFullCheckAt, previousStamp);
    fs.writeFileSync(`${dbFile}.check-failed`, JSON.stringify({ failedAt: Date.now() }));
    assert.doesNotThrow(() => openStorageDb({ dir: root, fullCheck: true }).close());
    assert.equal(fs.existsSync(`${dbFile}.check-failed`), false);
  });
});
