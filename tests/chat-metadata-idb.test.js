/**
 * Task 5.1 — chatMetadataIdb status / epoch guards (node, mock IDB).
 *
 * Run: node tests/chat-metadata-idb.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_METADATA_IDB_NAME, CHAT_METADATA_STORE_META } from '../app_front/features/chat/chatMetadataIdbSchema.js';
import {
  __resetChatMetadataIdbForTest,
  __testAbortMetadataWriteTransaction,
  __testOpenChatMetadataDatabase,
  __testTransactionFailureOnAbortOnlyForTest,
  getChatMetadataDb,
  getChatMetadataIdbStatus,
  getChatMetadataKv,
  invalidateChatMetadataIdbSession,
  putChatMetadataKv,
  setChatMetadataIdbSessionScope,
} from '../app_front/features/chat/chatMetadataIdb.js';

test('blocked open is not overwritten by later onsuccess', async () => {
  __resetChatMetadataIdbForTest();
  let closeCount = 0;
  const dbHandle = {
    close() {
      closeCount += 1;
    },
  };
  const factory = {
    open(name, version) {
      assert.equal(name, CHAT_METADATA_IDB_NAME);
      assert.ok(version >= 1);
      const req = {
        result: dbHandle,
        onblocked: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        if (typeof req.onblocked === 'function') req.onblocked();
        queueMicrotask(() => {
          if (typeof req.onsuccess === 'function') req.onsuccess();
        });
      });
      return req;
    },
  };
  const db = await __testOpenChatMetadataDatabase({ idb: () => factory }, 1);
  assert.equal(db, null);
  assert.equal(closeCount, 1);
  assert.equal(getChatMetadataIdbStatus(), 'blocked');
  __resetChatMetadataIdbForTest();
});

test('quota from onabort when tx.error is QuotaExceededError (no onerror)', () => {
  __resetChatMetadataIdbForTest();
  assert.equal(__testTransactionFailureOnAbortOnlyForTest({ name: 'QuotaExceededError' }), 'quota');
  __resetChatMetadataIdbForTest();
});

test('put catch marks quota before abort so onabort does not downgrade', async () => {
  __resetChatMetadataIdbForTest();
  const scope = { sessionId: 'sess-q', generation: 1 };
  setChatMetadataIdbSessionScope(scope);
  const factory = createMinimalReadWriteFactory({
    throwOnPut: true,
    abortErrorName: 'QuotaExceededError',
  });
  await __testOpenChatMetadataDatabase({ idb: () => factory }, 1);
  const ok = await putChatMetadataKv('k', 'v', scope, { idb: () => factory });
  assert.equal(ok, false);
  assert.equal(getChatMetadataIdbStatus(), 'quota');
  __resetChatMetadataIdbForTest();
});

test('getChatMetadataDb does not cache db after blocked open', async () => {
  __resetChatMetadataIdbForTest();
  let closeCount = 0;
  const dbHandle = {
    close() {
      closeCount += 1;
    },
    objectStoreNames: { contains() { return false; } },
    transaction() {
      throw new Error('unexpected');
    },
  };
  const factory = {
    open(name, version) {
      void version;
      assert.equal(name, CHAT_METADATA_IDB_NAME);
      const req = {
        result: dbHandle,
        onblocked: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        if (typeof req.onblocked === 'function') req.onblocked();
        queueMicrotask(() => {
          if (typeof req.onsuccess === 'function') req.onsuccess();
        });
      });
      return req;
    },
  };
  const db = await getChatMetadataDb({ idb: () => factory });
  assert.equal(db, null);
  assert.equal(closeCount, 1);
  assert.equal(getChatMetadataIdbStatus(), 'blocked');
  __resetChatMetadataIdbForTest();
});

test('putChatMetadataKv rejects commit when epoch bumps before oncomplete', async () => {
  __resetChatMetadataIdbForTest();
  const scope = { sessionId: 'sess-put', generation: 1 };
  setChatMetadataIdbSessionScope(scope);
  /** @type {(() => void) | null} */
  let resumePut = null;
  const factory = createMinimalReadWriteFactory({
    onPutComplete: (resume) => {
      resumePut = resume;
    },
  });
  await __testOpenChatMetadataDatabase({ idb: () => factory }, 1);
  const putPromise = putChatMetadataKv('k-epoch', 'v', scope, { idb: () => factory });
  await invalidateChatMetadataIdbSession('epoch-bump');
  resumePut?.();
  const ok = await putPromise;
  assert.equal(ok, false);
  assert.equal(getChatMetadataIdbStatus(), 'stale-session');
  __resetChatMetadataIdbForTest();
});

