import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDocsService } from '../lib/docs/docs-service.js';
import { getDocsWorkspace, loadDocsState, updateDocsWorkspace } from '../lib/docs/docs-state-store.js';
import { MAX_NOTE_BYTES, MAX_SKIPPED, MAX_ENTRIES, listNotes, readNote, sha256, writeNote } from '../lib/docs/docs-files.js';
import { parseNote } from '../lib/docs/docs-index.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-docs-'));
  const home = path.join(dir, 'workspace');
  const root = path.join(home, 'docs');
  const external = path.join(dir, 'external');
  const dataDir = path.join(dir, 'state');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(external);
  const options = { dataDir, resolveScope: async (_dir, input) => ({ workspaceUuid: input?.workspaceUuid || 'ws-a', homeFolder: home }) };
  const svc = createDocsService(options);
  t.after(() => { svc.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, home, root, external, dataDir, options, svc };
}
const human = 'human';
const agent = 'agent';
const code = (value) => (e) => e.code === value;

test('root defaults only when docs exists; explicit create/clear; workspace state isolation', async (t) => {
  const f = fixture(t);
  assert.equal((await f.svc.config({})).root.relativeHint, 'docs');
  fs.rmdirSync(f.root);
  assert.equal((await f.svc.config({})).root, null);
  await assert.rejects(f.svc.tree({}, human), code('docs-not-configured'));
  await f.svc.setConfig({}, { root: 'docs', create: true }, human);
  assert.ok(fs.statSync(f.root).isDirectory());
  await f.svc.setConfig({}, { root: null }, human);
  assert.equal((await f.svc.config({})).root, null);
  assert.equal((await f.svc.config({ workspaceUuid: 'ws-b' })).root.relativeHint, 'docs');
  await assert.rejects(f.svc.setConfig({}, { root: '../outside', create: true }, human), code('docs-invalid-root'));
  await assert.rejects(f.svc.setConfig({}, { root: 'docs' }, agent), code('docs-human-required'));
});

test('external consent persists, agents need agentRead, revoke and symlink retarget disable access', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.external, 'private.md'), '# External');
  const alias = path.join(f.home, 'notes');
  fs.symlinkSync(f.external, alias);
  await f.svc.setConfig({}, { root: 'notes' }, human);
  for (const action of [() => f.svc.tree({}, human), () => f.svc.read({}, { path: 'private.md' }, human),
    () => f.svc.search({}, { q: 'external' }, human), () => f.svc.backlinks({}, { path: 'private.md' }, human),
    () => f.svc.write({}, { path: 'new.md', text: '' }, human, true)]) {
    await assert.rejects(action(), code('docs-consent-required'));
  }
  await assert.rejects(f.svc.consent({}, {}, agent), code('docs-human-required'));
  await f.svc.consent({}, {}, human);
  assert.equal((await f.svc.tree({}, human)).items.length, 1);
  await assert.rejects(f.svc.tree({}, agent), code('docs-agent-read-denied'));
  const restarted = createDocsService(f.options);
  t.after(() => restarted.close());
  assert.equal((await restarted.tree({}, human)).items[0].path, 'private.md');
  await restarted.consent({}, { agentRead: true }, human);
  assert.equal((await f.svc.tree({}, agent)).items.length, 1);
  fs.unlinkSync(alias);
  const other = path.join(f.dir, 'other');
  fs.mkdirSync(other);
  fs.symlinkSync(other, alias);
  await assert.rejects(f.svc.tree({}, human), code('docs-consent-required'));
  await f.svc.consent({}, { agentRead: true }, human);
  await f.svc.consent({}, {}, human, true);
  await assert.rejects(f.svc.tree({}, agent), code('docs-consent-required'));
});

