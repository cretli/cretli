import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FEEDBACK_ROOT_MARKER, isFeedbackReport, isFeedbackDerivedTodo } from '../lib/feedback-marker.js';
import { createTodosStore, createLegacyJsonTodosBackend } from '../lib/persist/todos-store.js';
import { workspaceKeyFromCwd } from '../lib/persist/todos-persist.js';
import { isTodoBranchBlocked, listReadyTodoLeaves, resolveTodoRootId } from '../lib/todo-tree.js';
import { resolveManualTodoRoot } from '../lib/todo-worktree-manual.js';
import { slimTodoForList } from '../lib/routes/todos-routes.js';
import { countOpenFeedback } from '../app_front/features/todo/todoTabCounts.js';
import { openSqliteTodosBackend } from './fixtures/todos-sqlite-harness.js';

for (const backendKind of ['json', 'sqlite']) {
  test(`${backendKind}: legacy reports become independent roots, survive writes and reloads`, async () => {
    const dataDir = fs.mkdtempSync(path.join(ISOLATED_DATA_DIR, `feedback-${backendKind}-`));
    const cwd = path.join(dataDir, 'workspace');
    fs.mkdirSync(cwd);
    const key = workspaceKeyFromCwd(cwd);
    const at = '2026-01-01T00:00:00.000Z';
    const row = (id, extra) => ({ id, title: id, body: '', status: 'idea', createdAt: at, updatedAt: at, siblingIndex: 0, ...extra });
    const plan = { markdown: '# Fix one report', approvedAt: at };
    const changelog = [{ at, kind: 'note', text: 'Report history' }];
    const doc = { version: 3, updatedAt: at, items: [
      row('legacy-container', { body: FEEDBACK_ROOT_MARKER, status: 'ready', plan: { markdown: '# Container', approvedAt: at } }),
      row('one', { parentId: 'legacy-container', body: '<!-- cretli-feedback {"hash":"one"} -->\nFirst',
        chatId: 'report-chat', linkedChatIds: ['report-chat'], changelog, plan }),
      row('two', { parentId: 'legacy-container', body: '<!-- cretli-feedback {"hash":"two"} -->\nSecond', status: 'ready', siblingIndex: 1 }),
      row('step', { parentId: 'one', status: 'ready' }),
      row('plain', { status: 'ready', siblingIndex: 1 }),
    ], idempotency: {} };
    let opened;
    let store;
    if (backendKind === 'sqlite') {
      opened = await openSqliteTodosBackend({ dataDir, nudge: () => {} });
      await opened.store.importDocument({ commandId: 'seed-feedback', workspaceKey: key, doc });
      store = createTodosStore(opened.backend);
    } else {
      fs.mkdirSync(path.join(dataDir, 'todos'));
      fs.writeFileSync(path.join(dataDir, 'todos', `${key}.json`), JSON.stringify(doc));
      store = createTodosStore(createLegacyJsonTodosBackend());
    }
    try {
      const check = (items) => {
        const byId = new Map(items.map((item) => [item.id, item]));
        for (const id of ['one', 'two']) {
          const report = byId.get(id);
          assert.equal(report.parentId, undefined);
          assert.equal(isFeedbackReport(report), true);
          assert.equal(isFeedbackDerivedTodo(items, report), true);
          assert.equal(resolveTodoRootId(items, id), id);
          assert.equal(resolveManualTodoRoot(items, id).rootId, id);
        }
        assert.equal(byId.get('step').parentId, 'one');
        assert.equal(isFeedbackReport(byId.get('step')), false);
        assert.equal(resolveTodoRootId(items, 'step'), 'one');
        assert.equal(isTodoBranchBlocked(items, byId.get('two')), false);
        assert.equal(listReadyTodoLeaves(items).some((item) => item.id === 'legacy-container'), false);
        assert.equal(byId.get('one').chatId, 'report-chat');
        assert.deepEqual(byId.get('one').linkedChatIds, ['report-chat']);
        assert.deepEqual(byId.get('one').changelog, changelog);
        assert.equal(byId.get('one').plan.approvedAt, at);
        assert.equal(byId.get('two').plan, undefined);
        assert.equal(countOpenFeedback(items.map((item) => slimTodoForList(item, { lean: true }))), 2);
      };
      check((await store.listTodos(dataDir, cwd)).items);
      await store.updateTodo(dataDir, cwd, 'two', { title: 'Updated report' });
      if (opened) {
        await opened.close();
        opened = await openSqliteTodosBackend({ dataDir, bootstrap: false, nudge: () => {} });
        store = createTodosStore(opened.backend);
      }
      const items = (await store.listTodos(dataDir, cwd)).items;
      check(items);
      assert.equal(items.find((item) => item.id === 'two').title, 'Updated report');
    } finally {
      if (opened) await opened.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
}
