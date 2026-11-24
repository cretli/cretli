import './helpers/isolated-data-dir.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addChatAsync, getChatByIdAsync, loadChatsAsync, saveChatsAsync, updateChatAsync } from '../lib/persist/chats-persist.js';
import { addChat, updateChat } from '../lib/persist/chats-legacy-store.js';
import { setActiveChatsRuntime } from '../lib/persist/chats-runtime.js';
import { runOnChatsBackends } from './helpers/chats-backends.js';
import { isScoutReadOnlyChatId, isScoutReadOnlyChatIdAsync } from '../lib/workspace-scout-chat.js';
import { resetScoutChatRegistry } from '../lib/scout-chat-registry.js';
import { evaluateBrowserActionGuardAsync } from '../lib/browser/guards.js';
import { resolveCursorContextScope } from '../lib/context/context-scope.ts';
import { findChatById, patchChatContextSettings } from '../lib/context/context-settings-runtime.ts';
import { decisionRoomWorkspace, roomsInDecisionWorkspace } from '../lib/decisions/host-gates.js';
import { collectWorkspaceGitActivity } from '../lib/git-switch-guard.js';
import { listBrowserFamilyChatIds, resolveChatBindingOnFamilyAsync } from '../lib/browser/chat-browser-scope.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------------
// Scope contract: after B2 + B3 no production file imports a synchronous chats-persist export
// ---------------------------------------------------------------------------------------------------

/** Pure helpers of chats-persist that stay synchronous by design (docs/storage-chats-b-caller-inventory.md). */
const PURE_HELPERS = new Set([
  'withTitleSource', 'inferChatTitleSource', 'createFreshSdkContextEntry', 'DEFAULT_CHAT_TITLE_RE', 'CHAT_TITLE_SOURCES',
  'setChatArchiveRejector', 'onChatArchived', 'getChatsReadStats', 'legacyChatsBackend',
]);

/**
 * Files that may still import synchronous exports.
 * - the facade itself and the mixed-phase shim (removed in B5);
 * - B4: direct `chats.json` dependants (backup, isolation fork);
 * - B5: ChatCatalog and archiving (catalog, archive guard / policy / auto-archive, retention).
 */
const SYNC_IMPORT_ALLOWLIST = new Set([
  'lib/persist/chats-persist.js',
  'lib/persist/chats-runtime.js',
  'lib/persist/chats-legacy-store.js',
  'lib/persist/chats-backend-legacy.js',
  'lib/backup/conversations-store.js',
  'lib/chat-catalog.js',
  'lib/chat-archive-policy.js',
  'lib/chat-auto-archive.js',
  'lib/chat-retention.js',
]);

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'tests') continue;
      out.push(...walk(rel));
    } else if (/\.(js|ts|mjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const PRODUCTION_FILES = [...walk('lib'), ...walk('harnesses'), 'server.js'].filter((file) => fs.existsSync(path.join(ROOT, file)));

/**
 * @param {string} source
 * @returns {string[]} names imported from a chats-persist module (static, type-only, dynamic destructuring)
 */
function importedPersistNames(source) {
  const names = [];
  const patterns = [
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'[^']*\/chats-persist\.js'/g,
    /(?:const|let)\s+\{([^}]*)\}\s*=\s*await\s+import\(\s*'[^']*\/chats-persist\.js'\s*\)/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      for (const part of match[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) names.push(name);
      }
    }
  }
  return names;
}

