/**
 * Notification centre store, producers, routes, and sanitisation.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import {
  __resetNotificationStoreQueueForTest,
  dismissNotifications,
  listNotifications,
  markNotificationsRead,
  NOTIFICATION_MAX_RECORDS,
  publishNotification,
  readNotificationStoreSync,
  resolveNotificationStorePath,
  validatePublishInput,
  withNotificationStoreLock,
} from '../lib/notifications/notification-store.js';
import { sanitizeNotificationText } from '../lib/notifications/notification-sanitize.js';
import {
  fingerprintChatNotification,
  fingerprintModelsCatalogChange,
  publishModelsCatalogChangedNotification,
} from '../lib/notifications/notification-producers.js';
import { registerNotificationRoutes } from '../lib/routes/notification-routes.js';
import { notifyChatCreated } from '../lib/chat-created-push.js';
import { notifyAgentFinished } from '../lib/agent-finished-push.js';
import { subscribeChatListUpdates } from '../lib/chat-list-updates.js';
import { broadcastNotificationsChanged } from '../lib/notifications/notification-live.js';
import { refreshHarnessModelsCatalog } from '../lib/harness-models-refresh.js';
import { SNAPSHOT_FILE_NAME } from '../lib/harness-models-snapshot.js';
import { saveSettings } from '../lib/persist/settings.js';

const storePath = path.join(ISOLATED_DATA_DIR, 'notification-center.json');
const snapshotPath = path.join(ISOLATED_DATA_DIR, SNAPSHOT_FILE_NAME);

/**
 * @returns {void}
 */
function resetStoreFile() {
  __resetNotificationStoreQueueForTest();
  try {
    fs.rmSync(storePath, { force: true });
  } catch {
    // ignore
  }
}

test('one fingerprint is one occurrence: dedupe across active, read and dismissed', async () => {
  resetStoreFile();
  const fp = fingerprintChatNotification('finished', { chatId: 'c1', runId: 'run-a' });
  const first = await publishNotification({
    category: 'chat',
    severity: 'info',
    title: 'Done',
    body: 'body',
    actionUrl: '/?panel=chat',
    fingerprint: fp,
  }, { storePath, broadcast: false });
  assert.equal(first.created, true);
  assert.ok(first.id);
  const dup = await publishNotification({
    category: 'chat',
    severity: 'info',
    title: 'Done',
    body: 'body',
    actionUrl: '/?panel=chat',
    fingerprint: fp,
  }, { storePath, broadcast: false });
  assert.equal(dup.created, false);
  assert.equal(dup.id, first.id);
  const runB = fingerprintChatNotification('finished', { chatId: 'c1', runId: 'run-b' });
  const secondRun = await publishNotification({
    category: 'chat',
    severity: 'info',
    title: 'Done',
    body: 'body',
    actionUrl: '/?panel=chat',
    fingerprint: runB,
  }, { storePath, broadcast: false });
  assert.equal(secondRun.created, true, 'a new run gets a new fingerprint and a new row');
  const secondRow = listNotifications({}, { storePath }).items.find((row) => row.id === secondRun.id);
  assert.ok(secondRow, 'the new occurrence is listed');
  assert.equal(secondRow.readAt, null, 'the new occurrence is unread');

  // Reading must not unlock the fingerprint: a replayed occurrence stays deduped
  // and the existing row keeps its read state.
  const readOnce = await markNotificationsRead({ id: first.id }, { storePath });
  assert.equal(readOnce.ok, true);
  assert.equal(readOnce.changed, true);
  const readTwice = await markNotificationsRead({ id: first.id }, { storePath });
  assert.equal(readTwice.ok, true);
  assert.equal(readTwice.changed, false);
  const afterRead = await publishNotification({
    category: 'chat',
    severity: 'info',
    title: 'Done again',
    body: 'body',
    actionUrl: '/?panel=chat',
    fingerprint: fp,
  }, { storePath, broadcast: false });
  assert.equal(afterRead.created, false, 'a read occurrence is not re-created');
  assert.equal(afterRead.id, first.id);
  const rowAfterRead = listNotifications({}, { storePath }).items.find((row) => row.id === first.id);
  assert.ok(rowAfterRead);
  assert.ok(rowAfterRead.readAt, 'the existing row stays read');

  // Dismissing must not unlock the fingerprint either.
  const dismiss = await dismissNotifications({ id: first.id }, { storePath });
  assert.equal(dismiss.ok, true);
  assert.equal(dismiss.changed, true);
  const afterDismiss = await publishNotification({
    category: 'chat',
    severity: 'info',
    title: 'Done yet again',
    body: 'body',
    actionUrl: '/?panel=chat',
    fingerprint: fp,
  }, { storePath, broadcast: false });
  assert.equal(afterDismiss.created, false, 'a dismissed occurrence is not re-created');
  const afterDismissList = listNotifications({}, { storePath });
  assert.equal(afterDismissList.items.some((row) => row.id === first.id), false, 'dismissed row stays hidden');
  assert.ok(afterDismissList.items.some((row) => row.id === secondRun.id), 'the other occurrence is untouched');
});

