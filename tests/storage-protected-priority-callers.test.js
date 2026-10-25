import { scratchDataDir } from './fixtures/storage-history-scratch-data.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bootParts, chatIdOf, makeRoot, userRec } from './fixtures/storage-history-adapter-harness.js';

assert.ok(scratchDataDir.includes('cretli-history-scratch-data-'), 'legacy persistence must run on scratch data');
const { MAILBOX_HISTORY_PRIORITY } = await import('../lib/delegation-mailbox.js');

/** @type {string} */
let root;
/** @type {Awaited<ReturnType<typeof bootParts>>[]} */
let booted;

beforeEach(() => {
  root = makeRoot();
  booted = [];
});
afterEach(async () => {
  for (const parts of booted) await parts.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('protected storage priority on the delegation ack/report path', () => {
  it('mailbox history cards use a protected (non-normal) class', () => {
    assert.equal(MAILBOX_HISTORY_PRIORITY, 'final');
  });

  it('forwards callOptions.priority to the store for appendEvents; default stays unset (normal)', async () => {
    /** @type {Array<string | undefined>} */
    const seen = [];
    const parts = await bootParts({
      root,
      wrapStore: (store) => ({
        ...store,
        appendEvents: (args) => { seen.push(args.priority); return store.appendEvents(args); },
      }),
    });
    booted.push(parts);
    const chat = chatIdOf(1);
    await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('card') }], { priority: MAILBOX_HISTORY_PRIORITY });
    await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('plain') }]);
    assert.deepEqual(seen, ['final', undefined]);
  });
});
