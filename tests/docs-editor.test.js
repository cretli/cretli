import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { completedRenameSteps, linkKindKey, skippedReasonKey } from '../app_front/features/docs/docsLabels.js';
import { en } from '../app_front/i18n/en.js';
import { conflictKind, directoryTree, reviewedSave } from '../app_front/features/docs/docsLogic.js';

// Exercise the real async controller with a minimal Lit host; no browser or DOM is needed.
const source = fs.readFileSync(new URL('../app_front/features/docs/cr-docs-panel.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const translate = (key, vars) => {
  let text = key.split('.').reduce((node, part) => node?.[part], en) || key;
  for (const [name, value] of Object.entries(vars || {})) text = text.replaceAll(`{${name}}`, value);
  return text;
};
globalThis.__docsControllerDeps = { conflictKind, reviewedSave, directoryTree, completedRenameSteps, linkKindKey, skippedReasonKey, translate };
const prelude = `const { conflictKind, reviewedSave, directoryTree, completedRenameSteps, linkKindKey, skippedReasonKey, translate: t } = globalThis.__docsControllerDeps;
const LitElement = class { disconnectedCallback() {} };
const html = (strings, ...values) => ({ strings, values }); const nothing = undefined;
const renderDocMarkdown = () => [];
const customElements = { get: () => true }; const createDocsApi = () => ({});`;
const { CrDocsPanel } = await import(`data:text/javascript;base64,${Buffer.from(prelude + source).toString('base64')}`);
delete globalThis.__docsControllerDeps;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const base = { path: 'a.md', title: 'A', text: 'base', sha256: 'old' };
function editor(api) {
  const panel = new CrDocsPanel();
  panel.setScope({ workspaceUuid: 'one' }); panel.api = api;
  panel.note = { ...base }; panel.draft = 'draft'; panel.editing = true;
  return panel;
}

test('save conflict keeps the draft, loads disk for review, and a second change still conflicts', async () => {
  const hashes = [];
  let disk = { ...base, text: 'disk', sha256: 'new' };
  const panel = editor({
    save: async (_path, _text, hash) => { hashes.push(hash); throw Object.assign(new Error(), { status: 409, code: 'docs-conflict' }); },
    note: async () => ({ note: { ...disk } }),
  });
  await panel.save();
  assert.equal(panel.draft, 'draft'); assert.equal(panel.note.sha256, 'old');
  assert.equal(panel.conflict, 'conflict'); assert.equal(panel.remote.text, 'disk');
  disk = { ...disk, text: 'disk again', sha256: 'newer' };
  await panel.save(true);
  assert.deepEqual(hashes, ['old', 'new']);
  assert.equal(panel.remote.sha256, 'newer'); assert.equal(panel.draft, 'draft');
});

test('428 retains the draft and offers reload; preview refresh cannot discard a draft', async () => {
  const disk = { ...base, text: 'disk', sha256: 'new' };
  const api = {
    save: async () => { throw Object.assign(new Error(), { status: 428 }); },
    note: async () => ({ note: disk }), config: async () => ({ root: { external: false } }), tree: async () => ({ items: [disk] }),
  };
  const panel = editor(api);
  await panel.save(); assert.equal(panel.conflict, 'precondition'); assert.equal(panel.draft, 'draft');
  panel.editing = false;
  await panel.reload(); assert.equal(panel.draft, 'draft'); assert.equal(panel.note.sha256, 'old');
  panel.open('b.md'); assert.equal(panel.dialog, 'discard');
});

test('save success refreshes note and tree; scope changes ignore late writes and reads', async () => {
  const saved = { ...base, text: 'draft', sha256: 'saved' };
  const panel = editor({ save: async () => ({}), note: async () => ({ note: saved }), tree: async () => ({ items: [saved], skipped: [] }) });
  await panel.save(); assert.equal(panel.note.sha256, 'saved'); assert.equal(panel.editing, false); assert.equal(panel.conflict, '');
  const wait = deferred();
  panel.api.note = () => wait.promise;
  const read = panel.read('a.md');
  panel.setScope({ workspaceUuid: 'two' });
  wait.resolve({ note: saved }); await read;
  assert.equal(panel.note, null); assert.equal(panel.draft, '');
  const writeWait = deferred();
  panel.note = base; panel.draft = 'draft'; panel.editing = true; panel.api = { save: () => writeWait.promise };
  const write = panel.save();
  panel.setScope({ workspaceUuid: 'three' }); writeWait.resolve({}); await write;
  assert.equal(panel.note, null); assert.equal(panel.message, '');
});

test('latest search and latest note selection win regardless of response order', async () => {
  const slow = deferred();
  const panel = editor({ search: (q) => q === 'old' ? slow.promise : Promise.resolve({ items: [{ path: 'new.md' }] }) });
  const old = panel.search('old'); await panel.search('new'); slow.resolve({ items: [{ path: 'old.md' }] }); await old;
  assert.equal(panel.results[0].path, 'new.md');
  const slowNote = deferred();
  panel.api.note = (path) => path === 'old.md' ? slowNote.promise : Promise.resolve({ note: { ...base, path } });
  const oldRead = panel.read('old.md'); await panel.read('new.md'); slowNote.resolve({ note: { ...base, path: 'old.md' } }); await oldRead;
  assert.equal(panel.note.path, 'new.md');
});

test('R1A1-F1: dirty drafts block create, rename and trash at every mutation entry; cancel preserves the draft', async () => {
  let calls = 0;
  const panel = editor({ create: async () => { calls++; }, rename: async () => { calls++; }, trash: async () => { calls++; } });
  for (const kind of ['create', 'rename', 'trash']) {
    panel.showDialog(kind);
    assert.equal(panel.dialog, '', `${kind} cannot open over a draft`);
    panel.dialog = kind; panel.name = 'new.md';
    await panel.confirmDialog();
    panel.cancelDialog();
    assert.equal(panel.note.path, 'a.md'); assert.equal(panel.draft, 'draft');
  }
  await panel.mutate(async () => { calls++; return 'new.md'; });
  assert.equal(calls, 0);
  panel.open('b.md'); assert.equal(panel.dialog, 'discard');
  panel.cancelDialog();
  assert.equal(panel.dialog, ''); assert.equal(panel.draft, 'draft'); assert.equal(panel.note.path, 'a.md');
});

test('R1A1-F2: partial rename translates completed steps, closes the dialog and refreshes changed paths', async () => {
  const error = Object.assign(new Error(), { status: 409, code: 'docs-rename-partial', details: { completed: ['create:b.md', 'rewrite:folder:note.md', 'remove:a.md'] } });
  let treeCalls = 0;
  const panel = editor({ rename: async () => { throw error; }, tree: async () => { treeCalls++; return { items: [{ path: 'b.md' }], skipped: [] }; } });
  panel.draft = base.text; panel.dialog = 'rename'; panel.name = 'b.md';
  await panel.confirmDialog();
  assert.equal(treeCalls, 1); assert.equal(panel.dialog, ''); assert.equal(panel.note, null);
  assert.equal(panel.items[0].path, 'b.md');
  assert.match(panel.message, /Created destination: b\.md/);
  assert.match(panel.message, /Updated links in: folder:note\.md/);
  assert.match(panel.message, /Removed old path: a\.md/);
  assert.doesNotMatch(panel.message, /\["|create:|rewrite:|remove:/);
});

test('R1A1-F2: partial rename re-reads a surviving source and reports a failed tree refresh', async () => {
  const error = Object.assign(new Error(), { status: 409, code: 'docs-rename-partial', details: { completed: [] } });
  const panel = editor({
    rename: async () => { throw error; }, tree: async () => ({ items: [base] }),
    note: async () => ({ note: { ...base, sha256: 'rewritten' } }),
  });
  panel.draft = base.text; panel.dialog = 'rename'; panel.name = 'b.md';
  await panel.confirmDialog();
  assert.equal(panel.note.sha256, 'rewritten'); assert.equal(panel.dialog, '');
  assert.match(panel.message, /No completed steps/);
  panel.api.tree = async () => { throw new Error('offline'); };
  panel.dialog = 'rename'; await panel.confirmDialog();
  assert.equal(panel.dialog, ''); assert.match(panel.message, /tree could not be refreshed/);
});

test('R1A1-F4: create and rename trim the confirmed path before sending it', async () => {
  const requests = [];
  const panel = editor({
    create: async (path) => requests.push(['create', path]),
    rename: async (_old, path) => requests.push(['rename', path]),
    note: async (path) => ({ note: { ...base, path } }), tree: async () => ({ items: [] }),
  });
  panel.draft = base.text;
  panel.showDialog('create'); panel.name = '  new.md  '; await panel.confirmDialog();
  panel.showDialog('rename'); panel.name = '  renamed.md  '; await panel.confirmDialog();
  assert.deepEqual(requests, [['create', 'new.md'], ['rename', 'renamed.md']]);
});

test('R1A1-F5: input debounces for 250ms, invalidates old results immediately and Enter searches once', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred(), requests = [];
  const panel = editor({ search: async (q) => { requests.push(q); return q === 'old' ? pending.promise : { items: [{ path: `${q}.md` }] }; } });
  const old = panel.search('old');
  panel.scheduleSearch('n'); context.mock.timers.tick(100);
  panel.scheduleSearch('new'); context.mock.timers.tick(249);
  pending.resolve({ items: [{ path: 'old.md' }] }); await old;
  assert.deepEqual(panel.results, []); assert.deepEqual(requests, ['old']);
  context.mock.timers.tick(1); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(requests, ['old', 'new']); assert.equal(panel.results[0].path, 'new.md');
  panel.scheduleSearch('enter'); await panel.scheduleSearch('enter', true);
  context.mock.timers.tick(300); assert.deepEqual(requests, ['old', 'new', 'enter']);
  panel.scheduleSearch('cleared'); panel.scheduleSearch(''); context.mock.timers.tick(300);
  assert.equal(panel.results.length, 0); assert.equal(requests.length, 3);
  panel.scheduleSearch('other'); panel.setScope({ workspaceUuid: 'other' }); context.mock.timers.tick(300);
  assert.equal(requests.length, 3);
  panel.scheduleSearch('detached'); panel.disconnectedCallback(); context.mock.timers.tick(300);
  assert.equal(requests.length, 3);
  panel.api = { tree: async () => ({ items: [] }), search: async (q) => { requests.push(q); return { items: [] }; } };
  panel.scheduleSearch('before-create'); await panel.mutate(async () => null);
  context.mock.timers.tick(300); await Promise.resolve();
  assert.equal(panel.query, ''); assert.equal(requests.length, 3);
});

test('R1A1-F7: status live region persists when empty and the selected tree note has aria-current', () => {
  const panel = new CrDocsPanel();
  const empty = panel.render().strings.join('');
  assert.match(empty, /role="status" aria-live="polite" aria-atomic="true"/);
  panel.message = 'Saved';
  assert.equal(panel.render().strings.join(''), empty);
  panel.note = base;
  assert.equal(panel.noteButton(base, true).values[0], 'page');
  assert.equal(panel.noteButton({ path: 'b.md' }, true).values[0], undefined);
  assert.equal(panel.noteButton(base).values[0], undefined);
});

test('N1: workspace switches and reopening restore each dirty draft and detect disk conflicts', async () => {
  const panel = editor({});
  panel.remote = { ...base, text: 'remote', sha256: 'remote' }; panel.conflict = 'conflict';
  panel.setScope({ workspaceUuid: 'two' });
  assert.equal(panel.note, null); assert.equal(panel.draft, '');
  panel.note = { ...base, text: 'second base' }; panel.draft = 'second draft'; panel.editing = false;
  panel.setScope({ workspaceUuid: 'one' });
  assert.equal(panel.draft, 'draft'); assert.equal(panel.note.sha256, 'old');
  assert.equal(panel.editing, true); assert.equal(panel.remote.sha256, 'remote');
  panel.api = {
    config: async () => ({ root: { external: false } }), tree: async () => ({ items: [base] }),
    note: async () => ({ note: { ...base, text: 'changed on disk', sha256: 'latest' } }),
  };
  await panel.reload();
  assert.equal(panel.draft, 'draft'); assert.equal(panel.remote.sha256, 'latest');
  panel.open('b.md'); panel.cancelDialog(); assert.equal(panel.draft, 'draft');
  panel.setScope({ workspaceUuid: 'two' });
  assert.equal(panel.draft, 'second draft'); assert.equal(panel.editing, false);
  panel.setScope({ workspaceUuid: 'two' }); assert.equal(panel.draft, 'second draft');
  panel.draft = panel.note.text;
  panel.setScope({ workspaceUuid: 'one' }); panel.setScope({ workspaceUuid: 'two' });
  assert.equal(panel.note, null, 'a clean draft is not restored after leaving');
});

test('R1A1-R2: save completes in its source scope and retires its stashed draft without touching another scope', async () => {
  const wait = deferred();
  const saved = { ...base, text: 'draft', sha256: 'saved' };
  const panel = editor({ save: () => wait.promise });
  const saving = panel.save();
  panel.setScope({ workspaceUuid: 'two' });
  panel.note = { ...base, path: 'two.md' }; panel.draft = 'second draft';
  const secondNote = panel.note;
  wait.resolve({ note: saved }); await saving;
  assert.equal(panel.note, secondNote); assert.equal(panel.draft, 'second draft'); assert.equal(panel.busy, false);
  panel.setScope({ workspaceUuid: 'one' });
  assert.equal(panel.note, null); assert.equal(panel.dirty, false, 'the saved draft must not return with its stale base hash');
  panel.api = { note: async () => ({ note: saved }) };
  await panel.read(base.path);
  assert.equal(panel.note.sha256, 'saved'); assert.equal(panel.draft, 'draft'); assert.equal(panel.dirty, false);
});

test('R1A1-R2: returning before save completes blocks duplicate writes and then refreshes the saved version', async () => {
  const wait = deferred(); let saves = 0;
  const saved = { ...base, text: 'draft', sha256: 'saved' };
  const panel = editor({ save: () => { saves++; return wait.promise; }, tree: async () => ({ items: [saved] }) });
  const saving = panel.save();
  panel.setScope({ workspaceUuid: 'two' }); panel.setScope({ workspaceUuid: 'one' });
  assert.equal(panel.busy, true); await panel.save(); assert.equal(saves, 1);
  panel.api = { note: async () => ({ note: saved }), tree: async () => ({ items: [saved] }) };
  wait.resolve({ note: saved }); await saving;
  assert.equal(panel.note.sha256, 'saved'); assert.equal(panel.dirty, false); assert.equal(panel.busy, false);
  assert.equal(panel.message, 'Saved.');
});

test('R1A1-R2: failed save while away preserves the original draft and does not unlock another scope save', async () => {
  const first = deferred(), second = deferred();
  const panel = editor({ save: () => first.promise });
  const saving = panel.save(); panel.setScope({ workspaceUuid: 'two' });
  panel.note = { ...base, path: 'two.md' }; panel.draft = 'second draft';
  panel.api = { save: () => second.promise };
  const otherSave = panel.save();
  first.resolve(Promise.reject(Object.assign(new Error(), { status: 409, code: 'docs-conflict' })));
  await saving;
  assert.equal(panel.draft, 'second draft'); assert.equal(panel.busy, true); assert.equal(panel.message, '');
  second.resolve({}); await otherSave;
  panel.setScope({ workspaceUuid: 'one' });
  assert.equal(panel.draft, 'draft'); assert.equal(panel.note.sha256, 'old'); assert.equal(panel.busy, false);
});