test('repeated notifyAgentFinished for the same run after dismiss adds no row', async () => {
  resetStoreFile();
  const deps = {
    isPushAvailable: () => false,
    hasPushSubscriptions: () => false,
    broadcastPush: async () => assert.fail('must not broadcast push'),
  };
  const room = { chatId: 'chat-replay', chatTitle: 'Replay', _runId: 'run-durable-1' };
  notifyAgentFinished({ chatId: 'chat-replay', status: 'completed', runId: 'run-durable-1', room }, deps);
  await withNotificationStoreLock(() => undefined);
  const listed = listNotifications({}, { storePath });
  const row = listed.items.find((item) => item.fingerprint === 'chat:finished:chat-replay:run-durable-1');
  assert.ok(row, 'first finish publishes');
  await dismissNotifications({ id: row.id }, { storePath });
  notifyAgentFinished({ chatId: 'chat-replay', status: 'completed', runId: 'run-durable-1', room }, deps);
  await withNotificationStoreLock(() => undefined);
  const after = listNotifications({}, { storePath });
  assert.equal(
    after.items.filter((item) => item.fingerprint === 'chat:finished:chat-replay:run-durable-1').length,
    0,
    'a second finish of the same run does not resurrect the dismissed row',
  );
});

test('agent-finished notification falls back to the durable room run id', async () => {
  resetStoreFile();
  const deps = {
    isPushAvailable: () => false,
    hasPushSubscriptions: () => false,
    broadcastPush: async () => assert.fail('must not broadcast push'),
  };
  notifyAgentFinished({
    chatId: 'chat-roomrun',
    status: 'completed',
    room: { chatId: 'chat-roomrun', chatTitle: 'Room run', _runId: 'durable-room-id' },
  }, deps);
  await withNotificationStoreLock(() => undefined);
  const listed = listNotifications({}, { storePath });
  assert.ok(listed.items.some((item) => item.fingerprint === 'chat:finished:chat-roomrun:durable-room-id'));

  // Without any per-run discriminator the producer skips rather than collapsing
  // every finish of one chat into a single fingerprint.
  notifyAgentFinished({ chatId: 'chat-no-run', status: 'completed' }, deps);
  await withNotificationStoreLock(() => undefined);
  const after = listNotifications({}, { storePath });
  assert.equal(after.items.some((item) => item.fingerprint.startsWith('chat:finished:chat-no-run')), false);
});