test('path validation, all file operations reject escaping symlinks, size cap and exclusive create', async (t) => {
  const f = fixture(t);
  for (const invalid of ['../escape.md', '/absolute.md', 'C:/file.md', 'bad\0.md', 'no.txt', 'a\\b.md', '.hidden.md', 'a/../b.md', 'a//b.md', 'e\u0301.md']) {
    await assert.rejects(f.svc.read({}, { path: invalid }, human), code('docs-invalid-path'));
    await assert.rejects(f.svc.write({}, { path: invalid, text: '' }, human, true), code('docs-invalid-path'));
  }
  fs.writeFileSync(path.join(f.external, 'outside.md'), 'unchanged');
  fs.symlinkSync(f.external, path.join(f.root, 'escape'));
  for (const action of [() => f.svc.read({}, { path: 'escape/outside.md' }, human),
    () => f.svc.write({}, { path: 'escape/new.md', text: '' }, human, true),
    () => f.svc.remove({}, { path: 'escape/outside.md', expectedSha256: sha256('unchanged') }, human),
    () => f.svc.rename({}, { path: 'escape/outside.md', newPath: 'moved.md', expectedSha256: sha256('unchanged') }, human)]) {
    await assert.rejects(action(), code('docs-path-escape'));
  }
  fs.unlinkSync(path.join(f.root, 'escape'));
  fs.writeFileSync(path.join(f.root, 'big.md'), 'x'.repeat(MAX_NOTE_BYTES + 1));
  await assert.rejects(f.svc.read({}, { path: 'big.md' }, human), code('docs-too-large'));
  await assert.rejects(f.svc.write({}, { path: 'new.md', text: 'x'.repeat(MAX_NOTE_BYTES + 1) }, human, true), code('docs-too-large'));
  assert.equal(fs.readFileSync(path.join(f.external, 'outside.md'), 'utf8'), 'unchanged');
  const created = await f.svc.write({}, { path: 'a.md', text: '# First' }, human, true);
  await assert.rejects(f.svc.write({}, { path: 'a.md', text: 'replace' }, human, true), code('docs-exists'));
  await assert.rejects(f.svc.write({}, { path: 'a.md', text: 'replace' }, human), code('docs-precondition-required'));
  await assert.rejects(f.svc.write({}, { path: 'a.md', text: 'replace', expectedSha256: sha256('stale') }, human), code('docs-conflict'));
  assert.equal(readNote(f.root, 'a.md').sha256, created.note.sha256);
});

test('atomic writes preserve open old inode, leave no temp files and survive publish failure', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'a.md'), 'old');
  const fd = fs.openSync(path.join(f.root, 'a.md'), 'r');
  try {
    const result = writeNote(f.root, 'a.md', 'new', { expectedSha256: sha256('old') });
    assert.equal(result.text, 'new');
    assert.equal(fs.readFileSync(fd, 'utf8'), 'old');
  } finally { fs.closeSync(fd); }
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(f.root, 'a.md')) throw Object.assign(new Error('publish failed'), { code: 'EIO' });
    return rename(from, to);
  });
  assert.throws(() => writeNote(f.root, 'a.md', 'failed', { expectedSha256: sha256('new') }), /publish failed/);
  assert.equal(fs.readFileSync(path.join(f.root, 'a.md'), 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(f.root), ['a.md']);
});

