import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SPA_PANELS, SPA_ROUTE_QUERY_KEYS, parseSpaRoute, buildSpaPath } from '../lib/spa-routes.js';
import { MAIN_PANELS } from '../app_front/app/appShell/panelRegistry.js';
import { resolveWikilink, directoryTree, conflictKind, reviewedSave } from '../app_front/features/docs/docsLogic.js';
import { safeMarkdown, safeDocUrl } from '../app_front/features/docs/docsMarkdown.js';
import { createDocsApi } from '../app_front/core/api/docs.js';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('Docs registers in the shell, routes, offline allowlist, lazy router, settings and styles', () => {
  assert.ok(SPA_PANELS.includes('docs') && MAIN_PANELS.includes('docs'));
  assert.deepEqual(SPA_ROUTE_QUERY_KEYS.docs, []);
  assert.equal(parseSpaRoute('/docs').panel, 'docs');
  assert.equal(buildSpaPath({ panel: 'docs' }), '/docs');
  assert.match(read('public/sw-routes.js'), /'docs'/);
  assert.match(read('public/index.html'), /class="tab" data-panel="docs"/);
  assert.match(read('public/index.html'), /id="docs-panel" class="panel"><cr-docs-panel>/);
  assert.match(read('app_front/app/appShell/panelRouter.js'), /docsPanel\.js/);
  assert.match(read('app_front/app/appShell/settingsTabs.js'), /tabId === 'workspace'[\s\S]*docsSettings\.js/);
  assert.match(read('app_front/css/app.scss'), /@use '\.\/features\/docs\/docs-panel'/);
});

test('wiki resolution matches relative, root, unique basename and ambiguous backend semantics', () => {
  const items = ['start.md', 'one/topic.md', 'two/topic.md', 'unique/deep.md'].map((path) => ({ path }));
  assert.equal(resolveWikilink('one/start.md', ' topic #Heading|alias', items), 'one/topic.md');
  assert.equal(resolveWikilink('one/start.md', '../start', items), 'start.md');
  assert.equal(resolveWikilink('start.md', 'two/topic', items), 'two/topic.md');
  assert.equal(resolveWikilink('start.md', 'topic', items), null);
  assert.equal(resolveWikilink('start.md', 'deep', items), 'unique/deep.md');
  assert.equal(resolveWikilink('start.md', '#heading', items), 'start.md');
  assert.equal(resolveWikilink('start.md', 'missing', items), null);
  assert.equal(resolveWikilink('one/start.md', '../../start', items), null);
  assert.equal(directoryTree(items).folders.get('one').notes[0].path, 'one/topic.md');
});

test('Markdown cannot create raw elements, event attributes, active URLs, images or frames', () => {
  const payload = '<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n<svg onload=alert(1)>\n<iframe src="https://example.com"></iframe>\n\n[x](javascript:alert(1))\n[x](data:text/html,boom)\n![image](https://example.com/track)\n[ok](https://example.com)';
  const tree = safeMarkdown(payload);
  const all = [];
  const visit = (nodes) => { for (const node of nodes) { all.push(node); visit(node.children || []); } };
  visit(tree);
  assert.ok(all.some((node) => node.type === 'text' && node.text.includes('<script>')));
  assert.ok(all.some((node) => node.type === 'a' && node.href === 'https://example.com'));
  for (const node of all) {
    assert.ok(!['script', 'img', 'svg', 'iframe'].includes(node.type));
    assert.deepEqual(Object.keys(node).filter((key) => /^on/i.test(key)), []);
    if (node.href) assert.equal(safeDocUrl(node.href), node.href);
  }
  for (const url of ['javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,x', '//example.com', 'https://example.com/\nboom']) assert.equal(safeDocUrl(url), null);
  assert.equal(safeMarkdown('`[[code]]`')[0].children[0].type, 'code');
});

test('reviewed overwrite always uses the reviewed hash; 428 and partial rename stay distinct', () => {
  assert.equal(conflictKind({ status: 409, code: 'docs-conflict' }), 'conflict');
  assert.equal(conflictKind({ status: 409, code: 'docs-exists' }), 'error');
  assert.equal(conflictKind({ status: 409, code: 'docs-rename-partial' }), 'partial');
  assert.equal(conflictKind({ status: 428 }), 'precondition');
  const note = { path: 'a.md', sha256: 'old' };
  assert.deepEqual(reviewedSave(note, 'draft', { path: 'a.md', sha256: 'new' }), { path: 'a.md', text: 'draft', expectedSha256: 'new' });
  assert.throws(() => reviewedSave(note, 'draft', { path: 'b.md', sha256: 'other' }));
});

