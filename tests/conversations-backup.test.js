import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

const { saveChats, loadChats } = await import('../lib/persist/chats-persist.js');
const { appendChatHistoryEvents, loadChatHistory, deleteChatHistory } = await import('../lib/persist/chat-history-service.js');
const { createDefaultConversationStore } = await import('../lib/backup/conversations-store.js');
const { buildStoreZip, readStoreZip, ZipArchiveError } = await import('../lib/backup/zip-store.js');
const archiveLib = await import('../lib/backup/conversations-archive.js');
const { createConversationsBackupService } = await import('../lib/backup/conversations-backup-service.js');
const { createJobManager } = await import('../lib/backup/backup-jobs.js');
const { readReceiptState } = await import('../lib/backup/conversations-import.js');
const { registerConversationsBackupRoutes } = await import('../lib/routes/conversations-backup-routes.js');

const { buildConversationsExport, parseConversationsArchive, chatContentDigest, sha256Hex } = archiveLib;
const store = createDefaultConversationStore();
const UPLOADS = path.join(ISOLATED_DATA_DIR, 'uploads');
const RECEIPTS = path.join(ISOLATED_DATA_DIR, 'conversation-import-receipts.json');
const JOBS_DIR = path.join(ISOLATED_DATA_DIR, 'backup-jobs');

const ATT1 = '11111111-1111-4111-8111-111111111111.jpg';
const ATT2 = '22222222-2222-4222-8222-222222222222.jpg';
const ATT_MISSING = '33333333-3333-4333-8333-333333333333.jpg';
const ATT1_BYTES = crypto.randomBytes(300);
const ATT2_BYTES = crypto.randomBytes(120);

const user = (text, createdAt = '2026-01-01T00:00:00.000Z') => ({ kind: 'localUser', text, createdAt });
const assistant = (text) => ({ kind: 'sdk', event: { type: 'assistant', message: { content: [{ type: 'text', text }] } }, createdAt: '2026-01-01T00:00:01.000Z' });

async function wipeInstall() {
  for (const chat of loadChats()) await deleteChatHistory(chat.id);
  saveChats([]);
  fs.rmSync(UPLOADS, { recursive: true, force: true });
  fs.rmSync(RECEIPTS, { force: true });
  fs.rmSync(JOBS_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(ISOLATED_DATA_DIR, 'backup-staging'), { recursive: true, force: true });
}

/** Seeds a small installation and returns the source ids. */
async function seed() {
  await wipeInstall();
  fs.mkdirSync(UPLOADS, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS, ATT1), ATT1_BYTES);
  fs.writeFileSync(path.join(UPLOADS, ATT2), ATT2_BYTES);
  const ids = { a: 'aaaa0000-0000-4000-8000-00000000000a', b: 'bbbb0000-0000-4000-8000-00000000000b', c: 'cccc0000-0000-4000-8000-00000000000c', d: 'dddd0000-0000-4000-8000-00000000000d' };
  saveChats([
    {
      id: ids.a, title: 'Root chat', cursorSessionId: 'cs-A', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
      agentTransport: 'sdk', sdkMode: 'agent', workspaceFolder: '/work/acme', workspaceFile: '/work/acme/acme.code-workspace', model: 'm1',
      opencodeSessionId: 'oc-1', claudeSessionId: 'cl-1', codexThreadId: 'cx-1', sdkAgentId: 'ag-1', todoId: 'todo-1', widgetInstallationId: 'w-1',
    },
    {
      id: ids.b, title: 'Child fork', cursorSessionId: 'cs-B', createdAt: '2026-01-03T00:00:00.000Z', agentTransport: 'sdk', sdkMode: 'agent',
      workspaceFolder: '/work/acme', workspaceFile: '/work/acme/acme.code-workspace', forkParentChatId: ids.a, forkKind: 'conversation', claudeSessionId: 'cl-2',
    },
    { id: ids.c, title: 'Old archived', cursorSessionId: 'cs-C', createdAt: '2026-01-04T00:00:00.000Z', archivedAt: '2026-02-01T00:00:00.000Z', agentTransport: 'sdk', sdkMode: 'agent' },
    { id: ids.d, title: 'Other # workspace', cursorSessionId: 'cs-D', createdAt: '2026-01-05T00:00:00.000Z', agentTransport: 'sdk', sdkMode: 'agent', workspaceFolder: '/work/other' },
  ]);
  await appendChatHistoryEvents(ids.a, 'cs-A', [
    { rec: user(`look at ${UPLOADS}/${ATT1} and ${UPLOADS}/${ATT2}`) },
    { rec: assistant('Seen both.') },
    { rec: user('and this one is gone: ' + `${UPLOADS}/${ATT_MISSING}`), clientSeq: 7 },
  ]);
  await appendChatHistoryEvents(ids.b, 'cs-B', [{ rec: user(`fork uses ${UPLOADS}/${ATT2}`) }, { rec: assistant('ok') }]);
  await appendChatHistoryEvents(ids.c, 'cs-C', [{ rec: user('archived hello') }]);
  await appendChatHistoryEvents(ids.d, 'cs-D', [{ rec: user('text with ``` fence and\n# heading') }, { rec: assistant('reply') }]);
  return ids;
}