test('a finish-before-start does not inherit an already-consumed room run id', async () => {
  resetStoreFile();
  const deps = {
    isPushAvailable: () => false,
    hasPushSubscriptions: () => false,
    broadcastPush: async () => assert.fail('must not broadcast push'),
  };
  const room = { chatId: 'chat-fbs', chatTitle: 'FBS', _runId: 'run-prev' };
  notifyAgentFinished({ chatId: 'chat-fbs', status: 'completed', runId: 'run-prev', room }, deps);
  await withNotificationStoreLock(() => undefined);
  const first = listNotifications({}, { storePath }).items.find(
    (row) => row.fingerprint === 'chat:finished:chat-fbs:run-prev',
  );
  assert.ok(first, 'the first finish of the run publishes');

  // A setup failure emitted before its own `sdkPromptStarted` carries no runId,
  // so the producer would otherwise fall back to the already-consumed room id.
  notifyAgentFinished({ chatId: 'chat-fbs', status: 'error', runId: '', room }, deps);
  await withNotificationStoreLock(() => undefined);
  let chatItems = listNotifications({}, { storePath }).items.filter((row) => row.category === 'chat');
  assert.equal(chatItems.length, 2, 'the finish-before-start failure is a distinct occurrence');
  const failure = chatItems.find((row) => row.id !== first.id);
  assert.ok(
    failure && failure.fingerprint.startsWith('chat:finished:chat-fbs:run-prev:finish:'),
    `unexpected failure fingerprint: ${failure?.fingerprint}`,
  );

  // Replaying the same failure frame stays deduped.
  notifyAgentFinished({ chatId: 'chat-fbs', status: 'error', runId: '', room }, deps);
  await withNotificationStoreLock(() => undefined);
  chatItems = listNotifications({}, { storePath }).items.filter((row) => row.category === 'chat');
  assert.equal(chatItems.length, 2, 'a replay of the same failure is deduped');
});

test('dismissed fingerprints survive count-based pruning within the retention window', async () => {
  resetStoreFile();
  const now = () => 1_700_000_000_000;
  const dismissedFp = 'system:dismissed:keep';
  const created = await publishNotification({
    category: 'system',
    severity: 'info',
    title: 'Dismissed',
    body: '',
    actionUrl: '',
    fingerprint: dismissedFp,
  }, { storePath, now, broadcast: false });
  await dismissNotifications({ id: created.id }, { storePath, now });
  for (let i = 0; i < NOTIFICATION_MAX_RECORDS + 5; i += 1) {
    await publishNotification({
      category: 'system',
      severity: 'info',
      title: `Fill ${i}`,
      body: '',
      actionUrl: '',
      fingerprint: `system:fill:${i}`,
    }, { storePath, now, broadcast: false });
  }
  const doc = readNotificationStoreSync({ storePath });
  assert.equal(doc.items.some((row) => row.id === created.id), false, 'dismissed row left the record cap');
  assert.ok(
    doc.tombstones.some((tombstone) => tombstone.fingerprint === dismissedFp),
    'the dismissed fingerprint is carried as a tombstone',
  );
  const replay = await publishNotification({
    category: 'system',
    severity: 'info',
    title: 'Replay',
    body: '',
    actionUrl: '',
    fingerprint: dismissedFp,
  }, { storePath, now, broadcast: false });
  assert.equal(replay.created, false, 'the replay stays deduped after count pruning');
});