test('index parses metadata, wikilinks, tags and backlinks; immediate external edits refresh search', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'alpha.md'), '---\ntitle: Alpha title\ntags: [one, two]\ncretli:\n  todo: hint\n---\n# Heading\nA knownterm #inline\n[[beta#Part|Alias]]\ncretli-ref todo=12345678-abcd-4000-8000-123456789abc\n');
  fs.writeFileSync(path.join(f.root, 'beta.md'), '# Beta');
  const note = (await f.svc.read({}, { path: 'alpha.md' }, human)).note;
  assert.equal(note.title, 'Alpha title');
  assert.deepEqual(note.tags, ['one', 'two', 'inline']);
  assert.deepEqual(note.frontmatter.cretli, { todo: 'hint' });
  assert.deepEqual(note.wikilinks, [{ raw: 'beta#Part|Alias', target: 'beta', heading: 'Part', alias: 'Alias' }]);
  assert.deepEqual(note.mentions, ['12345678-abcd-4000-8000-123456789abc']);
  assert.deepEqual((await f.svc.backlinks({}, { path: 'beta.md' }, agent)).items, [{ path: 'alpha.md', title: 'Alpha title' }]);
  assert.equal((await f.svc.search({}, { q: 'knownterm' }, agent)).items.length, 1);
  fs.writeFileSync(path.join(f.root, 'alpha.md'), '# Replaced\nExternalchange');
  assert.equal((await f.svc.search({}, { q: 'externalchange' }, agent)).items.length, 1);
  assert.equal((await f.svc.search({}, { q: 'knownterm' }, agent)).items.length, 0);
  assert.equal((await f.svc.backlinks({}, { path: 'beta.md' }, agent)).items.length, 0);
  const cyclic = parseNote({ path: 'cyclic.md', text: '---\na: &a [*a]\n---\n# Safe' });
  assert.equal(cyclic.frontmatterError, 'Invalid YAML frontmatter');
  assert.doesNotThrow(() => JSON.stringify(cyclic));
});

test('rename rewrites resolved wikilinks with aliases/headings and managed rows; deletion uses trash', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'folder'));
  fs.writeFileSync(path.join(f.root, 'alpha.md'), '---\ntitle: Alpha\nreference: "[[alpha]]"\n---\n# Alpha\n[[alpha|self]]');
  fs.writeFileSync(path.join(f.root, 'folder', 'source.md'), '# Source\n[[alpha#Part|Alias]] [[alpha.md]] [[missing]]');
  updateDocsWorkspace(f.dataDir, 'ws-a', () => ({ root: { path: 'docs', external: false }, consent: null,
    links: [{ id: 'link-1', note: 'alpha.md', kind: 'todo', targetId: 'todo-1', state: 'ok', suggestedPath: null }] }));
  await f.svc.rename({}, { path: 'alpha.md', newPath: 'folder/renamed.md', expectedSha256: readNote(f.root, 'alpha.md').sha256 }, human);
  assert.equal(fs.existsSync(path.join(f.root, 'alpha.md')), false);
  assert.match(readNote(f.root, 'folder/source.md').text, /\[\[renamed#Part\|Alias\]\] \[\[renamed.md\]\] \[\[missing\]\]/);
  assert.match(readNote(f.root, 'folder/renamed.md').text, /\[\[renamed\|self\]\]/);
  assert.match(readNote(f.root, 'folder/renamed.md').text, /reference: "\[\[alpha\]\]"/);
  assert.equal(getDocsWorkspace(f.dataDir, 'ws-a').links[0].note, 'folder/renamed.md');
  const result = await f.svc.remove({}, { path: 'folder/renamed.md', expectedSha256: readNote(f.root, 'folder/renamed.md').sha256 }, human);
  assert.equal(fs.existsSync(path.join(f.root, result.trashPath)), true);
  assert.equal((await f.svc.tree({}, human)).items.length, 1);
  assert.equal(getDocsWorkspace(f.dataDir, 'ws-a').links[0].state, 'dangling');
});

test('external moves suggest matching content without silently rewriting managed links', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'before.md'), '---\ncretli_id: note-id\n---\n# Note');
  updateDocsWorkspace(f.dataDir, 'ws-a', () => ({ root: { path: 'docs', external: false }, consent: null,
    links: [{ id: 'link', note: 'before.md', kind: 'todo', targetId: 'todo', state: 'ok' }] }));
  await f.svc.tree({}, human);
  fs.renameSync(path.join(f.root, 'before.md'), path.join(f.root, 'after.md'));
  await f.svc.tree({}, human);
  const link = getDocsWorkspace(f.dataDir, 'ws-a').links[0];
  assert.equal(link.note, 'before.md');
  assert.equal(link.state, 'dangling');
  assert.equal(link.suggestedPath, 'after.md');
});