const exportAll = (extra = {}) => buildConversationsExport(store, { scope: 'all', includeArchived: true, includeSubchats: true, ...extra });

function makeService(extra = {}) {
  const hooks = {};
  const service = createConversationsBackupService({
    store: extra.store || store,
    jobsDir: JOBS_DIR,
    importerHooks: {
      afterPendingWritten: () => hooks.afterPendingWritten?.(),
      beforeCommit: () => hooks.beforeCommit?.(),
      afterCommit: () => hooks.afterCommit?.(),
    },
  });
  return { service, hooks };
}

async function importBytes(service, bytes, options = {}) {
  const staged = await service.stageImport(bytes);
  const preview = await service.previewImport({ stageId: staged.stageId, options });
  const result = await service.importer.apply({ previewId: preview.previewId });
  return { staged, preview, result };
}

/** Rebuild a zip after mutating its members; refreshes manifest sizes/checksums. */
function rezip(bytes, mutate, { refresh = true } = {}) {
  const members = readStoreZip(bytes);
  const map = new Map([...members].map(([name, data]) => [name, Buffer.from(data)]));
  mutate(map);
  if (refresh) {
    const manifest = JSON.parse(map.get('manifest.json').toString());
    for (const category of manifest.categories) {
      const data = map.get(category.path);
      if (!data) continue;
      category.byteSize = data.length;
      category.sha256 = sha256Hex(data);
    }
    map.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  }
  return buildStoreZip([...map].map(([name, data]) => ({ name, data })));
}

function expectCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
  });
}
async function expectCodeAsync(fn, code) {
  await assert.rejects(Promise.resolve().then(fn), (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
  });
}

test('export: selection options, manifest digests, omissions and Markdown', async () => {
  const ids = await seed();
  // Single chat: no children, relation to a missing parent is reported and removed.
  const single = await buildConversationsExport(store, { scope: 'chat', chatIds: [ids.b] });
  const singleParsed = parseConversationsArchive(single.bytes);
  assert.equal(singleParsed.chats.length, 1);
  assert.equal(singleParsed.chats[0].forkParentChatId, undefined);
  assert.ok(single.manifest.omissions.some((o) => o.reason === 'dependency_not_exported' && o.path.endsWith('forkParentChatId')));
  assert.ok(single.manifest.omissions.some((o) => o.reason === 'browser_unavailable'), 'unsynced queues are explicitly not covered');

  // Subchats and archived are explicit options.
  const noSub = await buildConversationsExport(store, { scope: 'selection', chatIds: [ids.a] });
  assert.equal(parseConversationsArchive(noSub.bytes).chats.length, 1);
  const withSub = await buildConversationsExport(store, { scope: 'selection', chatIds: [ids.a], includeSubchats: true });
  assert.deepEqual(parseConversationsArchive(withSub.bytes).chats.map((c) => c.sourceChatId).sort(), [ids.a, ids.b].sort());
  const allNoArchived = await buildConversationsExport(store, { scope: 'all' });
  assert.ok(!parseConversationsArchive(allNoArchived.bytes).chats.some((c) => c.sourceChatId === ids.c));
  assert.ok(allNoArchived.manifest.omissions.some((o) => o.reason === 'operator_excluded' && o.path.includes(ids.c)));
  const ws = await buildConversationsExport(store, { scope: 'workspace', workspaceFolder: '/work/acme', includeSubchats: true });
  assert.equal(parseConversationsArchive(ws.bytes).chats.length, 2);
  await assert.rejects(buildConversationsExport(store, { scope: 'chat', chatIds: ['nope'] }), (e) => e.code === 'chat_not_found');

  // Full archive: manifest digests match members, missing attachment is an omission, not a placeholder.
  const full = await exportAll();
  const members = readStoreZip(full.bytes);
  for (const category of full.manifest.categories) {
    assert.equal(sha256Hex(members.get(category.path)), category.sha256);
    assert.equal(members.get(category.path).length, category.byteSize);
  }
  assert.ok(full.manifest.omissions.some((o) => o.reason === 'attachment_missing' && o.path.includes(ATT_MISSING)));
  assert.equal(full.manifest.attachments.count, 2);
  assert.ok(members.has(`attachments/${ATT1}`) && members.has(`attachments/${ATT2}`));
  assert.ok(!JSON.stringify(full.manifest).includes('/work/acme'), 'workspace paths are opt-in');
  const withPaths = await exportAll({ includeWorkspacePaths: true });
  assert.ok(readStoreZip(withPaths.bytes).get('chats/metadata.json').toString().includes('/work/acme'));
  // Exported chat records never carry native session identifiers.
  const metadata = readStoreZip(full.bytes).get('chats/metadata.json').toString();
  for (const secret of ['oc-1', 'cl-1', 'cx-1', 'ag-1', 'cs-A', 'w-1', 'todo-1']) assert.ok(!metadata.includes(secret), `${secret} must not be exported`);

  // Markdown: reading copy, untrusted text cannot break out of its fence or become a heading.
  const md = await buildConversationsExport(store, { scope: 'all', includeArchived: true, format: 'markdown' });
  const text = md.bytes.toString('utf8');
  assert.equal(md.format, 'markdown');
  assert.ok(text.includes('````text'), 'fence is longer than the longest backtick run in the content');
  assert.ok(text.includes('## Other \\# workspace'));
  const markdownMember = readStoreZip(full.bytes).get('markdown/conversations.md');
  assert.ok(markdownMember && full.manifest.categories.find((c) => c.role === 'markdown'));
});