test('active fingerprints survive count-based pruning within the retention window', async () => {
  resetStoreFile();
  const now = () => 1_700_000_000_000;
  const activeFp = 'system:active:keep';
  const created = await publishNotification({
    category: 'system',
    severity: 'info',
    title: 'Active',
    body: '',
    actionUrl: '',
    fingerprint: activeFp,
  }, { storePath, now, broadcast: false });
  const activeRow = listNotifications({}, { storePath }).items.find((item) => item.id === created.id);
  assert.ok(activeRow, 'the active row is listed');
  assert.equal(activeRow.readAt, null, 'the row is unread (not dismissed) before pruning');
  for (let i = 0; i < NOTIFICATION_MAX_RECORDS + 5; i += 1) {
    await publishNotification({
      category: 'system',
      severity: 'info',
      title: `Fill ${i}`,
      body: '',
      actionUrl: '',
      fingerprint: `system:active-fill:${i}`,
    }, { storePath, now, broadcast: false });
  }
  const doc = readNotificationStoreSync({ storePath });
  assert.equal(doc.items.some((row) => row.id === created.id), false, 'the active row left the record cap');
  assert.ok(
    doc.tombstones.some((tombstone) => tombstone.fingerprint === activeFp),
    'the evicted active fingerprint is carried as a tombstone',
  );
  const replay = await publishNotification({
    category: 'system',
    severity: 'info',
    title: 'Active replay',
    body: '',
    actionUrl: '',
    fingerprint: activeFp,
  }, { storePath, now, broadcast: false });
  assert.equal(replay.created, false, 'the replay of an evicted active row stays deduped');
});

test('models fingerprints hash the resulting id set and distinguish changes', async () => {
  assert.equal(
    fingerprintModelsCatalogChange('deepseek', ['b', 'a']),
    fingerprintModelsCatalogChange('deepseek', ['a', 'b']),
    'order does not matter',
  );
  assert.notEqual(
    fingerprintModelsCatalogChange('deepseek', ['a', 'b']),
    fingerprintModelsCatalogChange('deepseek', ['a', 'c']),
    'a different id set is a different occurrence',
  );
  resetStoreFile();
  await publishModelsCatalogChangedNotification('deepseek', ['a'], ['a', 'b']);
  await withNotificationStoreLock(() => undefined);
  assert.equal(listNotifications({}, { storePath }).items.filter((row) => row.category === 'models').length, 1);
  // A retry of the same change (e.g. after a failed snapshot write) stays deduped.
  await publishModelsCatalogChangedNotification('deepseek', ['a'], ['a', 'b']);
  await withNotificationStoreLock(() => undefined);
  assert.equal(listNotifications({}, { storePath }).items.filter((row) => row.category === 'models').length, 1);
  await publishModelsCatalogChangedNotification('deepseek', ['a', 'b'], ['a', 'b', 'c']);
  await withNotificationStoreLock(() => undefined);
  assert.equal(listNotifications({}, { storePath }).items.filter((row) => row.category === 'models').length, 2);
});

test('validatePublishInput accepts only same-origin relative action URLs', () => {
  const base = { category: 'chat', severity: 'info', title: 'Title', fingerprint: 'fp-action-url' };
  const accepts = (actionUrl) => validatePublishInput({ ...base, actionUrl }).ok;
  assert.equal(accepts(''), true);
  assert.equal(accepts('/?panel=chat'), true);
  assert.equal(accepts('/a/b'), true);
  assert.equal(accepts('//evil.example/x'), false);
  assert.equal(accepts('/\\evil.example'), false);
  assert.equal(accepts('/a\\b'), false);
  assert.equal(accepts('https://evil.example/x'), false);
  assert.equal(accepts('javascript:alert(1)'), false);
  assert.equal(accepts('?panel=chat'), false);
  assert.equal(accepts('/x\ny'), false);
  assert.equal(accepts('/x y'), false);
});

test('retention bound and corrupt file yields empty store', async () => {
  resetStoreFile();
  const now = () => 1_700_000_000_000;
  for (let i = 0; i < NOTIFICATION_MAX_RECORDS + 5; i += 1) {
    await publishNotification({
      category: 'system',
      severity: 'info',
      title: `Row ${i}`,
      body: '',
      actionUrl: '',
      fingerprint: `system:test:${i}`,
    }, { storePath, now, broadcast: false });
  }
  const doc = readNotificationStoreSync({ storePath });
  assert.equal(doc.items.length, NOTIFICATION_MAX_RECORDS);
  fs.writeFileSync(storePath, '{not-json', 'utf8');
  const recovered = readNotificationStoreSync({ storePath });
  assert.equal(recovered.items.length, 0);
});