test('API sends captured workspace scope, hashes, JSON and correct mutation methods', async () => {
  const requests = [];
  const api = createDocsApi({ workspaceFile: 'acme.code-workspace', workspaceFolder: '/example' }, async (url, options) => {
    requests.push({ url: new URL(url, 'http://localhost'), ...options });
    return { ok: true, json: async () => ({ ok: true }) };
  });
  await api.config(); await api.tree(); await api.note('one/a.md'); await api.search('a & b'); await api.links('a.md');
  await api.setConfig('docs', true); await api.consent(false); await api.revoke(); await api.create('a.md', 'new');
  await api.save('a.md', 'edit', 'hash'); await api.rename('a.md', 'b.md', 'hash'); await api.trash('b.md', 'hash');
  assert.deepEqual(requests.map((r) => r.method), ['GET', 'GET', 'GET', 'GET', 'GET', 'PUT', 'POST', 'DELETE', 'POST', 'PUT', 'POST', 'DELETE']);
  assert.equal(requests[2].url.searchParams.get('path'), 'one/a.md');
  assert.equal(requests[3].url.searchParams.get('q'), 'a & b');
  assert.equal(requests[4].url.searchParams.get('note'), 'a.md');
  for (const req of requests) {
    assert.equal(req.url.searchParams.get('workspaceFile'), 'acme.code-workspace');
    if (req.method !== 'GET') {
      assert.equal(req.headers['Content-Type'], 'application/json');
      assert.equal(JSON.parse(req.body).workspaceFolder, '/example');
    }
  }
  for (const index of [9, 10, 11]) assert.equal(JSON.parse(requests[index].body).expectedSha256, 'hash');
  assert.equal(JSON.parse(requests[6].body).agentRead, false);
  const denied = createDocsApi({}, async () => ({ ok: false, status: 428, json: async () => ({ code: 'docs-precondition', error: 'hash required' }) }));
  await assert.rejects(denied.save('a.md', 'x'), (e) => e.status === 428 && e.code === 'docs-precondition');
});

test('R1A1-F3: skipped reasons and link kinds use translated keys, including unknown fallbacks', async () => {
  const { skippedReasonKey, linkKindKey, completedRenameSteps } = await import('../app_front/features/docs/docsLabels.js');
  const { en } = await import('../app_front/i18n/en.js');
  const { pl } = await import('../app_front/i18n/pl.js');
  const get = (dict, key) => key.split('.').reduce((obj, part) => obj?.[part], dict);
  const codes = ['docs-not-found', 'docs-unreadable', 'docs-symlink-cycle', 'docs-invalid-path', 'docs-path-escape', 'docs-too-large', 'docs-invalid-encoding', 'docs-entry-unavailable', 'future-code', '__proto__'];
  for (const dictionary of [en, pl]) {
    for (const code of codes) {
      const label = get(dictionary, skippedReasonKey(code));
      assert.equal(typeof label, 'string'); assert.notEqual(label, code);
    }
    for (const kind of ['todo', 'initiative', 'decision', 'future-kind']) assert.equal(typeof get(dictionary, linkKindKey(kind)), 'string');
    for (const step of completedRenameSteps(['create:a.md', 'rewrite:b.md', 'remove:c.md', 'future:d.md', 'unknown'])) assert.equal(typeof get(dictionary, step.key), 'string');
  }
  assert.equal(skippedReasonKey('future-code'), skippedReasonKey('docs-entry-unavailable'));
  assert.equal(linkKindKey('future-kind'), 'docs.kind.unknown');
  const source = read('app_front/features/docs/cr-docs-panel.js');
  assert.match(source, /t\(skippedReasonKey\(entry.reason\)\)/);
  assert.match(source, /t\(linkKindKey\(hint.kind\)\)/);
});

test('R1A1-F6: NFC and NFD wiki spelling follow the unchanged backend resolver exactly', async () => {
  const { resolveWikiTarget } = await import('../lib/docs/docs-index.js');
  const items = [{ path: 'caf\u00e9.md' }];
  const notes = new Map(items.map((item) => [item.path, item]));
  for (const target of ['caf\u00e9', 'cafe\u0301']) {
    assert.equal(resolveWikilink('start.md', target, items), resolveWikiTarget('start.md', target, notes));
  }
  assert.equal(resolveWikilink('start.md', 'cafe\u0301', items), null);
});

test('R1A1-F7: fragment links render as text, while external links keep safe link attributes', async () => {
  const { renderDocMarkdown } = await import('../app_front/features/docs/docsMarkdownView.js');
  const strings = (value) => {
    if (Array.isArray(value)) return value.map(strings).join('');
    if (value?.strings) return value.strings.join('') + value.values.map(strings).join('');
    return typeof value === 'string' ? value : '';
  };
  const fragment = strings(renderDocMarkdown('[Jump](#heading)', 'a.md', [], () => {}));
  assert.match(fragment, /Jump/); assert.doesNotMatch(fragment, /<a |target=/);
  const external = strings(renderDocMarkdown('[Site](https://example.com)', 'a.md', [], () => {}));
  assert.match(external, /<a /); assert.match(external, /noopener noreferrer/); assert.match(external, /target="_blank"/);
});