test('round trip: new ids, remapped relations, cleared sessions, attachment hashes', async () => {
  const ids = await seed();
  const built = await exportAll();
  const sourceDigests = Object.fromEntries(await Promise.all(Object.values(ids).map(async (id) => [id, chatContentDigest((await store.loadHistory(id)).events)])));
  await wipeInstall();
  const { service } = makeService();
  const staged = await service.stageImport(built.bytes);
  const acme = staged.workspaces.find((w) => w.label === 'acme');
  const preview = await service.previewImport({ stageId: staged.stageId, options: { workspaceMapping: { [acme.ref]: { workspaceFolder: '/new/acme', workspaceFile: '/new/acme/acme.code-workspace' } } } });
  assert.equal(preview.plan.counts.new, 4);
  assert.equal(preview.plan.chats.find((c) => c.sourceChatId === ids.a).attachments.missing, 1);
  assert.ok(preview.plan.chats.find((c) => c.sourceChatId === ids.b).relations.some((r) => r.action === 'remap'));
  assert.equal(preview.plan.chats.find((c) => c.sourceChatId === ids.c).workspace.resolved, true, 'chat without workspace needs none');
  const unmapped = preview.plan.chats.find((c) => c.sourceChatId === ids.d);
  assert.equal(unmapped.workspace.resolved, false);
  assert.ok(unmapped.warnings.some((w) => w.startsWith('workspace_unmapped')));
  assert.equal(loadChats().length, 0, 'preview writes nothing');

  const { mapping } = await service.importer.apply({ previewId: preview.previewId });
  const imported = loadChats();
  assert.equal(imported.length, 4);
  for (const [src, dest] of Object.entries(mapping)) assert.notEqual(src, dest);
  const byId = Object.fromEntries(imported.map((c) => [c.id, c]));
  const a = byId[mapping[ids.a]];
  const b = byId[mapping[ids.b]];
  assert.equal(b.forkParentChatId, mapping[ids.a], 'fork parent is remapped');
  assert.equal(a.workspaceFolder, '/new/acme');
  assert.equal(byId[mapping[ids.d]].workspaceFolder, undefined);
  for (const chat of imported) {
    for (const field of ['opencodeSessionId', 'claudeSessionId', 'codexThreadId', 'sdkAgentId', 'todoId', 'widgetInstallationId']) assert.equal(chat[field], undefined, `${field} must be cleared`);
    assert.ok(!['cs-A', 'cs-B', 'cs-C', 'cs-D'].includes(chat.cursorSessionId));
    assert.equal(chat.historyHandoff.required, true);
    assert.equal(chat.importedFrom.archiveId, built.archiveId);
  }
  assert.equal(byId[mapping[ids.c]].archivedAt, '2026-02-01T00:00:00.000Z');

  // Content, order and records match the source (attachment names are rewritten, notice appended).
  for (const [src, dest] of Object.entries(mapping)) {
    const doc = await loadChatHistory(dest);
    const events = doc.events.filter((e) => !e.rec.handoff);
    assert.equal(events.length, doc.events.length - 1, 'one import notice is appended');
    assert.equal(chatContentDigest(events), sourceDigests[src]);
    assert.ok(events.every((e) => e.rec.clientSeq === undefined), 'per-device clientSeq is not carried over');
  }
  // Attachment hashes: bytes identical, references point at the new files.
  const textA = (await loadChatHistory(mapping[ids.a])).events[0].rec.text;
  const refs = [...textA.matchAll(/uploads\/([a-f0-9-]{36}\.jpg)/g)].map((m) => m[1]);
  assert.equal(refs.length, 2);
  assert.ok(!refs.includes(ATT1) && !refs.includes(ATT2), 'names are remapped');
  const hashes = refs.map((name) => sha256Hex(fs.readFileSync(path.join(UPLOADS, name)))).sort();
  assert.deepEqual(hashes, [sha256Hex(ATT1_BYTES), sha256Hex(ATT2_BYTES)].sort());
  const forkRef = (await loadChatHistory(mapping[ids.b])).events[0].rec.text.match(/uploads\/([a-f0-9-]{36}\.jpg)/)[1];
  assert.ok(refs.includes(forkRef), 'an attachment shared by two chats is stored once');
  assert.ok((await loadChatHistory(mapping[ids.a])).events[2].rec.text.includes(ATT_MISSING), 'a missing attachment is left as text');
});