test('state refuses corrupt persisted documents instead of overwriting consent', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.dataDir);
  fs.writeFileSync(path.join(f.dataDir, 'docs-state.json'), '{bad');
  assert.throws(() => loadDocsState(f.dataDir), code('docs-state-unavailable'));
  assert.throws(() => updateDocsWorkspace(f.dataDir, 'ws-a', (state) => state), code('docs-state-unavailable'));
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'docs-state.json'), 'utf8'), '{bad');
});

test('invalid UTF-8 and Markdown symlinks targeting non-Markdown files are refused', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'invalid.md'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(f.svc.read({}, { path: 'invalid.md' }, human), code('docs-invalid-encoding'));
  fs.writeFileSync(path.join(f.root, 'plain.txt'), 'private');
  fs.symlinkSync(path.join(f.root, 'plain.txt'), path.join(f.root, 'alias.md'));
  await assert.rejects(f.svc.read({}, { path: 'alias.md' }, human), code('docs-invalid-path'));
});

test('bad tree entries are bounded diagnostics and do not break healthy reads, search, backlinks or rename', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'good.md'), '# Healthy\nKnownterm [[target]]');
  fs.writeFileSync(path.join(f.root, 'target.md'), '# Target');
  fs.symlinkSync(f.external, path.join(f.root, 'escape'));
  fs.symlinkSync(path.join(f.root, 'absent'), path.join(f.root, 'dangling'));
  fs.writeFileSync(path.join(f.root, 'e\u0301.md'), 'NFD');
  fs.writeFileSync(path.join(f.root, 'back\\slash.md'), 'Backslash');
  const blocked = path.join(f.root, 'blocked');
  fs.mkdirSync(blocked);
  const opendir = fs.opendirSync;
  t.mock.method(fs, 'opendirSync', (folder, ...args) => {
    if (folder === blocked) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
    return opendir(folder, ...args);
  });
  const tree = await f.svc.tree({}, human);
  assert.deepEqual(tree.items.map((note) => note.path), ['good.md', 'target.md']);
  assert.deepEqual(Object.fromEntries(tree.skipped.map((entry) => [entry.path, entry.reason])), {
    escape: 'docs-path-escape', dangling: 'docs-not-found', 'e\u0301.md': 'docs-invalid-path',
    'back\\slash.md': 'docs-invalid-path', blocked: 'docs-unreadable',
  });
  assert.equal(JSON.stringify(tree.skipped).includes(f.external), false);
  assert.equal(tree.skipped.some((entry) => path.isAbsolute(entry.path)), false);
  assert.equal((await f.svc.read({}, { path: 'good.md' }, human)).note.title, 'Healthy');
  assert.equal((await f.svc.search({}, { q: 'knownterm' }, human)).items.length, 1);
  assert.equal((await f.svc.backlinks({}, { path: 'target.md' }, human)).items.length, 1);
  await assert.rejects(f.svc.read({}, { path: 'escape/outside.md' }, human), code('docs-path-escape'));
  await assert.rejects(f.svc.read({}, { path: 'dangling/missing.md' }, human), code('ENOENT'));
  await f.svc.rename({}, { path: 'target.md', newPath: 'renamed.md', expectedSha256: readNote(f.root, 'target.md').sha256 }, human);
  assert.match(readNote(f.root, 'good.md').text, /\[\[renamed\]\]/);
  for (let i = 0; i < MAX_SKIPPED + 5; i++) fs.symlinkSync(f.external, path.join(f.root, `escape-${i}`));
  const capped = await f.svc.tree({}, human);
  assert.equal(capped.skipped.length, MAX_SKIPPED);
  assert.equal(capped.items.length, 2);
});

