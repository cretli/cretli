/**
 * Durable session continuity of a delegation chat: the live read, the per-chat generation bump on a context
 * invalidation (fire-and-forget write that the next read waits for) and the unknown / no-identity answers.
 * Runs on the legacy and the sqlite chats runtime.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { useChatsBackendFromEnv, registerChatsBackendTeardown } from './helpers/chats-backends.js';
import { addChatAsync, getChatByIdAsync } from '../lib/persist/chats-persist.js';
import { appendChatHistoryEvents } from '../lib/persist/chat-history-persist.js';
import { settleChatWrites } from '../lib/chat-write-async.js';
import { readCurrentSessionContinuity } from '../lib/delegation-session-continuity.js';
import { recordContextRestart, CONTEXT_RESTART_REASON } from '../lib/usage/context-restarts.ts';

await useChatsBackendFromEnv();

async function chatWithIdentity(identity) {
  return addChatAsync(randomUUID(), 'continuity', null, ISOLATED_DATA_DIR, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
    ...(identity ? { delegationSessionIdentity: identity, delegationSessionGeneration: 0 } : {}),
  });
}

const chat = await chatWithIdentity('identity-1');
await appendChatHistoryEvents(chat.id, '', [{ rec: { kind: 'localUser', text: 'hello' } }]);

// 1. The live read joins the persisted identity/generation with the history head.
const first = await readCurrentSessionContinuity(chat.id);
assert.equal(first.identity, 'identity-1');
assert.equal(first.generation, 0);
assert.ok(Number.isFinite(first.historyHeadSeq) && first.historyHeadSeq >= 1);

// 2. A context invalidation advances the durable generation; the very next read already sees it.
recordContextRestart({ chatId: chat.id, harness: 'opencode', reason: CONTEXT_RESTART_REASON.PROCESS_RECREATED });
const afterOne = await readCurrentSessionContinuity(chat.id);
assert.equal(afterOne.generation, 1);
assert.equal((await getChatByIdAsync(chat.id)).delegationSessionGeneration, 1);

// 3. A burst of invalidations never loses an increment (serialized per chat).
for (let i = 0; i < 3; i += 1) {
  recordContextRestart({ chatId: chat.id, harness: 'opencode', reason: CONTEXT_RESTART_REASON.PROCESS_RECREATED });
}
await settleChatWrites(chat.id);
assert.equal((await readCurrentSessionContinuity(chat.id)).generation, 4);

// 4. No identity, unknown chat and empty id are unknown (null), and an invalidation does not create an identity.
const plain = await chatWithIdentity('');
assert.equal(await readCurrentSessionContinuity(plain.id), null);
recordContextRestart({ chatId: plain.id, harness: 'opencode', reason: CONTEXT_RESTART_REASON.PROCESS_RECREATED });
await settleChatWrites(plain.id);
assert.equal((await getChatByIdAsync(plain.id)).delegationSessionGeneration, undefined);
assert.equal(await readCurrentSessionContinuity('no-such-chat'), null);
assert.equal(await readCurrentSessionContinuity(''), null);

registerChatsBackendTeardown();