test('replay and lost response never duplicate; deleted destination is not resurrected', async () => {
  const ids = await seed();
  const built = await exportAll();
  await wipeInstall();
  const { service } = makeService();
  const staged = await service.stageImport(built.bytes);
  const preview = await service.previewImport({ stageId: staged.stageId, options: {} });
  const first = await service.importer.apply({ previewId: preview.previewId });
  assert.equal(first.replayed, false);
  assert.equal(loadChats().length, 4);
  // Lost response: the client repeats the same apply.
  const again = await service.importer.apply({ previewId: preview.previewId });
  assert.equal(again.replayed, true);
  assert.deepEqual(again.mapping, first.mapping);
  assert.equal(loadChats().length, 4);
  // Same through the job layer (same preview -> same job).
  const preview2 = await service.previewImport({ stageId: staged.stageId, options: {} });
  assert.equal(preview2.plan.counts.already_imported, 4);
  assert.equal(preview2.plan.willImportCount, 0);
  const j1 = service.startImportApply({ previewId: preview2.previewId });
  const j2 = service.startImportApply({ previewId: preview2.previewId });
  assert.equal(j1.id, j2.id);
  const done = await service.jobs.wait(j1.id);
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(done.result.mapping, first.mapping, 'a fresh preview returns the earlier mapping');
  assert.equal(loadChats().length, 4);
  // Re-staging the identical archive (restart / second device) is also a replay.
  const { service: restarted } = makeService();
  const stagedAgain = await restarted.stageImport(built.bytes);
  const p3 = await restarted.previewImport({ stageId: stagedAgain.stageId, options: {} });
  assert.equal(p3.plan.counts.already_imported, 4);
  await restarted.importer.apply({ previewId: p3.previewId });
  assert.equal(loadChats().length, 4);
  // Persisted apply result survives a lost preview map.
  const replayAfterRestart = await restarted.importer.apply({ previewId: preview.previewId });
  assert.equal(replayAfterRestart.replayed, true);

  // Deleted destination is reported, never recreated.
  const destA = first.mapping[ids.a];
  await deleteChatHistory(destA);
  saveChats(loadChats().filter((c) => c.id !== destA));
  const p4 = await service.previewImport({ stageId: staged.stageId, options: {} });
  const planA = p4.plan.chats.find((c) => c.sourceChatId === ids.a);
  assert.equal(planA.status, 'destination_deleted');
  assert.equal(planA.willImport, false);
  await service.importer.apply({ previewId: p4.previewId });
  assert.equal(loadChats().length, 3);
  assert.ok(!loadChats().some((c) => c.id === destA));
  // Explicit duplicate mode is separate and creates new copies.
  const p5 = await service.previewImport({ stageId: staged.stageId, options: { duplicate: true, chatIds: [ids.a] } });
  assert.equal(p5.plan.chats.find((c) => c.sourceChatId === ids.a).status, 'duplicate');
  const dup = await service.importer.apply({ previewId: p5.previewId });
  assert.notEqual(dup.mapping[ids.a], destA);
  assert.equal(loadChats().length, 4);
  assert.equal((await service.importer.apply({ previewId: p5.previewId })).replayed, true);
  assert.equal(loadChats().length, 4, 'duplicate replay does not copy again');
});

test('option changes are explicit in the preview and need acknowledgement', async () => {
  const ids = await seed();
  const built = await exportAll({ includeWorkspacePaths: false });
  await wipeInstall();
  const { service } = makeService();
  const staged = await service.stageImport(built.bytes);
  const acme = staged.workspaces.find((w) => w.label === 'acme');
  const mapA = { workspaceMapping: { [acme.ref]: { workspaceFolder: '/one' } } };
  const mapB = { workspaceMapping: { [acme.ref]: { workspaceFolder: '/two' } } };
  const p1 = await service.previewImport({ stageId: staged.stageId, options: { ...mapA, chatIds: [ids.a] } });
  await service.importer.apply({ previewId: p1.previewId });
  const p2 = await service.previewImport({ stageId: staged.stageId, options: { ...mapB, chatIds: [ids.a] } });
  const planA = p2.plan.chats.find((c) => c.sourceChatId === ids.a);
  assert.equal(planA.status, 'options_changed');
  assert.equal(planA.previousDestinations.length, 1);
  assert.equal(p2.plan.requiresOptionChangeAck, true);
  await expectCodeAsync(() => service.importer.apply({ previewId: p2.previewId }), 'OPTION_CHANGE_UNCONFIRMED');
  assert.equal(loadChats().length, 1);
  const p3 = await service.previewImport({ stageId: staged.stageId, options: { ...mapB, chatIds: [ids.a], acknowledgeOptionChange: true } });
  await service.importer.apply({ previewId: p3.previewId });
  assert.equal(loadChats().length, 2);
  // The original options still replay to the first destination.
  const p4 = await service.previewImport({ stageId: staged.stageId, options: { ...mapA, chatIds: [ids.a] } });
  assert.equal(p4.plan.chats.find((c) => c.sourceChatId === ids.a).status, 'already_imported');
});

test('same archive id with a different digest is a conflict', async () => {
  await seed();
  const built = await exportAll();
  await wipeInstall();
  const { service } = makeService();
  await importBytes(service, built.bytes);
  const tampered = rezip(built.bytes, (map) => {
    const meta = JSON.parse(map.get('chats/metadata.json').toString());
    meta.chats[0].title = 'Renamed after export';
    map.set('chats/metadata.json', Buffer.from(JSON.stringify(meta)));
  });
  assert.equal(parseConversationsArchive(tampered).archiveId, built.archiveId, 'the forged archive is internally consistent');
  await expectCodeAsync(() => service.stageImport(tampered), 'ARCHIVE_DIGEST_CONFLICT');
  assert.equal(loadChats().length, 4);
});

