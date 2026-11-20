/**
 * Chat-backed reads of the model pick service: the controller's model (hard-excluded for review) and the tagged
 * purpose uses read from the chat store. Runs on the legacy and the sqlite chats runtime.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { useChatsBackendFromEnv, registerChatsBackendTeardown } from './helpers/chats-backends.js';
import { addChatAsync } from '../lib/persist/chats-persist.js';
import { listPurposeUses, listPurposeUsesFromRows, readControllerChatModel } from '../lib/model-pick-service.js';

await useChatsBackendFromEnv();

const orchestrator = await addChatAsync(randomUUID(), 'orch', null, ISOLATED_DATA_DIR, 'claude-sonnet-5-5', { agentTransport: 'claude', sdkMode: 'agent' });
const auto = await addChatAsync(randomUUID(), 'auto', null, ISOLATED_DATA_DIR, 'auto', { agentTransport: 'claude', sdkMode: 'agent' });
const scout = await addChatAsync(randomUUID(), 'scout', null, ISOLATED_DATA_DIR, 'm-a', { agentTransport: 'opencode', sdkMode: 'agent', pickPurpose: 'scout' });

// readControllerChatModel: model of the chat, '' for auto / unknown / empty id.
assert.equal(await readControllerChatModel(orchestrator.id), 'claude-sonnet-5-5');
assert.equal(await readControllerChatModel(auto.id), '');
assert.equal(await readControllerChatModel('no-such-chat'), '');
assert.equal(await readControllerChatModel(''), '');

// listPurposeUses without injected rows reads the store; with rows it stays pure.
const stored = await listPurposeUses('scout');
assert.deepEqual(stored.map((row) => [row.harness, row.model]), [['opencode', 'm-a']]);
assert.equal(scout.id.length > 0, true);
assert.deepEqual(await listPurposeUses('scout', { chats: [] }), []);
assert.deepEqual(await listPurposeUses(''), []);
assert.deepEqual(listPurposeUsesFromRows('scout', { chats: [{ pickPurpose: 'scout', agentTransport: 'x', model: 'y', createdAt: new Date().toISOString() }] }).length, 1);

registerChatsBackendTeardown();
