/**
 * Append input snapshot (PARENT-F3): the adapter and the pending buffer take their own immutable JSON copy of the
 * caller's input before the first await, so digest, pre-validation, pending entries, dispatch, receipts and
 * recovery all see the same bytes. Synthetic data in temp dirs only.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StorageError } from '../lib/storage/errors.js';
import { bootParts, chatIdOf, makeRoot, userRec } from './fixtures/storage-history-adapter-harness.js';

let root;
let booted = [];
beforeEach(() => { root = makeRoot('cretli-history-snapshot-'); booted = []; });
afterEach(async () => {
  for (const parts of booted.reverse()) await parts.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});
async function boot(options = {}) {
  const parts = await bootParts({ root, ...options });
  booted.push(parts);
  return parts;
}
const pendingFiles = () => fs.readdirSync(path.join(root, 'pending', 'entries')).map((name) => path.join(root, 'pending', 'entries', name));

for (const [label, size] of [['regular', 2 * 1024], ['large', 300 * 1024]]) {
  describe(`append input snapshot (${label} record)`, () => {
    it('keeps the bytes durable at fsync time when the caller mutates the record after recordMany', async () => {
      const chat = chatIdOf(1);
      const original = userRec('a'.repeat(size));
      const parts = await boot({
        wrapPendingBuffer: (buffer) => ({
          ...buffer,
          recordMany: async (entries) => {
            const saved = await buffer.recordMany(entries);
            const onDisk = pendingFiles().map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
            assert.ok(onDisk.length > 0);
            original.text = 'b'.repeat(size);
            return saved;
          },
        }),
      });
      const result = await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: original }]);
      assert.equal(result.appended[0].rec.text, 'a'.repeat(size));
      assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events[0].rec.text, 'a'.repeat(size));
    });

    it('is immune to a mutation right after the call starts (before the first await resolves)', async () => {
      const chat = chatIdOf(2);
      const original = userRec('a'.repeat(size));
      const parts = await boot();
      const pending = parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: original }]);
      original.text = 'z';
      const result = await pending;
      assert.equal(result.appended[0].rec.text, 'a'.repeat(size));
    });
  });
}

describe('append input snapshot (buffer + recovery)', () => {
  it('pending buffer entries are private frozen copies, also across list/get/listBatch', async () => {
    const parts = await boot();
    const payload = { events: [{ rec: userRec('x') }] };
    const [saved] = await parts.pendingBuffer.recordMany([{ commandId: 'hist.ae.snap1', producerId: 'p', operation: 'appendEvents', chatId: chatIdOf(3), payload }]);
    payload.events[0].rec.text = 'mutated';
    assert.equal(saved.payload.events[0].rec.text, 'x');
    assert.equal(parts.pendingBuffer.get('hist.ae.snap1').payload.events[0].rec.text, 'x');
    assert.throws(() => { parts.pendingBuffer.list()[0].payload.events[0].rec.text = 'q'; }, TypeError);
    assert.equal(JSON.parse(fs.readFileSync(pendingFiles()[0], 'utf8')).payload.events[0].rec.text, 'x');
  });

  it('retry after a partially staged large record re-drives the original snapshot', async () => {
    const chat = chatIdOf(4);
    const original = userRec('a'.repeat(300 * 1024));
    let failed = false;
    const parts = await boot({
      wrapStore: (store) => ({
        ...store,
        stageFragment: async (args) => {
          if (args.index === 1 && !failed) {
            failed = true;
            throw new StorageError('unknown_commit', 'lost', { details: { operation: 'history', commitState: 'unknown' } });
          }
          return store.stageFragment(args);
        },
        resolveUnknown: async () => { throw new StorageError('io', 'cannot reconcile', { retryable: false }); },
      }),
    });
    let token;
    try {
      await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: original }]);
    } catch (error) {
      token = error.details?.retryToken;
    }
    original.text = 'b'.repeat(300 * 1024);
    assert.ok(token, 'the append reports a retry token');
    {
      const retry = await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('a'.repeat(300 * 1024)) }], { retryToken: token });
      assert.equal(retry.ok, true);
    }
    const events = (await parts.adapter.getChatHistorySince(chat, 0, 10)).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].rec.text[0], 'a');
  });

  it('keeps unknown keys, own __proto__, Unicode and lone surrogates; runs toJSON once', async () => {
    const chat = chatIdOf(5);
    let calls = 0;
    const rec = JSON.parse('{"kind":"localUser","text":"\\ud800 zażółć \\ud83d\\ude00","__proto__":{"k":1},"extra":{"n":[1,2]}}');
    rec.stamp = { toJSON() { calls += 1; return `v${calls}`; } };
    const parts = await boot();
    await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec }]);
    assert.equal(calls, 1);
    const stored = (await parts.adapter.getChatHistorySince(chat, 0, 10)).events[0].rec;
    assert.equal(stored.text, '\ud800 zażółć 😀');
    assert.deepEqual(Object.getOwnPropertyDescriptor(stored, '__proto__')?.value, { k: 1 });
    assert.deepEqual(stored.extra, { n: [1, 2] });
    assert.equal(stored.stamp, 'v1');
  });

  it('refuses cyclic / unsupported records explicitly before anything is pending or acknowledged', async () => {
    const chat = chatIdOf(6);
    const parts = await boot();
    const cyclic = userRec('c');
    cyclic.self = cyclic;
    for (const bad of [cyclic, { ...userRec('f'), fn: () => 1 }, { ...userRec('m'), m: new Map() }, { ...userRec('b'), n: 1n }]) {
      await assert.rejects(parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('ok') }, { rec: bad }]),
        (error) => error.code === 'history_record_unserializable' && error.details?.commitState === 'not_committed');
    }
    assert.equal(pendingFiles().length, 0);
    assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.length, 0);
  });
});