test('lineage survives re-export with a new archive id and shows in the preview', async () => {
  const ids = await seed();
  const first = await exportAll();
  await wipeInstall();
  const { service } = makeService();
  const { result } = await importBytes(service, first.bytes);
  const second = await buildConversationsExport(store, { scope: 'all', includeArchived: true, includeSubchats: true });
  assert.notEqual(second.archiveId, first.archiveId);
  assert.deepEqual(second.manifest.lineage.sourceArchiveIds, [first.archiveId]);
  const parsed = parseConversationsArchive(second.bytes);
  const row = parsed.chats.find((c) => c.title === 'Root chat');
  assert.deepEqual(row.lineage, [{ archiveId: first.archiveId, sourceChatId: ids.a }]);
  // Importing the re-export where its lineage already exists: content match, skipped unless duplicate.
  const staged = await service.stageImport(second.bytes);
  const preview = await service.previewImport({ stageId: staged.stageId, options: {} });
  assert.equal(preview.plan.counts.content_match, 4);
  assert.equal(preview.plan.willImportCount, 0);
  assert.equal(preview.plan.archive.lineage.sourceArchiveIds[0], first.archiveId);
  const planRoot = preview.plan.chats.find((c) => c.title === 'Root chat');
  assert.deepEqual(planRoot.matches, [{ chatId: result.mapping[ids.a], kind: 'content' }]);
  const dup = await service.previewImport({ stageId: staged.stageId, options: { duplicate: true } });
  assert.equal(dup.plan.counts.duplicate, 4);
});

test('corrupt archives are rejected before any write; failed apply leaves nothing behind', async () => {
  const ids = await seed();
  const built = await exportAll();
  await wipeInstall();
  const { service } = makeService();
  // Flipped payload byte (checksum), truncated file, garbage.
  const flipped = Buffer.from(built.bytes);
  const marker = flipped.indexOf(Buffer.from('Root chat'));
  flipped[marker] ^= 0x20;
  await assert.rejects(service.stageImport(flipped), (e) => ['crc_mismatch', 'checksum_mismatch'].includes(e.code));
  await assert.rejects(service.stageImport(built.bytes.subarray(0, built.bytes.length - 40)), (e) => e.code === 'zip_invalid');
  await assert.rejects(service.stageImport(Buffer.from('not a zip at all, definitely not')), (e) => e.code === 'zip_invalid');
  // Manifest/payload mismatches that are internally CRC-consistent.
  await assert.rejects(service.stageImport(rezip(built.bytes, (m) => m.set('chats/history.json', Buffer.from('{}')), { refresh: false })), (e) => e.code === 'size_mismatch');
  await assert.rejects(service.stageImport(rezip(built.bytes, (m) => m.set('chats/history.json', Buffer.from(m.get('chats/history.json').toString().replace('Seen both', 'Seen BOTH'))), { refresh: false })), (e) => e.code === 'checksum_mismatch');
  await assert.rejects(service.stageImport(rezip(built.bytes, (m) => m.set('extra/evil.txt', Buffer.from('x')))), (e) => e.code === 'unlisted_member');
  await assert.rejects(service.stageImport(rezip(built.bytes, (m) => m.delete(`attachments/${ATT1}`))), (e) => e.code === 'member_missing');
  await assert.rejects(service.stageImport(rezip(built.bytes, (m) => {
    const h = JSON.parse(m.get('chats/history.json').toString());
    h.histories[0].events[0].rec = { kind: 'bogus' };
    m.set('chats/history.json', Buffer.from(JSON.stringify(h)));
  })), (e) => e.code === 'record_invalid');
  await assert.rejects(service.stageImport(rezip(built.bytes, (m) => {
    const meta = JSON.parse(m.get('chats/metadata.json').toString());
    meta.chats[1].forkParentChatId = 'ffff0000-0000-4000-8000-0000000000ff';
    m.set('chats/metadata.json', Buffer.from(JSON.stringify(meta)));
  })), (e) => e.code === 'reference_broken');
  await assert.rejects(service.stageImport(rezip(built.bytes, (m) => {
    m.set('chats/metadata.json', Buffer.from(m.get('chats/metadata.json').toString().replace('"title":"Root chat"', '"__proto__":{"x":1},"title":"Root chat"')));
  })), (e) => e.code === 'prototype_pollution');
  assert.equal(loadChats().length, 0);
  assert.ok(!fs.existsSync(RECEIPTS), 'rejected archives leave no receipts');

  // A failure in the middle of apply (after the first history was written) rolls everything back.
  let calls = 0;
  const failing = { ...store, async writeHistory(chatId, session, recs) {
    calls += 1;
    if (calls === 2) throw new Error('disk full');
    return store.writeHistory(chatId, session, recs);
  } };
  const { service: broken } = makeService({ store: failing });
  const staged = await broken.stageImport(built.bytes);
  const preview = await broken.previewImport({ stageId: staged.stageId, options: {} });
  await assert.rejects(broken.importer.apply({ previewId: preview.previewId }), /disk full/);
  assert.equal(loadChats().length, 0, 'no partial chat list');
  assert.deepEqual(fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS) : [], [], 'staged attachments removed');
  const historyDir = path.join(ISOLATED_DATA_DIR, 'chat-history');
  assert.deepEqual(fs.existsSync(historyDir) ? fs.readdirSync(historyDir).filter((n) => n.endsWith('.json')) : [], [], 'no orphan history files');
  assert.deepEqual(readReceiptState().receipts, []);
  assert.deepEqual(readReceiptState().pending, []);
  // The same archive imports cleanly afterwards.
  const { service: ok } = makeService();
  const again = await importBytes(ok, built.bytes);
  assert.equal(Object.keys(again.result.mapping).length, 4);
  assert.equal(loadChats().length, 4);
  void ids;
});