test('getChatMetadataKv rejects payload when epoch bumps before resolve', async () => {
  __resetChatMetadataIdbForTest();
  const scope = { sessionId: 'sess-a', generation: 1 };
  setChatMetadataIdbSessionScope(scope);
  const row = { key: 'k', value: 'stale-value', sessionId: 'sess-a', generation: 1 };
  /** @type {(() => void) | null} */
  let resolveGet = null;
  const factory = createDeferredGetFactory(row, (resume) => {
    resolveGet = resume;
  });
  const readPromise = getChatMetadataKv('k', scope, { idb: () => factory });
  await invalidateChatMetadataIdbSession('epoch-bump');
  resolveGet?.();
  const value = await readPromise;
  assert.equal(value, null);
  assert.equal(getChatMetadataIdbStatus(), 'stale-session');
  __resetChatMetadataIdbForTest();
});

test('aborted module transaction surfaces aborted status', async () => {
  __resetChatMetadataIdbForTest();
  setChatMetadataIdbSessionScope({ sessionId: 's1', generation: 1 });
  const factory = createMinimalReadWriteFactory();
  await __testOpenChatMetadataDatabase({ idb: () => factory }, 1);
  const status = await __testAbortMetadataWriteTransaction({ idb: () => factory });
  assert.equal(status, 'aborted');
  __resetChatMetadataIdbForTest();
});

/**
 * @param {object} row
 * @param {(resume: () => void) => void} beforeResolve
 */
function createDeferredGetFactory(row, beforeResolve) {
  return createMinimalReadWriteFactory({
    onGet(key, resume) {
      beforeResolve(() => {
        resume(row);
      });
    },
  });
}

/**
 * @param {{
 *   onGet?: (key: string, resume: (result: unknown) => void) => void,
 *   onPutComplete?: (resume: () => void) => void,
 *   throwOnPut?: boolean,
 *   abortErrorName?: string,
 * }} [hooks]
 */
function createMinimalReadWriteFactory(hooks = {}) {
  const stores = new Map();
  const db = {
    objectStoreNames: {
      contains(name) {
        return name === CHAT_METADATA_STORE_META;
      },
    },
    transaction(storeName, mode) {
      assert.equal(storeName, CHAT_METADATA_STORE_META);
      void mode;
      const tx = {
        error: null,
        onabort: null,
        onerror: null,
        oncomplete: null,
        objectStore() {
          return {
            put(value) {
              if (hooks.throwOnPut) {
                const err = new Error('quota');
                err.name = 'QuotaExceededError';
                throw err;
              }
              stores.set(value.key, value);
              const complete = () => {
                queueMicrotask(() => {
                  if (typeof tx.oncomplete === 'function') tx.oncomplete();
                });
              };
              if (hooks.onPutComplete) {
                hooks.onPutComplete(complete);
              } else {
                complete();
              }
            },
            get(key) {
              const req = {
                result: undefined,
                onsuccess: null,
                onerror: null,
              };
              const finish = (result) => {
                req.result = result;
                queueMicrotask(() => {
                  if (typeof req.onsuccess === 'function') req.onsuccess();
                  queueMicrotask(() => {
                    if (typeof tx.oncomplete === 'function') tx.oncomplete();
                  });
                });
              };
              if (hooks.onGet) {
                hooks.onGet(String(key), finish);
              } else {
                finish(stores.get(key));
              }
              return req;
            },
          };
        },
        abort() {
          if (hooks.abortErrorName) {
            tx.error = { name: hooks.abortErrorName };
          }
          queueMicrotask(() => {
            if (typeof tx.onabort === 'function') tx.onabort();
          });
        },
      };
      return tx;
    },
    close() {},
  };
  return {
    open(name, version) {
      assert.equal(name, CHAT_METADATA_IDB_NAME);
      void version;
      const req = {
        result: db,
        onblocked: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        if (typeof req.onsuccess === 'function') req.onsuccess();
      });
      return req;
    },
  };
}