test('concurrent publishes do not lose records', async () => {
  resetStoreFile();
  const jobs = [];
  for (let i = 0; i < 20; i += 1) {
    jobs.push(publishNotification({
      category: 'cli',
      severity: 'info',
      title: `CLI ${i}`,
      body: '',
      actionUrl: '',
      fingerprint: `cli:job:${i}`,
    }, { storePath, broadcast: false }));
  }
  await Promise.all(jobs);
  const doc = readNotificationStoreSync({ storePath });
  assert.equal(doc.items.length, 20);
});

test('producers run when push is disabled and without subscriptions', async () => {
  resetStoreFile();
  const deps = {
    isPushAvailable: () => false,
    hasPushSubscriptions: () => false,
    broadcastPush: async () => assert.fail('must not broadcast push'),
  };
  notifyChatCreated({ chatId: 'chat-push-off', chatTitle: 'T' }, deps);
  notifyAgentFinished({ chatId: 'chat-push-off', status: 'completed', runId: 'r1' }, deps);
  await withNotificationStoreLock(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const listed = listNotifications({}, { storePath });
  assert.ok(listed.items.some((row) => row.fingerprint.includes('chat:newChat:chat-push-off')));
  assert.ok(listed.items.some((row) => row.fingerprint.includes('chat:finished:chat-push-off:r1')));
});

test('preferences filter affects unread count', async () => {
  resetStoreFile();
  await publishNotification({
    category: 'chat',
    severity: 'info',
    title: 'Chat info',
    body: '',
    actionUrl: '',
    fingerprint: 'chat:info:1',
  }, { storePath, broadcast: false });
  await publishNotification({
    category: 'system',
    severity: 'error',
    title: 'System error',
    body: '',
    actionUrl: '',
    fingerprint: 'system:err:1',
  }, { storePath, broadcast: false });
  const all = listNotifications({}, {
    storePath,
    preferences: {
      preset: 'all',
      categories: { chat: true, models: true, cli: true, system: true },
      showBadge: true,
      sound: true,
    },
  });
  assert.equal(all.unreadCount, 2);
  const important = listNotifications({}, {
    storePath,
    preferences: {
      preset: 'important',
      categories: { chat: true, models: true, cli: true, system: true },
      showBadge: true,
      sound: true,
    },
  });
  assert.equal(important.unreadCount, 1);
  assert.equal(important.items.length, 1);
  const custom = listNotifications({}, {
    storePath,
    preferences: {
      preset: 'custom',
      categories: { chat: false, models: true, cli: true, system: true },
      showBadge: true,
      sound: true,
    },
  });
  assert.equal(custom.unreadCount, 1);
});

test('models notification only on real change, not first snapshot', async () => {
  resetStoreFile();
  const entryA = { value: 'model-a', label: 'A', modelId: 'model-a' };
  const entryB = { value: 'model-b', label: 'B', modelId: 'model-b' };
  await refreshHarnessModelsCatalog('deepseek', {
    snapshotPath,
    async listDeepSeekModels() {
      return { catalog: [entryA], modelsSource: 'live' };
    },
  });
  await withNotificationStoreLock(() => undefined);
  let listed = listNotifications({}, { storePath });
  assert.equal(listed.items.filter((row) => row.category === 'models').length, 0);
  await refreshHarnessModelsCatalog('deepseek', {
    snapshotPath,
    async listDeepSeekModels() {
      return { catalog: [entryA, entryB], modelsSource: 'live' };
    },
  });
  await withNotificationStoreLock(() => undefined);
  listed = listNotifications({}, { storePath });
  assert.equal(listed.items.filter((row) => row.category === 'models').length, 1);
  await publishModelsCatalogChangedNotification('deepseek', [], ['model-a']);
  await withNotificationStoreLock(() => undefined);
  listed = listNotifications({}, { storePath });
  assert.equal(listed.items.filter((row) => row.category === 'models').length, 1);
});

test('sanitisation strips secrets, home paths and URLs', () => {
  const raw = 'api_key=supersecretvalue at /home/example-user/project see https://api.example.com/v1';
  const cleaned = sanitizeNotificationText(raw);
  assert.ok(!cleaned.includes('supersecretvalue'));
  assert.ok(!cleaned.includes('/home/example-user'));
  assert.ok(!cleaned.includes('https://'));
  assert.ok(cleaned.includes('[url]') || cleaned.includes('[redacted]'));
});

test('HTTP routes list, read, dismiss, validation and widget rejection', async () => {
  resetStoreFile();
  const created = await publishNotification({
    category: 'chat',
    severity: 'info',
    title: 'Route row',
    body: '',
    actionUrl: '/?panel=chat',
    fingerprint: 'chat:route:1',
  }, { storePath, broadcast: false });
  const app = express();
  app.use(express.json());
  registerNotificationRoutes(app, {
    list: (query) => listNotifications(query, { storePath }),
    markRead: (body) => markNotificationsRead(body, { storePath }),
    dismiss: (body) => dismissNotifications(body, { storePath }),
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const listRes = await fetch(`${base}/api/notifications`);
    const listBody = await listRes.json();
    assert.equal(listRes.status, 200);
    assert.equal(listBody.ok, true);
    assert.equal(typeof listBody.revision, 'number');
    assert.equal(listBody.unreadCount, 1);
    assert.ok(Array.isArray(listBody.items));
    const readRes = await fetch(`${base}/api/notifications/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: created.id }),
    });
    assert.equal(readRes.status, 200);
    const readAll = await fetch(`${base}/api/notifications/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    assert.equal(readAll.status, 200);
    const dismissRes = await fetch(`${base}/api/notifications/dismiss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: created.id }),
    });
    assert.equal(dismissRes.status, 200);
    const unknown = await fetch(`${base}/api/notifications/dismiss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000099' }),
    });
    assert.equal(unknown.status, 404);
    for (const flag of ['widgetAccess', 'mcpIntegration']) {
      const restricted = express();
      restricted.use(express.json());
      restricted.use((req, _res, next) => {
        req[flag] = { installationId: 'x' };
        next();
      });
      registerNotificationRoutes(restricted, {
        list: () => assert.fail('must not list'),
      });
      const restrictedServer = await new Promise((resolve) => {
        const listener = restricted.listen(0, '127.0.0.1', () => resolve(listener));
      });
      try {
        const res = await fetch(`http://127.0.0.1:${restrictedServer.address().port}/api/notifications`);
        assert.equal(res.status, 403, flag);
      } finally {
        await new Promise((resolve) => restrictedServer.close(resolve));
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('live notificationsChanged frame carries revision', () => {
  const viewer = {
    readyState: 1,
    bufferedAmount: 0,
    messages: [],
    send(payload) {
      this.messages.push(JSON.parse(payload));
    },
    once() {},
  };
  subscribeChatListUpdates(viewer);
  broadcastNotificationsChanged({ revision: 7, reason: 'publish' });
  assert.deepEqual(viewer.messages.at(-1), {
    type: 'notificationsChanged',
    revision: 7,
    reason: 'publish',
  });
});

test('settings persist notificationCenter preferences', () => {
  saveSettings({
    notificationCenter: {
      preset: 'custom',
      categories: { chat: false, models: true, cli: true, system: false },
      showBadge: false,
      sound: false,
    },
  });
  const listed = listNotifications({});
  assert.equal(listed.preferences.preset, 'custom');
  assert.equal(listed.preferences.showBadge, false);
});

test('resolveNotificationStorePath uses data dir', () => {
  assert.equal(resolveNotificationStorePath(), storePath);
});