test('crash recovery: journal rolls an interrupted import back or forward without duplicates', async () => {
  const ids = await seed();
  const built = await exportAll();
  await wipeInstall();
  const { service, hooks } = makeService();
  const staged = await service.stageImport(built.bytes);

  // Crash after the journal was written but before the commit: roll back.
  hooks.afterPendingWritten = () => { throw new Error('crash'); };
  const p1 = await service.previewImport({ stageId: staged.stageId, options: {} });
  await assert.rejects(service.importer.apply({ previewId: p1.previewId }), /crash/);
  assert.equal(readReceiptState().pending.length, 1);
  hooks.afterPendingWritten = undefined;
  await service.recover();
  assert.equal(readReceiptState().pending.length, 0);
  assert.equal(loadChats().length, 0);

  // Crash after the commit before receipts are finalized: roll forward, replay returns the mapping.
  hooks.afterCommit = () => { throw new Error('crash after commit'); };
  const p2 = await service.previewImport({ stageId: staged.stageId, options: {} });
  await assert.rejects(service.importer.apply({ previewId: p2.previewId }), /crash after commit/);
  assert.equal(loadChats().length, 4);
  hooks.afterCommit = undefined;
  await service.recover();
  const state = readReceiptState();
  assert.equal(state.pending.length, 0);
  assert.equal(state.receipts.length, 4);
  const replay = await service.importer.apply({ previewId: p2.previewId });
  assert.equal(replay.replayed, true);
  assert.equal(Object.keys(replay.mapping).length, 4);
  const p3 = await service.previewImport({ stageId: staged.stageId, options: {} });
  assert.equal(p3.plan.counts.already_imported, 4);
  assert.equal(loadChats().length, 4);
  void ids;
});

test('stale previews are refused when the chat list changed', async () => {
  const ids = await seed();
  const built = await exportAll();
  await wipeInstall();
  const { service } = makeService();
  const staged = await service.stageImport(built.bytes);
  const preview = await service.previewImport({ stageId: staged.stageId, options: {} });
  saveChats([{ id: 'eeee0000-0000-4000-8000-0000000000ee', title: 'unrelated', cursorSessionId: 'x', createdAt: '2026-01-01T00:00:00.000Z', agentTransport: 'sdk' }]);
  await expectCodeAsync(() => service.importer.apply({ previewId: preview.previewId }), 'STALE_PREVIEW');
  await expectCodeAsync(() => service.importer.apply({ previewId: 'nope' }), 'PREVIEW_NOT_FOUND');
  void ids;
});

test('ZIP hardening: traversal, absolute paths, symlinks, compression, nested archives, overlap, size lies', async () => {
  const single = (name) => buildStoreZip([{ name, data: Buffer.from('payload') }]);
  const patch = (buf, from, to) => {
    const out = Buffer.from(buf);
    let at = out.indexOf(Buffer.from(from));
    assert.ok(at >= 0);
    while (at >= 0) { Buffer.from(to).copy(out, at); at = out.indexOf(Buffer.from(from), at + to.length); }
    return out;
  };
  expectCode(() => readStoreZip(patch(single('xx/evil.txt'), 'xx/', '../')), 'path_invalid');
  expectCode(() => readStoreZip(patch(single('xetc/passwd'), 'xetc/passwd', '/etc/passwd')), 'path_invalid');
  expectCode(() => readStoreZip(patch(single('C_/win.txt'), 'C_/', 'C:/')), 'path_invalid');
  expectCode(() => readStoreZip(patch(single('a_b.txt'), 'a_b.txt', 'a\\b.txt')), 'path_invalid');
  expectCode(() => readStoreZip(patch(single('a/./b.txt'), 'a/./b.txt', 'a/../.txt')), 'path_invalid');
  expectCode(() => single('nested.zip'), 'nested_archive_forbidden');
  expectCode(() => buildStoreZip([{ name: 'a.txt', data: Buffer.alloc(1) }, { name: 'a.txt', data: Buffer.alloc(1) }]), 'duplicate_entry');

  // Deflate / zip-bomb style entry: refused without inflating anything.
  const compressed = Buffer.from(single('bomb.bin'));
  compressed.writeUInt16LE(8, 8);
  const centralAt = compressed.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  compressed.writeUInt16LE(8, centralAt + 10);
  expectCode(() => readStoreZip(compressed), 'compression_forbidden');
  // Declared size far beyond what is present (and beyond the member limit).
  const lie = Buffer.from(single('big.bin'));
  const c2 = lie.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lie.writeUInt32LE(0xfffffff0, c2 + 20);
  lie.writeUInt32LE(0xfffffff0, c2 + 24);
  expectCode(() => readStoreZip(lie), 'member_size_exceeded');
  // Declared sizes that disagree with each other.
  const mismatch = Buffer.from(single('m.bin'));
  const c3 = mismatch.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  mismatch.writeUInt32LE(99, c3 + 24);
  expectCode(() => readStoreZip(mismatch), 'zip_invalid');
  // Symlink attribute.
  const link = Buffer.from(single('ln'));
  const c4 = link.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  link.writeUInt32LE((0o120777 << 16) >>> 0, c4 + 38);
  expectCode(() => readStoreZip(link), 'symlink_forbidden');
  // Total / per-member limits and entry count.
  const big = buildStoreZip([{ name: 'one.bin', data: Buffer.alloc(2000) }, { name: 'two.bin', data: Buffer.alloc(2000) }]);
  expectCode(() => readStoreZip(big, { maxTotalBytes: 3000 }), 'archive_size_exceeded');
  expectCode(() => readStoreZip(big, { maxMemberBytes: 1000 }), 'member_size_exceeded');
  expectCode(() => readStoreZip(big, { maxEntries: 1 }), 'entry_count_exceeded');
  // Overlapping entries (two central records pointing at the same local header).
  const two = Buffer.from(buildStoreZip([{ name: 'aa.bin', data: Buffer.from('1234') }, { name: 'bb.bin', data: Buffer.from('5678') }]));
  const firstCentral = two.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const secondCentral = two.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), firstCentral + 4);
  two.writeUInt32LE(two.readUInt32LE(firstCentral + 42), secondCentral + 42);
  expectCode(() => readStoreZip(two), 'zip_invalid');
  assert.ok(new ZipArchiveError('x', 'y') instanceof Error);
  // The archive-level size gate applies before parsing.
  await seed();
  const built = await exportAll();
  expectCode(() => parseConversationsArchive(built.bytes, { maxBytes: 64 }), 'archive_size_exceeded');
  // Round trip still fine for a legitimate store-only archive.
  assert.equal(readStoreZip(buildStoreZip([{ name: 'ok/a.txt', data: Buffer.from('hi') }])).get('ok/a.txt').toString(), 'hi');
});

