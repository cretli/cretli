/**
 * A fresh todo orchestrator may steer (verify) a delegation whose original
 * parent chat is gone; unrelated chats may not.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addTodo } from '../lib/persist/todos-persist.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { canChatSteerDelegation } from '../lib/delegation-service.js';

const cwd = mkdtempSync(path.join(tmpdir(), 'steer-'));
const dataDir = resolveDataPath();
const root = addTodo(dataDir, cwd, { title: 'root', idempotencyKey: 'steer-root', orchestratorChatId: 'new-orch' }).items[0];
const leaf = addTodo(dataDir, cwd, { title: 'leaf', idempotencyKey: 'steer-leaf', parentId: root.id }).items.find((it) => it.parentId === root.id);
const row = { parentChatId: 'old-parent', workspaceFolder: cwd, leafId: leaf.id };

assert.equal(await canChatSteerDelegation(row, 'old-parent', { dataDir }), true);
assert.equal(await canChatSteerDelegation(row, 'new-orch', { dataDir }), true);
assert.equal(await canChatSteerDelegation(row, 'stranger', { dataDir }), false);
assert.equal(await canChatSteerDelegation({ ...row, leafId: '' }, 'new-orch', { dataDir }), false);
console.log('delegation-steer-orchestrator ok');