test('scan depth and entry limits remain hard failures', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, ...Array(33).fill('nested')), { recursive: true });
  await assert.rejects(f.svc.tree({}, human), code('docs-index-limit'));
  fs.rmSync(path.join(f.root, 'nested'), { recursive: true });
  let entries = 0;
  t.mock.method(fs, 'opendirSync', () => ({
    readSync: () => ++entries <= MAX_ENTRIES + 1 ? { name: '.hidden' } : null,
    closeSync() {},
  }));
  assert.throws(() => listNotes(f.root), code('docs-index-limit'));
});

test('wikilinks in fenced blocks and inline code are neither indexed nor rewritten', async (t) => {
  const f = fixture(t);
  const text = ['# Source', '[[target#Live|Alias]]', '```md', '[[target#Fence]]', '```',
    '~~~', '[[target|Tilde]]', '~~~', '`[[target#Inline]]` and ``code ` [[target|Long span]]``',
    '[[target`code`]]', '[[unrelated`code`]]', '[[target.md]]'].join('\n');
  fs.writeFileSync(path.join(f.root, 'source.md'), text);
  fs.writeFileSync(path.join(f.root, 'target.md'), '# Target');
  const note = (await f.svc.read({}, { path: 'source.md' }, human)).note;
  assert.deepEqual(note.wikilinks.map((link) => link.raw), ['target#Live|Alias', 'target.md']);
  assert.equal((await f.svc.backlinks({}, { path: 'target.md' }, human)).items.length, 1);
  await f.svc.rename({}, { path: 'target.md', newPath: 'renamed.md', expectedSha256: readNote(f.root, 'target.md').sha256 }, human);
  assert.equal(readNote(f.root, 'source.md').text, text.replace('[[target#Live|Alias]]', '[[renamed#Live|Alias]]').replace('[[target.md]]', '[[renamed.md]]'));
  assert.equal((await f.svc.backlinks({}, { path: 'target.md' }, human)).items.length, 0);
  fs.writeFileSync(path.join(f.root, 'code-only.md'), '```\n[[renamed]]\n```\n`[[renamed]]`');
  const backlinks = (await f.svc.backlinks({}, { path: 'renamed.md' }, human)).items;
  assert.deepEqual(backlinks.map((entry) => entry.path), ['source.md']);
});

test('F6: blank paragraphs end inline spans while legitimate inline and fenced code stay hidden', () => {
  for (const newline of ['\n', '\r\n']) {
    const text = ['Use ` here', '', '[[target]]', ' \t', 'and ` there', '', '`[[x]]`', '```', '[[fenced]]', '```'].join(newline);
    const parsed = parseNote({ path: 'source.md', text });
    assert.deepEqual(parsed.wikilinks.map((link) => link.target), ['target']);
  }
});

test('F7: saturated skipped diagnostics keep unindexed note links unknown for agents and humans', async (t) => {
  const f = fixture(t);
  const targetId = '12345678-abcd-4000-8000-123456789abc';
  const note = 'skipped-99.md';
  fs.writeFileSync(path.join(f.root, 'healthy.md'), '# Healthy');
  for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(f.root, `skipped-${i}.md`), Buffer.from([0xff]));
  updateDocsWorkspace(f.dataDir, 'ws-a', (state) => ({ ...state, root: { path: 'docs', external: false },
    links: [{ id: 'link', note, kind: 'todo', targetId, state: 'ok' }] }));
  const service = createDocsService({ ...f.options, targetExists: async () => true });
  t.after(() => service.close());
  for (const actor of [agent, human]) {
    const tree = await service.tree({}, actor);
    assert.equal(tree.skipped.length, MAX_SKIPPED);
    assert.ok(!tree.skipped.some((entry) => entry.path === note));
    const link = (await service.links({}, { target: `todo:${targetId}` }, actor)).items[0];
    assert.equal(link.state, 'unknown'); assert.equal(link.noteMissing, null);
    assert.equal(getDocsWorkspace(f.dataDir, 'ws-a').links[0].state, 'ok');
  }
});