test('jobs: durable state, idempotency, interruption, cancellation before publication, verified artifacts', async () => {
  await seed();
  const { service } = makeService();
  const job = service.startExport({ scope: 'all', includeArchived: true, includeSubchats: true }, { idempotencyKey: 'exp-1' });
  assert.equal(service.startExport({ scope: 'all' }, { idempotencyKey: 'exp-1' }).id, job.id);
  const done = await service.jobs.wait(job.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.result.chatCount, 4);
  const file = service.jobs.artifactPath(job.id);
  assert.equal(sha256Hex(fs.readFileSync(file)), done.artifact.sha256, 'published bytes match the recorded digest');
  assert.equal(parseConversationsArchive(fs.readFileSync(file)).chats.length, 4);
  // State survives a "restart".
  service.jobs.resetForTests();
  assert.equal(service.jobs.get(job.id).status, 'succeeded');
  // A job that was running when the process died becomes interrupted, not running forever.
  const stuckId = 'j-abc-12345678';
  fs.writeFileSync(path.join(JOBS_DIR, `${stuckId}.json`), JSON.stringify({ id: stuckId, kind: 'conversations-export', status: 'running', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', progress: { done: 0, total: 1 } }));
  service.jobs.resetForTests();
  assert.equal(service.jobs.get(stuckId).status, 'interrupted');
  // Cancellation before publication leaves no artifact.
  const jobs = createJobManager({ dir: path.join(ISOLATED_DATA_DIR, 'jobs-cancel') });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = jobs.start('x', async (ctx) => {
    await gate;
    ctx.publish('late.zip', Buffer.from('data'), 'application/zip');
    return {};
  });
  jobs.cancel(slow.id);
  release();
  const cancelled = await jobs.wait(slow.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(jobs.artifactPath(slow.id), null);
  const uncancellable = jobs.start('y', async () => { await gate; }, { cancellable: false });
  assert.throws(() => jobs.cancel(uncancellable.id), (e) => e.code === 'JOB_NOT_CANCELLABLE');
  assert.throws(() => jobs.start('z', async () => {}, { idempotencyKey: '../bad' }), (e) => e.code === 'IDEMPOTENCY_KEY_INVALID');
  // An export of a missing chat fails as a job; the connection is not involved.
  const failing = service.startExport({ scope: 'chat', chatIds: ['nope'] });
  const failed = await service.jobs.wait(failing.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'chat_not_found');
  assert.equal(service.jobs.artifactPath(failing.id), null);
});

test('strict reads: a corrupt chat list fails the export instead of exporting nothing', async () => {
  await seed();
  const file = path.join(ISOLATED_DATA_DIR, 'chats.json');
  const good = fs.readFileSync(file);
  fs.writeFileSync(file, '{ not json');
  try {
    await assert.rejects(exportAll(), (e) => e.code === 'SOURCE_CORRUPT');
  } finally {
    fs.writeFileSync(file, good);
  }
});

test('HTTP flow: export job, download, raw upload, preview, apply job, auth boundary', async () => {
  await seed();
  const app = express();
  app.use((req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : express.json({ limit: '8mb' })(req, res, next)));
  app.use((req, res, next) => {
    if (req.get('x-limited')) req.widgetAccess = { installationId: 'w' };
    next();
  });
  const { service } = makeService();
  registerConversationsBackupRoutes(app, { service, maxImportBytes: 64 * 1024 * 1024 });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/conversations-backup`;
  const json = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const poll = async (id) => {
    for (let i = 0; i < 200; i += 1) {
      const { body } = await json('GET', `/jobs/${id}`);
      if (!['queued', 'running'].includes(body.job.status)) return body.job;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('job did not finish');
  };
  try {
    assert.equal((await json('GET', '/capabilities', undefined, { 'x-limited': '1' })).status, 403);
    assert.equal((await json('POST', '/export', { scope: 'all' }, { 'x-limited': '1' })).status, 403);
    assert.equal((await json('POST', '/export', { scope: 'bogus' })).status, 400);
    const estimate = await json('POST', '/export/estimate', { scope: 'all', includeArchived: true, includeSubchats: true });
    assert.equal(estimate.body.estimate.chatCount, 4);
    assert.equal(estimate.body.estimate.attachmentCount, 2);
    const started = await json('POST', '/export', { scope: 'all', includeArchived: true, includeSubchats: true }, { 'Idempotency-Key': 'http-1' });
    assert.equal(started.status, 202);
    const job = await poll(started.body.job.id);
    assert.equal(job.status, 'succeeded');
    const download = await fetch(`${base}/jobs/${job.id}/download`);
    assert.equal(download.status, 200);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(sha256Hex(bytes), download.headers.get('x-content-sha256'));
    assert.equal((await fetch(`${base}/jobs/..%2Fetc/download`)).status, 404);

    await wipeInstall();
    const upload = await fetch(`${base}/import/stage`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: bytes });
    const staged = (await upload.json()).staged;
    assert.equal(upload.status, 200);
    const bad = await fetch(`${base}/import/stage`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: bytes.subarray(0, 200) });
    assert.equal(bad.status, 400);
    const preview = await json('POST', '/import/preview', { stageId: staged.stageId, options: {} });
    assert.equal(preview.body.preview.plan.counts.new, 4);
    const applied = await json('POST', '/import/apply', { previewId: preview.body.preview.previewId });
    assert.equal(applied.status, 202);
    const retried = await json('POST', '/import/apply', { previewId: preview.body.preview.previewId });
    assert.equal(retried.body.job.id, applied.body.job.id, 'a retried apply returns the same job');
    const finished = await poll(applied.body.job.id);
    assert.equal(finished.status, 'succeeded');
    assert.equal(Object.keys(finished.result.mapping).length, 4);
    assert.equal(loadChats().length, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('attachment reference scan stays linear on long unbroken strings', () => {
  const blob = 'A'.repeat(2_000_000);
  const started = Date.now();
  const rewritten = archiveLib.rewriteAttachmentRefs({ kind: 'localUser', text: blob }, new Map(), '/dest/uploads');
  assert.equal(rewritten.text.length, blob.length);
  assert.ok(Date.now() - started < 2000, 'regex scan must not be quadratic');
});

test('a chat at the retention limit imports with all source events and a matching digest', async () => {
  await seed();
  const id = 'f000f000-0000-4000-8000-00000000f000';
  saveChats([...loadChats(), { id, title: 'Full history', cursorSessionId: 'cs-F', createdAt: '2026-01-06T00:00:00.000Z', agentTransport: 'sdk', sdkMode: 'agent' }]);
  for (let start = 0; start < 2000; start += 250) {
    await appendChatHistoryEvents(id, 'cs-F', Array.from({ length: 250 }, (_, i) => ({ rec: user(`message ${start + i}`) })));
  }
  const source = await store.loadHistory(id);
  assert.equal(source.events.length, 2000);
  const sourceDigest = chatContentDigest(source.events);
  const built = await buildConversationsExport(store, { scope: 'chat', chatIds: [id] });
  await wipeInstall();
  const { service } = makeService();
  const { result } = await importBytes(service, built.bytes);
  const imported = await loadChatHistory(result.mapping[id]);
  assert.equal(imported.events.length, 2000, 'no source event is trimmed');
  assert.equal(imported.events[0].rec.text, 'message 0');
  assert.equal(chatContentDigest(imported.events), sourceDigest);
});

test('a failed apply job does not block a retry of the same preview', async () => {
  await seed();
  const { service } = makeService();
  const previewId = crypto.randomUUID();
  const first = service.startImportApply({ previewId });
  const failed = await service.jobs.wait(first.id);
  assert.equal(failed.status, 'failed');
  const second = service.startImportApply({ previewId });
  assert.notEqual(second.id, first.id);
  await service.jobs.wait(second.id);
  const jobs = createJobManager({ dir: path.join(ISOLATED_DATA_DIR, 'jobs-retry') });
  const ok = jobs.start('k', async () => ({}), { idempotencyKey: 'same' });
  await jobs.wait(ok.id);
  assert.equal(jobs.start('k', async () => ({}), { idempotencyKey: 'same' }).id, ok.id, 'succeeded jobs are still returned');
});

test('omissions beyond the limit are summarized instead of silently dropped', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({ path: `chats/${i}`, reason: 'operator_excluded' }));
  const capped = archiveLib.capOmissions(many);
  assert.equal(capped.length, 4096);
  assert.match(capped[4095].detail, /905 further omissions/);
  assert.equal(archiveLib.capOmissions(many.slice(0, 10)).length, 10);
});