describe('B3 scope contract (B2 + B3 together)', () => {
  it('enumerates the production tree', () => {
    assert.ok(PRODUCTION_FILES.length > 300, `found ${PRODUCTION_FILES.length} files`);
    for (const must of ['lib/delegation-service.js', 'lib/workspace-watcher.js', 'lib/mcp/mcp-inprocess-client.js', 'lib/browser/routes.js']) {
      assert.ok(PRODUCTION_FILES.includes(must), must);
    }
  });

  it('no production file outside the B4/B5 allowlist imports a synchronous chats-persist export', () => {
    const offenders = [];
    for (const file of PRODUCTION_FILES) {
      if (SYNC_IMPORT_ALLOWLIST.has(file)) continue;
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const name of importedPersistNames(source)) {
        if (!name.endsWith('Async') && !PURE_HELPERS.has(name)) offenders.push(`${file}: ${name}`);
      }
      assert.doesNotMatch(source, /import\s+\*\s+as\s+\w+\s+from\s+'[^']*\/chats-persist\.js'/, `${file} imports the chats-persist namespace`);
      // `import('.../chats-persist.js').then(({ name }) => ...)` picks names at the call site.
      for (const match of source.matchAll(/import\(\s*'[^']*\/chats-persist\.js'\s*\)\s*\.then\(\s*\(?\s*\{([^}]*)\}/g)) {
        for (const part of match[1].split(',')) {
          const name = part.trim().split(/\s*:\s*/)[0].trim();
          if (name && !name.endsWith('Async') && !PURE_HELPERS.has(name)) offenders.push(`${file}: ${name}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('the allowlist only names files that exist', () => {
    for (const file of SYNC_IMPORT_ALLOWLIST) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  });

  it('the sync compat shim is gone and the legacy store has only the pinned production importers', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'lib/persist/chats-sync-compat.js')), false);
    const compatUsers = PRODUCTION_FILES.filter((file) => /chats-sync-compat/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    assert.deepEqual(compatUsers, []);
    const users = PRODUCTION_FILES.filter((file) => file !== 'lib/persist/chats-legacy-store.js'
      && /chats-legacy-store\.js/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    // Only the facade and the legacy adapter may touch the sync store; the sync run probes use lib/chat-row-index.js.
    const pinned = ['lib/persist/chats-persist.js', 'lib/persist/chats-backend-legacy.js'];
    for (const user of users) assert.ok(pinned.includes(user), `new legacy-store user: ${user}`);
  });

  it('holds no lock across an await: no chats lock and no synchronous wait around a chats call', () => {
    for (const file of PRODUCTION_FILES) {
      if (!/^lib\/(?:delegation|workspace-watcher|browser|mcp|decisions|context|usage|git-|worktree-|push|agent-finished|model-pick|orchestrator-leaf)/.test(file)) continue;
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      // Other domains keep their own short Atomics.wait sleeps (not the chats worker); a chats call must never use one.
      assert.doesNotMatch(source, /Atomics\.wait\([^)]*\)[\s\S]{0,200}Chats(?:Async)?\(/, `${file} waits synchronously around a chats call`);
      assert.doesNotMatch(source, /\b(?:withChatsLock|acquireChatsLock|lockSync|withStoreLock)\b/, `${file} takes a chats lock`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Converted callers on legacy and sqlite
// ---------------------------------------------------------------------------------------------------

describe('B3 converted callers on legacy and sqlite', () => {
  it('Scout read-only index: a facade-created scout chat is read-only on both backends; ordinary chats are not', async () => {
    await runOnChatsBackends(async (kind) => {
      resetScoutChatRegistry();
      const scout = await addChatAsync(`sess-scout-${kind}`, 'Scout', undefined, undefined, undefined, { pickPurpose: 'scout' });
      const plain = await addChatAsync(`sess-plain-${kind}`, 'Plain', undefined, undefined, undefined, {});
      assert.equal(isScoutReadOnlyChatId(scout.id), true, kind);
      assert.equal(isScoutReadOnlyChatId(plain.id), false, kind);
      assert.equal(await isScoutReadOnlyChatIdAsync(scout.id), true, kind);
      assert.equal(await isScoutReadOnlyChatIdAsync(plain.id), false, kind);
      assert.equal(isScoutReadOnlyChatId('missing'), false, kind);
    });
  });

  it('Scout read-only index: a row only read through the facade (restart case) is indexed before it can run', async () => {
    await runOnChatsBackends(async (kind) => {
      const scout = await addChatAsync(`sess-scout-r-${kind}`, 'Scout', undefined, undefined, undefined, { pickPurpose: 'feedback_triage' });
      resetScoutChatRegistry(); // a fresh process knows nothing yet
      await getChatByIdAsync(scout.id);
      assert.equal(isScoutReadOnlyChatId(scout.id, { loadChats: () => { throw new Error('store must not be consulted'); } }), true, kind);
    });
  });

  it('browser guard resolves the persisted chat mode through the runtime (plan blocks a mutation)', async () => {
    await runOnChatsBackends(async (kind) => {
      const plan = await addChatAsync(`sess-plan-${kind}`, 'Plan', undefined, undefined, undefined, { sdkMode: 'plan' });
      const agent = await addChatAsync(`sess-agent-${kind}`, 'Agent', undefined, undefined, undefined, { sdkMode: 'agent' });
      assert.equal((await evaluateBrowserActionGuardAsync({ action: 'navigate', chatId: plan.id })).allowed, false, kind);
      assert.equal((await evaluateBrowserActionGuardAsync({ action: 'navigate', chatId: agent.id })).allowed, true, kind);
      assert.equal((await evaluateBrowserActionGuardAsync({ action: 'navigate', chatId: 'unknown-chat' })).code, 'mode-required', kind);
    });
  });

  it('browser family walk follows forkParentChatId rows read from the runtime', async () => {
    await runOnChatsBackends(async (kind) => {
      const root = await addChatAsync(`sess-root-${kind}`, 'Root', undefined, undefined, undefined, {});
      const child = await addChatAsync(`sess-child-${kind}`, 'Child', undefined, undefined, undefined, { forkParentChatId: root.id });
      const manager = { resolveChatBinding: (id) => (id === root.id ? { browserSessionId: 'bs-1', chatId: root.id } : null) };
      const binding = await resolveChatBindingOnFamilyAsync(manager, child.id);
      assert.deepEqual(binding, { browserSessionId: 'bs-1', chatId: root.id, fromChatId: root.id }, kind);
      assert.deepEqual(listBrowserFamilyChatIds(child.id, await loadChatsAsync()), [child.id, root.id], kind);
    });
  });

  it('context settings: per-chat patch is a single command and survives a reload', async () => {
    await runOnChatsBackends(async (kind) => {
      const chat = await addChatAsync(`sess-ctx-${kind}`, 'Ctx', undefined, undefined, undefined, {});
      assert.equal((await patchChatContextSettings(chat.id, { profile: 'q' })).ok, true, kind);
      const stored = await findChatById(chat.id);
      assert.ok(stored?.contextSettings, kind);
      assert.equal((await patchChatContextSettings(chat.id, { agentsMd: { mode: 'bad' } })).ok, false, kind);
      assert.equal(await findChatById(''), null, kind);
    });
  });

  it('context scope: chat lookup, unknown chat and the injected loader', async () => {
    await runOnChatsBackends(async (kind) => {
      const cwd = fs.mkdtempSync(path.join(ROOT, 'data-b3-scope-')).replace(/\/$/, '');
      try {
        const chat = await addChatAsync(`sess-scope-${kind}`, 'Scope', undefined, cwd, undefined, {});
        const found = await resolveCursorContextScope({ query: { chatId: chat.id } }, { getCurrentCwd: () => '/global' });
        assert.equal(found.ok, true, kind);
        const missing = await resolveCursorContextScope({ query: { chatId: 'nope' } }, { getCurrentCwd: () => '/global' });
        assert.equal(missing.ok, false, kind);
        assert.equal(missing.status, 404, kind);
        const injected = await resolveCursorContextScope({ query: { chatId: 'inj' } }, { getCurrentCwd: () => '/global', deps: { loadChats: async () => [{ id: 'inj', workspaceFolder: cwd }] } });
        assert.equal(injected.ok, true, kind);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  it('decision gates: room workspace follows the chat row, falls back to the room cwd', async () => {
    await runOnChatsBackends(async (kind) => {
      const chat = await addChatAsync(`sess-gate-${kind}`, 'Gate', undefined, '/w/logical', undefined, {});
      const rooms = [
        { chatId: chat.id, cwd: '/w/worktree' },
        { chatId: 'no-such-chat', cwd: '/w/other' },
      ];
      assert.equal(await decisionRoomWorkspace(rooms[0]), '/w/logical', kind);
      assert.equal(await decisionRoomWorkspace(rooms[1]), '/w/other', kind);
      assert.deepEqual(await roomsInDecisionWorkspace(rooms, '/w/logical'), [rooms[0]], kind);
      assert.deepEqual(await roomsInDecisionWorkspace(rooms, '/w/other'), [rooms[1]], kind);
    });
  });

  it('git switch guard counts the busy chats it reads through the runtime', async () => {
    await runOnChatsBackends(async (kind) => {
      const repo = fs.mkdtempSync(path.join(ROOT, 'data-b3-git-')).replace(/\/$/, '');
      try {
        const busy = await addChatAsync(`sess-busy-${kind}`, 'Busy', undefined, repo, undefined, {});
        await addChatAsync(`sess-idle-${kind}`, 'Idle', undefined, repo, undefined, {});
        const activity = await collectWorkspaceGitActivity(repo, {
          deps: {
            probeChatRunLiveness: ({ chat }) => ({ busy: chat.id === busy.id }),
            listActiveDelegations: () => [],
            loadWorkspaceWatchers: () => ({}),
            getWorkspaceWatcherActiveCycles: () => [],
          },
        });
        assert.equal(activity.runningChats, 1, kind);
        assert.equal(activity.busy, true, kind);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// Mixed phase: converted B3 callers next to a sync caller of a not-yet-converted (B4/B5) group
// ---------------------------------------------------------------------------------------------------

describe('B3 mixed phase on the legacy runtime', () => {
  afterEach(async () => {
    setActiveChatsRuntime(null);
    await saveChatsAsync([]);
  });

  it('converted async writers and a sync B4/B5 caller share one adapter and lose no write', async () => {
    await saveChatsAsync([]);
    const base = addChat('sess-b3-mixed', 'Mixed', undefined, undefined, undefined, { agentTransport: 'claude' });
    const pending = [];
    for (let i = 0; i < 20; i += 1) {
      // The not-yet-converted caller (sync: retention / archive in B5) and the converted group (async) alternate.
      updateChat(base.id, { model: `sync-${i}` });
      pending.push(patchChatContextSettings(base.id, { profile: `p-${i}` }));
      pending.push(updateChatAsync(base.id, { summary: `s-${i}`, summaryTitle: 't' }));
      pending.push(addChatAsync(`sess-b3-async-${i}`, `Async ${i}`, undefined, undefined, undefined, { pickPurpose: 'scout' }));
      addChat(`sess-b3-sync-${i}`, `Sync ${i}`, undefined, undefined, undefined, {});
    }
    await Promise.all(pending);
    const stored = await getChatByIdAsync(base.id);
    assert.equal(stored.model, 'sync-19');
    assert.ok(stored.contextSettings, 'the per-chat settings patch landed');
    assert.equal((await loadChatsAsync()).length, 1 + 20 + 20, 'every row of both writers is present');
    // Every scout chat created through the facade is read-only for the synchronous guard paths.
    const scouts = (await loadChatsAsync()).filter((row) => row.pickPurpose === 'scout');
    assert.equal(scouts.length, 20);
    for (const row of scouts) assert.equal(isScoutReadOnlyChatId(row.id), true);
  });
});
